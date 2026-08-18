import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseRow = Database['public']['Tables']['cases']['Row']
export type CaseStatus = Database['public']['Enums']['case_status']
export type CaseWaitReason = Database['public']['Enums']['case_wait_reason']

// The three mailbox-availability reasons the write-fanout cron (every 5
// minutes) re-checks automatically. 'awaiting_manual_approval' clears via a
// human clicking Approve in /inbox; 'no_viable_leads' clears only if
// discovery adds a new lead — neither is time-based, so neither belongs
// here. See docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md.
export const AUTO_RETRY_WAIT_REASONS: readonly CaseWaitReason[] = [
  'mailreach_gate',
  'daily_cap',
  'no_healthy_mailbox',
]

export interface FindOrCreateCaseInput {
  clientId: string
  campaignId: string
  companyName: string
  companyDomain: string | null
  companyKey: string
}

// Race-safe find-or-create on the (campaign_id, company_key) unique index
// (Task 1 migration): the upsert wins the race for a brand-new key; a loser
// (two verified leads for the same company arriving in the same discovery
// batch) gets ignoreDuplicates' empty result and falls back to a plain read
// of the row the winner just created.
export async function findOrCreateCase(
  supabase: SupabaseClient<Database>,
  input: FindOrCreateCaseInput,
): Promise<CaseRow> {
  const { data: upserted, error: upsertErr } = await supabase
    .from('cases')
    .upsert(
      {
        client_id: input.clientId,
        campaign_id: input.campaignId,
        company_name: input.companyName,
        company_domain: input.companyDomain,
        company_key: input.companyKey,
      },
      { onConflict: 'campaign_id,company_key', ignoreDuplicates: true },
    )
    .select('*')
  if (upsertErr) {
    throw new AppError('DB_ERROR', 'Failed to upsert case', {
      campaignId: input.campaignId, companyKey: input.companyKey, cause: upsertErr.message,
    })
  }
  // length check above guarantees index 0 exists
  if (upserted && upserted.length > 0) return upserted[0]!

  const { data: existing, error: selErr } = await supabase
    .from('cases')
    .select('*')
    .eq('campaign_id', input.campaignId)
    .eq('company_key', input.companyKey)
    .single()
  if (selErr || !existing) {
    throw new AppError('DB_ERROR', 'Case upsert produced no row and none found on fallback lookup', {
      campaignId: input.campaignId, companyKey: input.companyKey, cause: selErr?.message,
    })
  }
  return existing
}

export async function getCaseById(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CaseRow | null> {
  const { data, error } = await supabase.from('cases').select('*').eq('id', caseId).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load case', { caseId, cause: error.message })
  }
  return data
}

// Every call site here sets a non-waiting status, so unconditionally
// clearing wait_reason is always correct — and required: the
// cases_wait_reason_matches_status check constraint (0049) rejects any row
// where status != 'waiting' but wait_reason is still set.
export async function updateCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
  status: CaseStatus,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status, wait_reason: null, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case status', { caseId, status, cause: error.message })
  }
}

export async function updateCaseWaiting(
  supabase: SupabaseClient<Database>,
  caseId: string,
  reason: CaseWaitReason,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status: 'waiting', wait_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case to waiting', { caseId, reason, cause: error.message })
  }
}

