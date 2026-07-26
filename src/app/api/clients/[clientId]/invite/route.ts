import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, insertAppUser } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const inviteSchema = z.object({
  email: z.string().email(),
})

function isDuplicateEmailError(error: { code?: string; message: string }): boolean {
  return error.code === 'email_exists' || /already registered|already exists/i.test(error.message);
}

/**
 * Builds the invite link ourselves instead of handing out `action_link`.
 *
 * `action_link` points at GoTrue's `/auth/v1/verify`, which finishes the
 * verification at Supabase and 302s to `redirect_to` with the session in the
 * URL *fragment* — a fragment the browser never sends to our server, so the
 * user lands on a page with no cookie and no session. Worse, GoTrue silently
 * replaces a `redirect_to` that is missing from the project's redirect
 * allow-list with the Site URL, which is how an invite ended up on the
 * marketing page.
 *
 * `hashed_token` is the same token without the hosted redirect: our own route
 * exchanges it via `verifyOtp` and writes the session cookies server-side, so
 * the flow depends on nothing but `APP_URL`.
 */
function buildInviteLink(hashedToken: string): string {
  const link = new URL('/auth/callback', env.APP_URL)
  link.searchParams.set('token_hash', hashedToken)
  link.searchParams.set('type', 'invite')
  link.searchParams.set('next', '/set-password')
  return link.toString()
}

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = inviteSchema.parse(await request.json())

    const { data, error } = await admin.auth.admin.generateLink({
      type: 'invite',
      email: body.email,
    })
    if (error || !data.user || !data.properties?.hashed_token) {
      const status = error && isDuplicateEmailError(error) ? 409 : 500
      return NextResponse.json(
        { error: status === 409 ? 'email_already_registered' : 'invite_failed' },
        { status },
      )
    }

    try {
      await insertAppUser(admin, { id: data.user.id, role: 'client', client_id: clientId })
    } catch (insertError) {
      // The auth user was already created by generateLink — without this
      // cleanup a failed app_users insert would leave an orphaned login with
      // no client link, invisible to this admin page but present in auth.users.
      await admin.auth.admin.deleteUser(data.user.id)
      throw insertError
    }

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.user_invited',
        payload: { email: body.email },
      })
    } catch {
      // Audit logging is best-effort — the invite was already created successfully.
    }

    return NextResponse.json({
      ok: true,
      link: buildInviteLink(data.properties.hashed_token),
      email: body.email,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
