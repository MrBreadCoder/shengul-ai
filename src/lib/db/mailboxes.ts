import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { WarmupProfile } from '@/lib/mailbox/warmup'
import type { MailboxHealth } from '@/lib/mailbox/health'

export type MailboxRow = Database['public']['Tables']['mailboxes']['Row']
export type MailboxInsert = Database['public']['Tables']['mailboxes']['Insert']

export async function insertMailbox(
  supabase: SupabaseClient<Database>,
  row: MailboxInsert,
): Promise<MailboxRow> {
  const { data, error } = await supabase.from('mailboxes').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert mailbox', { cause: error?.message })
  }
  return data
}

export async function getMailboxById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load mailbox', { id, cause: error.message })
  return data
}

// When previousOauth is passed, this becomes a conditional write (compare-and-
// swap on the snapshot the caller originally read): it only persists when the
// row's oauth still matches that snapshot. A concurrent refresh (overlapping
// poll cycle, a send racing a poll) that already wrote a newer token pair
// leaves this a silent no-op instead of clobbering it with a refresh derived
// from stale credentials. Omit it for an unconditional write.
export async function updateMailboxOauth(
  supabase: SupabaseClient<Database>,
  id: string,
  oauth: Record<string, Json>,
  previousOauth?: Record<string, Json>,
): Promise<void> {
  let query = supabase.from('mailboxes').update({ oauth }).eq('id', id)
  if (previousOauth !== undefined) query = query.eq('oauth', previousOauth)
  const { error } = await query
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox oauth', { id, cause: error.message })
}

export async function listMailboxesByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<MailboxRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('mailboxes').select('*').in('id', ids)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list mailboxes by ids', { count: ids.length, cause: error.message })
  }
  return data ?? []
}

// Atomic cap claim via the claim_mailbox_send Postgres function (migration 0012).
// effectiveCap is the warmup-ramped allowance from effectiveDailyCap(); the RPC
// clamps it with least(daily_cap, ...) so a caller can only ever lower the
// ceiling. Returns the updated row when the send is allowed, or null when the
// mailbox is at its cap for today or blocked.
export async function claimMailboxSend(
  supabase: SupabaseClient<Database>,
  mailboxId: string,
  effectiveCap: number,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.rpc('claim_mailbox_send', {
    p_mailbox_id: mailboxId,
    p_effective_cap: effectiveCap,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim mailbox send', { mailboxId, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Cap-free counterpart to claimMailboxSend, for human-written mail only
// (migration 0020). A separate RPC rather than an argument, so the agent's
// capped path cannot accidentally become uncapped. sent_today still increments,
// so the health monitor keeps seeing real volume; a 'blocked' mailbox still
// returns null, because a blocked mailbox is not a cap problem.
export async function claimMailboxSendUncapped(
  supabase: SupabaseClient<Database>,
  mailboxId: string,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.rpc('claim_mailbox_send_uncapped', {
    p_mailbox_id: mailboxId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim uncapped mailbox send', {
      mailboxId, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Sets health plus the machine-readable reason and the moment it changed, so the
// operator can tell an auto-pause from a manual one without reading the audit log.
export async function setMailboxHealth(
  supabase: SupabaseClient<Database>,
  id: string,
  health: MailboxHealth,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ health, health_reason: reason, health_changed_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to set mailbox health', { id, health, cause: error.message })
  }
}

export interface MailboxSendStats {
  sentCount: number
  bouncedCount: number
}

// Outbound volume and hard-bounce count per mailbox since `since`. One grouped
// RPC rather than a query per mailbox — the health sweep and the settings screen
// both need every mailbox at once. SECURITY INVOKER, so an RLS-scoped client
// only gets its own rows.
export async function mailboxSendStats(
  supabase: SupabaseClient<Database>,
  since: Date,
): Promise<Map<string, MailboxSendStats>> {
  const { data, error } = await supabase.rpc('mailbox_send_stats', { p_since: since.toISOString() })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load mailbox send stats', { cause: error.message })
  }
  return new Map(
    (data ?? []).map((row) => [row.mailbox_id, { sentCount: row.sent_count, bouncedCount: row.bounced_count }]),
  )
}

export async function updateMailboxWarmup(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: { warmup_profile: WarmupProfile; warmup_started_at: string | null },
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update(fields).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update mailbox warmup', { id, cause: error.message })
  }
}

export async function updateMailboxMailreachPending(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ mailreach_status: 'pending' }).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to set mailbox mailreach status pending', { id, cause: error.message })
}

export async function updateMailboxMailreachConnected(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: {
    mailreach_account_id: string
    mailreach_status: Database['public']['Enums']['mailreach_status']
    mailreach_started_at: string
    mailreach_enabled: boolean
  },
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update(fields).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to persist mailbox mailreach connection', { id, cause: error.message })
}

// Operator-initiated disconnect: clears the live connection AND the
// enrollment intent. mailreach_started_at is left untouched — a later
// re-enable resumes the day count instead of restarting it.
export async function updateMailboxMailreachDisconnected(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ mailreach_account_id: null, mailreach_status: 'disconnected', mailreach_enabled: false })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to disconnect mailbox from mailreach', { id, cause: error.message })
}

