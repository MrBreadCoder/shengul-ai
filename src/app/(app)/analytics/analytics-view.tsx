import Link from 'next/link'
import { ChartLineUp } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
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
  const t = await getTranslations('analytics')

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
          title={t('noDataTitle')}
          description={t('noDataDescription')}
        />
      ) : null}

      <Section title={t('sectionOutreach')}>
        <div className={TILE_GRID}>
          <StatTile
            index={0}
            label={t('tile.emailsSent')}
            value={formatCount(overview.emailsSent)}
            hint={t('tile.emailsSentHint', {
              firstTouch: formatCount(overview.firstTouchSent),
              followups: formatCount(overview.followupsSent),
            })}
          />
          <StatTile
            index={1}
            label={t('tile.replies')}
            value={formatCount(overview.repliesReceived)}
            hint={t('tile.repliesHint', { count: formatCount(overview.leadsReplied) })}
          />
          <StatTile
            index={2}
            label={t('tile.replyRate')}
            value={formatPercent(replyRate)}
            hint={t('tile.replyRateHint', { count: formatCount(overview.leadsContacted) })}
          />
          <StatTile
            index={3}
            label={t('tile.bounceRate')}
            value={formatPercent(bounceRate)}
            hint={t('tile.bounceRateHint', { count: formatCount(overview.emailsBounced) })}
          />
          <StatTile
            index={4}
            label={t('tile.sendFailures')}
            value={formatCount(overview.emailsFailed)}
            hint={t('tile.sendFailuresHint', { percent: formatPercent(failureRate) })}
          />
          <StatTile
            index={5}
            label={t('tile.activeSequences')}
            value={formatCount(overview.activeSequences)}
            hint={t('tile.activeSequencesHint')}
          />
        </div>
      </Section>

      <Section title={t('sectionPipeline')}>
        <div className={TILE_GRID}>
          <StatTile index={0} label={t('tile.leadsDiscovered')} value={formatCount(overview.leadsDiscovered)} />
          <StatTile
            index={1}
            label={t('tile.verifiedEmails')}
            value={formatCount(overview.leadsVerified)}
            hint={t('tile.verifiedEmailsHint', { percent: formatPercent(verifiedRate) })}
          />
          <StatTile index={2} label={t('tile.casesCreated')} value={formatCount(overview.casesCreated)} />
          <StatTile
            index={3}
            label={t('tile.suppressionsAdded')}
            value={formatCount(overview.suppressionsAdded)}
            hint={t('tile.suppressionsAddedHint')}
          />
        </div>
      </Section>

      <Section title={t('sectionDailyTrend')} aside={t('lastDaysShown', { count: Math.min(TREND_TABLE_DAYS, daily.length) })}>
        <div className="grid gap-3 md:grid-cols-3">
          <SparklineChart
            index={0}
            title={t('tile.emailsSent')}
            color="var(--status-contacted)"
            total={formatCount(overview.emailsSent)}
            values={daily.map((day) => day.emailsSent)}
          />
          <SparklineChart
            index={1}
            title={t('tile.replies')}
            color="var(--status-won)"
            total={formatCount(overview.repliesReceived)}
            values={daily.map((day) => day.repliesReceived)}
          />
          <SparklineChart
            index={2}
            title={t('tile.leadsDiscovered')}
            color="var(--status-ready)"
            total={formatCount(overview.leadsDiscovered)}
            values={daily.map((day) => day.leadsDiscovered)}
          />
        </div>

        {trendRows.length > 0 ? (
          <div className="border-hairline mt-1 overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="sr-only">{t('trendTable.caption')}</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('trendTable.day')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('trendTable.discovered')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('trendTable.sent')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('trendTable.replies')}</TableHead>
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

      <Section title={t('sectionCampaigns')}>
        {scopedCampaigns.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('campaignsTable.empty')}{' '}
            <Link href={scope.kind === 'client' ? `/clients/${scope.clientId}?tab=campaigns` : '/campaigns'} className="text-primary underline underline-offset-2">
              {t('campaignsTable.createOne')}
            </Link>
            .
          </p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('campaignsTable.campaign')}</TableHead>
                  <TableHead scope="col">{t('campaignsTable.status')}</TableHead>
                  {(
                    [
                      t('campaignsTable.discovered'),
                      t('campaignsTable.verified'),
                      t('campaignsTable.sent'),
                      t('campaignsTable.contacted'),
                      t('campaignsTable.replied'),
                      t('campaignsTable.replyRate'),
                      t('campaignsTable.inConversation'),
                      t('campaignsTable.hot'),
                      t('campaignsTable.won'),
                      t('campaignsTable.dead'),
                    ] as const
                  ).map((heading) => (
                    <TableHead key={heading} scope="col" className="text-right">
                      {heading}
                    </TableHead>
                  ))}
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

      <Section title={t('sectionMailboxes')}>
        {mailboxes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            {t('mailboxesTable.empty')}{' '}
            <Link href="/settings" className="text-primary underline underline-offset-2">
              {t('mailboxesTable.connectOne')}
            </Link>
            .
          </p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('mailboxesTable.mailbox')}</TableHead>
                  <TableHead scope="col">{t('mailboxesTable.provider')}</TableHead>
                  <TableHead scope="col">{t('mailboxesTable.health')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('mailboxesTable.today')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('mailboxesTable.capUsed')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('mailboxesTable.sentAllTime')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('mailboxesTable.bounceRate')}</TableHead>
                  <TableHead scope="col">{t('mailboxesTable.lastSend')}</TableHead>
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

      <Section title={t('sectionAgentActivity')} className="pb-4">
        {eventCounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">{t('activityTable.empty')}</p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">{t('activityTable.event')}</TableHead>
                  <TableHead scope="col" className="text-right">{t('activityTable.count')}</TableHead>
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
