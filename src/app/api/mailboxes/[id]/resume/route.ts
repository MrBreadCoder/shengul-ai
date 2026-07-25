import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, setMailboxHealth } from '@/lib/db/mailboxes'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Undoes the per-mailbox kill switch. Unlike the automatic health sweep
// (evaluateBounceHealth never auto-recovers a blocked mailbox), this is an
// explicit operator decision — the mailbox goes straight back to 'ok' rather
// than waiting for the next health sweep to re-evaluate it.
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    await setMailboxHealth(admin, id, 'ok', null)
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: `human:${appUser.id}`,
      type: 'mailbox.resumed',
      source: 'mailbox',
      payload: { mailboxId: id, emailAddress: mailbox.email_address, previousReason: mailbox.health_reason },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
