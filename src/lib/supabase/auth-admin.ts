import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

// Supabase has no "ban forever" value — ~100 years is the documented
// convention for an effectively permanent ban that `unbanAuthUsers` can still
// reverse (accounts are banned, never deleted, for the "archive" action).
const PERMANENT_BAN_DURATION = '876000h'

export async function banAuthUsers(admin: SupabaseClient<Database>, userIds: string[]): Promise<void> {
  const results = await Promise.all(
    userIds.map((id) => admin.auth.admin.updateUserById(id, { ban_duration: PERMANENT_BAN_DURATION })),
  )
  const failed = results.find((result) => result.error)
  if (failed?.error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to ban an auth user', { cause: failed.error.message })
  }
}

export async function unbanAuthUsers(admin: SupabaseClient<Database>, userIds: string[]): Promise<void> {
  const results = await Promise.all(
    userIds.map((id) => admin.auth.admin.updateUserById(id, { ban_duration: 'none' })),
  )
  const failed = results.find((result) => result.error)
  if (failed?.error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to unban an auth user', { cause: failed.error.message })
  }
}

// Called only after the corresponding clients row (and its cascaded app_users
// row) has already been deleted — auth.users has no FK to clients, so this is
// the only thing that removes the login itself.
export async function deleteAuthUsers(admin: SupabaseClient<Database>, userIds: string[]): Promise<void> {
  const results = await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)))
  const failed = results.find((result) => result.error)
  if (failed?.error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to delete an auth user', { cause: failed.error.message })
  }
}
