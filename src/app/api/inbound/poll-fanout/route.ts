import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listAllMailboxes } from '@/lib/db/mailboxes'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const mailboxes = await listAllMailboxes(admin)
    const failedMailboxIds: string[] = []
    for (const mailbox of mailboxes) {
      try {
        await publishJson('/api/inbound/poll', { mailboxId: mailbox.id })
      } catch {
        failedMailboxIds.push(mailbox.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'inbound.poll_fanout.completed',
        payload: { mailboxCount: mailboxes.length, failedMailboxIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, mailboxCount: mailboxes.length, failedMailboxIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
