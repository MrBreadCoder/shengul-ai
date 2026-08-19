import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EmailRow = Database['public']['Tables']['emails']['Row']
export type EmailInsert = Database['public']['Tables']['emails']['Insert']

// Claims the (lead_id, sequence_step, direction) slot. ignoreDuplicates makes a
// QStash retry idempotent: a slot already claimed by a row that is still
// pending/sent returns no row here, so the caller knows this step was already
// handled and must not send again. A slot left at `status: 'failed'` (the
// send itself threw — see write.ts/followup.ts) is NOT "already handled": it
// falls through to reclaimFailedOutboundEmail so a transient send failure can
// actually be retried instead of permanently occupying the unique slot.
export async function claimOutboundEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .upsert(row, { onConflict: 'lead_id,sequence_step,direction', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim outbound email', {
      leadId: row.lead_id, step: row.sequence_step, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  if (data && data.length > 0) return data[0]!
  return reclaimFailedOutboundEmail(supabase, row)
}

// The `.eq('status', 'failed')` guard makes this an atomic claim: only one
// concurrent retry can win the reclaim, matching the semantics of the
// ignoreDuplicates upsert above for a genuinely free slot.
async function reclaimFailedOutboundEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  // lead_id/sequence_step are optional on the Insert type (nullable columns),
  // but the (lead_id, sequence_step, direction) unique index this reclaims
  // against requires both — every real caller of claimOutboundEmail sets them.
  const { lead_id: leadId, sequence_step: sequenceStep } = row
  if (leadId == null || sequenceStep == null) {
    throw new AppError('INVARIANT_VIOLATION', 'claimOutboundEmail requires lead_id and sequence_step', {})
  }
  const { data, error } = await supabase
    .from('emails')
    .update({
      subject: row.subject,
      body: row.body,
      status: row.status,
      thread_id: row.thread_id ?? null,
    })
    .eq('lead_id', leadId)
    .eq('sequence_step', sequenceStep)
    .eq('direction', row.direction)
    .eq('status', 'failed')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to reclaim failed outbound email', {
      leadId, step: sequenceStep, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Inserts an inbound email, deduped on provider_message_id (unique index from
// migration 0007). ignoreDuplicates makes overlapping poll cycles idempotent:
// an already-ingested message returns no row, so the caller skips re-processing.
export async function insertInboundEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .upsert(row, { onConflict: 'provider_message_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert inbound email', {
      providerMessageId: row.provider_message_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

export async function getEmailByProviderMessageId(
  supabase: SupabaseClient<Database>,
  providerMessageId: string,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('provider_message_id', providerMessageId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load email by provider message id', { providerMessageId, cause: error.message })
  }
  return data
}

// Claims the single "reply to this inbound" outbound slot (unique index on
// in_reply_to_email_id). A retried /api/inbound/reply delivery that finds the
// slot taken returns null and must not send a second reply.
export async function claimReplyEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .upsert(row, { onConflict: 'in_reply_to_email_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim reply email', {
      inReplyToEmailId: row.in_reply_to_email_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// A human-written email that is not a cadence step. sequence_step is null, so
// the (lead_id, sequence_step, direction) unique index cannot claim it — and
// should not: many manual messages per lead are legitimate, and Postgres allows
// unlimited nulls in a unique index. Used only when claimOutboundEmail found the
// step-0 slot already taken.
export async function insertManualEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow> {
  const { data, error } = await supabase.from('emails').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert manual email', {
      leadId: row.lead_id, cause: error?.message ?? 'no row returned',
    })
  }
  return data
}

// Atomically transitions a single draft to 'queued'. The `.eq('status','draft')`
// guard makes this a claim: only the first concurrent caller (double-click, two
// tabs, a Server Action retry) matches a row and gets it back — everyone else
// gets an empty result and must NOT send. Prevents a TOCTOU double-send on the
// human-approval path. Run with an admin client so RLS can't silently no-op it.
export async function claimDraftForSend(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .update({ status: 'queued' })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim draft for send', { id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Same atomic-claim shape as claimDraftForSend: the `.eq('status','draft')`
// guard means a concurrent approval (double-click, two tabs, an approval that
// landed while this edit was in flight) makes this a no-op that returns null
// instead of silently overwriting a row that has already gone out. Used by
// both a manual Save and an AI Redesign in /inbox — one write path for both.
export async function updateDraftContent(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: { subject: string; body: string },
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .update({ subject: patch.subject, body: patch.body })
    .eq('id', id)
    .eq('status', 'draft')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update draft content', { id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

export async function markEmailSent(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: { providerMessageId: string; threadId: string; mailboxId: string },
): Promise<void> {
  const { error } = await supabase
    .from('emails')
    .update({
      status: 'sent',
      provider_message_id: patch.providerMessageId,
      thread_id: patch.threadId,
      mailbox_id: patch.mailboxId,
      sent_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email sent', { id, cause: error.message })
  }
}

export async function markEmailFailed(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('emails').update({ status: 'failed' }).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email failed', { id, cause: error.message })
  }
}

// Content already exists on this row (generated, or client-approved) and a
// real send hit RATE_LIMITED — park it as-is for the drain sweep
// (lib/pipeline/resend-failed.ts) to retry verbatim. Distinct from
// markEmailFailed, which is reserved for a genuine, non-auto-retryable
// delivery error.
export async function markEmailWaiting(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('emails').update({ status: 'waiting' }).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email waiting', { id, cause: error.message })
  }
}

export async function listThreadEmails(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list thread emails', { leadId, cause: error.message })
  }
  return data ?? []
}

// Whether a reply has already been claimed/sent for this inbound (unique
// index on in_reply_to_email_id) — used to decide if it is still safe to
// resume an interrupted knowledge-answer pipeline.
export async function hasReplyForInbound(
  supabase: SupabaseClient<Database>,
  inboundEmailId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('emails')
    .select('id', { count: 'exact', head: true })
    .eq('in_reply_to_email_id', inboundEmailId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check reply for inbound', { inboundEmailId, cause: error.message })
  }
  return (count ?? 0) > 0
}

export async function hasInboundReply(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('emails')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('direction', 'inbound')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check inbound reply', { leadId, cause: error.message })
  }
  return (count ?? 0) > 0
}

// RLS-scoped: pass a session-bound server client so a client role only sees
// their own drafts. Used by /inbox (human_approve / hybrid queue).
export async function listDraftEmailsForClient(
  supabase: SupabaseClient<Database>,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('status', 'draft')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list draft emails', { cause: error.message })
  }
  return data ?? []
}

export async function getEmailById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailRow | null> {
  const { data, error } = await supabase.from('emails').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load email', { id, cause: error.message })
  }
  return data
}

// Full outbound + inbound history for one case, oldest first, so the case
// timeline reads top-to-bottom like a conversation.
export async function listEmailsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list emails for case', { caseId, cause: error.message })
  }
  return data ?? []
}

