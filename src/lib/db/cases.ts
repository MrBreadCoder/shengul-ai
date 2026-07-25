import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseRow = Database['public']['Tables']['cases']['Row']
export type CaseStatus = Database['public']['Enums']['case_status']

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

export async function updateCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
  status: CaseStatus,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case status', { caseId, status, cause: error.message })
  }
}

export async function listCasesByStatus(
  supabase: SupabaseClient<Database>,
  status: CaseStatus,
  limit: number,
): Promise<CaseRow[]> {
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: true })
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
