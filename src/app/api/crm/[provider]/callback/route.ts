import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCrmProvider } from '@/lib/crm/registry'
import { encryptCrmTokens } from '@/lib/crm/tokens'
import { upsertCrmConnection } from '@/lib/db/crm-connections'
import { logEvent } from '@/lib/events/log-event'
import { timingSafeEqualString } from '@/lib/auth/timing-safe-equal'
import { isAppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'
import { CRM_OAUTH_STATE_COOKIE } from '../state-cookie'

export const runtime = 'nodejs'

const providerSchema = z.enum(['hubspot', 'pipedrive'])

interface RouteContext {
  params: Promise<{ provider: string }>
}

function redirectAndClearState(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, env.APP_URL))
  response.cookies.delete(CRM_OAUTH_STATE_COOKIE)
  return response
}

/**
 * NextRequest's typed cookie jar is not available on the plain Request this
 * handler receives, so the state cookie is read off the raw header.
 */
function readStateCookie(request: Request): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CRM_OAUTH_STATE_COOKIE}=`))
    ?.slice(CRM_OAUTH_STATE_COOKIE.length + 1)
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsedProvider = providerSchema.safeParse((await context.params).provider)
  if (!parsedProvider.success) {
    return NextResponse.json({ error: 'unknown_provider' }, { status: 404 })
  }
  const provider = parsedProvider.data

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expectedState = readStateCookie(request)

  // The single-use nonce comparison IS the CSRF check. Without a match this
  // callback either was not initiated by this browser or is a replay.
  if (!code || !state || !expectedState || !timingSafeEqualString(state, expectedState)) {
    return redirectAndClearState('/settings?error=oauth')
  }

  try {
    const exchange = await getCrmProvider(provider).exchangeCode(code)
    const admin = createAdminClient()
    const connection = await upsertCrmConnection(admin, {
      clientId: appUser.client_id,
      provider,
      accountLabel: exchange.accountLabel,
      accountRef: exchange.accountRef,
      oauth: encryptCrmTokens(exchange.tokens),
    })
    await logEvent({
      clientId: appUser.client_id,
      actor: `human:${appUser.id}`,
      type: 'crm.connected',
      source: 'crm',
      payload: { connectionId: connection.id, provider, accountLabel: exchange.accountLabel },
    })
    return redirectAndClearState(`/settings?connect=${provider}`)
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return redirectAndClearState(`/settings?error=${reason}`)
  }
}
