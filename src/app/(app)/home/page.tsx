import type { Metadata } from 'next'
import type { ComponentType } from 'react'
import Link from 'next/link'
import { redirect } from 'next/navigation'
import { Envelope, Lightning, Users } from '@phosphor-icons/react/dist/ssr'
import type { IconProps } from '@phosphor-icons/react'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getOverviewMetrics, getDailyMetrics } from '@/lib/db/analytics'
import { rangeFromDays } from '@/lib/analytics/range'
import { formatCount } from '@/lib/analytics/rates'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listRecentLeadsForClient } from '@/lib/db/leads'
import { listEmailsForClient, listDraftEmailsForClient } from '@/lib/db/emails'
import { listOpenKnowledgeRequestsForClient } from '@/lib/db/knowledge-requests'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { getClientById } from '@/lib/db/clients'
import { listMailreachConnectedMailboxes } from '@/lib/db/mailboxes'
import { summarizeMailboxWarmup } from '@/lib/mailbox/mailreach-gate'
import { PageHeader } from '@/components/page-header'
import { StatTile } from '@/components/stat-tile'
import { RealtimeRefresher } from '@/components/realtime-refresher'
import { EmptyState } from '@/components/empty-state'
import { NeedsActionCard } from './needs-action-card'
import { CampaignRow } from './campaign-row'
import { LeadRow } from './lead-row'
import { MailRow } from './mail-row'
import { WarmupBanner } from './warmup-banner'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Home' }

// Must be one of RANGE_OPTIONS in src/lib/analytics/range.ts (7 | 30 | 90).
const HOME_RANGE_DAYS = 7
// Each list column now stretches to fill the viewport (see ListColumn's
// h-full), so 5 rows left visible dead space below the fold on any normal
// screen. 12 comfortably fills a typical laptop's height; anything beyond
// that scrolls inside the column instead of growing the page.
const LIST_LIMIT = 12

// Shared shape for the three "at a glance" list columns below the stat row —
// keeps their header markup (icon + title + optional aside) identical so the
// column grid reads as one system instead of three ad-hoc panels.
function ListColumn({
  icon: Icon,
  title,
  aside,
  children,
}: {
  icon: ComponentType<IconProps>
  title: string
  aside?: React.ReactNode
  children: React.ReactNode
}): React.ReactElement {
  return (
    <section className="flex min-h-0 flex-col gap-3">
      <div className="flex shrink-0 items-baseline justify-between gap-3">
        <h2 className="flex items-center gap-1.5 text-sm font-medium">
          <Icon size={15} weight="light" className="text-faint" />
          {title}
        </h2>
        {aside ? <div className="text-muted-foreground text-xs">{aside}</div> : null}
      </div>
      <div className="border-hairline bg-surface animate-rise min-h-0 flex-1 overflow-y-auto rounded-lg border">
        {children}
      </div>
    </section>
  )
}

