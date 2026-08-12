import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getWeeklyPeriod, getMonthlyPeriod } from './period'
import { buildReportMetrics } from './metrics'
import { generateReportCommentary, buildFallbackCommentary } from './commentary'
import { pickTemplate, renderTemplate, type ReportEmailTemplateInput } from './email-templates'
import { sendReportEmail } from './mailer'
import {
  upsertReport,
  getPreviousReport,
  countPriorReportsForClient,
  insertReportDelivery,
  type ReportRow,
} from '@/lib/db/reports'
import { getClientById, listClientRoleAppUsersForClient } from '@/lib/db/clients'
import { getAuthUserEmails } from '@/lib/supabase/auth-admin'
import { reportMetricsSnapshotSchema } from '@/types/reports'
import { AppError } from '@/lib/errors/app-error'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { env } from '@/lib/env'

export interface GenerateReportInput {
  clientId: string
  type: 'weekly' | 'monthly'
  now: Date
}

const ACTOR = 'reports_generate'

function reportUrlFor(reportId: string): string {
  return new URL(`/reports/${reportId}`, env.APP_URL).toString()
}

/**
 * The full generate -> commentary -> send pipeline for one client/type/
 * period. Called by /api/pipeline/reports-generate (one QStash message per
 * client). See docs/superpowers/specs/2026-08-12-reports-design.md §2
 * "Generation flow" for the numbered step-by-step this mirrors exactly.
 */
export async function generateReport(
  admin: SupabaseClient<Database>,
  input: GenerateReportInput,
): Promise<ReportRow> {
  const client = await getClientById(admin, input.clientId)
  if (!client) {
    throw new AppError('NOT_FOUND', 'Client not found for report generation', { clientId: input.clientId })
  }

  const period = input.type === 'weekly' ? getWeeklyPeriod(input.now) : getMonthlyPeriod(input.now)

  let report = await upsertReport(admin, {
    clientId: input.clientId,
    type: input.type,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    status: 'generating',
  })

  const metrics = await buildReportMetrics(admin, {
    clientId: input.clientId,
    type: input.type,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
  })
  const validatedMetrics = reportMetricsSnapshotSchema.parse(metrics)

  const previousReport = await getPreviousReport(admin, {
    clientId: input.clientId,
    type: input.type,
    beforePeriodStart: period.periodStart,
  })
  const previousOverview = previousReport
    ? reportMetricsSnapshotSchema.parse(previousReport.metrics).overview
    : null

  let commentary
  try {
    commentary = await generateReportCommentary(
      { clientId: input.clientId, actor: ACTOR },
      {
        clientName: client.name,
        type: input.type,
        periodLabel: period.periodLabel,
        current: validatedMetrics.overview,
        previous: previousOverview,
      },
    )
  } catch (cause) {
    await logError({
      clientId: input.clientId,
      actor: ACTOR,
      type: 'reports.commentary_failed',
      source: 'gemini',
      error: cause,
      payload: { reportType: input.type },
    })
    commentary = buildFallbackCommentary(period.periodLabel, validatedMetrics.overview)
  }

  report = await upsertReport(admin, {
    clientId: input.clientId,
    type: input.type,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    metrics: validatedMetrics,
    aiHeadline: commentary.headline,
    aiSummary: commentary.summary,
    aiHighlights: commentary.highlights,
    status: 'ready',
  })

  const clientUsers = await listClientRoleAppUsersForClient(admin, input.clientId)
  const recipients = await getAuthUserEmails(admin, clientUsers.map((user) => user.id))

  if (recipients.length === 0) {
    await logEventSafe({
      clientId: input.clientId,
      actor: ACTOR,
      type: 'reports.no_recipients',
      payload: { reportId: report.id, reportType: input.type },
    })
    return report
  }

  const priorCount = await countPriorReportsForClient(admin, input.clientId)
  const template = pickTemplate(priorCount)
  const templateInput: ReportEmailTemplateInput = {
    clientName: client.name,
    periodLabel: period.periodLabel,
    leadsFound: validatedMetrics.overview.leadsDiscovered,
    emailsSent: validatedMetrics.overview.emailsSent,
    repliesReceived: validatedMetrics.overview.repliesReceived,
    reportUrl: reportUrlFor(report.id),
  }
  const rendered = renderTemplate(template, templateInput)

  let sentCount = 0
  for (const recipient of recipients) {
    try {
      await sendReportEmail({ to: recipient.email, subject: rendered.subject, text: rendered.text, html: rendered.html })
      await insertReportDelivery(admin, {
        clientId: input.clientId,
        reportId: report.id,
        appUserId: recipient.userId,
        email: recipient.email,
        status: 'sent',
        error: null,
        sentAt: new Date().toISOString(),
      })
      sentCount += 1
    } catch (cause) {
      const message = cause instanceof AppError ? cause.message : String(cause)
      await insertReportDelivery(admin, {
        clientId: input.clientId,
        reportId: report.id,
        appUserId: recipient.userId,
        email: recipient.email,
        status: 'failed',
        error: message,
        sentAt: null,
      })
    }
  }

  report = await upsertReport(admin, {
    clientId: input.clientId,
    type: input.type,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    status: sentCount > 0 ? 'sent' : 'send_failed',
  })

  await logEventSafe({
    clientId: input.clientId,
    actor: ACTOR,
    type: 'reports.generated',
    payload: { reportId: report.id, reportType: input.type, recipientCount: recipients.length, sentCount },
  })

  return report
}
