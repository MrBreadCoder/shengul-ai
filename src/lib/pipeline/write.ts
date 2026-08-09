import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { listActiveLeadsForCase, type LeadRow } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { getClientById, type ClientRow } from '@/lib/db/clients'
import { getEmailStyleById, getDefaultEmailStyle } from '@/lib/db/email-styles'
import { claimOutboundEmail, markEmailSent, markEmailFailed } from '@/lib/db/emails'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext, EMAIL_WRITER_MODEL_ID } from '@/lib/llm/client'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from './followup'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { appendSignatureBlock } from './signature'
import { logEventSafe } from '@/lib/events/log-event'
import { draftSchema, SUBJECT_TARGET_CHARS } from './draft-schema'

// Exported (not just module-scoped) so scripts/regenerate-sample-emails.ts can
// drive the exact same generation path against a historical row instead of
// duplicating the prompt-construction logic.
// Bumped alongside the 'medium' thinking level below (matching reply.ts's
// identically-sized classificationSchema at the same budget) so extra
// reasoning tokens don't starve the actual subject/body output.
export const MAX_OUTPUT_TOKENS = 1_600
// The added 'medium' thinking budget can push a single call past the
// client's 20s default (see reply.ts's identical CLASSIFY_TIMEOUT_MS).
const GENERATE_TIMEOUT_MS = 30_000
const ACTOR = 'email_writer_agent'

// Re-exported so scripts/regenerate-sample-emails.ts and
// scripts/rewrite-draft-emails.ts (which drive this exact generation path
// against historical/draft rows) default to the same model write.ts
// actually uses, without duplicating the constant. Defined once in
// src/lib/llm/client.ts — every email-writing pipeline stage
// (followup.ts, redesign.ts, reply.ts, knowledge-answer.ts) imports it
// from there directly.
export { EMAIL_WRITER_MODEL_ID }

export type ReplyMode = Database['public']['Enums']['reply_mode']

export interface RunWriteInput {
  clientId: string
  campaignId: string
  caseId: string
  replyMode: ReplyMode
  valueProp: string | null
  bookingLink: string | null
  mailboxIds: string[]
  companyName: string
}

export interface WriteSummary {
  caseId: string
  drafted: number
  sent: number
}

// Lower number = surfaced first in the dossier text handed to the model. A
// (pain_point) or (news) fact makes a far sharper personalization hook than
// a bare (company) firmographic line (industry/size/founding year/location)
// — putting the sharpest facts first means the model reaches for them before
// it ever gets to the generic ones, regardless of how well it follows the
// prioritization instruction in FORMAL_INTRO_SYSTEM_PROMPT's hook beat.
const DOSSIER_KIND_PRIORITY: Record<Database['public']['Enums']['knowledge_kind'], number> = {
  pain_point: 0,
  news: 1,
  answer: 2,
  person: 3,
  company: 4,
}

// Shared across every style's system prompt so subject-line formatting can
// never drift between them.
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]

// Always true regardless of which email_styles row a client is on — never
// something an operator-authored style's voice_instructions can opt out of.
// This is the entire trust boundary between "operator picks the voice and
// structure" and "operator can break compliance": subject formatting,
// English-only output, no bulk-sender markers, and dossier-grounded facts
// all live here, in code, never in a database row a non-engineer edits. See
// docs/superpowers/specs/2026-08-09-editable-email-styles-design.md
const FIXED_GUARDRAILS = [
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any other specific you were not given.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
].join(' ')

// Combines the fixed guardrails above with a style's operator-authored voice
// text (email_styles.voice_instructions). The only place style text touches
// the system prompt — kept pure so it's trivial to unit test.
export function buildSystemPrompt(voiceInstructions: string): string {
  return `${FIXED_GUARDRAILS} ${voiceInstructions}`
}

