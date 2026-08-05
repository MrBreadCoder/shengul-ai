import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import {
  ArrowLeft,
  Brain,
  Envelope,
  LinkedinLogo,
  Question,
  Pulse,
} from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getCaseById } from '@/lib/db/cases'
import { getCaseCrmLink } from '@/lib/db/case-crm-links'
import { getCrmConnectionForClient } from '@/lib/db/crm-connections'
import { listLeadsForCase } from '@/lib/db/leads'
import { listEmailsForCase } from '@/lib/db/emails'
import { listKnowledgeForCase } from '@/lib/db/case-knowledge'
import { listKnowledgeRequestsForCase } from '@/lib/db/knowledge-requests'
import { listEventsForCase } from '@/lib/db/events'
import { getCampaignById } from '@/lib/db/campaigns'
import { listNotesForCase } from '@/lib/db/notes'
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
import { listSequencesForCase } from '@/lib/db/sequences'
import { CASE_STATUS, KNOWLEDGE_REQ_STATUS, LEAD_EMAIL_STATUS } from '@/lib/ui/status'
import { buildContactThreads } from '@/lib/ui/mail-threads'
import { formatAbsolute, formatRelative, humanizeEnum, formatFollowupCountdown } from '@/lib/format'
import { CompanyMark } from '@/components/company-mark'
import { StatusPill } from '@/components/status-dot'
import { KnowledgeItem } from '@/components/knowledge-item'
import { EmptyState } from '@/components/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { StopLeadButton } from './stop-lead-button'
import { LeadFollowupControl } from './lead-followup-control'
import { NotesPanel, type NotePanelItem } from './notes-panel'
import { MailTab } from './mail-tab'
import { CrmLinkBadge } from './crm-link-badge'

export const dynamic = 'force-dynamic'

const EVENT_LIMIT = 60
const RESOURCE_LIMIT = 50

const paramsSchema = z.object({ id: z.string().uuid() })

interface CasePageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: CasePageProps): Promise<Metadata> {
  const parsed = paramsSchema.safeParse(await params)
  if (!parsed.success) return { title: 'Case' }
  const supabase = await createServerClient()
  const kase = await getCaseById(supabase, parsed.data.id)
  return { title: kase?.company_name ?? 'Case' }
}

