import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { outlookProvider } from '@/lib/mailbox/outlook-provider'
import { insertMailbox } from '@/lib/db/mailboxes'
import { resolveMailboxClientId, getClientById } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'
import { encryptMailboxTokens } from '@/lib/mailbox/tokens'
import { warmupInsertFields, DEFAULT_MAILBOX_DAILY_CAP } from '@/lib/mailbox/warmup'
import { timingSafeEqualString } from '@/lib/auth/timing-safe-equal'
import { OUTLOOK_OAUTH_STATE_COOKIE } from '../state-cookie'

export const runtime = 'nodejs'

function redirectAndClearState(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, env.APP_URL))
  response.cookies.delete(OUTLOOK_OAUTH_STATE_COOKIE)
  return response
}

export async function GET(request: Request) {
  const { appUser } = await requireUser()
  // Both roles may connect a mailbox; a client-role account only lacks
  // `client_id` in a state the UI should never let reach here.
  if (appUser.role === 'client' && appUser.client_id === null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  // NextRequest's typed cookie jar isn't available on the plain Request this
  // handler receives; read the state cookie directly off the header instead.
  const cookieHeader = request.headers.get('cookie') ?? ''
  const expectedState = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${OUTLOOK_OAUTH_STATE_COOKIE}=`))
    ?.slice(OUTLOOK_OAUTH_STATE_COOKIE.length + 1)

  // state is a single-use random nonce minted by /connect and stored in an
  // httpOnly cookie — this is the actual CSRF check. Without a match, this
  // callback either wasn't initiated by this browser or is a replay.
  if (!code || !state || !expectedState || !timingSafeEqualString(state, expectedState)) {
    return redirectAndClearState('/settings?error=oauth')
  }
  try {
    const exchange = await outlookProvider.exchangeCode(code)
    const admin = createAdminClient()
    const clientId = await resolveMailboxClientId(admin, appUser)
    // A newly connected mailbox starts at the client's configured ramp. Clients
    // whose addresses are already warm are set to 'none' and skip the ramp.
    const client = await getClientById(admin, clientId)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'outlook',
      email_address: exchange.emailAddress,
      display_name: exchange.displayName,
      oauth: encryptMailboxTokens(exchange.tokens),
      // `daily_cap` isn't set explicitly (the column defaults it), so the
      // ramp's target has to match that same default — it has no default of
      // its own (see the constant's own comment).
      warmup_target_cap: DEFAULT_MAILBOX_DAILY_CAP,
      ...warmupInsertFields(client?.warmup_profile ?? 'standard', new Date()),
    })
    await logEvent({
      clientId, actor: `human:${appUser.id}`, type: 'mailbox.connected',
      payload: { mailboxId: mailbox.id, provider: 'outlook', emailAddress: exchange.emailAddress },
    })
    return redirectAndClearState('/settings?connected=outlook')
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return redirectAndClearState(`/settings?error=${reason}`)
  }
}
