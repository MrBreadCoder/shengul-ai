import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type InviteLinkRow = Database['public']['Tables']['invite_links']['Row']
export type InviteLinkInsert = Database['public']['Tables']['invite_links']['Insert']

export async function insertInviteLink(
  supabase: SupabaseClient<Database>,
  row: InviteLinkInsert,
): Promise<void> {
  const { error } = await supabase.from('invite_links').insert(row)
  if (error) throw new AppError('DB_ERROR', 'Failed to insert invite link', { cause: error.message })
}

/**
 * Looks a link up by token hash without judging whether it is still valid.
 *
 * Expiry is deliberately left to the caller: an expired row and a missing row
 * need different answers on screen — "ask for a new link" versus "this link
 * was never real" — and filtering on `expires_at` here would collapse the two
 * into a single null.
 */
export async function getInviteLinkByTokenHash(
  supabase: SupabaseClient<Database>,
  tokenHash: string,
): Promise<InviteLinkRow | null> {
  const { data, error } = await supabase
    .from('invite_links')
    .select('*')
    .eq('token_hash', tokenHash)
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load invite link', { cause: error.message })
  return data
}

/**
 * Drops every invite for one user.
 *
 * Called when a fresh link is issued for the same person, so re-inviting
 * cannot leave two live links against one account, and after a password is
 * set, so a link cannot outlive the setup it existed for.
 */
export async function deleteInviteLinksForUser(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<void> {
  const { error } = await supabase.from('invite_links').delete().eq('user_id', userId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete invite links', { userId, cause: error.message })
  }
}

/** Removes rows that lapsed before `before`. Housekeeping only. */
export async function deleteExpiredInviteLinks(
  supabase: SupabaseClient<Database>,
  before: Date,
): Promise<void> {
  const { error } = await supabase.from('invite_links').delete().lt('expires_at', before.toISOString())
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete expired invite links', { cause: error.message })
  }
}
