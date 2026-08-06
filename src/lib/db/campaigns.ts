import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CampaignRow = Database['public']['Tables']['campaigns']['Row']
export type CampaignInsert = Database['public']['Tables']['campaigns']['Insert']

export async function insertCampaign(
  supabase: SupabaseClient<Database>,
  row: CampaignInsert,
): Promise<CampaignRow> {
  const { data, error } = await supabase.from('campaigns').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert campaign', { cause: error?.message })
  }
  return data
}

export async function getCampaignById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<CampaignRow | null> {
  const { data, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load campaign', { id, cause: error.message })
  return data
}

export async function listActiveCampaigns(
  supabase: SupabaseClient<Database>,
): Promise<CampaignRow[]> {
  const { data, error } = await supabase.from('campaigns').select('*').eq('status', 'active')
  if (error) throw new AppError('DB_ERROR', 'Failed to list active campaigns', { cause: error.message })
  return data ?? []
}

export async function listCampaignsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string | null,
): Promise<CampaignRow[]> {
  const base = supabase.from('campaigns').select('*').order('created_at', { ascending: false })
  const { data, error } = clientId ? await base.eq('client_id', clientId) : await base
  if (error) throw new AppError('DB_ERROR', 'Failed to list campaigns', { cause: error.message })
  return data ?? []
}

// Scrubs a deleted mailbox out of every one of the client's campaigns that
// still lists it. Supabase's query builder has no array_remove, so this reads
// the small candidate set (one client's campaigns) and writes back the
// filtered array per row rather than a single set-based statement. Safe to
// call even if the id is not assigned to anything — the filter just no-ops.
export async function removeMailboxFromCampaigns(
  supabase: SupabaseClient<Database>,
  clientId: string,
  mailboxId: string,
): Promise<void> {
  const campaigns = await listCampaignsForClient(supabase, clientId)
  const affected = campaigns.filter((campaign) => campaign.mailbox_ids.includes(mailboxId))
  for (const campaign of affected) {
    const { error } = await supabase
      .from('campaigns')
      .update({ mailbox_ids: campaign.mailbox_ids.filter((id) => id !== mailboxId) })
      .eq('id', campaign.id)
    if (error) {
      throw new AppError('DB_ERROR', 'Failed to remove mailbox from campaign', {
        campaignId: campaign.id, mailboxId, cause: error.message,
      })
    }
  }
}

// Loads the campaign that owns a case, via a case → campaign lookup. Returns
// null if the case or its campaign is missing.
export async function getCampaignForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CampaignRow | null> {
  const { data, error } = await supabase
    .from('cases')
    .select('campaign:campaigns(*)')
    .eq('id', caseId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load campaign for case', { caseId, cause: error.message })
  }
  const campaign = (data as { campaign: CampaignRow | null } | null)?.campaign ?? null
  return campaign
}

// Only flips campaigns that were actually running — an already-paused or
// already-archived campaign the operator set aside deliberately stays as-is.
export async function pauseActiveCampaignsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ status: 'paused' })
    .eq('client_id', clientId)
    .eq('status', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to pause campaigns for client', { clientId, cause: error.message })
  }
}

// Symmetric counterpart used by both "resume" and "reactivate". There is no
// per-campaign pause toggle in this product yet, so every one of this
// client's paused campaigns is assumed to have been paused by the client-level
// action being reversed here.
export async function resumeCampaignsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ status: 'active' })
    .eq('client_id', clientId)
    .eq('status', 'paused')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to resume campaigns for client', { clientId, cause: error.message })
  }
}

// No status filter, unlike pauseActiveCampaignsForClient/resumeCampaignsForClient
// — every campaign (active, paused, or archived) must reflect the client's
// current preference immediately, so a paused campaign is already correct if
// it is ever resumed.
export async function syncReplyModeForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  mode: Database['public']['Enums']['reply_mode'],
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ reply_mode: mode })
    .eq('client_id', clientId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to sync reply mode for client', { clientId, cause: error.message })
  }
}

export async function updateCampaignStatus(
  supabase: SupabaseClient<Database>,
  id: string,
  status: CampaignRow['status'],
): Promise<CampaignRow> {
  const { data, error } = await supabase.from('campaigns').update({ status }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update campaign status', { id, status, cause: error?.message })
  }
  return data
}

export interface CampaignSettingsPatch {
  name: string
  value_prop: string
  booking_link: string | null
  daily_target: number
  icp: Json
}

// Full-replace update of a campaign's editable settings (name, value prop,
// booking link, daily target, ICP). client_id and status are not part of
// this patch — status has its own updateCampaignStatus, client_id is
// immutable once a campaign exists.
export async function updateCampaignSettings(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: CampaignSettingsPatch,
): Promise<CampaignRow> {
  const { data, error } = await supabase.from('campaigns').update(patch).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update campaign settings', { id, cause: error?.message })
  }
  return data
}

// Every FK to campaigns carries `on delete cascade` — this permanently
// removes every case, lead, email, and sequence row for this campaign.
// Callers must have already confirmed this with the operator before calling.
export async function deleteCampaign(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase.from('campaigns').delete().eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete campaign', { id, cause: error.message })
}
