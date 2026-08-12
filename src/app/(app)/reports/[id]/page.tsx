import type { Metadata } from 'next'
import { redirect, notFound } from 'next/navigation'
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getReportById } from '@/lib/db/reports'
import { reportMetricsSnapshotSchema } from '@/types/reports'
import { PageHeader } from '@/components/page-header'
import { StatTile } from '@/components/stat-tile'
import { ReportChart } from '@/components/report-chart'
import { formatCount } from '@/lib/analytics/rates'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Report' }

function formatPeriodDate(iso: string): string {
  return iso.slice(0, 10)
}

export default async function ReportDetailPage({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    redirect('/crm')
  }

  const { id } = await params
  const supabase = await createServerClient()
  const t = await getTranslations('reports')
  const report = await getReportById(supabase, id)
  // A 'generating' or 'send_failed' report is not shown — same rule as the
  // list page (Task 15); this also guards against ever Zod-parsing the
  // migration's placeholder '{}' metrics default, which would throw.
  if (!report || (report.status !== 'ready' && report.status !== 'sent')) {
    notFound()
  }

  const metrics = reportMetricsSnapshotSchema.parse(report.metrics)
  const dailyLabels = metrics.daily.map((day) => day.day.slice(5))

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title={report.type === 'monthly' ? t('typeMonthly') : t('typeWeekly')}
        description={`${formatPeriodDate(report.period_start)} – ${formatPeriodDate(report.period_end)}`}
      />

      <div className="grid gap-3 sm:grid-cols-3">
        <StatTile index={0} label={t('tile.leadsFound')} value={formatCount(metrics.overview.leadsDiscovered)} />
        <StatTile index={1} label={t('tile.emailsSent')} value={formatCount(metrics.overview.emailsSent)} />
        <StatTile index={2} label={t('tile.replies')} value={formatCount(metrics.overview.repliesReceived)} />
      </div>

      <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">{t('aiSummaryLabel')}</p>
        <h2 className="mt-2 text-lg font-semibold">{report.ai_headline}</h2>
        <p className="text-muted-foreground mt-2 text-sm leading-relaxed">{report.ai_summary}</p>
        {report.ai_highlights.length > 0 ? (
          <ul className="mt-4 flex flex-col gap-1.5">
            {report.ai_highlights.map((highlight) => (
              <li key={highlight} className="flex items-start gap-2 text-sm">
                <span className="text-faint mt-1.5 block h-1 w-1 shrink-0 rounded-full bg-current" aria-hidden />
                {highlight}
              </li>
            ))}
          </ul>
        ) : null}
      </div>

      <ReportChart
        title={t('activityTrend')}
        emptyLabel={t('activityTrendEmpty')}
        xLabels={dailyLabels}
        series={[
          { label: t('tile.leadsFound'), color: 'var(--chart-1)', values: metrics.daily.map((d) => d.leadsDiscovered) },
          { label: t('tile.emailsSent'), color: 'var(--chart-2)', values: metrics.daily.map((d) => d.emailsSent) },
          { label: t('tile.replies'), color: 'var(--chart-3)', values: metrics.daily.map((d) => d.repliesReceived) },
        ]}
      />

      {metrics.weeklyBreakdown && metrics.weeklyBreakdown.length > 0 ? (
        <div className="border-hairline bg-surface animate-rise overflow-hidden rounded-lg border">
          <p className="border-hairline border-b px-4 py-3 text-sm font-medium">{t('weeklyRecap')}</p>
          <div className="divide-hairline flex flex-col divide-y">
            {metrics.weeklyBreakdown.map((week) => (
              <Link
                key={week.reportId}
                href={`/reports/${week.reportId}`}
                className="hover:bg-accent/40 flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200"
              >
                <span className="tnum text-muted-foreground">
                  {formatPeriodDate(week.periodStart)} – {formatPeriodDate(week.periodEnd)}
                </span>
                <span className="tnum text-xs">{t('weeklyRecapStat', { count: formatCount(week.overview.leadsDiscovered) })}</span>
              </Link>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  )
}
