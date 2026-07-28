import type { AppUser } from '@/lib/db/app-users'

/**
 * Whether `appUser` may create content under `clientId`.
 *
 * Routes that touch client-writable tables use createAdminClient(), which
 * bypasses RLS entirely — so this check, not the policy, is what stops a client
 * user writing into another tenant. Never skip it on such a route.
 */
export function canManageClient(appUser: AppUser, clientId: string): boolean {
  if (appUser.role === 'operator') return true
  return appUser.client_id !== null && appUser.client_id === clientId
}

/**
 * Whether `appUser` may modify or remove an existing row. Operators may touch
 * anything; a client user may only touch rows they themselves created, within
 * their own client.
 */
export function canManageOwnRow(
  appUser: AppUser,
  row: { client_id: string; created_by: string },
): boolean {
  if (appUser.role === 'operator') return true
  return canManageClient(appUser, row.client_id) && row.created_by === appUser.id
}
