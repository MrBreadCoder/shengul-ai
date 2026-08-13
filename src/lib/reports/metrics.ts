import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getOverviewMetrics, getDailyMetrics } from '@/lib/db/analytics'
import { listWeeklyReportsInRange } from '@/lib/db/reports'
import { getClientById } from '@/lib/db/clients'
import { listMailreachConnectedMailboxes } from '@/lib/db/mailboxes'
import { summarizeMailboxWarmup } from '@/lib/mailbox/mailreach-gate'
import { reportMetricsSnapshotSchema, type ReportMetricsSnapshot } from '@/types/reports'

export interface BuildReportMetricsInput {
  clientId: string
  type: 'weekly' | 'monthly'
  periodStart: string
  periodEnd: string
  now: Date
}

// Aggregates across the client's whole account — campaignId: null — no
// per-campaign breakdown in v1 (spec §3, YAGNI: /analytics already owns
// that drill-down).
export async function buildReportMetrics(
  supabase: SupabaseClient<Database>,
  input: BuildReportMetricsInput,
): Promise<ReportMetricsSnapshot> {
  const range = { from: input.periodStart, to: input.periodEnd, campaignId: null, clientId: input.clientId }
  const [overview, daily, client, mailreachMailboxes] = await Promise.all([
    getOverviewMetrics(supabase, range),
    getDailyMetrics(supabase, range),
    getClientById(supabase, input.clientId),
    listMailreachConnectedMailboxes(supabase, input.clientId),
  ])
  const warmupSummary = summarizeMailboxWarmup(mailreachMailboxes, client?.mailreach_enabled ?? false, input.now)
  const warmup = warmupSummary.length > 0 ? warmupSummary : undefined

  if (input.type !== 'monthly') {
    return { overview, daily, warmup }
  }

  const weeklyReports = await listWeeklyReportsInRange(supabase, {
    clientId: input.clientId,
    from: input.periodStart,
    to: input.periodEnd,
  })
  return {
    overview,
    daily,
    warmup,
    // Copied from each weekly report's own frozen snapshot, not
    // recomputed — a monthly report must always agree exactly with the
    // weekly reports it recaps (spec §3).
    weeklyBreakdown: weeklyReports.map((report) => {
      const weeklyMetrics = reportMetricsSnapshotSchema.parse(report.metrics)
      return {
        reportId: report.id,
        periodStart: report.period_start,
        periodEnd: report.period_end,
        overview: weeklyMetrics.overview,
      }
    }),
  }
}
