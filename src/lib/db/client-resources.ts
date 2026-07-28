import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type ClientResourceRow = Database['public']['Tables']['client_resources']['Row']

export interface InsertClientResourceInput {
  clientId: string
  createdBy: string
  title: string
  description: string
  fileName: string
  mimeType: string
  byteSize: number
  storagePath: string
}

export async function insertClientResource(
  supabase: SupabaseClient<Database>,
  input: InsertClientResourceInput,
): Promise<ClientResourceRow> {
  const { data, error } = await supabase
    .from('client_resources')
    .insert({
      client_id: input.clientId,
      created_by: input.createdBy,
      title: input.title,
      description: input.description,
      file_name: input.fileName,
      mime_type: input.mimeType,
      byte_size: input.byteSize,
      storage_path: input.storagePath,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert resource', {
      clientId: input.clientId, cause: error?.message,
    })
  }
  return data
}

// Newest first so the AI menu's ordinals are stable within a run and recent
// collateral surfaces before stale collateral once the menu is capped.
export async function listActiveResourcesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  limit: number,
): Promise<ClientResourceRow[]> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list resources', { clientId, cause: error.message })
  }
  return data ?? []
}

/**
 * Per-client libraries for a page that renders rows from several clients at
 * once, keyed by client id.
 *
 * One query per client rather than one `.in()` with a shared ceiling: a shared
 * ceiling is spent in `created_at` order across every client, so one busy client
 * silently starves the rest of an empty picker. `clientIds` is bounded by the
 * clients that actually have rows on the page, and the queries run in parallel,
 * so this costs one round trip.
 */
export async function listActiveResourcesForClients(
  supabase: SupabaseClient<Database>,
  clientIds: readonly string[],
  perClientLimit: number,
): Promise<Map<string, ClientResourceRow[]>> {
  const unique = [...new Set(clientIds)]
  if (unique.length === 0) return new Map()

  const lists = await Promise.all(
    unique.map((clientId) => listActiveResourcesForClient(supabase, clientId, perClientLimit)),
  )
  // safe: lists is mapped from unique, so the indexes line up exactly
  return new Map(unique.map((clientId, index) => [clientId, lists[index]!]))
}

// No client filter: RLS decides what the caller sees. Pass a session-bound
// server client — an operator gets every client's resources, a client-role
// session only its own.
export async function listActiveResourcesForVisibleClients(
  supabase: SupabaseClient<Database>,
  limit: number,
): Promise<ClientResourceRow[]> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list resources', { cause: error.message })
  }
  return data ?? []
}

export async function getResourceById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ClientResourceRow | null> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load resource', { id, cause: error.message })
  return data
}

// Client-scoped on purpose: this is the lookup that turns model-supplied or
// form-supplied ids into real files, so an id belonging to another client must
// not resolve even when the caller holds the service-role key.
export async function getActiveResourcesByIds(
  supabase: SupabaseClient<Database>,
  clientId: string,
  ids: readonly string[],
): Promise<ClientResourceRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .in('id', [...ids])
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load resources', { clientId, cause: error.message })
  }
  return data ?? []
}

// Soft delete. The `.eq('is_active', true)` guard makes it a claim: a second
// concurrent delete gets null and must not re-remove the storage object.
export async function deactivateClientResource(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ClientResourceRow | null> {
  const { data, error } = await supabase
    .from('client_resources')
    .update({ is_active: false })
    .eq('id', id)
    .eq('is_active', true)
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to deactivate resource', { id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
