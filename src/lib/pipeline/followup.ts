import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  getSequenceById,
  createSequence,
  advanceSequence,
  stopSequence,
  consumeFollowupSkip,
} from '@/lib/db/sequences'
import {
  hasInboundReply,
  listThreadEmails,
  claimOutboundEmail,
  markEmailSent,
  markEmailFailed,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { updateCaseStatus } from '@/lib/db/cases'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateText, type LlmCallContext } from '@/lib/llm/client'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'

const DAY_SECONDS = 86_400
export const FOLLOWUP_DELAYS_SECONDS: readonly number[] = [3 * DAY_SECONDS, 7 * DAY_SECONDS, 14 * DAY_SECONDS]
export const MAX_FOLLOWUP_STEP = 3
export const FIRST_TOUCH_STEP = 0
const MAX_OUTPUT_TOKENS = 1_000
const ACTOR = 'email_writer_agent'

// How long before retrying a followup step that was skipped because the
// campaign was paused/archived at the time. Independent of the normal
// step-to-step cadence in FOLLOWUP_DELAYS_SECONDS.
const PAUSED_CAMPAIGN_RETRY_SECONDS = DAY_SECONDS

// Shared post-first-touch bookkeeping: create the sequence row and enqueue the
// step-1 follow-up (3-day delay). Idempotent — createSequence returns null when
// a sequence already exists for the lead, so a retry never double-schedules.
// Called by both the automated write path and the manual /inbox approval path.
export async function scheduleFirstFollowup(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; caseId: string; leadId: string },
): Promise<void> {
  const sequence = await createSequence(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: input.leadId,
    current_step: FIRST_TOUCH_STEP,
    state: 'active',
  })
  if (!sequence) return
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: 1 },
    FOLLOWUP_DELAYS_SECONDS[0]!, // step 1 delay (3d); index 0 always exists
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: FIRST_TOUCH_STEP,
    nextActionAt: null,
    qstashMessageId: messageId,
  })
}

export interface RunFollowupInput {
  sequenceId: string
  step: number
}

export interface FollowupSummary {
  sequenceId: string
  action: 'sent' | 'completed' | 'stopped' | 'skipped'
}

// Booking link only enters the prompt from this step onward — the first nudge
// (step 1) stays a low-friction reply ask, since a calendar link is too big an
// ask this early in the sequence.
const BOOKING_LINK_ELIGIBLE_STEP = 2

const SYSTEM_PROMPT = [
  'You write a short, polite follow-up nudge to a cold email that got no reply.',
  'Always write in English, even if the company knowledge below is in another',
  'language — translate any facts you use, never copy foreign-language text.',
  'Reference the earlier message lightly, add one new angle or question, stay under 60 words.',
  'No pushiness, no bulk markers, no unsubscribe footer.',
  HUMAN_VOICE_INSTRUCTION,
  'Call to action: default to a low-friction reply question. Only offer the booking link if',
  'one is given below, and even then only as an easy option, never a hard ask.',
].join(' ')

