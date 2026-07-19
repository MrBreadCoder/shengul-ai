import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { gmailProvider } from '@/lib/mailbox/gmail-provider'
import { insertMailbox } from '@/lib/db/mailboxes'
import { getOrCreateOperatorClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || state !== appUser.id) {
    return NextResponse.redirect(new URL('/settings?error=oauth', env.APP_URL))
  }
  try {
    const exchange = await gmailProvider.exchangeCode(code)
    const admin = createAdminClient()
    const clientId = await getOrCreateOperatorClient(admin)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'gmail',
      email_address: exchange.emailAddress,
      display_name: exchange.displayName,
      oauth: { ...exchange.tokens },
    })
    await logEvent({
      clientId, actor: `human:${appUser.id}`, type: 'mailbox.connected',
      payload: { mailboxId: mailbox.id, provider: 'gmail', emailAddress: exchange.emailAddress },
    })
    return NextResponse.redirect(new URL('/settings?connected=gmail', env.APP_URL))
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return NextResponse.redirect(new URL(`/settings?error=${reason}`, env.APP_URL))
  }
}
