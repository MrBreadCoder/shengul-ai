import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { getCrmProvider } from '@/lib/crm/registry'
import { env } from '@/lib/env'
import {
  CRM_OAUTH_STATE_COOKIE,
  CRM_OAUTH_STATE_COOKIE_PATH,
  CRM_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from '../state-cookie'

export const runtime = 'nodejs'

const providerSchema = z.enum(['hubspot', 'pipedrive'])

interface RouteContext {
  params: Promise<{ provider: string }>
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { appUser } = await requireUser()
  // Inverted vs. the mailbox flow on purpose: the CRM account belongs to the
  // client, so only a client-role session may authorize it.
  if (appUser.role !== 'client') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsedProvider = providerSchema.safeParse((await context.params).provider)
  if (!parsedProvider.success) {
    return NextResponse.json({ error: 'unknown_provider' }, { status: 404 })
  }

  // A random single-use nonce (not the user id) — the callback compares it to
  // this httpOnly cookie, which is what proves the callback came from the
  // browser that started the flow.
  const state = randomUUID()
  const response = NextResponse.redirect(getCrmProvider(parsedProvider.data).buildAuthUrl(state))
  response.cookies.set(CRM_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.APP_URL.startsWith('https://'),
    sameSite: 'lax',
    maxAge: CRM_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    path: CRM_OAUTH_STATE_COOKIE_PATH,
  })
  return response
}
