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
  markEmailWaiting,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getClientById } from '@/lib/db/clients'
import { isSuppressed } from '@/lib/db/suppressions'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateText, type LlmCallContext, EMAIL_WRITER_MODEL_ID } from '@/lib/llm/client'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { appendSignatureBlock, resolveSignatureContext } from './signature'
import { logEventSafe } from '@/lib/events/log-event'
import { DEFAULT_FOLLOWUP_DELAYS_DAYS } from '@/lib/validation/followup-limits'

export const DAY_SECONDS = 86_400
export const FIRST_TOUCH_STEP = 0
const MAX_OUTPUT_TOKENS = 1_000
const ACTOR = 'email_writer_agent'

// How long before retrying a followup step that was skipped because the
// campaign was paused/archived at the time. Independent of the normal
// step-to-step cadence in sequence.followup_delays_days.
const PAUSED_CAMPAIGN_RETRY_SECONDS = DAY_SECONDS

// Shared post-first-touch bookkeeping: create the sequence row — snapshotting
// the client's current default cadence onto it, so a later change to that
// default never reaches back into this sequence (see
// docs/superpowers/specs/2026-08-05-configurable-followup-cadence-design.md §3)
// — and enqueue the step-1 follow-up. Idempotent — createSequence returns null
// when a sequence already exists for the lead, so a retry never
// double-schedules. Called by both the automated write path and the manual
// /inbox approval path.
export async function scheduleFirstFollowup(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; caseId: string; leadId: string },
): Promise<void> {
  const client = await getClientById(supabase, input.clientId)
  const delaysDays = client?.followup_delays_days ?? DEFAULT_FOLLOWUP_DELAYS_DAYS
  const sequence = await createSequence(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: input.leadId,
    current_step: FIRST_TOUCH_STEP,
    state: 'active',
    followup_delays_days: delaysDays,
  })
  if (!sequence) return
  const delaySeconds = delaysDays[0]! * DAY_SECONDS // array is never empty — schema floor is 1 (Task 2)
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: 1 },
    delaySeconds,
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: FIRST_TOUCH_STEP,
    nextActionAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
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

// Persists 'waiting' with one retry. 'queued' (where claimOutboundEmail left
// the row) is a dead end for a QStash redelivery of this same step — its
// upsert no-ops against the still-occupied slot, and its own fallback
// (reclaimFailedOutboundEmail) only reclaims 'failed' — so a swallowed
// failure here would leave the retry silently skipping forever, and the
// drain sweep (resend-failed.ts) would never see it either, since it only
// polls 'waiting'. A persistent failure falls back to 'failed' (still
// reclaimable by claimOutboundEmail's own fallback) and rethrows rather than
// silently resolving — the caller must not report this step as routinely
// parked 'waiting' when the row is actually 'failed', or the case-level
// wait_reason bookkeeping built on that outcome desyncs from the real row.
async function parkAsWaiting(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  try {
    await markEmailWaiting(supabase, id)
  } catch {
    try {
      await markEmailWaiting(supabase, id)
    } catch (error) {
      await markEmailFailed(supabase, id)
      throw error
    }
  }
}

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
  maxStep: number,
  companyInfo: string | null,
): string {
  const showBookingLink = bookingLink !== null && step >= BOOKING_LINK_ELIGIBLE_STEP
  return [
    `This is follow-up number ${step} (of ${maxStep}).`,
    `Original subject: ${priorSubject}`,
    `Original message:\n${priorBody}`,
    `Our value proposition: ${valueProp ?? 'n/a'}`,
    companyInfo ? `About our company:\n${companyInfo}` : '',
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

  const maxStep = sequence.followup_delays_days.length

  // Stale/duplicate QStash delivery guard: this message drives step N only when
  // the sequence is still active and sitting at step N-1.
  if (sequence.state !== 'active' || sequence.current_step !== input.step - 1) {
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  // The cadence may have been shrunk (fewer follow-ups) since this step was
  // enqueued — its QStash delay was fixed at publish time and can't be pulled
  // back. A step beyond the current array length is stale and must not send.
  if (input.step > maxStep) {
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
    if (input.step >= maxStep) {
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

    // Same index rule as the send path below (Step 9): always in range for step < maxStep.
    const skipDelaySeconds = sequence.followup_delays_days[input.step]! * DAY_SECONDS
    const skipMessageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: input.step + 1 },
      skipDelaySeconds,
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: input.step,
      nextActionAt: new Date(Date.now() + skipDelaySeconds * 1000).toISOString(),
      qstashMessageId: skipMessageId,
    })
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.skipped_manual', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  // Fetched once, up front — feeds both the prompt's "About our company" line
  // (client.company_info) and the deterministic signature block below.
  const client = await getClientById(supabase, sequence.client_id)
  const context: LlmCallContext = { clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR }
  const nudgeBody = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildNudgePrompt(
      priorSubject,
      firstOutbound?.body ?? '',
      campaign.value_prop,
      campaign.booking_link,
      input.step,
      maxStep,
      client?.company_info ?? null,
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    modelId: EMAIL_WRITER_MODEL_ID,
  })

  const signedBody = appendSignatureBlock(
    nudgeBody,
    resolveSignatureContext(client, {
      signatureName: campaign.signature_name,
      signatureTitle: campaign.signature_title,
      phone: campaign.phone,
      address: campaign.address,
    }),
  )

  // Claim the (lead, step, outbound) slot before sending — retry-safe.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: sequence.client_id,
    case_id: sequence.case_id,
    lead_id: sequence.lead_id,
    thread_id: threadId,
    direction: 'outbound',
    subject: replySubject,
    body: signedBody,
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
      body: signedBody,
      purpose: 'outreach',
      threadId,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
    })
  } catch (error) {
    // Content already exists on this row (the nudge was already written) —
    // park it as-is for the drain sweep, never regenerate, and never
    // reschedule through QStash: unlike the paused-campaign branch above,
    // there is no "try again in a day" here. The row's 'waiting' status is
    // what the drain sweep (lib/pipeline/resend-failed.ts) polls for.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await parkAsWaiting(supabase, claimed.id)
      return { sequenceId: sequence.id, action: 'skipped' }
    }
    await markEmailFailed(supabase, claimed.id)
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
  if (input.step >= maxStep) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, sequence.case_id, 'dead')
    await enqueueCrmSync(sequence.case_id, 'dead')
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const nextStep = input.step + 1
  // Index = current step → delay before nextStep; always in range for step < maxStep.
  const nextDelaySeconds = sequence.followup_delays_days[input.step]! * DAY_SECONDS
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: nextStep },
    nextDelaySeconds,
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: input.step,
    nextActionAt: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
    qstashMessageId: messageId,
  })
  await logEventSafe({
    clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
    type: 'pipeline.followup.sent', payload: { sequenceId: sequence.id, step: input.step },
  })
  return { sequenceId: sequence.id, action: 'sent' }
}