export interface EmailFilter {
  direction?: Database['public']['Enums']['email_direction']
  status?: Database['public']['Enums']['email_status']
  caseId?: string
  limit: number
}

// Client-wide mail browser. RLS scopes the rows; this only orders and narrows.
// Sorted by coalesce(sent_at, created_at) is not expressible in PostgREST, so we
// order by created_at — for drafts sent_at is null anyway, and for sent mail the
// two are within seconds of each other.
export async function listEmailsForClient(
  supabase: SupabaseClient<Database>,
  filter: EmailFilter,
): Promise<EmailRow[]> {
  let query = supabase.from('emails').select('*')
  if (filter.direction) query = query.eq('direction', filter.direction)
  if (filter.status) query = query.eq('status', filter.status)
  if (filter.caseId) query = query.eq('case_id', filter.caseId)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(filter.limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list emails for client', { cause: error.message })
  }
  return data ?? []
}

// Every 'waiting' outbound row, oldest first — first-touch and follow-up
// steps alike (no sequence_step filter). Drives the drain sweep
// (lib/pipeline/resend-failed.ts): each row's content is resent verbatim,
// never regenerated. Oldest-first ordering is what gives already-committed
// content priority over the same day's brand-new work once the cap resets.
export async function listWaitingOutboundEmails(
  supabase: SupabaseClient<Database>,
  limit: number,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('status', 'waiting')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list waiting outbound emails', { cause: error.message })
  }
  return data ?? []
}

// Distinct leads on a case whose first-touch already has real content
// parked 'waiting' — lets runWriteForCase (write.ts) skip calling the LLM
// again for a lead the drain sweep already owns, instead of generating a
// fresh draft that would just get discarded when the claim no-ops.
export async function listWaitingLeadIds(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('emails')
    .select('lead_id')
    .eq('case_id', caseId)
    .eq('sequence_step', 0)
    .eq('status', 'waiting')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list waiting lead ids', { caseId, cause: error.message })
  }
  return new Set((data ?? []).flatMap((row) => (row.lead_id ? [row.lead_id] : [])))
}

// Reclaims a specific 'waiting' row for the drain sweep — resend-failed.ts
// only, never the generation paths. The `.eq('status', 'waiting')` guard
// makes this atomic (only one concurrent sweep tick can win a given row) and
// is also the reason this is a SEPARATE function from
// reclaimFailedOutboundEmail rather than a widened version of it:
// claimOutboundEmail's reclaim must keep matching 'failed' only, so a
// 'waiting' row stays invisible to the generation paths (processLead,
// runFollowupStep) — that's what stops a mistaken re-dispatch from
// overwriting already-committed content. See markEmailWaiting's callers.
export async function claimWaitingOutboundEmail(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .update({ status: 'queued' })
    .eq('id', id)
    .eq('status', 'waiting')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim waiting outbound email', { id, cause: error.message })
  }
  return data && data.length > 0 ? data[0]! : null
}

// Flips the newest delivered/sent outbound email for a lead to 'bounced' — this
// is what makes the address show up in mailbox_send_stats' bounce numerator.
// The status guard on the update makes it a claim: a concurrent DSN for the same
// message cannot double-count. Returns null when there is nothing to flip (a
// bounce for mail we have no record of sending).
export async function markLatestOutboundBounced(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<EmailRow | null> {
  const { data: candidates, error: lookupError } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', leadId)
    .eq('direction', 'outbound')
    .in('status', ['sent', 'delivered'])
    .order('sent_at', { ascending: false })
    .limit(1)
  if (lookupError) {
    throw new AppError('DB_ERROR', 'Failed to find outbound email to mark bounced', {
      leadId, cause: lookupError.message,
    })
  }
  const target = candidates?.[0]
  if (!target) return null

  const { data, error } = await supabase
    .from('emails')
    .update({ status: 'bounced' })
    .eq('id', target.id)
    .in('status', ['sent', 'delivered'])
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email bounced', { leadId, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
