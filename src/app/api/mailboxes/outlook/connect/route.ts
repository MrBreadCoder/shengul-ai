import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { outlookProvider } from '@/lib/mailbox/outlook-provider'
import { env } from '@/lib/env'
import {
  OUTLOOK_OAUTH_STATE_COOKIE,
  OUTLOOK_OAUTH_STATE_COOKIE_PATH,
  OUTLOOK_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from '../state-cookie'

export const runtime = 'nodejs'

export async function GET() {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // A random, single-use nonce (not the user id) — the callback validates it
  // against this httpOnly cookie, which is what actually proves the callback
  // request came from the browser that started this flow.
  const state = randomUUID()
  const response = NextResponse.redirect(outlookProvider.buildAuthUrl(state))
  response.cookies.set(OUTLOOK_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.APP_URL.startsWith('https://'),
    sameSite: 'lax',
    maxAge: OUTLOOK_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    path: OUTLOOK_OAUTH_STATE_COOKIE_PATH,
  })
  return response
}
