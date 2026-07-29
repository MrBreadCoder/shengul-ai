import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type SequenceRow = Database['public']['Tables']['sequences']['Row']
export type SequenceInsert = Database['public']['Tables']['sequences']['Insert']

// ignoreDuplicates on the (lead_id) unique index: a retried write can't create a
// second sequence for the same lead. Returns null when one already exists.
export async function createSequence(
  supabase: SupabaseClient<Database>,
  row: SequenceInsert,
): Promise<SequenceRow | null> {
  const { data, error } = await supabase
    .from('sequences')
    .upsert(row, { onConflict: 'lead_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to create sequence', {
      leadId: row.lead_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

export async function getSequenceById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<SequenceRow | null> {
  const { data, error } = await supabase.from('sequences').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load sequence', { id, cause: error.message })
  }
  return data
}

// The `.eq('state', 'active')` guard makes this a claim: a stale/duplicate
// QStash job for a sequence a concurrent run already stopped or completed
// matches no row and must not reactivate it.
export async function advanceSequence(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: { currentStep: number; nextActionAt: string | null; qstashMessageId: string | null },
): Promise<void> {
  const { data, error } = await supabase
    .from('sequences')
    .update({
      current_step: patch.currentStep,
      next_action_at: patch.nextActionAt,
      qstash_message_id: patch.qstashMessageId,
      state: 'active',
    })
    .eq('id', id)
    .eq('state', 'active')
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to advance sequence', { id, cause: error.message })
  }
  if (!data || data.length === 0) {
    throw new AppError('DB_ERROR', 'Sequence is not active; refused to advance', { id })
  }
}

export async function stopSequence(
  supabase: SupabaseClient<Database>,
  id: string,
  state: 'stopped' | 'completed',
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ state, next_action_at: null, qstash_message_id: null })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to stop sequence', { id, state, cause: error.message })
  }
}

// Inbound reply arrived: pause the lead's active sequence so the pending QStash
// follow-up no-ops (runFollowupStep skips when state !== 'active'). Guarded on
// state = 'active' so a stopped/completed sequence is never reactivated.
export async function pauseActiveSequenceForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ state: 'paused', next_action_at: null })
    .eq('lead_id', leadId)
    .eq('state', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to pause sequence for lead', { leadId, cause: error.message })
  }
}

// Terminally stops the lead's sequence (price handoff / opt-out). Matches active
// or paused rows so a reply that already paused the sequence is still stopped.
export async function stopSequenceForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
  state: 'stopped' | 'completed',
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ state, next_action_at: null, qstash_message_id: null })
    .eq('lead_id', leadId)
    .in('state', ['active', 'paused'])
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to stop sequence for lead', { leadId, state, cause: error.message })
  }
}

// Fresh point-in-time check used by the collision-notice worker: the fan-out
// step (triggerCollisionNotice) takes a snapshot of "untouched" contacts, but
// time passes before each QStash message is processed, so a target may have
// replied for real in the interim (which already paused their sequence via
// pauseActiveSequenceForLead). A real conversation always wins over a canned
// notice.
export async function isSequenceActiveForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('sequences')
    .select('id')
    .eq('lead_id', leadId)
    .eq('state', 'active')
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check sequence state for lead', { leadId, cause: error.message })
  }
  return data !== null
}

// A human interjected into this lead's cadence: mark the next scheduled step to
// be skipped when its QStash message fires. Guarded on 'active' — a stopped or
// completed sequence has no next step to skip. Idempotent by construction: two
// manual sends before the next firing still skip exactly one step, which is the
// intended reading of "don't let the agent talk over me".
export async function requestFollowupSkip(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ skip_next_step: true })
    .eq('lead_id', leadId)
    .eq('state', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to request follow-up skip', { leadId, cause: error.message })
  }
}

// Claims the pending skip. The `.eq('skip_next_step', true)` guard is what makes
// this a claim rather than a write: a duplicate QStash delivery that arrives
// after the flag was consumed matches no row, gets false, and must not enqueue a
// second copy of the next step.
//
// Deliberately does NOT advance current_step. The caller advances only after the
// next step is successfully enqueued, so a publish failure leaves the sequence
// at step N-1 with the flag gone — the QStash retry then sends a real nudge
// instead of skipping. Losing a skip is strictly better than a cadence that
// silently ends.
export async function consumeFollowupSkip(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('sequences')
    .update({ skip_next_step: false })
    .eq('id', id)
    .eq('state', 'active')
    .eq('skip_next_step', true)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to consume follow-up skip', { id, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}
