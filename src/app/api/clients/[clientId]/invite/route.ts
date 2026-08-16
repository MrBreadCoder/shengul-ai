import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, insertAppUser } from '@/lib/db/clients'
import { insertInviteLink, deleteInviteLinksForUser } from '@/lib/db/invite-links'
import { generateInviteToken, hashInviteToken } from '@/lib/auth/invite-token'
import { inviteExpiryFrom, INVITE_TTL_MINUTES } from '@/lib/auth/invite-ttl'
import { renderInviteEmail } from '@/lib/auth/invite-email'
import { sendReportEmail } from '@/lib/reports/mailer'
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
 * The link the operator hands over.
 *
 * It carries our own token rather than a Supabase one. A Supabase email token
 * is single-use, so the first fetch of the URL redeems it — and that fetch is
 * routinely a mail or chat platform prefetching the link rather than the
 * person it was sent to, which silently burned invites before anyone clicked.
 * This token stays usable until it expires; see `lib/auth/invite-token.ts`.
 */
function buildInviteLink(token: string): string {
  const link = new URL('/auth/callback', env.APP_URL)
  link.searchParams.set('token', token)
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

    // `email_confirm` skips Supabase's own confirmation mail: nothing is
    // emailed by this flow, and the account cannot be used until the invitee
    // sets a password through the link anyway.
    const { data, error } = await admin.auth.admin.createUser({
      email: body.email,
      email_confirm: true,
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
      // The auth user was already created above — without this cleanup a
      // failed app_users insert would leave an orphaned login with no client
      // link, invisible to this admin page but present in auth.users.
      await admin.auth.admin.deleteUser(data.user.id)
      throw insertError
    }

    const token = generateInviteToken()
    try {
      // Reissuing must not leave the earlier link alive alongside the new one.
      await deleteInviteLinksForUser(admin, data.user.id)
      await insertInviteLink(admin, {
        token_hash: hashInviteToken(token),
        user_id: data.user.id,
        client_id: clientId,
        created_by: appUser.id,
        expires_at: inviteExpiryFrom(new Date()).toISOString(),
      })
    } catch (linkError) {
      // A login nobody can reach is worse than no login: it consumes the
      // address, so the operator cannot even retry with the same email.
      await admin.auth.admin.deleteUser(data.user.id)
      throw linkError
    }

    const link = buildInviteLink(token)

    // Delivery is best-effort: the login already exists and works from the
    // link either way, so an SMTP failure here must not roll back or fail
    // the request — it only means the operator has to hand the link over
    // some other way, which the UI still lets them do by showing it.
    let emailSent = true
    try {
      const rendered = renderInviteEmail({ clientName: client.name, link, expiresInMinutes: INVITE_TTL_MINUTES })
      await sendReportEmail({ to: body.email, subject: rendered.subject, text: rendered.text, html: rendered.html })
    } catch {
      emailSent = false
    }

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.user_invited',
        payload: { email: body.email, expiresInMinutes: INVITE_TTL_MINUTES, emailSent },
      })
    } catch {
      // Audit logging is best-effort — the invite was already created successfully.
    }

    return NextResponse.json({
      ok: true,
      link,
      email: body.email,
      expiresInMinutes: INVITE_TTL_MINUTES,
      emailSent,
    })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
