import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxWarmup } from '@/lib/db/mailboxes'
import { warmupInsertFields } from '@/lib/mailbox/warmup'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ profile: z.enum(['standard', 'slow', 'none']) })

// Per-mailbox warmup override. Switching to a ramping profile restarts the ramp
// from day one on purpose: an operator only changes this when the mailbox needs
// re-warming (reconnected, previously blocked, new domain).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const { profile } = bodySchema.parse(await request.json())
    await updateMailboxWarmup(admin, id, warmupInsertFields(profile, new Date()))
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: `human:${appUser.id}`,
      type: 'mailbox.warmup_changed',
      source: 'mailbox',
      payload: { mailboxId: id, from: mailbox.warmup_profile, to: profile },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
