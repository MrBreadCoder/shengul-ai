import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { readInboundForMailbox } from '@/lib/mailbox/reader'
import type { MailboxRow } from '@/lib/db/mailboxes'
import { updateInboundCursor } from '@/lib/db/mailboxes'
import { findContactedLeadByEmail } from '@/lib/db/leads'
import { insertInboundEmail, getEmailByProviderMessageId } from '@/lib/db/emails'
import { pauseActiveSequenceForLead } from '@/lib/db/sequences'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'
import { detectBounce, detectAutoReply } from '@/lib/mailbox/bounce'
import { handleBounce } from '@/lib/pipeline/bounce'

const ACTOR = 'inbound_ingest'

export interface IngestSummary {
  mailboxId: string
  ingested: number
  enqueued: number
  bounces: number
  autoReplies: number
}

// Polls one mailbox for new inbound mail, matches each message to a contacted
// lead by sender address, stores it (deduped), pauses that lead's sequence, and
// fans one QStash message per new inbound to the Reply Agent. The cursor is
// advanced only after the loop, so a mid-loop crash re-processes on retry —
// safe because insertInboundEmail is deduped on provider_message_id and the
// pause/publish steps below are retried (idempotently) even for a message
// that was already stored on a prior, interrupted run.
export async function ingestInboundForMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
): Promise<IngestSummary> {
  const { messages, cursor } = await readInboundForMailbox(supabase, mailbox)

  let ingested = 0
  let enqueued = 0
  let bounces = 0
  let autoReplies = 0

  for (const message of messages) {
    // Order matters: a DSN also carries Auto-Submitted: auto-replied, so bounce
    // detection has to win. Neither branch stores an emails row — an inbound row
    // for a machine-generated message would make hasInboundReply() true and end
    // the follow-up sequence as if a human had answered.
    const bounce = detectBounce(message, mailbox.email_address)
    if (bounce) {
      await handleBounce(supabase, { mailbox, report: bounce })
      bounces += 1
      continue
    }

    if (detectAutoReply(message)) {
      autoReplies += 1
      await logEventSafe({
        clientId: mailbox.client_id,
        actor: ACTOR,
        type: 'inbound.auto_reply_ignored',
        source: 'mailbox',
        payload: { mailboxId: mailbox.id, fromEmail: message.fromEmail, subject: message.subject },
      })
      continue
    }

    const lead = await findContactedLeadByEmail(supabase, mailbox.client_id, message.fromEmail, mailbox.id)
    if (!lead || !lead.case_id) continue // not a reply to our outreach

    const inserted = await insertInboundEmail(supabase, {
      client_id: mailbox.client_id,
      case_id: lead.case_id,
      lead_id: lead.id,
      thread_id: message.threadId,
      provider_message_id: message.providerMessageId,
      direction: 'inbound',
      subject: message.subject,
      body: message.body,
      status: 'delivered',
      mailbox_id: mailbox.id,
    })

    // insertInboundEmail dedupes on provider_message_id, so a retry after a
    // crash between the insert and the pause/publish below returns null here
    // even though that downstream work never ran. Resolve the existing row and
    // retry pause + publish regardless of whether this is a fresh insert —
    // both are idempotent (pause no-ops once the sequence isn't active;
    // publish re-triggers the reply agent, which is safe because
    // sendOrDraftReply claims a single reply-per-inbound slot) — so an
    // interrupted delivery is retried instead of stuck with no reply forever.
    const isNewInbound = inserted !== null
    const inbound = inserted ?? (await getEmailByProviderMessageId(supabase, message.providerMessageId))
    if (!inbound) continue // unreachable in practice; guards a race on the lookup

    if (isNewInbound) ingested += 1

    await pauseActiveSequenceForLead(supabase, lead.id)
    await publishJson('/api/inbound/reply', { emailId: inbound.id })
    enqueued += 1

    if (isNewInbound) {
      await logEventSafe({
        clientId: mailbox.client_id,
        caseId: lead.case_id,
        actor: ACTOR,
        type: 'inbound.received',
        payload: { emailId: inbound.id, leadId: lead.id, mailboxId: mailbox.id },
      })
    }
  }

  await updateInboundCursor(supabase, mailbox.id, cursor)
  return { mailboxId: mailbox.id, ingested, enqueued, bounces, autoReplies }
}