function buildNudgePrompt(
  priorSubject: string,
  priorBody: string,
  valueProp: string | null,
  bookingLink: string | null,
  step: number,
  clientKnowledge: string,
): string {
  const showBookingLink = bookingLink !== null && step >= BOOKING_LINK_ELIGIBLE_STEP
  return [
    `This is follow-up number ${step} (of ${MAX_FOLLOWUP_STEP}).`,
    `Original subject: ${priorSubject}`,
    `Original message:\n${priorBody}`,
    `Our value proposition: ${valueProp ?? 'n/a'}`,
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
    showBookingLink ? `Booking link (optional CTA): ${bookingLink}` : '',
    'Write only the follow-up body text (no subject line).',
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function runFollowupStep(
  supabase: SupabaseClient<Database>,
  input: RunFollowupInput,
): Promise<FollowupSummary> {
  const sequence = await getSequenceById(supabase, input.sequenceId)
  if (!sequence) throw new AppError('NOT_FOUND', 'Sequence not found', { sequenceId: input.sequenceId })

  // Stale/duplicate QStash delivery guard: this message drives step N only when
  // the sequence is still active and sitting at step N-1.
  if (sequence.state !== 'active' || sequence.current_step !== input.step - 1) {
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  // A reply anywhere on the thread ends the sequence.
  if (await hasInboundReply(supabase, sequence.lead_id)) {
    await stopSequence(supabase, sequence.id, 'completed')
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: 'system',
      type: 'pipeline.followup.completed_on_reply', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'completed' }
  }

  const lead = await getLeadById(supabase, sequence.lead_id)
  if (!lead || !lead.email || (await isSuppressed(supabase, sequence.client_id, lead.email))) {
    await stopSequence(supabase, sequence.id, 'stopped')
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const thread = await listThreadEmails(supabase, sequence.lead_id)
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const priorSubject = firstOutbound?.subject ?? 'Following up'
  const replySubject = priorSubject.startsWith('Re: ') ? priorSubject : `Re: ${priorSubject}`
  const threadId = firstOutbound?.thread_id ?? null
  const inReplyTo = thread.at(-1)?.provider_message_id ?? null

  const campaign = await getCampaignForCase(supabase, sequence.case_id)
  if (!campaign || campaign.status !== 'active') {
    // Reschedule the same step rather than advancing or stopping — a paused
    // client is expected to resume, and the sequence must pick back up then.
    const messageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: input.step },
      PAUSED_CAMPAIGN_RETRY_SECONDS,
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: sequence.current_step,
      nextActionAt: null,
      qstashMessageId: messageId,
    })
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  // A human interjected into this cadence — a client wrote to this lead
  // themselves from the case page. Skip exactly one step: send nothing, consume
  // the flag, and schedule the step after it so the cadence survives instead of
  // ending here.
  //
  // Placed below the campaign-active branch so a paused client still freezes
  // everything, and above the LLM call so a skipped step costs no tokens. The
  // reply and lead/suppression checks sit above too, deliberately: a prospect
  // who answered ends the sequence outright, and a dead address still stops it.
  //
  // Checked atomically against the DB here rather than via the `sequence`
  // snapshot loaded at the top of this function: a manual send can call
  // requestFollowupSkip at any point while this run is awaiting the reply/lead/
  // thread/campaign lookups above, so a stale in-memory flag would miss a skip
  // requested mid-flight. consumeFollowupSkip's `skip_next_step = true` guard
  // also makes this the race-loser check for duplicate QStash deliveries.
  const consumedSkip = await consumeFollowupSkip(supabase, sequence.id)
  if (consumedSkip) {
    if (input.step >= MAX_FOLLOWUP_STEP) {
      await stopSequence(supabase, sequence.id, 'stopped')
      // Deliberately NOT updateCaseStatus('dead'), unlike the send path below:
      // a human is in this thread, so the case is not a cold lead that ran out
      // of nudges.
      await logEventSafe({
        clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
        type: 'pipeline.followup.skipped_final', payload: { sequenceId: sequence.id, step: input.step },
      })
      return { sequenceId: sequence.id, action: 'skipped' }
    }

    const skipMessageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: input.step + 1 },
      FOLLOWUP_DELAYS_SECONDS[input.step]!, // same index rule as the send path; always in range for step < MAX
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: input.step,
      nextActionAt: null,
      qstashMessageId: skipMessageId,
    })
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.skipped_manual', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  const context: LlmCallContext = { clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR }
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: sequence.client_id,
    queryText: `${firstOutbound?.body ?? ''} ${campaign.value_prop ?? ''}`.trim(),
  })
  const nudgeBody = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildNudgePrompt(
      priorSubject,
      firstOutbound?.body ?? '',
      campaign.value_prop,
      campaign.booking_link,
      input.step,
      clientKnowledge,
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // Claim the (lead, step, outbound) slot before sending — retry-safe.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: sequence.client_id,
    case_id: sequence.case_id,
    lead_id: sequence.lead_id,
    thread_id: threadId,
    direction: 'outbound',
    subject: replySubject,
    body: nudgeBody,
    status: 'queued',
    sequence_step: input.step,
  })
  if (!claimed) return { sequenceId: sequence.id, action: 'skipped' }

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: sequence.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: replySubject,
      body: nudgeBody,
      purpose: 'outreach',
      threadId,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
    })
  } catch (error) {
    // Only a delivery failure means the email was never sent — mark it failed
    // so it can be retried. A failure below (markEmailSent) means the message
    // already went out and must not be treated as a send failure.
    await markEmailFailed(supabase, claimed.id)
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      return { sequenceId: sequence.id, action: 'skipped' }
    }
    throw error
  }

  await markEmailSent(supabase, claimed.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })

  // Final step? Stop the sequence and mark the case dead. Otherwise advance and
  // enqueue the next delay (index step-1 → step's own delay; step 1 used index 0
  // at first-touch, so step N enqueues index N).
  if (input.step >= MAX_FOLLOWUP_STEP) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, sequence.case_id, 'dead')
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const nextStep = input.step + 1
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: nextStep },
    FOLLOWUP_DELAYS_SECONDS[input.step]!, // index = current step → delay before nextStep; always in range for step < MAX
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: input.step,
    nextActionAt: null,
    qstashMessageId: messageId,
  })
  await logEventSafe({
    clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
    type: 'pipeline.followup.sent', payload: { sequenceId: sequence.id, step: input.step },
  })
  return { sequenceId: sequence.id, action: 'sent' }
}
