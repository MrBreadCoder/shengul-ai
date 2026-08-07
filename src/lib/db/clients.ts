import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { WarmupProfile } from '@/lib/mailbox/warmup'
import type { AppLocale } from '@/types/i18n'

export type ClientRow = Database['public']['Tables']['clients']['Row']
export type ClientInsert = Database['public']['Tables']['clients']['Insert']
export type ClientOption = Pick<ClientRow, 'id' | 'name'>
export type AppUserRow = Database['public']['Tables']['app_users']['Row']
export type AppUserInsert = Database['public']['Tables']['app_users']['Insert']

export async function listClients(supabase: SupabaseClient<Database>): Promise<ClientOption[]> {
  const { data, error } = await supabase.from('clients').select('id, name').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list clients', { cause: error.message })
  return data ?? []
}

export async function listClientsFull(supabase: SupabaseClient<Database>): Promise<ClientRow[]> {
  const { data, error } = await supabase.from('clients').select('*').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list clients', { cause: error.message })
  return data ?? []
}

export async function insertClient(
  supabase: SupabaseClient<Database>,
  row: ClientInsert,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert client', { cause: error?.message })
  }
  return data
}

export async function getClientById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ClientRow | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load client', { id, cause: error.message })
  return data
}

// All client-role logins across every client, in one query — the admin page
// renders every client at once and must not issue one query per row.
export async function listClientRoleAppUsers(
  supabase: SupabaseClient<Database>,
): Promise<AppUserRow[]> {
  const { data, error } = await supabase.from('app_users').select('*').eq('role', 'client')
  if (error) throw new AppError('DB_ERROR', 'Failed to list client app_users', { cause: error.message })
  return data ?? []
}

export async function insertAppUser(
  supabase: SupabaseClient<Database>,
  row: AppUserInsert,
): Promise<void> {
  const { error } = await supabase.from('app_users').insert(row)
  if (error) throw new AppError('DB_ERROR', 'Failed to insert app_user', { cause: error.message })
}

// Removes the role/client link only. The Supabase Auth user is a separate
// resource with no FK to this table, so callers must delete it themselves —
// see `deleteAuthUser`, which the users route calls *first* for exactly that
// reason.
export async function deleteAppUser(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase.from('app_users').delete().eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete app_user', { id, cause: error.message })
}

const DEMO_CLIENT_NAME = 'Demo Client'

// P0 has no campaign/client UI. The operator demo attaches mailboxes to a single
// stable "Demo Client". Idempotent: returns the existing row's id or creates it.
export async function getOrCreateOperatorClient(
  supabase: SupabaseClient<Database>,
): Promise<string> {
  const { data: existing, error: selErr } = await supabase
    .from('clients').select('id').eq('name', DEMO_CLIENT_NAME).maybeSingle()
  if (selErr) throw new AppError('DB_ERROR', 'Failed to look up demo client', { cause: selErr.message })
  if (existing) return existing.id

  const { data: created, error: insErr } = await supabase
    .from('clients').insert({ name: DEMO_CLIENT_NAME }).select('id').single()
  if (insErr || !created) throw new AppError('DB_ERROR', 'Failed to create demo client', { cause: insErr?.message })
  return created.id
}

// Mailbox-connect routes call this instead of `getOrCreateOperatorClient`
// directly so the same connect/callback code path works for both roles: an
// operator's mailboxes land on the shared demo client, a client-role user's
// land on their own. `client_id` is nullable on `app_users` only because the
// column is shared with the `operator` role — a `client`-role row is always
// provisioned with one (see the invite flow), so a null here means the
// account is in a state the UI should never have allowed to reach this call.
export async function resolveMailboxClientId(
  supabase: SupabaseClient<Database>,
  appUser: Pick<AppUserRow, 'role' | 'client_id'>,
): Promise<string> {
  switch (appUser.role) {
    case 'operator':
      return getOrCreateOperatorClient(supabase)
    case 'client': {
      if (appUser.client_id === null) {
        throw new AppError('FORBIDDEN', 'Client user has no client_id assigned', {
          role: appUser.role,
        })
      }
      return appUser.client_id
    }
    default: {
      const exhaustive: never = appUser.role
      throw new AppError('INVARIANT_VIOLATION', `Unknown app user role: ${String(exhaustive)}`, {})
    }
  }
}