// Client-master-switch-initiated pause: clears the live connection but
// preserves the mailbox's own mailreach_enabled intent, so turning the client
// switch back on knows which mailboxes to reconnect.
export async function clearMailboxMailreachConnection(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ mailreach_account_id: null, mailreach_status: 'disconnected' })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to clear mailbox mailreach connection', { id, cause: error.message })
}

export async function updateMailboxMailreachStats(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: { reputationScore: number | null; syncedAt: string },
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ mailreach_reputation_score: fields.reputationScore, mailreach_stats_synced_at: fields.syncedAt })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox mailreach stats', { id, cause: error.message })
}

export async function listMailboxesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('client_id', clientId)
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailboxes for client', { clientId, cause: error.message })
  return data ?? []
}

// The stats-sync sweep's candidate set — every mailbox currently live on
// Mailreach's side, across every client.
export async function listMailreachConnectedMailboxes(
  supabase: SupabaseClient<Database>,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('mailreach_status', 'connected')
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailreach-connected mailboxes', { cause: error.message })
  return data ?? []
}

export async function resetDailyCounters(supabase: SupabaseClient<Database>): Promise<void> {
  const { error } = await supabase.rpc('reset_mailbox_daily_counters')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to reset mailbox daily counters', { cause: error.message })
  }
}

// Every connected mailbox across all clients — the poll-fanout entry point runs
// with the admin client, so RLS scoping is intentionally bypassed here.
export async function listAllMailboxes(
  supabase: SupabaseClient<Database>,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list mailboxes', { cause: error.message })
  }
  return data ?? []
}

// Persists the opaque polling cursor (Gmail historyId / Graph delta link) after
// a poll cycle completes.
export async function updateInboundCursor(
  supabase: SupabaseClient<Database>,
  id: string,
  cursor: string,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ inbound_cursor: cursor }).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update inbound cursor', { id, cause: error.message })
  }
}

/** The subset the settings screen renders. Excludes OAuth tokens by design. */
export type MailboxSummary = Pick<
  MailboxRow,
  | 'id' | 'provider' | 'email_address' | 'display_name' | 'health' | 'created_at'
  | 'health_reason' | 'warmup_profile' | 'warmup_started_at' | 'daily_cap' | 'sent_today'
  | 'mailreach_enabled' | 'mailreach_started_at' | 'mailreach_status' | 'mailreach_reputation_score'
>

/**
 * Mailboxes the caller is allowed to see. MUST be given an RLS-scoped client,
 * never the admin client: the `mailboxes_select` policy
 * (`is_operator() or client_id = current_client_id()`) is what stops a
 * client-role user from reading another client's connected addresses.
 */
export async function listMailboxesForViewer(
  supabase: SupabaseClient<Database>,
): Promise<MailboxSummary[]> {
  const { data, error } = await supabase
    .from('mailboxes')
    .select(
      'id, provider, email_address, display_name, health, created_at, health_reason, warmup_profile, warmup_started_at, daily_cap, sent_today, mailreach_enabled, mailreach_started_at, mailreach_status, mailreach_reputation_score',
    )
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list mailboxes', { cause: error.message })
  }
  return data ?? []
}
