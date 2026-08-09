import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { getEmailById, listThreadEmails, type EmailRow } from '@/lib/db/emails'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { generateJson, type LlmCallContext, EMAIL_WRITER_MODEL_ID } from '@/lib/llm/client'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
import { draftSchema, type Draft } from './draft-schema'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'

const MAX_OUTPUT_TOKENS = 1_400
const ACTOR = 'email_redesign_agent'

const SYSTEM_PROMPT = [
  'You are revising an existing B2B cold email draft per an operator instruction.',
  'Always write in English, even if the dossier, thread, or instruction below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language. One clear idea.',
  '90 words or fewer.',
  'Use ONLY facts present in the dossier/thread below. Never invent a new fact, even',
  'if the instruction implies one — if the instruction asks for something the dossier',
  'does not support, do the best you can within it and leave that part out rather',
  'than inventing it.',
  HUMAN_VOICE_INSTRUCTION,
  'If the draft is a reply within an existing thread, keep the subject prefixed with',
  '"Re: " unless the instruction explicitly asks to change it.',
  'Return the full revised subject and body — not a diff, not commentary about the change.',
].join(' ')

export interface RegenerateDraftInput {
  emailId: string
  instruction: string
}

function buildPrompt(
  email: EmailRow,
  instruction: string,
  knowledge: KnowledgeRow[],
  clientKnowledge: string,
  thread: EmailRow[] | null,
): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const threadText = thread
    ? thread.map((e) => `[${e.direction}] ${e.subject ?? ''}\n${e.body ?? ''}`).join('\n---\n')
    : ''
  return [
    `Current subject: ${email.subject ?? '(none)'}`,
    `Current body:\n${email.body ?? '(none)'}`,
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    threadText ? `Prior thread:\n${threadText}` : '',
    `Operator instruction: ${instruction}`,
    'Rewrite the subject and body following the instruction.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// Rewrites a queued draft per an operator's freeform instruction, re-grounded
// in the same case dossier (and, for a reply draft, the prior thread) the
// original draft used — never a blind rewrite of just the current text. Does
// NOT write to the DB; the caller (inbox actions.ts) persists the result
// through updateDraftContent, the same write path a manual Save uses.
export async function regenerateDraftContent(
  supabase: SupabaseClient<Database>,
  input: RegenerateDraftInput,
): Promise<Draft> {
  const email = await getEmailById(supabase, input.emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not a redesignable draft', { emailId: input.emailId })
  }
  if (!email.case_id || !email.lead_id) {
    throw new AppError('VALIDATION_ERROR', 'Draft is missing required fields', { emailId: input.emailId })
  }

  const isReply = email.in_reply_to_email_id !== null
  const [knowledge, thread] = await Promise.all([
    listKnowledgeForCase(supabase, email.case_id),
    isReply ? listThreadEmails(supabase, email.lead_id) : Promise.resolve(null),
  ])

  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: email.client_id,
    queryText: buildKnowledgeQueryText({ primary: dossierText, secondary: [input.instruction] }),
  })

  const context: LlmCallContext = { clientId: email.client_id, caseId: email.case_id, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildPrompt(email, input.instruction, knowledge, clientKnowledge, thread),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    modelId: EMAIL_WRITER_MODEL_ID,
    // See write.ts — same draftSchema/token ceiling, same fix: pin thinking to
    // 'minimal' so reasoning tokens don't truncate the JSON payload.
    thinkingLevel: 'minimal',
  })

  await logEventSafe({
    clientId: email.client_id,
    caseId: email.case_id,
    actor: ACTOR,
    type: 'inbox.draft_regenerated',
    payload: { emailId: input.emailId, instruction: input.instruction },
  })

  return draft
}
