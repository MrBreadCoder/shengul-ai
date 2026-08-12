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

/** Supabase reports a missing user as a 404 with this code. */
const USER_NOT_FOUND_CODE = 'user_not_found'

function isUserNotFound(error: { status?: number; code?: string }): boolean {
  return error.status === 404 || error.code === USER_NOT_FOUND_CODE
}

/**
 * Reads one auth user's email, for confirming a destructive action against the
 * address the operator actually typed. Returns null when the user is gone, so
 * the caller can answer 404 rather than throw.
 */
export async function getAuthUserEmail(
  admin: SupabaseClient<Database>,
  userId: string,
): Promise<string | null> {
  const { data, error } = await admin.auth.admin.getUserById(userId)
  if (error) {
    if (isUserNotFound(error)) return null
    throw new AppError('EXTERNAL_ERROR', 'Failed to load an auth user', { userId, cause: error.message })
  }
  return data.user?.email ?? null
}

/**
 * Deletes a single login.
 *
 * A user that is already gone counts as success. Removing a login is two
 * deletes against two systems that share no transaction, so a failure between
 * them has to be retryable: without this, a retry after the auth user was
 * deleted but its `app_users` row was not would fail forever on a user that no
 * longer exists.
 */
export async function deleteAuthUser(admin: SupabaseClient<Database>, userId: string): Promise<void> {
  const { error } = await admin.auth.admin.deleteUser(userId)
  if (error && !isUserNotFound(error)) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to delete an auth user', { userId, cause: error.message })
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

export interface AuthUserEmail {
  userId: string
  email: string
}

/**
 * Resolves emails for a batch of auth user ids — best-effort, unlike
 * deleteAuthUsers's all-or-nothing semantics. An id that errors (banned,
 * deleted) or has no email is silently dropped rather than failing the
 * whole batch: report recipient resolution must not let one broken account
 * block delivery to a client's other dashboard users.
 */
export async function getAuthUserEmails(
  admin: SupabaseClient<Database>,
  userIds: string[],
): Promise<AuthUserEmail[]> {
  const results = await Promise.allSettled(
    userIds.map(async (userId): Promise<AuthUserEmail | null> => {
      const { data, error } = await admin.auth.admin.getUserById(userId)
      if (error || !data.user?.email) return null
      return { userId, email: data.user.email }
    }),
  )
  return results
    .filter((result): result is PromiseFulfilledResult<AuthUserEmail | null> => result.status === 'fulfilled')
    .map((result) => result.value)
    .filter((value): value is AuthUserEmail => value !== null)
}
