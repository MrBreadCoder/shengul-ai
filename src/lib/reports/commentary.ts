import { z } from 'zod'
import type { OverviewMetrics } from '@/types/analytics'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { closestToReady, totalMessagesExchanged, type MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

const reportCommentarySchema = z.object({
  headline: z.string().min(1).max(80),
  summary: z.string().min(1).max(600),
  highlights: z.array(z.string().min(1).max(140)).min(2).max(4),
})

export type ReportCommentary = z.infer<typeof reportCommentarySchema>

export interface GenerateReportCommentaryInput {
  clientName: string
  type: 'weekly' | 'monthly'
  periodLabel: 'this week' | 'this month'
  current: OverviewMetrics
  previous: OverviewMetrics | null
  warmup: MailboxWarmupInfo[]
}

const MAX_OUTPUT_TOKENS = 500
// Grounded numeric summarization, not judgment-heavy research/reply
// triage — stays on the lighter thinking level those tasks earn 'medium'/
// 'high' for (see lib/llm/client.ts's ThinkingLevel doc comment).
const THINKING_LEVEL = 'low' as const

const INSTRUCTIONS =
  'You write a short, grounded performance summary for a B2B cold-outreach client dashboard. ' +
  'Use only the numbers given to you — never invent a trend, percentage, or fact not derivable from them. ' +
  'If no comparison period is given, describe the period on its own terms without inventing a delta. ' +
  'If the client has mailboxes still in Mailreach warmup and outreach numbers are low as a result, prioritize ' +
  'describing the warmup progress (days remaining, reputation trend) over dwelling on low lead/email counts — ' +
  'this is expected and positive, not a shortfall. If outreach numbers are healthy, mention warmup progress only ' +
  'briefly, as a secondary note. ' +
  'Tone: plain, confident, specific — like a knowledgeable colleague, not a marketing summary.'

function formatMetricsBlock(label: string, metrics: OverviewMetrics): string {
  return (
    `${label}:\n` +
    `- Leads discovered: ${metrics.leadsDiscovered}\n` +
    `- Emails sent: ${metrics.emailsSent} (first touch ${metrics.firstTouchSent}, follow-ups ${metrics.followupsSent})\n` +
    `- Replies received: ${metrics.repliesReceived}\n` +
    `- Bounced: ${metrics.emailsBounced}, failed: ${metrics.emailsFailed}\n` +
    `- Cases created: ${metrics.casesCreated}\n` +
    `- Active sequences: ${metrics.activeSequences}`
  )
}

function formatWarmupBlock(warmup: MailboxWarmupInfo[]): string {
  const gated = warmup.filter((w) => w.isGated)
  if (gated.length === 0) return ''
  const scores = gated.map((w) => w.reputationScore).filter((s): s is number => s !== null)
  return (
    `\n\nMailbox warmup in progress:\n` +
    `- ${gated.length} of ${warmup.length} connected mailboxes still building sending reputation\n` +
    gated.map((w) => `  - Day ${w.dayNumber} of ${w.gateDays}`).join('\n') +
    (scores.length > 0 ? `\n- Reputation scores so far: ${scores.join(', ')}` : '') +
    `\n- Messages exchanged as part of warmup: ${totalMessagesExchanged(gated)}`
  )
}

function buildPrompt(input: GenerateReportCommentaryInput): string {
  const sections = [
    `Client: ${input.clientName}`,
    `Report type: ${input.type}, covering ${input.periodLabel}.`,
    formatMetricsBlock('Current period', input.current),
  ]
  if (input.previous) {
    sections.push(formatMetricsBlock('Previous period', input.previous))
  } else {
    sections.push('No previous period exists yet — this is the first report of this type for this client.')
  }
  return sections.join('\n\n') + formatWarmupBlock(input.warmup)
}

export async function generateReportCommentary(
  context: LlmCallContext,
  input: GenerateReportCommentaryInput,
): Promise<ReportCommentary> {
  return generateJson(context, {
    instructions: INSTRUCTIONS,
    prompt: buildPrompt(input),
    schema: reportCommentarySchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingLevel: THINKING_LEVEL,
  })
}

/**
 * Deterministic stand-in for a failed generateReportCommentary call — a
 * Gemini hiccup must never block a report from generating and sending
 * (spec §4). When there were zero sends this period and at least one
 * mailbox is still gated, leads with warmup progress instead of a flat "0
 * leads found" — the actual problem this feature exists to fix. Otherwise
 * falls back to 2 real highlights derived from the numbers, same as before.
 */
export function buildFallbackCommentary(
  periodLabel: 'this week' | 'this month',
  overview: OverviewMetrics,
  warmup: MailboxWarmupInfo[],
): ReportCommentary {
  const gated = warmup.filter((w) => w.isGated)
  if (overview.emailsSent === 0 && gated.length > 0) {
    const closest = closestToReady(gated)
    if (closest) {
      return {
        headline: 'Building your sending reputation',
        summary:
          `${gated.length} mailbox${gated.length === 1 ? '' : 'es'} still warming up with Mailreach — ` +
          `the closest is on day ${closest.dayNumber} of ${closest.gateDays}. ` +
          `Outreach begins automatically once warmup clears.`,
        highlights: [
          `Day ${closest.dayNumber} of ${closest.gateDays} for the closest mailbox`,
          closest.reputationScore !== null
            ? `Reputation score: ${closest.reputationScore}`
            : `${gated.length} mailbox${gated.length === 1 ? '' : 'es'} warming up`,
        ],
      }
    }
  }
  return {
    headline: `${periodLabel === 'this week' ? 'Weekly' : 'Monthly'} performance summary`,
    summary: `${overview.leadsDiscovered} leads found, ${overview.emailsSent} emails sent, ${overview.repliesReceived} replies received.`,
    highlights: [
      `${overview.leadsDiscovered} leads discovered`,
      `${overview.emailsSent} emails sent, ${overview.repliesReceived} replies received`,
    ],
  }
}
