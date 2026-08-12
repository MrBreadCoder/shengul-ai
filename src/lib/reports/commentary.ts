import { z } from 'zod'
import type { OverviewMetrics } from '@/types/analytics'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'

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
  return sections.join('\n\n')
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
 * (spec §4). Returns 2 real highlights derived from the numbers rather than
 * an empty list, so the shape stays genuinely valid against
 * reportCommentarySchema's 2-4 minimum even though it's never re-validated
 * through it.
 */
export function buildFallbackCommentary(
  periodLabel: 'this week' | 'this month',
  overview: OverviewMetrics,
): ReportCommentary {
  return {
    headline: `${periodLabel === 'this week' ? 'Weekly' : 'Monthly'} performance summary`,
    summary: `${overview.leadsDiscovered} leads found, ${overview.emailsSent} emails sent, ${overview.repliesReceived} replies received.`,
    highlights: [
      `${overview.leadsDiscovered} leads discovered`,
      `${overview.emailsSent} emails sent, ${overview.repliesReceived} replies received`,
    ],
  }
}
