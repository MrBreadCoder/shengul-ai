import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxMailreachPending } from '@/lib/db/mailboxes'
import { getClientById } from '@/lib/db/clients'
import { connectSmtpMailbox, oauthAuthorizeUrl } from '@/lib/mailreach/enrollment'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'
import {
  MAILREACH_OAUTH_STATE_COOKIE,
  MAILREACH_OAUTH_STATE_COOKIE_PATH,
  MAILREACH_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from '../../../mailreach/state-cookie'

export const runtime = 'nodejs'

// SMTP mailboxes connect synchronously — we already hold real IMAP/SMTP
// credentials. Gmail/Outlook mailboxes need Mailreach's own OAuth consent, so
// this hands the browser a redirect URL instead (checking the box for those
// providers navigates rather than firing an async toggle — see
// mailreach-controls.tsx).
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  const admin = createAdminClient()
  const mailbox = await getMailboxById(admin, id)
  if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const client = await getClientById(admin, mailbox.client_id)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  // isEligibleForCampaignSend ungates warmup entirely while the client's master
  // switch is off (see mailreach-gate.ts) — enrolling an individual mailbox in
  // that state would connect a real Mailreach account yet send unrestricted
  // 'outreach' mail from day 0, defeating the reason it was enrolled.
  if (!client.mailreach_enabled) {
    return NextResponse.json({ error: 'client_mailreach_disabled' }, { status: 400 })
  }

  if (mailbox.provider === 'smtp') {
    try {
      await connectSmtpMailbox(admin, mailbox, new Date())
      await logEventSafe({
        clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_connected',
        source: 'mailbox', payload: { mailboxId: id, provider: 'smtp' },
      })
      return NextResponse.json({ ok: true, redirect: false })
    } catch (error) {
      // Diagnostic instrumentation: this catch previously returned only a bare
      // AppError code to the client and logged nothing, so a failed connect
      // left no trace anywhere to debug from. fetchJson's AppError carries the
      // real detail in `context` (vendor status/body, or a network `cause`) —
      // pull out whichever of those this particular failure actually set.
      await logError({
        clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_connect_failed',
        source: 'mailbox', error,
        payload: {
          mailboxId: id,
          provider: 'smtp',
          ...(isAppError(error) && typeof error.context.status === 'number' ? { status: error.context.status } : {}),
          ...(isAppError(error) && typeof error.context.body === 'string' ? { body: error.context.body } : {}),
          ...(isAppError(error) && typeof error.context.cause === 'string' ? { cause: error.context.cause } : {}),
        },
      })
      return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
    }
  }

  try {
    const state = randomUUID()
    await updateMailboxMailreachPending(admin, id)
    const authorizeUrl = oauthAuthorizeUrl({
      provider: mailbox.provider as 'gmail' | 'outlook',
      redirectUri: new URL('/api/mailboxes/mailreach/callback', env.APP_URL).toString(),
      state,
    })
    const response = NextResponse.json({ ok: true, redirect: true, authorizeUrl })
    response.cookies.set(
      MAILREACH_OAUTH_STATE_COOKIE,
      JSON.stringify({ nonce: state, mailboxId: id }),
      {
        httpOnly: true,
        secure: env.APP_URL.startsWith('https://'),
        sameSite: 'lax',
        maxAge: MAILREACH_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
        path: MAILREACH_OAUTH_STATE_COOKIE_PATH,
      },
    )
    return response
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
