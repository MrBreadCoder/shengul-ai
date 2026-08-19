import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { isAppError, AppError } from '@/lib/errors/app-error'
import {
  listWaitingOutboundEmails,
  claimWaitingOutboundEmail,
  markEmailSent,
  markEmailFailed,
  markEmailWaiting,
  hasInboundReply,
  listThreadEmails,
  type EmailRow,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getCaseById, updateCaseStatus, type CaseStatus } from '@/lib/db/cases'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { scheduleFirstFollowup, FIRST_TOUCH_STEP, DAY_SECONDS } from './followup'
import { getSequenceByLeadId, advanceSequence, stopSequence, type SequenceRow } from '@/lib/db/sequences'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'resend_failed_outbound'

// A case explicitly closed out — by a human, by the CRM sync, or by the
// follow-up sequence exhausting — must not get a resend resurrected under
// it, first-touch or follow-up alike.
const CASE_CLOSED_STATUSES: readonly CaseStatus[] = ['won', 'lost', 'dead']

export type ResendOutcome = 'sent' | 'rate_limited' | 'failed' | 'skipped'

export interface ResendResult {
  emailId: string
  outcome: ResendOutcome
}

// Resends exactly one stranded 'waiting' outbound email, reusing its stored
// subject/body verbatim — never regenerated. First-touch (sequence_step 0)
// mirrors processLead's send + bookkeeping (write.ts), minus draft
// generation. A follow-up step (sequence_step > 0) mirrors runFollowupStep's
// send + cadence bookkeeping (followup.ts), also minus generation. See
// docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md.
async function resendOne(supabase: SupabaseClient<Database>, email: EmailRow): Promise<ResendOutcome> {
  if (
    !email.lead_id || !email.case_id || !email.subject || !email.body || email.sequence_step === null
  ) {
    // Malformed row — these fields can never become valid on their own, so
    // leaving it 'waiting' would just re-skip forever on every sweep tick.
    await markEmailFailed(supabase, email.id)
    return 'skipped'
  }
  const caseId = email.case_id
  const leadId = email.lead_id
  const step = email.sequence_step

  const [lead, kase] = await Promise.all([getLeadById(supabase, leadId), getCaseById(supabase, caseId)])
  if (!lead || lead.status !== 'active' || !lead.email) {
    // A deleted, parked, or emailless lead does not become resendable again
    // on its own — same permanent-skip reasoning as above.
    await markEmailFailed(supabase, email.id)
    return 'skipped'
  }
  if (!kase || CASE_CLOSED_STATUSES.includes(kase.status)) {
    // A closed-out (or deleted) case must not get a resend resurrected
    // under it — permanent, matching CASE_CLOSED_STATUSES' own intent.
    await markEmailFailed(supabase, email.id)
    return 'skipped'
  }

  const campaign = await getCampaignForCase(supabase, caseId)
  if (!campaign || campaign.status === 'archived') {
    // Deleted or permanently archived — permanent, unlike 'paused' just
    // below, which an operator is expected to resume.
    await markEmailFailed(supabase, email.id)
    return 'skipped'
  }
  if (campaign.status !== 'active') return 'skipped' // 'paused' — resumable, leave 'waiting'

  let sequence: SequenceRow | null = null
  let inReplyTo: string | null = null
  if (step > FIRST_TOUCH_STEP) {
    // A reply that arrived while this step sat 'waiting' never got the
    // chance to stop the sequence — runFollowupStep does that check on
    // every invocation, but a 'waiting' row is deliberately never
    // rescheduled through runFollowupStep again (see followup.ts). Check it
    // here instead of resending a nudge to someone who already answered.
    if (await hasInboundReply(supabase, leadId)) {
      const activeSequence = await getSequenceByLeadId(supabase, leadId)
      if (activeSequence) await stopSequence(supabase, activeSequence.id, 'completed')
      // The prospect already answered — resending a nudge is now permanently wrong.
      await markEmailFailed(supabase, email.id)
      return 'skipped'
    }
    sequence = await getSequenceByLeadId(supabase, leadId)
    if (!sequence) {
      // Already stopped/completed since this row was parked — permanent.
      await markEmailFailed(supabase, email.id)
      return 'skipped'
    }
    // Excludes this row itself and any message that was never actually
    // delivered (provider_message_id null — e.g. a manual send still
    // mid-flight): referencing an undelivered message in In-Reply-To would
    // produce a broken thread reference. listThreadEmails orders ascending,
    // so .at(-1) on the filtered set is still the most recent real message.
    const thread = await listThreadEmails(supabase, leadId)
    inReplyTo = thread
      .filter((e) => e.id !== email.id && e.provider_message_id !== null)
      .at(-1)?.provider_message_id ?? null
  }

  // Reclaims this specific 'waiting' row back to 'queued'. The
  // `.eq('status','waiting')` guard inside claimWaitingOutboundEmail
  // (lib/db/emails.ts) makes this safe to race against a concurrent sweep
  // tick — only one wins, the loser gets null and skips, never double-sends.
  const claimed = await claimWaitingOutboundEmail(supabase, email.id)
  if (!claimed) return 'skipped'

  // Only a delivery failure means the email was never sent — mark it failed
  // (or RATE_LIMITED-park it 'waiting' again) so a later drain sweep tick can
  // reclaim it. Every bookkeeping call below runs unconditionally after a
  // real send, outside this catch, so a bookkeeping failure can never be
  // mistaken for — and corrupt the status of — an email that already went out.
  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: email.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: claimed.subject ?? email.subject,
      body: claimed.body ?? email.body,
      purpose: 'outreach',
      threadId: claimed.thread_id,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
    })
  } catch (error) {
    if (isAppError(error) && error.code === 'RATE_LIMITED') {
      await markEmailWaiting(supabase, claimed.id)
      return 'rate_limited'
    }
    await markEmailFailed(supabase, claimed.id)
    throw error
  }

  await markEmailSent(supabase, claimed.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })

  if (step === FIRST_TOUCH_STEP) {
    await scheduleFirstFollowup(supabase, { clientId: email.client_id, caseId, leadId })
    if (kase.status !== 'contacted') {
      await updateCaseStatus(supabase, caseId, 'contacted')
      await enqueueCrmSync(caseId, 'contacted')
    }
    return 'sent'
  }

  if (!sequence) {
    throw new AppError('INVARIANT_VIOLATION', 'Follow-up resend lost its sequence after sending', { leadId, caseId })
  }
  const maxStep = sequence.followup_delays_days.length
  if (step >= maxStep) {
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, caseId, 'dead')
    await enqueueCrmSync(caseId, 'dead')
  } else {
    const nextStep = step + 1
    // Index = current step → delay before nextStep; always in range for
    // step < maxStep — same indexing rule as runFollowupStep's own send path.
    const nextDelaySeconds = sequence.followup_delays_days[step]! * DAY_SECONDS
    const messageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: nextStep },
      nextDelaySeconds,
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: step,
      nextActionAt: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
      qstashMessageId: messageId,
    })
  }
  return 'sent'
}

// Sweeps a bounded batch of 'waiting' outbound emails — first-touch and
// follow-up steps alike — and retries each through the real send path
// (health/rotation/cap/warmup-gate/suppression all still apply via
// sendViaMailbox — no bypass). One email's genuine (non-RATE_LIMITED)
// failure is logged and does not abort the rest of the batch.
export async function sweepFailedFirstTouch(supabase: SupabaseClient<Database>, limit: number): Promise<ResendResult[]> {
  const emails = await listWaitingOutboundEmails(supabase, limit)
  const results: ResendResult[] = []
  for (const email of emails) {
    try {
      const outcome = await resendOne(supabase, email)
      results.push({ emailId: email.id, outcome })
    } catch (error) {
      results.push({ emailId: email.id, outcome: 'failed' })
      await logEventSafe({
        clientId: email.client_id,
        caseId: email.case_id,
        actor: ACTOR,
        type: 'pipeline.resend_failed.error',
        payload: { emailId: email.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return results
}
