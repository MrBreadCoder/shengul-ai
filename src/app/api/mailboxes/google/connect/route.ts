import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { gmailProvider } from '@/lib/mailbox/gmail-provider'
import { env } from '@/lib/env'
import {
  GMAIL_OAUTH_STATE_COOKIE,
  GMAIL_OAUTH_STATE_COOKIE_PATH,
  GMAIL_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from '../state-cookie'

export const runtime = 'nodejs'

export async function GET() {
  const { appUser } = await requireUser()
  // Both roles may connect a mailbox; a client-role account only lacks
  // `client_id` in a state the UI should never let reach here.
  if (appUser.role === 'client' && appUser.client_id === null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // A random, single-use nonce (not the user id) — the callback validates it
  // against this httpOnly cookie, which is what actually proves the callback
  // request came from the browser that started this flow.
  const state = randomUUID()
  const response = NextResponse.redirect(gmailProvider.buildAuthUrl(state))
  response.cookies.set(GMAIL_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.APP_URL.startsWith('https://'),
    sameSite: 'lax',
    maxAge: GMAIL_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    path: GMAIL_OAUTH_STATE_COOKIE_PATH,
  })
  return response
}
