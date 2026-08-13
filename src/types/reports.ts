import { z } from 'zod'
import type { OverviewMetrics, DailyMetric } from './analytics'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

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

const mailboxWarmupSchema = z.object({
  mailboxId: z.string().uuid(),
  emailAddress: z.string(),
  elapsedDays: z.number().int().nonnegative(),
  gateDays: z.number().int().positive(),
  isGated: z.boolean(),
  reputationScore: z.number().nullable(),
  totalMessagesSent: z.number().int().nonnegative().nullable(),
  totalMessagesReceived: z.number().int().nonnegative().nullable(),
  totalSpam: z.number().int().nonnegative().nullable(),
  currentConversations: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<MailboxWarmupInfo>

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
  // Present only when the client has ≥1 Mailreach-enrolled, connected
  // mailbox at generation time. Frozen like weeklyBreakdown — the report
  // stays historically accurate even after the gate later clears.
  warmup: z.array(mailboxWarmupSchema).optional(),
})

export type ReportMetricsSnapshot = z.infer<typeof reportMetricsSnapshotSchema>
