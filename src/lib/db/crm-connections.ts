import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { CrmProviderName } from '@/lib/crm/provider'

export type CrmConnectionRow = Database['public']['Tables']['crm_connections']['Row']

export interface UpsertCrmConnectionInput {
  clientId: string
  // Imported from the provider module rather than re-derived here, so there is
  // exactly one CrmProviderName in the codebase.
  provider: CrmProviderName
  accountLabel: string | null
  accountRef: string | null
  oauth: Record<string, Json>
}

export interface CrmPipelineSelection {
  pipelineId: string
  pipelineLabel: string
  initialStageId: string
  wonStageId: string | null
  lostStageId: string | null
}

export async function getCrmConnectionForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<CrmConnectionRow | null> {
  const { data, error } = await supabase
    .from('crm_connections')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load CRM connection for client', {
      clientId, cause: error.message,
    })
  }
  return data
}

export async function getCrmConnectionById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<CrmConnectionRow | null> {
  const { data, error } = await supabase
    .from('crm_connections')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load CRM connection', { id, cause: error.message })
  }
  return data
}

/**
 * Upsert on the client_id unique constraint: reconnecting (same or different
 * provider) replaces the stored grant in place rather than failing. Pipeline
 * selection is deliberately reset to null so a provider switch cannot leave a
 * stage id from the previous CRM behind — the client re-picks after connecting.
 */
export async function upsertCrmConnection(
  supabase: SupabaseClient<Database>,
  input: UpsertCrmConnectionInput,
): Promise<CrmConnectionRow> {
  const { data, error } = await supabase
    .from('crm_connections')
    .upsert(
      {
        client_id: input.clientId,
        provider: input.provider,
        account_label: input.accountLabel,
        account_ref: input.accountRef,
        oauth: input.oauth,
        pipeline_id: null,
        pipeline_label: null,
        initial_stage_id: null,
        won_stage_id: null,
        lost_stage_id: null,
        status: 'connected',
        status_reason: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' },
    )
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to upsert CRM connection', {
      clientId: input.clientId, provider: input.provider, cause: error?.message,
    })
  }
  return data
}

export async function updateCrmConnectionPipeline(
  supabase: SupabaseClient<Database>,
  id: string,
  selection: CrmPipelineSelection,
): Promise<void> {
  const { error } = await supabase
    .from('crm_connections')
    .update({
      pipeline_id: selection.pipelineId,
      pipeline_label: selection.pipelineLabel,
      initial_stage_id: selection.initialStageId,
      won_stage_id: selection.wonStageId,
      lost_stage_id: selection.lostStageId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update CRM connection pipeline', { id, cause: error.message })
  }
}

export async function updateCrmConnectionTokens(
  supabase: SupabaseClient<Database>,
  id: string,
  oauth: Record<string, Json>,
): Promise<void> {
  const { error } = await supabase
    .from('crm_connections')
    .update({ oauth, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update CRM connection tokens', { id, cause: error.message })
  }
}

/**
 * Parks the connection. enqueueCrmSync short-circuits on status 'error', so
 * this both stops the retry loop and lights the reconnect banner in Settings.
 */
export async function markCrmConnectionError(
  supabase: SupabaseClient<Database>,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from('crm_connections')
    .update({ status: 'error', status_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark CRM connection errored', { id, cause: error.message })
  }
}

/** Cascades to case_crm_links — see the FK comment in migration 0022. */
export async function deleteCrmConnection(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('crm_connections').delete().eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete CRM connection', { id, cause: error.message })
  }
}
