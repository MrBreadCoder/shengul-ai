import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, deleteMailbox } from '@/lib/db/mailboxes'
import { removeMailboxFromCampaigns } from '@/lib/db/campaigns'
import { disconnectMailbox } from '@/lib/mailreach/enrollment'
import { logEvent, logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Removes a mailbox connection entirely. Irreversible: sending from it stops
// immediately, and a later reconnect creates a new row (resume only lifts a
// pause, it cannot recreate a deleted mailbox). Operators may remove any
// mailbox; a client may only remove one of their own client's, per
// canManageClient — RLS itself can't enforce this since the route runs on
// the admin client (mailboxes_write is operator-only at the DB layer).
export async function DELETE(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  const { id } = await context.params

  const admin = createAdminClient()
  const mailbox = await getMailboxById(admin, id)
  if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })
  if (!canManageClient(appUser, mailbox.client_id)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    // Best-effort: a Mailreach vendor failure must not strand the delete —
    // there's no retry affordance once the mailbox row is gone anyway.
    if (mailbox.mailreach_account_id) {
      try {
        await disconnectMailbox(admin, mailbox)
      } catch (error) {
        await logEventSafe({
          clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_disconnect_failed',
          source: 'mailbox', payload: { mailboxId: id, cause: error instanceof Error ? error.message : String(error) },
        })
      }
    }

    await removeMailboxFromCampaigns(admin, mailbox.client_id, id)
    await deleteMailbox(admin, id)

    try {
      await logEvent({
        clientId: mailbox.client_id,
        actor: `human:${appUser.id}`,
        type: 'mailbox.deleted',
        source: 'mailbox',
        payload: { mailboxId: id, emailAddress: mailbox.email_address, provider: mailbox.provider },
      })
    } catch {
      // Audit logging is best-effort here — the delete already succeeded,
      // and events.client_id still references a real client either way.
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
