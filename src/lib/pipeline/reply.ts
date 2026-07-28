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
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
import { insertEmailAttachments } from '@/lib/db/email-attachments'
import {
  MAX_RESOURCE_MENU, buildResourceMenu, formatResourceMenu, resolveAttachments,
} from '@/lib/resources/menu'
import { loadResourceAttachments } from '@/lib/resources/load-attachments'

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
  // Ordinals from the resource menu, not ids. Everything here is untrusted —
  // resolveAttachments drops hallucinated ordinals and enforces the budget.
  attachResourceIds: z.array(z.number().int()).default([]),
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
  'Use ONLY the dossier facts, the prior thread, and any company-knowledge line',
  'tagged "attachable #N". Never invent a business fact.',
  'Classify intent: question, interested, price (pricing/quote/buying signal),',
  'not_interested (opt-out / unsubscribe / "stop"), or other.',
  'Set canAnswer=true only if you can fully answer from the dossier/thread without',
  'inventing anything, and then put the ready-to-send reply body in replyBody.',
  'If a real business fact is missing, set canAnswer=false and put the exact',
  'question to ask a human in missingQuestion. For price/not_interested, leave',
  'replyBody null. confidence is your 0..1 certainty in the classification+answer.',
  'You may be given a numbered list of resources (files) you can attach. Attach',
  'one only when the prospect explicitly asked for something that resource',
  'provides — never as a bonus. Put the numbers in attachResourceIds, or leave',
  'it empty. When you do attach, say so naturally in replyBody.',
  'A company-knowledge line tagged "attachable #N" was taken from one of those',
  'files: you may answer from it, and whenever your answer leans on that line you',
  'must put N in attachResourceIds. An untagged company-knowledge line is',
  'background only — do not answer a business question from it.',
  'Replies are short, human, no bulk markers, no unsubscribe footer.',
].join(' ')

interface ClassifyPromptArgs {
  thread: EmailRow[]
  knowledge: KnowledgeRow[]
  valueProp: string | null
  inboundBody: string
  clientKnowledge: string
  resourceMenu: string
}

function buildClassifyPrompt(args: ClassifyPromptArgs): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const transcript = args.thread
    .map((e) => `[${e.direction}] ${e.subject ?? ''}\n${e.body ?? ''}`)
    .join('\n---\n')
  return [
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    args.clientKnowledge ? `About our company:\n${args.clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    `Thread so far:\n${transcript}`,
    args.resourceMenu ? `Resources you may attach:\n${args.resourceMenu}` : '',
    `Latest inbound reply to triage:\n${args.inboundBody}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function classifyReply(
  context: LlmCallContext,
  args: ClassifyPromptArgs,
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
  // Resolved and budget-checked by the caller. Recorded against the email even
  // when drafting, so /inbox can show and edit what the AI picked.
  resourceIds: readonly string[]
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

  // Recorded before the draft branch so a draft carries the AI's picks and
  // /inbox can render them. Skipped when empty — there is nothing to write.
  if (input.resourceIds.length > 0) {
    await insertEmailAttachments(supabase, {
      clientId: input.inbound.client_id,
      emailId: claimed.id,
      resourceIds: input.resourceIds,
    })
  }
  if (input.disposition === 'draft') return // sits in /inbox for a human

  let sent: SendViaMailboxResult
  try {
    // Inside the try so a storage failure lands in the same markEmailFailed
    // path as a send failure: an email promising an attachment must not go out
    // without one.
    const attachments = await loadResourceAttachments(
      supabase, input.inbound.client_id, input.resourceIds,
    )
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
      attachments,
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

  const [thread, knowledge, resources] = await Promise.all([
    listThreadEmails(supabase, inbound.lead_id),
    listKnowledgeForCase(supabase, inbound.case_id),
    listActiveResourcesForClient(supabase, inbound.client_id, MAX_RESOURCE_MENU),
  ])
  const resourceMenu = buildResourceMenu(resources)
  // Lets retrieval label a chunk that came from one of these files, so a fact
  // and the file it came from arrive at the model together.
  const resourceOrdinalById = new Map(resourceMenu.map((entry) => [entry.resource.id, entry.ordinal]))

  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: inbound.client_id,
    queryText: `${dossierText} ${inbound.body ?? ''} ${campaign.value_prop ?? ''}`.trim(),
    resourceOrdinalById,
  })
  const classification = await classifyReply(context, {
    thread, knowledge, valueProp: campaign.value_prop, inboundBody: inbound.body ?? '', clientKnowledge,
    resourceMenu: formatResourceMenu(resourceMenu),
  })

  // A reply always means we are in a conversation now.
  await updateCaseStatus(supabase, inbound.case_id, 'in_conversation')

  switch (classification.intent) {
    case 'price': {
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: buildBookingReply(campaign.booking_link),
        disposition: replyDisposition(campaign.reply_mode, 1),
        // A pricing handoff is a booking link, never a file.
        resourceIds: [],
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
      const { resources: attachResources, droppedResourceIds } = resolveAttachments(
        resourceMenu, classification.attachResourceIds,
      )
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: classification.replyBody,
        disposition: replyDisposition(campaign.reply_mode, classification.confidence),
        resourceIds: attachResources.map((r) => r.id),
      })
      if (attachResources.length > 0 || droppedResourceIds.length > 0) {
        await logEventSafe({
          clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
          type: 'reply.resources_attached',
          payload: {
            emailId: inbound.id,
            resourceIds: attachResources.map((r) => r.id),
            droppedResourceIds,
          },
        })
      }
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
