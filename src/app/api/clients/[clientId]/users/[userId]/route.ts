import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, deleteAppUser } from '@/lib/db/clients'
import { getAppUser } from '@/lib/db/app-users'
import { deleteAuthUser, getAuthUserEmail } from '@/lib/supabase/auth-admin'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const paramsSchema = z.object({
  clientId: z.string().uuid(),
  userId: z.string().uuid(),
})

const deleteSchema = z.object({
  confirmEmail: z.string().email(),
})

/**
 * Permanently removes one client login: the Supabase Auth user *and* its
 * `app_users` row.
 *
 * Everything that identifies the target is checked before anything is deleted —
 * the row must exist, be `role: 'client'`, and belong to the client in the
 * path. Without the ownership check this endpoint would delete any account in
 * the system by id, operators included, since `userId` is caller-supplied.
 * Every rejection is a 404 rather than a 403: an operator probing ids for
 * another client's users should not be able to tell "not yours" from "no such
 * user".
 *
 * The auth user is deleted *before* the `app_users` row, which is the reverse
 * of `DELETE /api/clients/[clientId]`. The Users tab is rendered from
 * `app_users`, so dropping that row first and then failing the auth delete
 * would hide a login that still exists and whose email stays permanently
 * consumed — invisible in the UI and impossible to retry. This order fails
 * clean: the row is still listed and the operator can try again.
 */
export async function DELETE(
  request: Request,
  context: { params: Promise<{ clientId: string; userId: string }> },
) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsedParams = paramsSchema.safeParse(await context.params)
  if (!parsedParams.success) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  const { clientId, userId } = parsedParams.data

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const target = await getAppUser(admin, userId)
    if (!target || target.role !== 'client' || target.client_id !== clientId) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const email = await getAuthUserEmail(admin, userId)
    if (!email) {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }

    const body = deleteSchema.parse(await request.json())
    if (body.confirmEmail !== email) {
      return NextResponse.json({ error: 'email_mismatch' }, { status: 400 })
    }

    await deleteAuthUser(admin, userId)
    await deleteAppUser(admin, userId)

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.user_removed',
        payload: { email },
      })
    } catch {
      // Audit logging is best-effort — the login is already gone.
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
