import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById } from '@/lib/db/mailboxes'
import { completeOAuthConnectForMailbox } from '@/lib/mailreach/enrollment'
import { logEventSafe } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'
import { timingSafeEqualString } from '@/lib/auth/timing-safe-equal'
import { MAILREACH_OAUTH_STATE_COOKIE, MAILREACH_OAUTH_STATE_COOKIE_PATH } from '../state-cookie'

export const runtime = 'nodejs'

const cookieStateSchema = z.object({ nonce: z.string(), mailboxId: z.string() })

function redirectAndClearState(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, env.APP_URL))
  // Must match the path the cookie was set with in /connect
  // (MAILREACH_OAUTH_STATE_COOKIE_PATH = '/api/mailboxes', a directory this
  // callback route does not sit directly under) — a delete without it is a
  // different cookie to the browser and never actually clears the original.
  response.cookies.delete({ name: MAILREACH_OAUTH_STATE_COOKIE, path: MAILREACH_OAUTH_STATE_COOKIE_PATH })
  return response
}

export async function GET(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookieHeader = request.headers.get('cookie') ?? ''
  const rawCookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${MAILREACH_OAUTH_STATE_COOKIE}=`))
    ?.slice(MAILREACH_OAUTH_STATE_COOKIE.length + 1)

  if (!code || !state || !rawCookie) return redirectAndClearState('/settings?error=oauth')

  const cookieParse = (() => {
    try {
      return cookieStateSchema.safeParse(JSON.parse(decodeURIComponent(rawCookie)))
    } catch {
      return { success: false as const }
    }
  })()
  if (!cookieParse.success) return redirectAndClearState('/settings?error=oauth')

  // state is a single-use random nonce minted by /connect and stored in an
  // httpOnly cookie alongside the target mailbox id — this is the actual CSRF
  // check. Without a match, this callback either wasn't initiated by this
  // browser or is a replay.
  if (!timingSafeEqualString(state, cookieParse.data.nonce)) return redirectAndClearState('/settings?error=oauth')

  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, cookieParse.data.mailboxId)
    if (!mailbox) return redirectAndClearState('/settings?error=not_found')

    await completeOAuthConnectForMailbox(admin, mailbox, code, new Date())
    await logEventSafe({
      clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_connected',
      source: 'mailbox', payload: { mailboxId: mailbox.id, provider: mailbox.provider },
    })
    return redirectAndClearState('/settings?mailreach=connected')
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return redirectAndClearState(`/settings?error=${reason}`)
  }
}
