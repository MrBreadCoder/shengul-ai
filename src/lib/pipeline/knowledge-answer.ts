import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getKnowledgeRequestById } from '@/lib/db/knowledge-requests'
import { getEmailById, listThreadEmails, type EmailRow } from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { generateText, type LlmCallContext } from '@/lib/llm/client'
import { sendOrDraftReply, replyDisposition } from '@/lib/pipeline/reply'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'

const ACTOR = 'reply_agent'
const MAX_OUTPUT_TOKENS = 1_000

const SYSTEM_PROMPT = [
  'You write the reply to a prospect once a human colleague has supplied the',
  'previously-missing fact. Ground the reply in that fact and the dossier — never',
  'add anything beyond them. Short, human, no bulk markers, under 90 words.',
  'Always write in English, even if the supplied fact or company knowledge is in',
  'another language — translate any facts you use, never copy foreign-language text.',
].join(' ')

function buildAnswerPrompt(args: {
  thread: EmailRow[]; knowledge: KnowledgeRow[]; humanAnswer: string; valueProp: string | null; clientKnowledge: string
}): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const lastInbound = [...args.thread].reverse().find((e) => e.direction === 'inbound')
  return [
    `The colleague's answer to use: ${args.humanAnswer}`,
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    args.clientKnowledge ? `About our company:\n${args.clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    `The prospect's question:\n${lastInbound?.body ?? ''}`,
    'Write only the reply body (no subject line).',
  ]
    .filter(Boolean)
    .join('\n\n')
}

function replySubject(thread: EmailRow[]): string {
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const base = firstOutbound?.subject ?? 'Re: your message'
  return base.startsWith('Re: ') ? base : `Re: ${base}`
}

// Runs after a human answers a knowledge_request in /inbox: writes the reply in
// the AI's voice grounded on the human-supplied fact and sends per reply mode.
// Idempotent via sendOrDraftReply's one-reply-per-inbound claim.
export async function runKnowledgeAnswer(
  supabase: SupabaseClient<Database>,
  input: { knowledgeRequestId: string },
): Promise<{ knowledgeRequestId: string; action: 'sent' | 'drafted' | 'skipped' }> {
  const kr = await getKnowledgeRequestById(supabase, input.knowledgeRequestId)
  if (!kr || kr.status !== 'answered' || !kr.email_id || !kr.human_answer) {
    return { knowledgeRequestId: input.knowledgeRequestId, action: 'skipped' }
  }
  const inbound = await getEmailById(supabase, kr.email_id)
  if (!inbound || inbound.direction !== 'inbound' || !inbound.lead_id || !inbound.case_id) {
    return { knowledgeRequestId: kr.id, action: 'skipped' }
  }
  const lead = await getLeadById(supabase, inbound.lead_id)
  if (!lead?.email) return { knowledgeRequestId: kr.id, action: 'skipped' }

  const campaign = await getCampaignForCase(supabase, inbound.case_id)
  if (!campaign) return { knowledgeRequestId: kr.id, action: 'skipped' }

  const [thread, knowledge] = await Promise.all([
    listThreadEmails(supabase, inbound.lead_id),
    listKnowledgeForCase(supabase, inbound.case_id),
  ])

  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(
    supabase, inbound.client_id, `${dossierText} ${kr.human_answer} ${campaign.value_prop ?? ''}`.trim(),
  )
  const body = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildAnswerPrompt({
      thread, knowledge, humanAnswer: kr.human_answer, valueProp: campaign.value_prop, clientKnowledge,
    }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // A human confirmed the fact, so treat as fully confident.
  const disposition = replyDisposition(campaign.reply_mode, 1)
  await sendOrDraftReply(supabase, {
    inbound, lead, mailboxIds: campaign.mailbox_ids, subject: replySubject(thread), body, disposition,
  })

  await logEventSafe({
    clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
    type: 'reply.knowledge_answered', payload: { knowledgeRequestId: kr.id, emailId: inbound.id, disposition },
  })

  return { knowledgeRequestId: kr.id, action: disposition === 'send' ? 'sent' : 'drafted' }
}
