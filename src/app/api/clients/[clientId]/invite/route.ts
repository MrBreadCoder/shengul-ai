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
      options: { redirectTo: `${env.APP_URL}/auth/callback` },
    })
    if (error || !data.user) {
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

    return NextResponse.json({ ok: true, link: data.properties.action_link, email: body.email })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
