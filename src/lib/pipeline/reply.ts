import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  getEmailById, listThreadEmails, claimReplyEmail, markEmailSent, markEmailFailed, type EmailRow,
} from '@/lib/db/emails'
import { getLeadById, type LeadRow } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { addSuppression } from '@/lib/db/suppressions'
import { stopSequenceForLead } from '@/lib/db/sequences'
import { updateCaseStatus } from '@/lib/db/cases'
import { triggerCollisionNotice } from '@/lib/pipeline/collision-notify'
import { createKnowledgeRequest } from '@/lib/db/knowledge-requests'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'

const ACTOR = 'reply_agent'
// Bumped alongside the 'medium' thinking level below so extra reasoning tokens
// don't starve the actual classification/reply output.
const MAX_OUTPUT_TOKENS = 1_600
// The added thinking budget can push a single call past the client's 20s default.
const CLASSIFY_TIMEOUT_MS = 30_000
// Below this the hybrid mode routes to a human draft instead of auto-sending.
const HYBRID_CONFIDENCE_THRESHOLD = 0.75

type ReplyMode = Database['public']['Enums']['reply_mode']
export type ReplyIntent = 'question' | 'interested' | 'price' | 'not_interested' | 'other'

const classificationSchema = z.object({
  intent: z.enum(['question', 'interested', 'price', 'not_interested', 'other']),
  confidence: z.number().min(0).max(1),
  canAnswer: z.boolean(),
  missingQuestion: z.string().nullable(),
  replyBody: z.string().nullable(),
})
export type ReplyClassification = z.infer<typeof classificationSchema>

export interface ReplySummary {
  emailId: string
  action: 'answered' | 'escalated' | 'handoff' | 'suppressed' | 'skipped'
}

const SYSTEM_PROMPT = [
  'You triage inbound replies to a B2B cold email and decide how to respond.',
  'Always write replyBody in English, even if the dossier, company knowledge, or',
  'the prospect\'s message is in another language — translate any facts you use,',
  'never copy foreign-language text.',
  'Use ONLY the dossier facts and the prior thread. Never invent a business fact.',
  'Classify intent: question, interested, price (pricing/quote/buying signal),',
  'not_interested (opt-out / unsubscribe / "stop"), or other.',
  'Set canAnswer=true only if you can fully answer from the dossier/thread without',
  'inventing anything, and then put the ready-to-send reply body in replyBody.',
  'If a real business fact is missing, set canAnswer=false and put the exact',
  'question to ask a human in missingQuestion. For price/not_interested, leave',
  'replyBody null. confidence is your 0..1 certainty in the classification+answer.',
  'Replies are short, human, no bulk markers, no unsubscribe footer.',
].join(' ')

function buildClassifyPrompt(args: {
  thread: EmailRow[]; knowledge: KnowledgeRow[]; valueProp: string | null; inboundBody: string; clientKnowledge: string
}): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const transcript = args.thread
    .map((e) => `[${e.direction}] ${e.subject ?? ''}\n${e.body ?? ''}`)
    .join('\n---\n')
  return [
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    args.clientKnowledge ? `About our company:\n${args.clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    `Thread so far:\n${transcript}`,
    `Latest inbound reply to triage:\n${args.inboundBody}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function classifyReply(
  context: LlmCallContext,
  args: { thread: EmailRow[]; knowledge: KnowledgeRow[]; valueProp: string | null; inboundBody: string; clientKnowledge: string },
): Promise<ReplyClassification> {
  return generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildClassifyPrompt(args),
    schema: classificationSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    // Deciding intent and whether the dossier truly supports an answer (vs.
    // inventing one) is exactly the kind of judgment call worth extra reasoning.
    thinkingLevel: 'medium',
  })
}

// human_approve always drafts; auto_send always sends; hybrid sends only when
// the agent is confident, otherwise drafts to /inbox for a human ("escalate").
export function replyDisposition(mode: ReplyMode, confidence: number): 'send' | 'draft' {
  if (mode === 'human_approve') return 'draft'
  if (mode === 'auto_send') return 'send'
  return confidence >= HYBRID_CONFIDENCE_THRESHOLD ? 'send' : 'draft'
}

function replySubject(thread: EmailRow[]): string {
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const base = firstOutbound?.subject ?? 'Re: your message'
  return base.startsWith('Re: ') ? base : `Re: ${base}`
}

interface SendOrDraftInput {
  inbound: EmailRow
  lead: LeadRow
  mailboxIds: string[]
  subject: string
  body: string
  disposition: 'send' | 'draft'
}

