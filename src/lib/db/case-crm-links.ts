import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseCrmLinkRow = Database['public']['Tables']['case_crm_links']['Row']

/**
 * How long a sync claim stays valid. A worker that crashes mid-sync leaves
 * sync_started_at set; past this cutoff another worker may reclaim it, so a
 * crash cannot strand a case permanently. Longer than any realistic sync
 * (a handful of sequential HTTP calls), short enough to self-heal quickly.
 */
export const CRM_SYNC_CLAIM_STALE_MS = 300_000

export interface EnsureCaseCrmLinkInput {
  clientId: string
  caseId: string
  crmConnectionId: string
}

export interface CaseCrmLinkIds {
  externalCompanyId?: string
  externalContactIds?: string[]
  externalDealId?: string
  externalDealUrl?: string
}

export type CrmSyncResult =
  | { status: 'ok' }
  | { status: 'error'; message: string }

/** Truncated so a verbose provider error cannot bloat the row or the UI. */
const MAX_SYNC_ERROR_CHARS = 500

export async function getCaseCrmLink(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CaseCrmLinkRow | null> {
  const { data, error } = await supabase
    .from('case_crm_links')
    .select('*')
    .eq('case_id', caseId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load case CRM link', { caseId, cause: error.message })
  }
  return data
}

/**
 * Race-safe find-or-create on the case_id unique index, the same shape as
 * findOrCreateCase. ignoreDuplicates is deliberately NOT set: the merge-on-
 * conflict returns the existing row, which is what a second sync for an
 * already-linked case needs.
 */
export async function ensureCaseCrmLink(
  supabase: SupabaseClient<Database>,
  input: EnsureCaseCrmLinkInput,
): Promise<CaseCrmLinkRow> {
  const { data, error } = await supabase
    .from('case_crm_links')
    .upsert(
      {
        client_id: input.clientId,
        case_id: input.caseId,
        crm_connection_id: input.crmConnectionId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'case_id' },
    )
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to ensure case CRM link', {
      caseId: input.caseId, cause: error?.message,
    })
  }
  return data
}

/**
 * Atomic single-flight claim: only the caller that actually updates a row gets
 * true and may talk to the CRM. A loser must not proceed — two concurrent
 * status transitions on one case would otherwise create two Deals.
 */
export async function claimCrmSync(
  supabase: SupabaseClient<Database>,
  caseId: string,
  now: Date,
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - CRM_SYNC_CLAIM_STALE_MS).toISOString()
  const { data, error } = await supabase
    .from('case_crm_links')
    .update({ sync_started_at: now.toISOString() })
    .eq('case_id', caseId)
    .or(`sync_started_at.is.null,sync_started_at.lt.${staleBefore}`)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim CRM sync', { caseId, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}

/**
 * Persists external ids as soon as each is obtained, so a retry after a partial
 * failure resumes instead of restarting — which is what stops an orphaned
 * Company or Contact from being created twice.
 */
export async function updateCaseCrmLinkIds(
  supabase: SupabaseClient<Database>,
  caseId: string,
  ids: CaseCrmLinkIds,
): Promise<void> {
  const patch: Database['public']['Tables']['case_crm_links']['Update'] = {
    updated_at: new Date().toISOString(),
  }
  if (ids.externalCompanyId !== undefined) patch.external_company_id = ids.externalCompanyId
  if (ids.externalContactIds !== undefined) patch.external_contact_ids = ids.externalContactIds
  if (ids.externalDealId !== undefined) patch.external_deal_id = ids.externalDealId
  if (ids.externalDealUrl !== undefined) patch.external_deal_url = ids.externalDealUrl

  const { error } = await supabase.from('case_crm_links').update(patch).eq('case_id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case CRM link ids', { caseId, cause: error.message })
  }
}

/** Records the outcome and releases the claim in one write. */
export async function markCrmSyncResult(
  supabase: SupabaseClient<Database>,
  caseId: string,
  result: CrmSyncResult,
): Promise<void> {
  const { error } = await supabase
    .from('case_crm_links')
    .update({
      sync_started_at: null,
      last_synced_at: new Date().toISOString(),
      last_sync_status: result.status,
      last_sync_error: result.status === 'error' ? result.message.slice(0, MAX_SYNC_ERROR_CHARS) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('case_id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to record CRM sync result', { caseId, cause: error.message })
  }
}

/** Most recent successful-or-failed sync across all of a connection's cases. */
export async function getLatestCrmSyncAt(
  supabase: SupabaseClient<Database>,
  crmConnectionId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('case_crm_links')
    .select('last_synced_at')
    .eq('crm_connection_id', crmConnectionId)
    .not('last_synced_at', 'is', null)
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load latest CRM sync time', {
      crmConnectionId, cause: error.message,
    })
  }
  return data?.last_synced_at ?? null
}