// Atomic first-contact claim: only the caller whose update actually flips
// status != 'contacted' -> 'contacted' gets true and should fire the CRM
// sync (approveDraft, first touch). A read-then-write ('read status, then
// write if not contacted') lets two concurrent approvals for different
// leads on the same case both pass the read before either writes, double-
// firing the sync — this closes that race the same way claimCollisionNotice
// closes its own.
export async function claimCaseContacted(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('cases')
    .update({ status: 'contacted', wait_reason: null, updated_at: new Date().toISOString() })
    .eq('id', caseId)
    .neq('status', 'contacted')
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim case contacted transition', { caseId, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}

// Same atomic shape as claimCaseContacted, but restricted to an explicit
// allowlist of source statuses instead of "anything not already contacted".
// A manual first-touch send (send-actions.ts) must not walk a case already
// past first contact — in_conversation/hot_handoff/won/lost/dead — back down
// to 'contacted' just because one lead on a multi-lead case had never had
// its own first-touch outbound; claimCaseContacted's broad `!= contacted`
// would incorrectly claim (and regress) those. A read-then-write against a
// stale `kase.status` snapshot has the same race claimCaseContacted's own
// comment describes — this closes it for callers with a narrower claim rule.
export async function claimCaseContactedFrom(
  supabase: SupabaseClient<Database>,
  caseId: string,
  fromStatuses: readonly CaseStatus[],
): Promise<boolean> {
  const { data, error } = await supabase
    .from('cases')
    .update({ status: 'contacted', wait_reason: null, updated_at: new Date().toISOString() })
    .eq('id', caseId)
    .in('status', fromStatuses)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim case contacted transition', { caseId, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}

// Atomic write claim: only the caller whose update actually flips a
// ready/retryable-waiting case to 'writing' gets the row back and should
// proceed to runWriteForCase. A read-then-write ('read status, then write
// unconditionally') lets two concurrent deliveries for the same case — a
// retried QStash message racing the original, or overlapping fanout ticks —
// both pass the read before either claims, so both would call
// runWriteForCase and could double-send. Same pattern as claimCaseContacted,
// against the criteria write-fanout itself dispatches on.
export async function claimCaseForWriting(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CaseRow | null> {
  const retryReasons = AUTO_RETRY_WAIT_REASONS.join(',')
  const { data, error } = await supabase
    .from('cases')
    .update({ status: 'writing', wait_reason: null, updated_at: new Date().toISOString() })
    .eq('id', caseId)
    .or(`status.eq.ready,and(status.eq.waiting,wait_reason.in.(${retryReasons}))`)
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim case for writing', { caseId, cause: error.message })
  }
  return data?.[0] ?? null
}

// `after` is a keyset cursor (created_at + id of the last row already seen),
// not an offset — offset pagination breaks under concurrent inserts into the
// same status set (QUALITY.md). Lets a caller page past a full page of rows
// it isn't going to use (write-fanout's non-dispatchable 'waiting' cases)
// instead of being stuck re-fetching the same head of the queue.
//
// created_at alone is not unique — a bulk-created batch (discovery/seeding
// inserting many cases in one pass) can leave several rows sharing the exact
// same created_at. A plain `created_at > cursor` filter silently drops any
// sibling of the boundary row that didn't make it into the previous page,
// forever. `id` (a UUID, always unique) breaks the tie: page past a row with
// `created_at > cursor.createdAt`, OR (`created_at == cursor.createdAt` AND
// `id > cursor.id`) — matching the `.order()` below so paging is exhaustive.
export interface CaseListCursor {
  createdAt: string
  id: string
}

export async function listCasesByStatus(
  supabase: SupabaseClient<Database>,
  status: CaseStatus | CaseStatus[],
  limit: number,
  after?: CaseListCursor,
): Promise<CaseRow[]> {
  const base = supabase
    .from('cases')
    .select('*')
    .in('status', Array.isArray(status) ? status : [status])
  const filtered =
    after !== undefined
      ? base.or(`created_at.gt.${after.createdAt},and(created_at.eq.${after.createdAt},id.gt.${after.id})`)
      : base
  const { data, error } = await filtered
    .order('created_at', { ascending: true })
    .order('id', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list cases by status', { status, cause: error.message })
  }
  return data ?? []
}

// Cases stranded mid-research/write (see migration 0006). Delegates the
// completeness logic to the find_stuck_cases RPC so the ambiguous 'contacted'
// state is only reported when leads still lack their first-touch email.
export async function listStuckCases(
  supabase: SupabaseClient<Database>,
  cutoffIso: string,
  limit: number,
): Promise<CaseRow[]> {
  const { data, error } = await supabase.rpc('find_stuck_cases', {
    p_cutoff: cutoffIso,
    p_limit: limit,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list stuck cases', { cutoffIso, cause: error.message })
  }
  return data ?? []
}

// Atomic claim: only the first caller for a case gets true and should proceed
// to fan out notices to other contacts at that company. A concurrent or
// later call for the same case (e.g. a second contact also reaching
// hot_handoff) returns false and must no-op.
export async function claimCollisionNotice(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('cases')
    .update({ collision_notified_at: new Date().toISOString() })
    .eq('id', caseId)
    .is('collision_notified_at', null)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim collision notice for case', { caseId, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}

// Blast-radius count for the campaign delete confirmation dialog — a head
// count avoids fetching every case row just to show a number.
export async function countCasesForCampaign(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('cases')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count cases for campaign', { campaignId, cause: error.message })
  }
  return count ?? 0
}
