import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, setMailboxHealth } from '@/lib/db/mailboxes'
import { HEALTH_REASON } from '@/lib/mailbox/health'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Per-mailbox kill switch. Blocking is instant: rotationOrder skips blocked
// mailboxes and claim_mailbox_send refuses them, so an in-flight campaign stops
// using this address on its very next send.
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    await setMailboxHealth(admin, id, 'blocked', HEALTH_REASON.operatorPaused)
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: `human:${appUser.id}`,
      type: 'mailbox.paused',
      source: 'mailbox',
      severity: 'warn',
      payload: { mailboxId: id, emailAddress: mailbox.email_address, from: mailbox.health },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
