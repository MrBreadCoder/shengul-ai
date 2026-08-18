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
  crm: { label: 'CRM', color: 'var(--status-in-conversation)' },
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

// BrightData failures log the vendor's own status/response body separately
// from `errorMessage` (see externalErrorDetails in research/tools.ts) since
// `errorMessage` alone collapses every 4xx to the same generic "HTTP 400" —
// this appends the actual reason so an operator doesn't have to read source
// to diagnose it.
function vendorDetailSuffix(payload: Json): string {
  const status = readNumber(payload, 'status')
  const detail = readString(payload, 'body') ?? readString(payload, 'cause')
  if (!detail) return ''
  return ` (${status > 0 ? `HTTP ${status}: ` : ''}${detail})`
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
    `Web search failed for "${readString(p, 'query') ?? 'unknown query'}": ${readString(p, 'errorMessage') ?? 'unknown error'}${vendorDetailSuffix(p)}.`,
  'brightdata.scrape.failed': (p) =>
    `Page fetch failed for ${readString(p, 'url') ?? 'an unknown URL'}: ${readString(p, 'errorMessage') ?? 'unknown error'}${vendorDetailSuffix(p)}.`,
  'mailbox.send.failed': (p) =>
    `Sending from a mailbox failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'mailbox.none_healthy': (p) => {
    const total = readNumber(p, 'mailboxCount')
    const gated = readNumber(p, 'warmupGatedCount')
    if (gated > 0 && gated === total) {
      return `No healthy mailbox available — all ${total} configured mailboxes still in Mailreach warmup.`
    }
    if (gated > 0) {
      return `No healthy mailbox available — ${total} configured, ${gated} still warming up, the rest capped or blocked.`
    }
    return `No healthy mailbox available — ${total} configured, all capped or blocked.`
  },
  'mailbox.connected': () => 'Mailbox connected.',
  // `serverResponse` is the mail host's own reply text (e.g. an SMTP 535
  // banner) — the actual diagnostic, and worth more than the generic
  // `errorMessage` every logWarn call also carries. Falls back to it only
  // when the server never returned one (a timeout or a connection failure).
  'mailbox.connect_failed': (p) => {
    const stage = readString(p, 'stage')
    const leg = stage ? ` on the ${stage === 'smtp' ? 'sending (SMTP)' : 'reading (IMAP)'} server` : ''
    const reason = readString(p, 'serverResponse') ?? readString(p, 'errorMessage') ?? 'unknown error'
    return `Mailbox connect failed${leg}: ${reason}.`
  },
  // Failure moved past mail-server verification into our own backend.
  // `dbError` is the raw Postgres message (e.g. a unique/foreign-key
  // violation) — the actual reason, versus the generic AppError message
  // ("Failed to insert mailbox") every DB failure produces. `mailboxId`
  // present means the row was actually created and only a step after it
  // (the audit log) failed — worth calling out, since that needs a
  // different fix than a genuine insert failure.
  'mailbox.connect_error': (p) => {
    const stage = readString(p, 'stage')
    const reason = readString(p, 'dbError') ?? readString(p, 'errorMessage') ?? 'unknown error'
    const mailboxId = readString(p, 'mailboxId')
    if (stage === 'post_insert' && mailboxId) {
      return `Mailbox row ${mailboxId} was created, but finishing the connection failed: ${reason}.`
    }
    if (stage === 'resolve_client') {
      return `Could not determine which client to attach the mailbox to: ${reason}.`
    }
    return `Could not save the mailbox: ${reason}.`
  },
}

export function describeEvent(type: string, payload: Json): string {
  const build = SENTENCE_BUILDERS[type]
  if (build) return build(payload)
  // Unmapped error rows still read well: logError always writes errorMessage.
  const message = readString(payload, 'errorMessage')
  if (message) return message
  return humanizeEnum(type.replace(/\./g, ' '))
}
