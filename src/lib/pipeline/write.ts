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

const MAX_OUTPUT_TOKENS = 1_400
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

const SYSTEM_PROMPT = [
  'You write short, human-sounding B2B cold emails.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'One clear idea. 90 words or fewer.',
  'Use only facts present in the provided dossier. Never invent specifics.',
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
  HUMAN_VOICE_INSTRUCTION,
  'Lead with the specific dossier fact, not a greeting.',
  'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"),',
  'not the booking link. Only offer the booking link if it is clearly the natural next step —',
  'it is an optional extra, never the default ask.',
].join(' ')

function buildPrompt(input: RunWriteInput, lead: LeadRow, knowledge: KnowledgeRow[], clientKnowledge: string): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
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
    instructions: SYSTEM_PROMPT,
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
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