export default async function HomePage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // Client-only page: an operator has no single client_id to scope a
  // dashboard to, so they keep landing on /crm (the nav also hides this
  // link from them — see src/components/shell/nav.tsx's clientOnly flag).
  if (appUser.role !== 'client' || appUser.client_id === null) {
    redirect('/crm')
  }
  const clientId = appUser.client_id

  const supabase = await createServerClient()
  const t = await getTranslations('home')
  const { from, to } = rangeFromDays(HOME_RANGE_DAYS, new Date())

  const [overview, daily, campaigns, leads, mail, drafts, knowledgeRequests, cases, client, mailreachMailboxes] =
    await Promise.all([
      getOverviewMetrics(supabase, { from, to, campaignId: null, clientId }),
      getDailyMetrics(supabase, { from, to, campaignId: null, clientId }),
      listCampaignsForClient(supabase, clientId),
      listRecentLeadsForClient(supabase, { limit: LIST_LIMIT }),
      listEmailsForClient(supabase, { direction: 'outbound', limit: LIST_LIMIT }),
      listDraftEmailsForClient(supabase),
      listOpenKnowledgeRequestsForClient(supabase),
      listCaseCompanyNames(supabase),
      getClientById(supabase, clientId),
      listMailreachConnectedMailboxes(supabase, clientId),
    ])

  const activeCampaigns = campaigns.filter((campaign) => campaign.status === 'active')
  // The campaigns column shows every campaign, active first — a client with
  // only 1-2 running campaigns would otherwise see a mostly-empty column even
  // though the card itself fills the full row height. Paused/archived ones
  // still carry their real status pill, so nothing is misrepresented.
  const campaignsForDisplay = [
    ...activeCampaigns,
    ...campaigns.filter((campaign) => campaign.status !== 'active'),
  ].slice(0, LIST_LIMIT)
  const companyByCaseId = new Map(cases.map((kase) => [kase.id, kase.companyName]))
  const now = new Date()
  const warmup = summarizeMailboxWarmup(mailreachMailboxes, client?.mailreach_enabled ?? false, now)
  const gatedWarmup = warmup.filter((w) => w.isGated)

  return (
    // The fixed height only engages at lg — the shell's content padding is
    // py-10 there (5rem total), so the page fills the viewport exactly
    // instead of stopping short with dead space below the fold. Below lg the
    // cap is dropped entirely and the page flows + scrolls normally; overflow
    // here is always absorbed by the list columns' own scroll areas, not
    // hidden — see ListColumn's overflow-y-auto.
    <div className="flex flex-col gap-6 lg:h-[calc(100dvh-5rem)] lg:min-h-0">
      <RealtimeRefresher channel="home-metrics" />
      <PageHeader title={t('pageTitle')} description={t('description')} className="shrink-0" />

      {gatedWarmup.length > 0 ? <WarmupBanner mailboxes={warmup} gated={gatedWarmup} /> : null}

      {/*
        Asymmetric bento, not five equal boxes: leads found is the
        top-of-funnel headline number, so it gets the widest tile. The
        needs-action tile closes the row instead of living in its own
        full-width section below — one fewer stack, and it reads as part of
        "the state of things right now" alongside the other four numbers.
      */}
      <div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1.2fr]">
        <StatTile
          index={0}
          label={t('tile.leadsFound')}
          value={formatCount(overview.leadsDiscovered)}
          trend={daily.map((day) => day.leadsDiscovered)}
          trendColor="var(--status-ready)"
        />
        <StatTile
          index={1}
          label={t('tile.emailsSent')}
          value={formatCount(overview.emailsSent)}
          trend={daily.map((day) => day.emailsSent)}
          trendColor="var(--status-contacted)"
        />
        <StatTile
          index={2}
          label={t('tile.replies')}
          value={formatCount(overview.repliesReceived)}
          trend={daily.map((day) => day.repliesReceived)}
          trendColor="var(--status-won)"
        />
        <StatTile index={3} label={t('tile.activeCampaigns')} value={formatCount(activeCampaigns.length)} />
        <NeedsActionCard index={4} draftCount={drafts.length} questionCount={knowledgeRequests.length} />
      </div>

      {/*
        Three columns, each a card that fills the rest of the viewport height
        (h-full on ListColumn's border) rather than shrink-wrapping its rows —
        the fix for the layout reading "empty": a 2-row list no longer leaves
        raw background showing beneath it.
      */}
      <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
        <ListColumn icon={Lightning} title={t('sectionCampaigns')}>
          {campaignsForDisplay.length === 0 ? (
            <EmptyState
              icon={Lightning}
              title={t('emptyCampaignsTitle')}
              description={t('emptyCampaignsDescription')}
              className="h-full rounded-lg border-none"
            />
          ) : (
            <div className="divide-hairline flex flex-col divide-y">
              {campaignsForDisplay.map((campaign) => (
                <CampaignRow
                  key={campaign.id}
                  id={campaign.id}
                  name={campaign.name}
                  status={campaign.status}
                  dailyTarget={campaign.daily_target}
                />
              ))}
            </div>
          )}
        </ListColumn>

        <ListColumn icon={Users} title={t('sectionLatestLeads')}>
          {leads.length === 0 ? (
            <EmptyState
              icon={Users}
              title={t('emptyLeadsTitle')}
              description={t('emptyLeadsDescription')}
              className="h-full rounded-lg border-none"
            />
          ) : (
            <div className="divide-hairline flex flex-col divide-y">
              {leads.map((lead) => (
                <LeadRow
                  key={lead.id}
                  fullName={lead.fullName}
                  title={lead.title}
                  companyName={lead.companyName}
                  companyDomain={lead.companyDomain}
                  emailStatus={lead.emailStatus}
                  caseId={lead.caseId}
                  createdAt={lead.createdAt}
                  now={now}
                />
              ))}
            </div>
          )}
        </ListColumn>

        <ListColumn
          icon={Envelope}
          title={t('sectionRecentMail')}
          aside={
            <Link href="/mail" className="hover:text-foreground transition-colors duration-200">
              {t('viewAllMail')}
            </Link>
          }
        >
          {mail.length === 0 ? (
            <EmptyState
              icon={Envelope}
              title={t('emptyMailTitle')}
              description={t('emptyMailDescription')}
              className="h-full rounded-lg border-none"
            />
          ) : (
            <div className="divide-hairline flex flex-col divide-y">
              {mail.map((email) => (
                <MailRow
                  key={email.id}
                  direction={email.direction}
                  status={email.status}
                  subject={email.subject}
                  companyName={email.case_id ? (companyByCaseId.get(email.case_id) ?? null) : null}
                  caseId={email.case_id}
                  timestamp={email.sent_at ?? email.created_at}
                  now={now}
                />
              ))}
            </div>
          )}
        </ListColumn>
      </div>
    </div>
  )
}