export default async function CasePage({
  params,
  searchParams,
}: CasePageProps): Promise<React.ReactElement> {
  const { appUser } = await requireUser()

  // A non-uuid path segment would otherwise reach Postgres and throw a 500.
  const parsed = paramsSchema.safeParse(await params)
  if (!parsed.success) notFound()
  const caseId = parsed.data.id

  // Untrusted: parsed as a uuid here and checked against this case's own leads
  // below, so a foreign or malformed id simply preselects nothing.
  const noteParam = z.string().uuid().safeParse((await searchParams).note)

  const supabase = await createServerClient()
  const kase = await getCaseById(supabase, caseId)
  // RLS makes an out-of-scope case indistinguishable from a missing one, which
  // is the behaviour we want: no existence leak across clients.
  if (!kase) notFound()

  const [leads, emails, knowledge, requests, events, campaign, notes, resources, crmLink, sequences] = await Promise.all([
    listLeadsForCase(supabase, caseId),
    listEmailsForCase(supabase, caseId),
    listKnowledgeForCase(supabase, caseId),
    listKnowledgeRequestsForCase(supabase, caseId),
    listEventsForCase(supabase, caseId, EVENT_LIMIT),
    getCampaignById(supabase, kase.campaign_id),
    listNotesForCase(supabase, caseId),
    listActiveResourcesForClient(supabase, kase.client_id, RESOURCE_LIMIT),
    getCaseCrmLink(supabase, caseId),
    listSequencesForCase(supabase, caseId),
  ])
  const crmConnection = crmLink ? await getCrmConnectionForClient(supabase, kase.client_id) : null
  // Only an active/paused sequence has anything left to edit — a
  // stopped/completed one shows no control at all (see LeadFollowupControl).
  const sequenceByLeadId = new Map(
    sequences
      .filter((sequence) => sequence.state === 'active' || sequence.state === 'paused')
      .map((sequence) => [sequence.lead_id, sequence]),
  )

  const now = new Date()
  const openRequests = requests.filter((request) => request.status === 'open').length

  // "You" or "Teammate", never a name: app_users carries only id/role/client_id
  // (no email — that lives in auth.users, reachable only through the admin
  // client). Resolving names would mean an auth-admin lookup on a page a
  // client-role user loads, to show one teammate another teammate's address.
  const noteItems: NotePanelItem[] = notes.map((note) => ({
    id: note.id,
    body: note.body,
    leadId: note.lead_id,
    authorLabel: note.created_by === appUser.id ? 'You' : 'Teammate',
    canManage: appUser.role === 'operator' || note.created_by === appUser.id,
    createdAt: note.created_at,
  }))
  const noteCountByLeadId = new Map<string, number>()
  for (const note of notes) {
    if (note.lead_id) noteCountByLeadId.set(note.lead_id, (noteCountByLeadId.get(note.lead_id) ?? 0) + 1)
  }
  const initialNoteLeadId =
    noteParam.success && leads.some((lead) => lead.id === noteParam.data) ? noteParam.data : null

  // Parked leads are excluded: outreach to them was deliberately stopped, and a
  // send would be refused by the suppression check anyway.
  const composeContacts = leads
    .filter((lead) => lead.status !== 'parked' && lead.email !== null)
    // safe: filtered on lead.email !== null immediately above
    .map((lead) => ({ id: lead.id, fullName: lead.full_name, email: lead.email! }))

  const { threads: mailThreads, newContactOptions } = buildContactThreads(leads, emails, composeContacts)

  // Mapped inline, matching /inbox, /knowledge/resources and the client detail
  // page. Extracting a shared mapper is a cross-cutting change those three
  // surfaces would have to adopt too — out of scope here.
  const composeResources = resources.map((resource) => ({
    id: resource.id,
    clientId: resource.client_id,
    title: resource.title,
    description: resource.description,
    fileName: resource.file_name,
    mimeType: resource.mime_type,
    byteSize: resource.byte_size,
    contentStatus: resource.content_status,
    contentSummary: resource.content_summary,
    canManage: false,
  }))

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5">
        <Link
          href="/crm"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs transition-colors duration-200"
        >
          <ArrowLeft size={13} weight="light" />
          Pipeline
        </Link>

        <div className="flex flex-wrap items-start gap-4">
          <CompanyMark name={kase.company_name} domain={kase.company_domain} className="size-11 rounded-lg text-sm" />
          <div className="min-w-0 flex-1">
            <h1 className="truncate text-2xl font-semibold tracking-tight">{kase.company_name}</h1>
            <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              {kase.company_domain ? (
                <a
                  href={`https://${kase.company_domain}`}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="hover:text-foreground underline underline-offset-2 transition-colors duration-200"
                >
                  {kase.company_domain}
                </a>
              ) : null}
              {campaign ? <span>Campaign: {campaign.name}</span> : null}
              <span title={formatAbsolute(kase.created_at)}>
                Opened {formatRelative(kase.created_at, now)}
              </span>
              {crmLink && crmConnection ? (
                <CrmLinkBadge
                  provider={crmConnection.provider}
                  dealUrl={crmLink.external_deal_url}
                  syncError={crmLink.last_sync_status === 'error' ? crmLink.last_sync_error : null}
                />
              ) : null}
            </div>
          </div>
          <StatusPill meta={CASE_STATUS[kase.status]} className="mt-1 px-2.5 py-1 text-xs" />
        </div>

        {kase.summary ? (
          <p className="border-hairline bg-surface-sunken max-w-[75ch] rounded-lg border p-4 text-sm leading-relaxed">
            {kase.summary}
          </p>
        ) : null}
      </header>

      <NotesPanel
        // Remount when the target changes: the composer seeds its About selector
        // from initialLeadId in useState, which only reads on mount, so a second
        // "Add note" click would otherwise change the URL and nothing else.
        key={initialNoteLeadId ?? 'company'}
        caseId={kase.id}
        contacts={leads.map((lead) => ({ id: lead.id, fullName: lead.full_name }))}
        notes={noteItems}
        initialLeadId={initialNoteLeadId}
      />

      <section aria-label="Contacts" className="flex flex-col gap-3">
        <h2 className="text-sm font-medium">
          Contacts <span className="text-faint tnum font-normal">{leads.length}</span>
        </h2>
        {leads.length === 0 ? (
          <p className="border-hairline text-muted-foreground rounded-lg border border-dashed px-4 py-6 text-center text-sm">
            No contacts attached to this case yet.
          </p>
        ) : (
          <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
            {leads.map((lead) => {
              const sequence = sequenceByLeadId.get(lead.id)
              return (
                <li
                  key={lead.id}
                  className="border-hairline bg-surface flex items-start gap-3 rounded-lg border p-3"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-[13px] font-medium">{lead.full_name}</p>
                    <p className="text-faint truncate text-[11px]">{lead.title ?? 'Title unknown'}</p>
                    {lead.email ? (
                      <p className="text-muted-foreground mt-1.5 truncate font-mono text-[11px]">
                        {lead.email}
                      </p>
                    ) : null}
                    <div className="mt-2 flex items-center gap-2">
                      <StatusPill meta={LEAD_EMAIL_STATUS[lead.email_status]} />
                      {lead.linkedin_url ? (
                        <a
                          href={lead.linkedin_url}
                          target="_blank"
                          rel="noreferrer noopener"
                          aria-label={`${lead.full_name} on LinkedIn`}
                          className="text-faint hover:text-foreground transition-colors duration-200"
                        >
                          <LinkedinLogo size={14} weight="light" />
                        </a>
                      ) : null}
                      {/* A contact with no notes still shows the control, so the
                          first note on a person is as easy to write as the tenth. */}
                      <Link
                        href={`/cases/${kase.id}?note=${lead.id}#notes`}
                        scroll
                        className="text-faint hover:text-foreground text-[11px] underline underline-offset-2 transition-colors duration-200"
                      >
                        {(noteCountByLeadId.get(lead.id) ?? 0) > 0
                          ? `${noteCountByLeadId.get(lead.id)} note${noteCountByLeadId.get(lead.id) === 1 ? '' : 's'}`
                          : 'Add note'}
                      </Link>
                    </div>
                    {sequence ? (
                      <LeadFollowupControl
                        leadId={lead.id}
                        caseId={kase.id}
                        delaysDays={sequence.followup_delays_days}
                        currentStep={sequence.current_step}
                        countdownLabel={formatFollowupCountdown(sequence.next_action_at, now)}
                      />
                    ) : null}
                  </div>
                  {lead.status === 'parked' ? (
                    <span className="text-faint shrink-0 text-[11px]">Stopped</span>
                  ) : (
                    <StopLeadButton leadId={lead.id} caseId={kase.id} fullName={lead.full_name} />
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      <Tabs defaultValue="mail" className="gap-5">
        <TabsList>
          <TabsTrigger value="mail">
            <Envelope size={14} weight="light" />
            Mail
            <span className="tnum text-faint">{emails.length}</span>
          </TabsTrigger>
          <TabsTrigger value="knowledge">
            <Brain size={14} weight="light" />
            Knowledge
            <span className="tnum text-faint">{knowledge.length}</span>
          </TabsTrigger>
          <TabsTrigger value="requests">
            <Question size={14} weight="light" />
            Questions
            <span className="tnum text-faint">{requests.length}</span>
          </TabsTrigger>
          <TabsTrigger value="activity">
            <Pulse size={14} weight="light" />
            Activity
          </TabsTrigger>
        </TabsList>

        <TabsContent value="mail">
          <MailTab
            caseId={kase.id}
            threads={mailThreads}
            newContactOptions={newContactOptions}
            resources={composeResources}
            now={now}
          />
        </TabsContent>

        <TabsContent value="knowledge">
          {knowledge.length === 0 ? (
            <EmptyState
              icon={Brain}
              title="Nothing researched yet"
              description="The research agent writes company facts, news and pain points here before the first email is drafted."
            />
          ) : (
            <div className="flex max-w-[80ch] flex-col gap-3">
              {knowledge.map((fact) => (
                <KnowledgeItem
                  key={fact.id}
                  kind={fact.kind}
                  content={fact.content}
                  sourceUrl={fact.source_url}
                  citation={fact.citation}
                  createdBy={fact.created_by}
                  createdAt={fact.created_at}
                  now={now}
                />
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="requests">
          {requests.length === 0 ? (
            <EmptyState
              icon={Question}
              title="The agent has not needed you"
              description="When a reply asks something the agent cannot answer from its research, it raises a question here and waits for a human."
            />
          ) : (
            <div className="flex max-w-[80ch] flex-col gap-3">
              {openRequests > 0 ? (
                <p className="text-muted-foreground text-xs">
                  {openRequests} open. Answer them from the{' '}
                  <Link href="/inbox" className="text-primary underline underline-offset-2">
                    inbox
                  </Link>
                  .
                </p>
              ) : null}
              {requests.map((request) => (
                <article key={request.id} className="border-hairline bg-surface rounded-lg border p-4">
                  <div className="flex items-center gap-2.5">
                    <StatusPill meta={KNOWLEDGE_REQ_STATUS[request.status]} />
                    <time
                      dateTime={request.created_at}
                      title={formatAbsolute(request.created_at)}
                      className="text-faint ml-auto text-[11px]"
                    >
                      {formatRelative(request.created_at, now)}
                    </time>
                  </div>
                  <p className="mt-3 text-sm leading-relaxed">{request.question}</p>
                  {request.human_answer ? (
                    <div
                      className="mt-3 border-l-2 pl-3"
                      style={{ borderColor: 'color-mix(in oklch, var(--status-won) 45%, transparent)' }}
                    >
                      <p className="text-faint text-[11px]">Operator answered</p>
                      <p className="text-muted-foreground mt-1 text-sm leading-relaxed whitespace-pre-wrap">
                        {request.human_answer}
                      </p>
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          )}
        </TabsContent>

        <TabsContent value="activity">
          {events.length === 0 ? (
            <EmptyState
              icon={Pulse}
              title="No activity logged"
              description="Every pipeline step the agent takes on this case is recorded here as it happens."
            />
          ) : (
            <ol className="max-w-[80ch]">
              {events.map((event, index) => (
                <li key={event.id} className="flex gap-3">
                  {/* Rail: a dot per event, joined by a line except on the last. */}
                  <div className="flex flex-col items-center pt-1.5">
                    <span className="bg-faint size-1.5 shrink-0 rounded-full" aria-hidden />
                    {index < events.length - 1 ? (
                      <span className="bg-hairline w-px flex-1" aria-hidden />
                    ) : null}
                  </div>
                  <div className="min-w-0 flex-1 pb-4">
                    <div className="flex flex-wrap items-baseline gap-x-2.5">
                      <p className="text-[13px] font-medium">{humanizeEnum(event.type)}</p>
                      <span className="text-faint font-mono text-[11px]">{event.actor}</span>
                      <time
                        dateTime={event.created_at}
                        title={formatAbsolute(event.created_at)}
                        className="text-faint ml-auto text-[11px]"
                      >
                        {formatRelative(event.created_at, now)}
                      </time>
                    </div>
                  </div>
                </li>
              ))}
            </ol>
          )}
        </TabsContent>
      </Tabs>
    </div>
  )
}
