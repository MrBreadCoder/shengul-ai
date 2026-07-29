import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById } from '@/lib/db/mailboxes'
import { disconnectMailbox } from '@/lib/mailreach/enrollment'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  const admin = createAdminClient()
  const mailbox = await getMailboxById(admin, id)
  if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    await disconnectMailbox(admin, mailbox)
    await logEventSafe({
      clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_disconnected',
      source: 'mailbox', payload: { mailboxId: id },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
