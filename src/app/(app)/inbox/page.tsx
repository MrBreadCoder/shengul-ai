import type { Metadata } from 'next'
import { CheckCircle } from '@phosphor-icons/react/dist/ssr'
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/require-user'
import { listDraftEmailsForClient } from '@/lib/db/emails'
import { listOpenKnowledgeRequestsForClient } from '@/lib/db/knowledge-requests'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { formatRelative } from '@/lib/format'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { DraftRow } from './draft-row'
import { KnowledgeRequestRow } from './knowledge-request-row'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Inbox' }

export default async function InboxPage(): Promise<React.ReactElement> {
  await requireUser()
  const supabase = await createServerClient()
  const [drafts, knowledgeRequests, cases] = await Promise.all([
    listDraftEmailsForClient(supabase),
    listOpenKnowledgeRequestsForClient(supabase),
    listCaseCompanyNames(supabase),
  ])

  const companyByCaseId = new Map(cases.map((kase) => [kase.id, kase.companyName]))
  const now = new Date()
  const total = drafts.length + knowledgeRequests.length

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Inbox"
        description="The only two things the agent cannot do alone: send a first email, and answer a question it has no facts for."
        actions={
          total > 0 ? (
            <span className="text-muted-foreground tnum text-sm">
              {total} awaiting you
            </span>
          ) : null
        }
      />

      {total === 0 ? (
        <EmptyState
          icon={CheckCircle}
          title="Nothing needs your attention"
          description="Drafts awaiting approval and questions the agent cannot answer will collect here. It is running on its own until then."
        />
      ) : (
        <div className="flex flex-col gap-10">
          {/* Blocked conversations come first: a stalled reply costs more than
              an unsent first touch. */}
          {knowledgeRequests.length > 0 ? (
            <Section
              title="Questions the agent cannot answer"
              aside={`${knowledgeRequests.length} open`}
            >
              <div className="flex flex-col gap-3">
                {knowledgeRequests.map((request) => (
                  <KnowledgeRequestRow
                    key={request.id}
                    knowledgeRequestId={request.id}
                    caseId={request.case_id}
                    question={request.question}
                    companyName={companyByCaseId.get(request.case_id) ?? 'Unknown company'}
                    age={formatRelative(request.created_at, now)}
                  />
                ))}
              </div>
            </Section>
          ) : null}

          {drafts.length > 0 ? (
            <Section title="Drafts awaiting approval" aside={`${drafts.length} queued`}>
              <div className="flex flex-col gap-3">
                {drafts.map((draft) => (
                  <DraftRow
                    key={draft.id}
                    emailId={draft.id}
                    caseId={draft.case_id}
                    subject={draft.subject ?? '(no subject)'}
                    body={draft.body ?? ''}
                    companyName={
                      (draft.case_id && companyByCaseId.get(draft.case_id)) || 'Unknown company'
                    }
                    age={formatRelative(draft.created_at, now)}
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
