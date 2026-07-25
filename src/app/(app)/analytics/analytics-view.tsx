import Link from 'next/link'
import { ChartLineUp } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listClients } from '@/lib/db/clients'
import {
  getOverviewMetrics,
  getDailyMetrics,
  getCampaignMetrics,
  getMailboxMetrics,
  getEventCounts,
} from '@/lib/db/analytics'
import { analyticsSearchParamsSchema, parseRangeDays, rangeFromDays } from '@/lib/analytics/range'
import { rate, formatPercent, formatCount, formatDateTime } from '@/lib/analytics/rates'
import { humanizeEnum } from '@/lib/format'
import { MAILBOX_HEALTH } from '@/lib/ui/status'
import { Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatusPill } from '@/components/status-dot'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatTile } from './stat-tile'
import { SparklineChart } from './sparkline-chart'
import { AnalyticsFilters } from './filters'

const EVENT_TYPE_LIMIT = 12
const TREND_TABLE_DAYS = 14

const TILE_GRID = 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

export type AnalyticsScope = { kind: 'global' } | { kind: 'client'; clientId: string }

interface AnalyticsViewProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  scope: AnalyticsScope
}

export async function AnalyticsView({ searchParams, scope }: AnalyticsViewProps): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  const supabase = await createServerClient()

  // URL params are untrusted input that reaches SQL — validate, then whitelist.
  const parsed = analyticsSearchParamsSchema.safeParse(await searchParams)
  const days = parseRangeDays(parsed.success ? parsed.data.days : undefined)
  const requestedCampaignId = parsed.success ? (parsed.data.campaign ?? null) : null
  // In 'client' scope the client filter is fixed by the route, not the URL.
  const requestedClientId = scope.kind === 'client' ? scope.clientId : parsed.success ? (parsed.data.client ?? null) : null

  const isOperator = appUser.role === 'operator'
  const showClientPicker = scope.kind === 'global' && isOperator
  const [rawCampaigns, clientOptions] = await Promise.all([
    listCampaignsForClient(supabase, appUser.client_id),
    showClientPicker ? listClients(supabase) : Promise.resolve([]),
  ])
  const campaigns = rawCampaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    clientId: campaign.client_id,
  }))

  const clientId =
    scope.kind === 'client'
      ? scope.clientId
      : isOperator && clientOptions.some((client) => client.id === requestedClientId)
        ? requestedClientId
        : null
  const campaignId = campaigns.some(
    (campaign) => campaign.id === requestedCampaignId && (!clientId || campaign.clientId === clientId),
  )
    ? requestedCampaignId
    : null

  const { from, to } = rangeFromDays(days, new Date())
  const [overview, daily, byCampaign, allMailboxes, eventCounts] = await Promise.all([
    getOverviewMetrics(supabase, { from, to, campaignId, clientId }),
    getDailyMetrics(supabase, { from, to, campaignId, clientId }),
    getCampaignMetrics(supabase, { from, to }),
    getMailboxMetrics(supabase),
    getEventCounts(supabase, { from, to, limit: EVENT_TYPE_LIMIT }),
  ])

  const replyRate = rate(overview.leadsReplied, overview.leadsContacted)
  const bounceRate = rate(overview.emailsBounced, overview.emailsSent)
  const failureRate = rate(overview.emailsFailed, overview.emailsSent + overview.emailsFailed)
  const verifiedRate = rate(overview.leadsVerified, overview.leadsDiscovered)
  const trendRows = daily.slice(-TREND_TABLE_DAYS).reverse()
  const scopedCampaigns = byCampaign.filter(
    (row) => (!campaignId || row.campaignId === campaignId) && (!clientId || row.clientId === clientId),
  )
  const mailboxes = clientId ? allMailboxes.filter((mailbox) => mailbox.clientId === clientId) : allMailboxes
  const hasAnyData = overview.leadsDiscovered + overview.emailsSent + overview.repliesReceived > 0

  return (
    <div className="flex flex-col gap-8">
      <AnalyticsFilters
        days={days}
        campaignId={campaignId}
        clientId={showClientPicker ? clientId : null}
        campaigns={campaigns}
        clients={showClientPicker ? clientOptions : []}
        basePath={scope.kind === 'client' ? `/clients/${scope.clientId}` : '/analytics'}
        fixedParams={scope.kind === 'client' ? { tab: 'analytics' } : {}}
      />

      {!hasAnyData ? (
        <EmptyState
          icon={ChartLineUp}
          title="No pipeline activity in this range"
          description="Run discovery or widen the date range above. Metrics appear the moment the first lead lands."
        />
      ) : null}

      <Section title="Outreach">
        <div className={TILE_GRID}>
          <StatTile
            index={0}
            label="Emails sent"
            value={formatCount(overview.emailsSent)}
            hint={`${formatCount(overview.firstTouchSent)} first touch · ${formatCount(overview.followupsSent)} follow-ups`}
          />
          <StatTile
            index={1}
            label="Replies"
            value={formatCount(overview.repliesReceived)}
            hint={`${formatCount(overview.leadsReplied)} people replied`}
          />
          <StatTile
            index={2}
            label="Reply rate"
            value={formatPercent(replyRate)}
            hint={`of ${formatCount(overview.leadsContacted)} people contacted`}
          />
          <StatTile
            index={3}
            label="Bounce rate"
            value={formatPercent(bounceRate)}
            hint={`${formatCount(overview.emailsBounced)} bounced`}
          />
          <StatTile
            index={4}
            label="Send failures"
            value={formatCount(overview.emailsFailed)}
            hint={`${formatPercent(failureRate)} of send attempts`}
          />
          <StatTile
            index={5}
            label="Active sequences"
            value={formatCount(overview.activeSequences)}
            hint="Follow-ups still running right now"
          />
        </div>
      </Section>

      <Section title="Pipeline">
        <div className={TILE_GRID}>
          <StatTile index={0} label="Leads discovered" value={formatCount(overview.leadsDiscovered)} />
          <StatTile
            index={1}
            label="Verified emails"
            value={formatCount(overview.leadsVerified)}
            hint={`${formatPercent(verifiedRate)} of discovered`}
          />
          <StatTile index={2} label="Cases created" value={formatCount(overview.casesCreated)} />
          <StatTile
            index={3}
            label="Suppressions added"
            value={formatCount(overview.suppressionsAdded)}
            hint="Ignores the campaign filter, honours the client filter"
          />
        </div>
      </Section>

      <Section title="Daily trend" aside={`Last ${Math.min(TREND_TABLE_DAYS, daily.length)} days shown below`}>
        <div className="grid gap-3 md:grid-cols-3">
          <SparklineChart
            index={0}
            title="Emails sent"
            color="var(--status-contacted)"
            total={formatCount(overview.emailsSent)}
            values={daily.map((day) => day.emailsSent)}
          />
          <SparklineChart
            index={1}
            title="Replies"
            color="var(--status-won)"
            total={formatCount(overview.repliesReceived)}
            values={daily.map((day) => day.repliesReceived)}
          />
          <SparklineChart
            index={2}
            title="Leads discovered"
            color="var(--status-ready)"
            total={formatCount(overview.leadsDiscovered)}
            values={daily.map((day) => day.leadsDiscovered)}
          />
        </div>

        {trendRows.length > 0 ? (
          <div className="border-hairline mt-1 overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="sr-only">Daily totals, most recent first, in UTC</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Day (UTC)</TableHead>
                  <TableHead scope="col" className="text-right">Discovered</TableHead>
                  <TableHead scope="col" className="text-right">Sent</TableHead>
                  <TableHead scope="col" className="text-right">Replies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trendRows.map((day) => (
                  <TableRow key={day.day}>
                    <TableCell className="font-mono text-xs">{day.day}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(day.leadsDiscovered)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(day.emailsSent)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(day.repliesReceived)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </Section>

      <Section title="Campaigns">
        {scopedCampaigns.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No campaigns yet.{' '}
            <Link href={scope.kind === 'client' ? `/clients/${scope.clientId}?tab=campaigns` : '/campaigns'} className="text-primary underline underline-offset-2">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Campaign</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  {['Discovered', 'Verified', 'Sent', 'Contacted', 'Replied', 'Reply rate', 'In conv.', 'Hot', 'Won', 'Dead'].map(
                    (heading) => (
                      <TableHead key={heading} scope="col" className="text-right">
                        {heading}
                      </TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {scopedCampaigns.map((row) => (
                  <TableRow key={row.campaignId}>
                    <TableCell className="font-medium">{row.campaignName}</TableCell>
                    <TableCell className="text-muted-foreground">{humanizeEnum(row.campaignStatus)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsDiscovered)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsVerified)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.emailsSent)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsContacted)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsReplied)}</TableCell>
                    <TableCell className="tnum text-right">{formatPercent(rate(row.leadsReplied, row.leadsContacted))}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesInConversation)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesHotHandoff)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesWon)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesDead)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Mailboxes">
        {mailboxes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No mailboxes connected.{' '}
            <Link href="/settings" className="text-primary underline underline-offset-2">
              Connect one
            </Link>
            .
          </p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Mailbox</TableHead>
                  <TableHead scope="col">Provider</TableHead>
                  <TableHead scope="col">Health</TableHead>
                  <TableHead scope="col" className="text-right">Today</TableHead>
                  <TableHead scope="col" className="text-right">Cap used</TableHead>
                  <TableHead scope="col" className="text-right">Sent all-time</TableHead>
                  <TableHead scope="col" className="text-right">Bounce rate</TableHead>
                  <TableHead scope="col">Last send</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mailboxes.map((mailbox) => (
                  <TableRow key={mailbox.mailboxId}>
                    <TableCell className="font-medium">{mailbox.emailAddress}</TableCell>
                    <TableCell className="text-muted-foreground">{mailbox.provider}</TableCell>
                    <TableCell>
                      <StatusPill meta={MAILBOX_HEALTH[mailbox.health]} />
                    </TableCell>
                    <TableCell className="tnum text-right">
                      {formatCount(mailbox.sentToday)} / {formatCount(mailbox.dailyCap)}
                    </TableCell>
                    <TableCell className="tnum text-right">{formatPercent(rate(mailbox.sentToday, mailbox.dailyCap))}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(mailbox.sentTotal)}</TableCell>
                    <TableCell className="tnum text-right">{formatPercent(rate(mailbox.bouncedTotal, mailbox.sentTotal))}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{formatDateTime(mailbox.lastSentAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Agent activity" className="pb-4">
        {eventCounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No agent events logged in this range.</p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Event</TableHead>
                  <TableHead scope="col" className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventCounts.map((event) => (
                  <TableRow key={event.type}>
                    <TableCell>{humanizeEnum(event.type)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(event.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  )
}
