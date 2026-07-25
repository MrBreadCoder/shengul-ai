import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { MailboxRow } from '@/lib/db/mailboxes'
import type { BounceReport } from '@/lib/mailbox/bounce'
import { findContactedLeadByEmail, parkLead } from '@/lib/db/leads'
import { markLatestOutboundBounced } from '@/lib/db/emails'
import { addSuppression } from '@/lib/db/suppressions'
import { stopSequenceForLead } from '@/lib/db/sequences'
import { logEventSafe, logWarn } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const ACTOR = 'bounce_handler'

export type BounceOutcome = 'suppressed' | 'recorded' | 'unmatched'

export interface HandleBounceInput {
  mailbox: MailboxRow
  report: BounceReport
}

/**
 * Applies a delivery status notification.
 *
 * Only hard (5.x.x) bounces suppress: a soft bounce is a full mailbox or a
 * greylisting retry, and suppressing on one would throw away a live prospect.
 * An unparseable DSN is treated as soft for the same reason — detectBounce
 * defaults it that way — and shows up in the log for a human to look at.
 *
 * Only hard bounces flip the outbound email to 'bounced', which is what feeds
 * the mailbox_send_stats bounce numerator, so the health signal is a hard-bounce
 * rate and comparable to the published 2-3% benchmarks.
 */
export async function handleBounce(
  supabase: SupabaseClient<Database>,
  { mailbox, report }: HandleBounceInput,
): Promise<BounceOutcome> {
  if (!report.recipient) {
    await logWarn({
      clientId: mailbox.client_id,
      actor: ACTOR,
      type: 'bounce.unmatched',
      source: 'mailbox',
      error: new AppError('VALIDATION_ERROR', 'Bounce carried no parseable recipient', {}),
      payload: { mailboxId: mailbox.id, statusCode: report.statusCode, kind: report.kind },
    })
    return 'unmatched'
  }

  const recipient = report.recipient.toLowerCase()
  const lead = await findContactedLeadByEmail(supabase, mailbox.client_id, recipient, mailbox.id)
  if (!lead) {
    await logWarn({
      clientId: mailbox.client_id,
      actor: ACTOR,
      type: 'bounce.unmatched',
      source: 'mailbox',
      error: new AppError('NOT_FOUND', 'Bounce recipient matched no contacted lead', {}),
      payload: { mailboxId: mailbox.id, statusCode: report.statusCode, kind: report.kind },
    })
    return 'unmatched'
  }

  if (report.kind === 'soft') {
    await logEventSafe({
      clientId: mailbox.client_id,
      caseId: lead.case_id,
      actor: ACTOR,
      type: 'bounce.soft',
      source: 'mailbox',
      severity: 'warn',
      payload: { mailboxId: mailbox.id, leadId: lead.id, statusCode: report.statusCode, diagnostic: report.diagnostic },
    })
    return 'recorded'
  }

  await markLatestOutboundBounced(supabase, lead.id)
  await addSuppression(supabase, { clientId: mailbox.client_id, email: recipient, reason: 'bounced' })
  await stopSequenceForLead(supabase, lead.id, 'stopped')
  await parkLead(supabase, lead.id)

  await logEventSafe({
    clientId: mailbox.client_id,
    caseId: lead.case_id,
    actor: ACTOR,
    type: 'bounce.hard',
    source: 'mailbox',
    severity: 'warn',
    payload: { mailboxId: mailbox.id, leadId: lead.id, statusCode: report.statusCode, diagnostic: report.diagnostic },
  })
  return 'suppressed'
}