export function buildPrompt(
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  client: ClientRow | null,
): string {
  const sortedKnowledge = [...knowledge].sort((a, b) => DOSSIER_KIND_PRIORITY[a.kind] - DOSSIER_KIND_PRIORITY[b.kind])
  const dossier = sortedKnowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
    client?.name ? `Our company name: ${client.name}` : '',
    client?.signature_name ? `Sender name: ${client.signature_name}` : '',
    client?.company_info ? `About our company:\n${client.company_info}` : '',
    input.bookingLink ? `Booking link (optional CTA): ${input.bookingLink}` : '',
    `Dossier:\n${dossier}`,
    'Write the first-touch email. Return a subject and a body.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// auto_send and hybrid both send first-touch immediately (hybrid only diverges
// on replies, per .claude/architecture.md §6 Stage 4). human_approve leaves a draft.
function shouldSendFirstTouch(replyMode: ReplyMode): boolean {
  return replyMode === 'auto_send' || replyMode === 'hybrid'
}

async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  client: ClientRow | null,
): Promise<'sent' | 'drafted' | 'skipped'> {
  if (!lead.email) return 'skipped'
  if (await isSuppressed(supabase, input.clientId, lead.email)) return 'skipped'

  // Resolves the client's configured voice, falling back to the DB-wide
  // default whenever the client has none set (or has no row at all) — same
  // "missing client row never blocks generation" guarantee the old
  // selectSystemPrompt(undefined) fallback provided.
  const clientStyle = client?.email_style_id ? await getEmailStyleById(supabase, client.email_style_id) : null
  const style = clientStyle ?? (await getDefaultEmailStyle(supabase))

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: buildSystemPrompt(style.voice_instructions),
    prompt: buildPrompt(input, lead, knowledge, client),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: GENERATE_TIMEOUT_MS,
    modelId: EMAIL_WRITER_MODEL_ID,
    // Deciding what to lead with and how to phrase a first-touch email is a
    // judgment call worth the extra reasoning (see .claude/roadmap.md
    // 2026-08-09) — 'medium' matches reply.ts's classifyReply, which already
    // proved this thinking level stays within a 1,600-token ceiling without
    // truncating the JSON payload (the 2026-08-08 "No object generated"
    // failures traced to 'minimal'/omitted thinkingLevel plus too tight a
    // budget, not to 'medium' itself).
    thinkingLevel: 'medium',
  })

  // Deterministic — never left to the model's discretion. Appended here,
  // before the claim, so both a sent email and a human_approve draft carry it.
  const signedBody = appendSignatureBlock(draft.body, {
    companyName: client?.name ?? '',
    signatureName: client?.signature_name ?? null,
    signatureTitle: client?.signature_title ?? null,
    phone: client?.phone ?? null,
    address: client?.address ?? null,
    domain: client?.domain ?? null,
  })

  // Claim the (lead, step 0, outbound) slot BEFORE sending — a retry that finds
  // the slot taken returns null and we never double-send.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: lead.id,
    direction: 'outbound',
    subject: draft.subject,
    body: signedBody,
    status: shouldSendFirstTouch(input.replyMode) ? 'queued' : 'draft',
    sequence_step: FIRST_TOUCH_STEP,
  })
  if (!claimed) return 'skipped'

  if (!shouldSendFirstTouch(input.replyMode)) return 'drafted'

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: input.clientId,
      mailboxIds: input.mailboxIds,
      to: lead.email,
      subject: draft.subject,
      body: signedBody,
      purpose: 'outreach',
    })
  } catch (error) {
    // Only a delivery failure means the email was never sent — mark it failed.
    // A failure in the bookkeeping below means the message already went out
    // and must not be treated as a send failure.
    await markEmailFailed(supabase, claimed.id)
    if (error instanceof AppError && error.code === 'RATE_LIMITED') return 'skipped'
    throw error
  }

  await markEmailSent(supabase, claimed.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })
  await scheduleFirstFollowup(supabase, {
    clientId: input.clientId,
    caseId: input.caseId,
    leadId: lead.id,
  })
  return 'sent'
}

export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)
  const client = await getClientById(supabase, input.clientId)

  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    const outcome = await processLead(supabase, input, lead, knowledge, client)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
  }

  await updateCaseStatus(supabase, input.caseId, 'contacted')
  await enqueueCrmSync(input.caseId, 'contacted')
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.write.completed',
    payload: { caseId: input.caseId, sent, drafted, leadCount: leads.length },
  })
  return { caseId: input.caseId, drafted, sent }
}
