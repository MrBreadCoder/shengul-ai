import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { isAppError } from '@/lib/errors/app-error'
import { listFailedFirstTouchEmails, claimOutboundEmail, markEmailSent, markEmailFailed, type EmailRow } from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getCaseById, updateCaseStatus, type CaseStatus } from '@/lib/db/cases'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { scheduleFirstFollowup, FIRST_TOUCH_STEP } from './followup'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'resend_failed_outbound'

// A case explicitly closed out — by a human, by the CRM sync, or by the
// follow-up sequence exhausting — must not get a fresh cold first-touch
// resurrected under it. Every other status (including 'contacted', the
// normal case this sweep exists for, and every pre-contact status, where a
// concurrent write-fanout run may also be racing this exact reclaim) is
// fine: the atomic claim below resolves any race safely either way.
const CASE_CLOSED_STATUSES: readonly CaseStatus[] = ['won', 'lost', 'dead']

export type ResendOutcome = 'sent' | 'rate_limited' | 'failed' | 'skipped'

export interface ResendResult {
  emailId: string
  outcome: ResendOutcome
}

// Resends exactly one stranded first-touch email, reusing its stored
// subject/body verbatim — never regenerated. Mirrors processLead's
// (write.ts) send + bookkeeping, minus draft generation: this only ever
// handles a row that was already generated and claimed once before.
async function resendOne(supabase: SupabaseClient<Database>, email: EmailRow): Promise<ResendOutcome> {
  if (!email.lead_id || !email.case_id || !email.subject || !email.body) return 'skipped'
  const caseId = email.case_id
  const leadId = email.lead_id
  const subject = email.subject
  const body = email.body

  const [lead, kase] = await Promise.all([getLeadById(supabase, leadId), getCaseById(supabase, caseId)])
  if (!lead || lead.status !== 'active' || !lead.email) return 'skipped'
  if (!kase || CASE_CLOSED_STATUSES.includes(kase.status)) return 'skipped'

  const campaign = await getCampaignForCase(supabase, caseId)
  if (!campaign || campaign.status !== 'active') return 'skipped'

  // Reclaims the (lead, step 0, outbound) slot from 'failed' back to
  // 'queued'. The atomic `.eq('status','failed')` guard inside this (see
  // reclaimFailedOutboundEmail in lib/db/emails.ts) is what makes this safe
  // to race against the normal write-fanout path: a case that is also
  // 'ready'/'waiting' may be reclaiming this exact row via runWriteForCase
  // at the same moment, and only one of the two wins — the loser gets null
  // here and skips, never double-sends.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: email.client_id,
    case_id: caseId,
    lead_id: leadId,
    direction: 'outbound',
    subject,
    body,
    status: 'queued',
    sequence_step: FIRST_TOUCH_STEP,
  })
  if (!claimed) return 'skipped'

  try {
    const sent = await sendViaMailbox(supabase, {
      clientId: email.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: claimed.subject ?? subject,
      body: claimed.body ?? body,
      purpose: 'outreach',
    })
    await markEmailSent(supabase, claimed.id, {
      providerMessageId: sent.providerMessageId,
      threadId: sent.threadId,
      mailboxId: sent.mailboxId,
    })
    await scheduleFirstFollowup(supabase, { clientId: email.client_id, caseId, leadId })
    if (kase.status !== 'contacted') {
      await updateCaseStatus(supabase, caseId, 'contacted')
      await enqueueCrmSync(caseId, 'contacted')
    }
    return 'sent'
  } catch (error) {
    // Only a delivery failure means the email was never sent — mark it
    // failed so a later sweep tick can reclaim it again. A failure in the
    // bookkeeping above (markEmailSent et al.) means the message already
    // went out and must not be treated as a send failure.
    await markEmailFailed(supabase, claimed.id)
    if (isAppError(error) && error.code === 'RATE_LIMITED') return 'rate_limited'
    throw error
  }
}

// Sweeps a bounded batch of stranded first-touch sends and retries each
// through the real send path (health/rotation/cap/warmup-gate/suppression
// all still apply via sendViaMailbox — no bypass). Exists specifically for
// the case runWriteForCase itself can never revisit: a case with 2+ active
// leads where one lead's send succeeded (case -> 'contacted', terminal) and
// another's hit RATE_LIMITED in the very same run — write-fanout only
// re-sweeps 'ready'/'waiting' cases, so a lead stranded this way had no path
// back before this. See .claude/roadmap.md 2026-08-19.
//
// One email's genuine (non-RATE_LIMITED) failure is logged and does not
// abort the rest of the batch — same "one bad row doesn't sink the sweep"
// stance runResearchForCase and rewriteDraftsForCase take.
export async function sweepFailedFirstTouch(supabase: SupabaseClient<Database>, limit: number): Promise<ResendResult[]> {
  const emails = await listFailedFirstTouchEmails(supabase, limit)
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
