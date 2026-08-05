import type { Metadata } from 'next'
import { CheckCircle } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/require-user'
import { listDraftEmailsForClient } from '@/lib/db/emails'
import { listOpenKnowledgeRequestsForClient } from '@/lib/db/knowledge-requests'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { listActiveResourcesForClients } from '@/lib/db/client-resources'
import { listAttachmentsForEmails } from '@/lib/db/email-attachments'
import { formatRelative } from '@/lib/format'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import type { ResourceSummary } from '@/components/resource-list'
import { DraftRow, type DraftAttachment } from './draft-row'
import { KnowledgeRequestRow } from './knowledge-request-row'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Inbox' }

// Per client, not per page — see listActiveResourcesForClients. Generous
// enough that a picker is never silently short.
const RESOURCES_PER_CLIENT = 200

export default async function InboxPage(): Promise<React.ReactElement> {
  await requireUser()
  const supabase = await createServerClient()
  const t = await getTranslations('inbox')
  const [drafts, knowledgeRequests, cases] = await Promise.all([
    listDraftEmailsForClient(supabase),
    listOpenKnowledgeRequestsForClient(supabase),
    listCaseCompanyNames(supabase),
  ])

  // Only the clients that actually have a row on this page, so no client's
  // library can be crowded out by another's.
  const pageClientIds = [
    ...drafts.map((draft) => draft.client_id),
    ...knowledgeRequests.map((request) => request.client_id),
  ]
  const [resourcesByClient, attachmentsByEmailId] = await Promise.all([
    listActiveResourcesForClients(supabase, pageClientIds, RESOURCES_PER_CLIENT),
    // One query for every draft on the page rather than one per row.
    listAttachmentsForEmails(supabase, drafts.map((draft) => draft.id)),
  ])

  // Each row sees only its own client's library, so an operator viewing several
  // clients cannot attach one client's collateral to another's email.
  const resourcesByClientId = new Map<string, ResourceSummary[]>()
  for (const [clientId, resources] of resourcesByClient) {
    resourcesByClientId.set(
      clientId,
      resources.map((resource) => ({
        id: resource.id,
        clientId: resource.client_id,
        title: resource.title,
        description: resource.description,
        fileName: resource.file_name,
        mimeType: resource.mime_type,
        byteSize: resource.byte_size,
        contentStatus: resource.content_status,
        contentSummary: resource.content_summary,
        // /inbox never deletes; the picker ignores this flag.
        canManage: false,
      })),
    )
  }

  // Narrowed to the three fields the row renders. The stored row also carries
  // storage_path, and every prop of a Client Component is serialized into the
  // payload the browser receives — internal storage keys do not belong there.
  const draftAttachments = (emailId: string): DraftAttachment[] =>
    (attachmentsByEmailId.get(emailId) ?? []).map((attachment) => ({
      resourceId: attachment.resourceId,
      title: attachment.title,
      byteSize: attachment.byteSize,
    }))

  const companyByCaseId = new Map(cases.map((kase) => [kase.id, kase.companyName]))
  const now = new Date()
  const total = drafts.length + knowledgeRequests.length

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          total > 0 ? (
            <span className="text-muted-foreground tnum text-sm">
              {t('awaitingCount', { count: total })}
            </span>
          ) : null
        }
      />

      {total === 0 ? (
        <EmptyState
          icon={CheckCircle}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : (
        <div className="flex flex-col gap-10">
          {/* Blocked conversations come first: a stalled reply costs more than
              an unsent first touch. */}
          {knowledgeRequests.length > 0 ? (
            <Section
              title={t('questionsSectionTitle')}
              aside={t('questionsOpenAside', { count: knowledgeRequests.length })}
            >
              <div className="flex flex-col gap-3">
                {knowledgeRequests.map((request) => (
                  <KnowledgeRequestRow
                    key={request.id}
                    knowledgeRequestId={request.id}
                    caseId={request.case_id}
                    clientId={request.client_id}
                    question={request.question}
                    companyName={companyByCaseId.get(request.case_id) ?? t('unknownCompany')}
                    age={formatRelative(request.created_at, now)}
                    resources={resourcesByClientId.get(request.client_id) ?? []}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {drafts.length > 0 ? (
            <Section title={t('draftsSectionTitle')} aside={t('draftsQueuedAside', { count: drafts.length })}>
              <div className="flex flex-col gap-3">
                {drafts.map((draft) => (
                  <DraftRow
                    key={draft.id}
                    emailId={draft.id}
                    caseId={draft.case_id}
                    subject={draft.subject ?? t('noSubjectPlaceholder')}
                    body={draft.body ?? ''}
                    companyName={
                      (draft.case_id && companyByCaseId.get(draft.case_id)) || t('unknownCompany')
                    }
                    age={formatRelative(draft.created_at, now)}
                    attachments={draftAttachments(draft.id)}
                    resources={resourcesByClientId.get(draft.client_id) ?? []}
                  />
                ))}
              </div>
            </Section>
          ) : null}
        </div>
      )}
    </div>
  )
}