// Claims the one-reply-per-inbound slot, then sends or leaves a draft. Idempotent
// on retry: a claimed slot returns null and no second reply is sent.
export async function sendOrDraftReply(
  supabase: SupabaseClient<Database>,
  input: SendOrDraftInput,
): Promise<void> {
  if (!input.lead.email) return
  const claimed = await claimReplyEmail(supabase, {
    client_id: input.inbound.client_id,
    case_id: input.inbound.case_id,
    lead_id: input.inbound.lead_id,
    thread_id: input.inbound.thread_id,
    direction: 'outbound',
    subject: input.subject,
    body: input.body,
    status: input.disposition === 'send' ? 'queued' : 'draft',
    in_reply_to_email_id: input.inbound.id,
  })
  if (!claimed) return // already handled by a prior delivery
  if (input.disposition === 'draft') return // sits in /inbox for a human

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: input.inbound.client_id,
      mailboxIds: input.mailboxIds,
      to: input.lead.email,
      subject: input.subject,
      body: input.body,
      purpose: 'reply',
      threadId: input.inbound.thread_id,
      inReplyToMessageId: input.inbound.provider_message_id,
      references: input.inbound.provider_message_id,
    })
  } catch (error) {
    // RATE_LIMITED is transient: leave the claimed row 'queued' (skip
    // markEmailFailed) and rethrow so the QStash delivery is retried, instead
    // of silently swallowing it and leaving the reply never sent.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') throw error
    await markEmailFailed(supabase, claimed.id)
    // FORBIDDEN means the address is hard-bounced. Retrying cannot help, and
    // the failed row is the durable record, so stop here instead of rethrowing
    // into a QStash retry loop.
    if (error instanceof AppError && error.code === 'FORBIDDEN') {
      await logEventSafe({
        clientId: input.inbound.client_id,
        caseId: input.inbound.case_id,
        actor: 'reply_agent',
        type: 'reply.send_suppressed',
        payload: { emailId: claimed.id, leadId: input.lead.id },
      })
      return
    }
    throw error
  }
  await markEmailSent(supabase, claimed.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })
}

function buildBookingReply(bookingLink: string | null): string {
  const link = bookingLink ?? '(booking link unavailable — a colleague will follow up)'
  return [
    'Thanks for the interest — happy to walk through pricing on a quick call.',
    `Grab whatever time works best here: ${link}`,
  ].join(' ')
}

export async function runReplyForInbound(
  supabase: SupabaseClient<Database>,
  input: { emailId: string },
): Promise<ReplySummary> {
  const inbound = await getEmailById(supabase, input.emailId)
  if (!inbound || inbound.direction !== 'inbound' || !inbound.lead_id || !inbound.case_id) {
    return { emailId: input.emailId, action: 'skipped' }
  }
  const lead = await getLeadById(supabase, inbound.lead_id)
  if (!lead?.email) return { emailId: input.emailId, action: 'skipped' }

  const campaign = await getCampaignForCase(supabase, inbound.case_id)
  if (!campaign) return { emailId: input.emailId, action: 'skipped' }

  const [thread, knowledge] = await Promise.all([
    listThreadEmails(supabase, inbound.lead_id),
    listKnowledgeForCase(supabase, inbound.case_id),
  ])

  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(
    supabase, inbound.client_id, `${dossierText} ${inbound.body ?? ''} ${campaign.value_prop ?? ''}`.trim(),
  )
  const classification = await classifyReply(context, {
    thread, knowledge, valueProp: campaign.value_prop, inboundBody: inbound.body ?? '', clientKnowledge,
  })

  // A reply always means we are in a conversation now.
  await updateCaseStatus(supabase, inbound.case_id, 'in_conversation')

  switch (classification.intent) {
    case 'price': {
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: buildBookingReply(campaign.booking_link),
        disposition: replyDisposition(campaign.reply_mode, 1),
      })
      await addSuppression(supabase, { clientId: inbound.client_id, email: lead.email, reason: 'price_handoff' })
      await stopSequenceForLead(supabase, inbound.lead_id, 'stopped')
      await updateCaseStatus(supabase, inbound.case_id, 'hot_handoff')
      await triggerCollisionNotice(supabase, inbound.case_id, inbound.lead_id)
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.price_handoff', payload: { emailId: inbound.id, leadId: inbound.lead_id },
      })
      return { emailId: inbound.id, action: 'handoff' }
    }
    case 'not_interested': {
      await addSuppression(supabase, { clientId: inbound.client_id, email: lead.email, reason: 'manual' })
      await stopSequenceForLead(supabase, inbound.lead_id, 'stopped')
      await updateCaseStatus(supabase, inbound.case_id, 'lost')
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.opt_out', payload: { emailId: inbound.id, leadId: inbound.lead_id },
      })
      return { emailId: inbound.id, action: 'suppressed' }
    }
    case 'question':
    case 'interested':
    case 'other': {
      if (!classification.canAnswer || classification.replyBody === null) {
        const question = classification.missingQuestion
          ?? 'Cannot answer this reply automatically — please review the thread.'
        await createKnowledgeRequest(supabase, {
          client_id: inbound.client_id,
          case_id: inbound.case_id,
          lead_id: inbound.lead_id,
          email_id: inbound.id,
          question,
        })
        await logEventSafe({
          clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
          type: 'reply.knowledge_gap', payload: { emailId: inbound.id, question },
        })
        return { emailId: inbound.id, action: 'escalated' }
      }
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: classification.replyBody,
        disposition: replyDisposition(campaign.reply_mode, classification.confidence),
      })
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.answered', payload: { emailId: inbound.id, intent: classification.intent },
      })
      return { emailId: inbound.id, action: 'answered' }
    }
    default: {
      const exhaustive: never = classification.intent
      throw new AppError('INVARIANT_VIOLATION', 'Unhandled reply intent', { intent: String(exhaustive) })
    }
  }
}
