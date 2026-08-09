import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { listActiveLeadsForCase, type LeadRow } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { getClientById, type ClientRow } from '@/lib/db/clients'
import { claimOutboundEmail, markEmailSent, markEmailFailed } from '@/lib/db/emails'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from './followup'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { appendSignatureBlock } from './signature'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
import { draftSchema, SUBJECT_TARGET_CHARS } from './draft-schema'

// Exported (not just module-scoped) so scripts/regenerate-sample-emails.ts can
// drive the exact same generation path against a historical row instead of
// duplicating the prompt-construction logic.
export const MAX_OUTPUT_TOKENS = 1_400
const ACTOR = 'email_writer_agent'

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

export type EmailStyle = Database['public']['Enums']['email_style']

// Shared between both system prompts below so subject-line formatting can
// never drift between styles.
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]

// Default voice — dossier-led, low-friction, no greeting. Used for every
// client unless email_style is explicitly set to 'formal_intro'.
export const CONCISE_SYSTEM_PROMPT = [
  'You write short, human-sounding B2B cold emails.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'One clear idea. 90 words or fewer.',
  'Use only facts present in the provided dossier. Never invent specifics.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
  'Lead with the specific dossier fact, not a greeting.',
  'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"),',
  'not the booking link. Only offer the booking link if it is clearly the natural next step —',
  'it is an optional extra, never the default ask.',
].join(' ')

// Formal introduction voice — a per-client opt-in (clients.email_style =
// 'formal_intro'), currently used only by Uniforms Fashion. See
// docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md
export const FORMAL_INTRO_SYSTEM_PROMPT = [
  'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any specific you were not given.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
  'Structure the body as exactly five short paragraphs, in this order:',
  '1. Greeting: "Dear [Recipient first name]," using the recipient\'s first name from the Recipient',
  'line below; if no name is given, use "Dear," alone.',
  '2. Self-introduction: one sentence giving the sender name and company name exactly as given in',
  '"Sender name" / "Our company name" below, plus the company\'s home base and years of experience —',
  'only the ones you have evidence for in "About our company"; drop whichever you don\'t have',
  'rather than guessing.',
  '3. Capabilities: one sentence on what the company manufactures or does, grounded in the value',
  'proposition and "About our company" below.',
  '4. Hook: one sentence connecting to this specific recipient — cite a real fact about their',
  'company or industry from the dossier. Never use a generic line like "I came across your',
  'company" or "I wanted to introduce ourselves" — the hook must trace to a dossier fact.',
  '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the',
  'kind of procurement or project relevant to their industry, followed by an offer to send the',
  'company profile, references, and product capabilities if so. Only mention the booking link',
  'here if it is clearly the natural next step; otherwise the offer to send materials is the',
  'entire ask.',
  'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any',
  'sign-off — a signature block is appended separately in code.',
  '120 words or fewer, including the greeting.',
].join(' ')

// Picks the system prompt for a client's configured voice. Falls back to
// CONCISE_SYSTEM_PROMPT for null/undefined so a missing client row never
// blocks first-touch generation.
export function selectSystemPrompt(emailStyle: EmailStyle | null | undefined): string {
  return emailStyle === 'formal_intro' ? FORMAL_INTRO_SYSTEM_PROMPT : CONCISE_SYSTEM_PROMPT
}

export function buildPrompt(
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  clientKnowledge: string,
  client: ClientRow | null,
): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
    client?.name ? `Our company name: ${client.name}` : '',
    client?.signature_name ? `Sender name: ${client.signature_name}` : '',
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
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
  clientKnowledge: string,
  client: ClientRow | null,
): Promise<'sent' | 'drafted' | 'skipped'> {
  if (!lead.email) return 'skipped'
  if (await isSuppressed(supabase, input.clientId, lead.email)) return 'skipped'

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: selectSystemPrompt(client?.email_style),
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge, client),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    // Straight-line generation, not a judgment call — pinning thinking to
    // 'minimal' keeps reasoning tokens from competing with MAX_OUTPUT_TOKENS
    // for the actual JSON payload (see .claude/roadmap.md 2026-08-08: the
    // model's default thinking budget was truncating output here, causing
    // intermittent "No object generated" failures).
    thinkingLevel: 'minimal',
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

  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: input.clientId,
    queryText: buildKnowledgeQueryText({ primary: dossierText, secondary: [input.valueProp ?? ''] }),
  })

  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    const outcome = await processLead(supabase, input, lead, knowledge, clientKnowledge, client)
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
