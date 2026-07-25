import type { Json } from '@/types/database'
import type { LogSeverity, LogSeverityFilter, LogSource } from '@/types/logs'
import { humanizeEnum } from '@/lib/format'
import type { StatusMeta } from './status'

export const LOG_SEVERITY_META: Record<LogSeverity, StatusMeta> = {
  info: { label: 'Info', color: 'var(--status-contacted)' },
  warn: { label: 'Warning', color: 'var(--status-hot-handoff)' },
  error: { label: 'Error', color: 'var(--status-lost)' },
}

export const LOG_SOURCE_META: Record<LogSource, StatusMeta> = {
  app: { label: 'App', color: 'var(--status-new)' },
  pipeline: { label: 'Pipeline', color: 'var(--status-researching)' },
  gemini: { label: 'Gemini', color: 'var(--status-ready)' },
  apollo: { label: 'Apollo', color: 'var(--status-contacted)' },
  brightdata: { label: 'BrightData', color: 'var(--status-in-conversation)' },
  mailbox: { label: 'Mailbox', color: 'var(--status-won)' },
  qstash: { label: 'QStash', color: 'var(--status-dead)' },
  db: { label: 'Database', color: 'var(--status-lost)' },
  emailable: { label: 'Emailable', color: 'var(--status-hot-handoff)' },
}

export const LOG_SEVERITY_FILTER_LABEL: Record<LogSeverityFilter, string> = {
  problems: 'Problems',
  errors: 'Errors',
  all: 'Everything',
}

// `payload` is `Json`, so every read has to narrow before indexing — a log row
// written by an older deploy may not carry the field a builder expects.
function readNumber(payload: Json, key: string): number {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 0
  const value = payload[key]
  return typeof value === 'number' ? value : 0
}

function readString(payload: Json, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm
}

/**
 * Turns one event row into the sentence an operator reads in the feed. Keyed by
 * event type so each row says what actually happened ("14 leads found") rather
 * than exposing a raw JSON payload.
 */
const SENTENCE_BUILDERS: Record<string, (payload: Json) => string> = {
  'pipeline.discover.completed': (p) => {
    const base = `Discovery run finished — ${readNumber(p, 'inserted')} leads found, ${readNumber(p, 'verified')} with a verified email.`
    const failedOpen = readNumber(p, 'emailableFailedOpen')
    if (failedOpen === 0) return base
    return `${base} ${failedOpen} activated without verification — the deliverability guard was unavailable.`
  },
  'pipeline.discover.failed': (p) =>
    `Discovery run failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.discover.group_lead_failed': (p) =>
    `Could not group a discovered lead into a company case: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.company_knowledge_failed': (p) =>
    `Could not save Apollo company info for a case: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.discover.route_failed': (p) =>
    `Discovery job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.research.completed': (p) =>
    `Research finished — ${readNumber(p, 'knowledgeCount')} dossier ${plural(readNumber(p, 'knowledgeCount'), 'fact', 'facts')} gathered, ${readNumber(p, 'agentsFailed')} ${plural(readNumber(p, 'agentsFailed'), 'agent', 'agents')} failed.`,
  'pipeline.research.agent_failed': (p) =>
    `A ${readString(p, 'role') ?? 'research'} agent failed (${readString(p, 'errorCode') ?? 'unknown'}).`,
  'pipeline.research.route_failed': (p) =>
    `Research job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.write.completed': (p) =>
    `Outreach written for ${readNumber(p, 'leadCount')} leads — ${readNumber(p, 'sent')} sent, ${readNumber(p, 'drafted')} left as a draft.`,
  'pipeline.write.route_failed': (p) =>
    `Write job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.followup.sent': (p) => `Follow-up ${readNumber(p, 'step')} sent.`,
  'pipeline.followup.exhausted': () => 'Follow-up sequence finished with no reply.',
  'pipeline.followup.completed_on_reply': () => 'Follow-up sequence stopped — the lead replied.',
  'pipeline.followup.route_failed': (p) =>
    `Follow-up job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'inbound.received': () => 'Inbound reply received.',
  'inbound.reply.route_failed': (p) =>
    `Reply handling crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'reply.answered': (p) => `Reply answered automatically (${readString(p, 'intent') ?? 'other'}).`,
  'reply.knowledge_gap': (p) =>
    `Reply escalated — the agent needs an answer: "${readString(p, 'question') ?? 'unknown question'}".`,
  'reply.knowledge_answered': () => 'Reply answered from an operator-supplied answer.',
  'reply.opt_out': () => 'Lead opted out — suppressed and sequence stopped.',
  'reply.price_handoff': () => 'Pricing question — handed off to a human and marked hot.',
  'llm.completed': (p) =>
    `Gemini call completed in ${readNumber(p, 'durationMs')}ms (${readNumber(p, 'promptTokens')} in / ${readNumber(p, 'completionTokens')} out tokens).`,
  'llm.failed': (p) =>
    `Gemini ${readString(p, 'operation') ?? 'call'} failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'apollo.search.failed': (p) =>
    `Apollo people search failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'apollo.enrich.failed': (p) =>
    `Apollo enrichment failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'emailable.verify.failed': (p) =>
    `Email verification failed for a lead at ${readString(p, 'domain') ?? 'an unknown domain'}: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'brightdata.search.failed': (p) =>
    `Web search failed for "${readString(p, 'query') ?? 'unknown query'}": ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'brightdata.scrape.failed': (p) =>
    `Page fetch failed for ${readString(p, 'url') ?? 'an unknown URL'}: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'mailbox.send.failed': (p) =>
    `Sending from a mailbox failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'mailbox.none_healthy': (p) =>
    `No healthy mailbox available — ${readNumber(p, 'mailboxCount')} configured, all capped or blocked.`,
  'mailbox.connected': () => 'Mailbox connected.',
}

export function describeEvent(type: string, payload: Json): string {
  const build = SENTENCE_BUILDERS[type]
  if (build) return build(payload)
  // Unmapped error rows still read well: logError always writes errorMessage.
  const message = readString(payload, 'errorMessage')
  if (message) return message
  return humanizeEnum(type.replace(/\./g, ' '))
}
