import { z } from 'zod'
import type { OverviewMetrics, DailyMetric } from './analytics'

const overviewMetricsSchema = z.object({
  leadsDiscovered: z.number().int().nonnegative(),
  leadsVerified: z.number().int().nonnegative(),
  casesCreated: z.number().int().nonnegative(),
  emailsSent: z.number().int().nonnegative(),
  firstTouchSent: z.number().int().nonnegative(),
  followupsSent: z.number().int().nonnegative(),
  emailsBounced: z.number().int().nonnegative(),
  emailsFailed: z.number().int().nonnegative(),
  repliesReceived: z.number().int().nonnegative(),
  leadsContacted: z.number().int().nonnegative(),
  leadsReplied: z.number().int().nonnegative(),
  suppressionsAdded: z.number().int().nonnegative(),
  activeSequences: z.number().int().nonnegative(),
}) satisfies z.ZodType<OverviewMetrics>

const dailyMetricSchema = z.object({
  day: z.string(),
  leadsDiscovered: z.number().int().nonnegative(),
  emailsSent: z.number().int().nonnegative(),
  repliesReceived: z.number().int().nonnegative(),
}) satisfies z.ZodType<DailyMetric>

export const reportMetricsSnapshotSchema = z.object({
  overview: overviewMetricsSchema,
  daily: z.array(dailyMetricSchema),
  // Present only when the parent report's type is 'monthly' — see
  // lib/reports/metrics.ts.
  weeklyBreakdown: z
    .array(
      z.object({
        reportId: z.string().uuid(),
        periodStart: z.string(),
        periodEnd: z.string(),
        overview: overviewMetricsSchema,
      }),
    )
    .optional(),
})

export type ReportMetricsSnapshot = z.infer<typeof reportMetricsSnapshotSchema>
