import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { isAppError } from '@/lib/errors/app-error'
import { claimCollisionNotice } from '@/lib/db/cases'
import { listOtherActiveLeadsForCollisionNotice, getLeadById } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import {
  listThreadEmails, claimOutboundEmail, markEmailSent, markEmailFailed, type EmailRow,
} from '@/lib/db/emails'
import { isSequenceActiveForLead, stopSequenceForLead } from '@/lib/db/sequences'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'collision_notify'
// Regular cadence steps (followup.ts/write.ts) are 0..sequence.followup_delays_days.length,
// a per-sequence value now rather than a fixed constant.
// A negative sentinel can never collide with a real step, so this notice
// gets its own slot in the existing (lead_id, sequence_step, direction)
// unique-index claim on `emails` instead of a new dedup mechanism.
const COLLISION_NOTICE_SEQUENCE_STEP = -1

export interface CollisionNoticeSummary {
  leadId: string
  action: 'notified' | 'skipped'
}

type ReplyMode = Database['public']['Enums']['reply_mode']

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName
}

function replySubject(thread: EmailRow[]): string {
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const base = firstOutbound?.subject ?? 'Re: your message'
  return base.startsWith('Re: ') ? base : `Re: ${base}`
}

function buildCollisionNoticeBody(targetFirstName: string, triggeringFirstName: string): string {
  return `Hi ${targetFirstName} — looks like ${triggeringFirstName} already grabbed time with us. `
    + `Happy to keep it to one call, or loop you in too if that'd be useful — just let us know either way!`
}

// Deterministic content, so there is no classification confidence to weigh —
// only human_approve needs a human in the loop.
function collisionDisposition(mode: ReplyMode): 'send' | 'draft' {
  return mode === 'human_approve' ? 'draft' : 'send'
}

// Called from reply.ts right after a case flips to hot_handoff. Fans one
// QStash message per other untouched contact at the same company so a slow
// or failing send to one contact can't block or duplicate another's notice.
export async function triggerCollisionNotice(
  supabase: SupabaseClient<Database>,
  caseId: string,
  triggeringLeadId: string,
): Promise<void> {
  const claimed = await claimCollisionNotice(supabase, caseId)
  if (!claimed) return // another contact at this company already fired the notice

  const others = await listOtherActiveLeadsForCollisionNotice(supabase, caseId, triggeringLeadId)
  for (const lead of others) {
    await publishJson('/api/pipeline/collision-notify', { caseId, leadId: lead.id, triggeringLeadId })
  }
}

// Per-contact worker, invoked by /api/pipeline/collision-notify. The
// isSequenceActiveForLead check is the business-logic guard (skip if they
// replied for real); claimOutboundEmail is the retry-safety guard (skip if
// this exact notice was already sent on a prior delivery of this message).
export async function runCollisionNotice(
  supabase: SupabaseClient<Database>,
  input: { caseId: string; leadId: string; triggeringLeadId: string },
): Promise<CollisionNoticeSummary> {
  const stillUntouched = await isSequenceActiveForLead(supabase, input.leadId)
  if (!stillUntouched) return { leadId: input.leadId, action: 'skipped' }

  const [lead, triggeringLead, campaign] = await Promise.all([
    getLeadById(supabase, input.leadId),
    getLeadById(supabase, input.triggeringLeadId),
    getCampaignForCase(supabase, input.caseId),
  ])
  if (!lead?.email || !triggeringLead || !campaign) {
    return { leadId: input.leadId, action: 'skipped' }
  }

  const thread = await listThreadEmails(supabase, input.leadId)
  const subject = replySubject(thread)
  const body = buildCollisionNoticeBody(firstName(lead.full_name), firstName(triggeringLead.full_name))
  const disposition = collisionDisposition(campaign.reply_mode)

  const claimed = await claimOutboundEmail(supabase, {
    client_id: lead.client_id,
    case_id: input.caseId,
    lead_id: lead.id,
    direction: 'outbound',
    sequence_step: COLLISION_NOTICE_SEQUENCE_STEP,
    subject,
    body,
    status: disposition === 'send' ? 'queued' : 'draft',
  })
  if (!claimed) return { leadId: input.leadId, action: 'skipped' } // already handled by a prior delivery

  if (disposition === 'send') {
    try {
      const sent = await sendViaMailbox(supabase, {
        clientId: lead.client_id,
        mailboxIds: campaign.mailbox_ids,
        to: lead.email,
        subject,
        body,
        purpose: 'reply',
      })
      await markEmailSent(supabase, claimed.id, {
        providerMessageId: sent.providerMessageId, threadId: sent.threadId, mailboxId: sent.mailboxId,
      })
    } catch (error) {
      // RATE_LIMITED is transient: leave the claimed row 'queued' and rethrow
      // so QStash retries the whole delivery, matching sendOrDraftReply.
      if (isAppError(error) && error.code === 'RATE_LIMITED') throw error
      await markEmailFailed(supabase, claimed.id)
      // FORBIDDEN means the address is hard-bounced/suppressed. Retrying
      // cannot help; stop here (the sequence is still stopped below) instead
      // of rethrowing into a QStash retry loop.
      if (isAppError(error) && error.code === 'FORBIDDEN') {
        await logEventSafe({
          clientId: lead.client_id, caseId: input.caseId, actor: ACTOR,
          type: 'reply.send_suppressed', payload: { emailId: claimed.id, leadId: lead.id },
        })
        return { leadId: input.leadId, action: 'skipped' }
      }
      throw error
    }
  }

  await stopSequenceForLead(supabase, input.leadId, 'stopped')
  await logEventSafe({
    clientId: lead.client_id, caseId: input.caseId, actor: ACTOR,
    type: 'case.collision_notified', payload: { leadId: lead.id, triggeringLeadId: input.triggeringLeadId },
  })
  return { leadId: input.leadId, action: 'notified' }
}