export async function updateClientName(
  supabase: SupabaseClient<Database>,
  id: string,
  name: string,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update({ name }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to rename client', { id, cause: error?.message })
  }
  return data
}

// The client-level default. Mailboxes snapshot it at connect time rather than
// reading it live, so changing this never retro-ramps a mailbox already in
// service — use the per-mailbox warmup route for that.
export async function updateClientWarmupProfile(
  supabase: SupabaseClient<Database>,
  id: string,
  profile: WarmupProfile,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ warmup_profile: profile })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client warmup profile', { id, cause: error?.message })
  }
  return data
}

export async function updateClientMailreachEnabled(
  supabase: SupabaseClient<Database>,
  id: string,
  enabled: boolean,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ mailreach_enabled: enabled })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client mailreach_enabled', { id, cause: error?.message })
  }
  return data
}

// `null` clears the website — used both by the "Website" edit control and by
// the domain-favicon fallback in CompanyMark, so leaving it unset just means
// no auto-fetched logo is available yet.
export async function updateClientDomain(
  supabase: SupabaseClient<Database>,
  id: string,
  domain: string | null,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update({ domain }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client domain', { id, cause: error?.message })
  }
  return data
}

export interface ClientSignatureUpdate {
  phone: string | null
  address: string | null
  signatureName: string | null
  signatureTitle: string | null
}

// Single combined update — the operator edits phone/address/signatureName/
// signatureTitle from one dialog in one submit, so there's one write path
// rather than four independent single-field updates like updateClientDomain.
export async function updateClientSignature(
  supabase: SupabaseClient<Database>,
  id: string,
  update: ClientSignatureUpdate,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({
      phone: update.phone,
      address: update.address,
      signature_name: update.signatureName,
      signature_title: update.signatureTitle,
    })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client signature', { id, cause: error?.message })
  }
  return data
}

// `null` reverts the client back to its domain favicon (or initials, if no
// domain is set either). Callers are responsible for deleting the storage
// object behind the previous `logo_url`, if any.
export async function updateClientLogoUrl(
  supabase: SupabaseClient<Database>,
  id: string,
  logoUrl: string | null,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update({ logo_url: logoUrl }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client logo', { id, cause: error?.message })
  }
  return data
}

export async function updateClientReplyMode(
  supabase: SupabaseClient<Database>,
  id: string,
  mode: Database['public']['Enums']['reply_mode'],
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ reply_mode: mode })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client reply mode', { id, cause: error?.message })
  }
  return data
}

export async function updateClientDefaultLocale(
  supabase: SupabaseClient<Database>,
  id: string,
  locale: AppLocale,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ default_locale: locale })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client default locale', { id, cause: error?.message })
  }
  return data
}

// The client-level default. Sequences snapshot it at creation time rather
// than reading it live (see scheduleFirstFollowup in lib/pipeline/followup.ts),
// so changing this never retroactively reschedules a sequence already
// running — a per-lead override on that sequence's own row does that.
export async function updateClientFollowupDelays(
  supabase: SupabaseClient<Database>,
  id: string,
  delaysDays: number[],
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ followup_delays_days: delaysDays })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client follow-up delays', { id, cause: error?.message })
  }
  return data
}

export interface ClientSchedulePatch {
  timezone: string
  default_discover_time: string
}

// The client-level default discovery schedule. Campaigns that don't set
// their own discover_time/discover_timezone override inherit this — see
// recomputeClientCampaignSchedules in lib/db/campaigns.ts, called by the
// caller of this function right after it succeeds.
export async function updateClientSchedule(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: ClientSchedulePatch,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update(patch).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client schedule', { id, cause: error?.message })
  }
  return data
}

export async function updateClientStatus(
  supabase: SupabaseClient<Database>,
  id: string,
  status: ClientRow['status'],
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update({ status }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client status', { id, status, cause: error?.message })
  }
  return data
}

// Every FK to clients carries `on delete cascade` — this permanently removes
// every campaign, case, lead, email, sequence, mailbox, suppression, event,
// and app_users row for this client. Callers must delete the corresponding
// Supabase Auth users separately (auth.users has no FK to clients), and must
// have already confirmed this with the operator before calling.
export async function deleteClientCascade(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete client', { id, cause: error.message })
}
