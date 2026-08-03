import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxWarmup } from '@/lib/db/mailboxes'
import { warmupInsertFields } from '@/lib/mailbox/warmup'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({
  profile: z.enum(['standard', 'slow', 'none']).optional(),
  warmupStartCap: z.number().int().positive().optional(),
  warmupIncrement: z.number().int().positive().optional(),
  warmupTargetCap: z.number().int().positive().optional(),
  dailyCap: z.number().int().positive().optional(),
})

// Per-mailbox warmup override — a partial update. Only an actual profile
// change restarts the ramp from day one (an operator changes this when the
// mailbox needs re-warming: reconnected, previously blocked, new domain);
// editing the numeric ramp knobs alone never touches warmup_started_at.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const body = bodySchema.parse(await request.json())

    const fields: Parameters<typeof updateMailboxWarmup>[2] = {}
    if (body.warmupStartCap !== undefined) fields.warmup_start_cap = body.warmupStartCap
    if (body.warmupIncrement !== undefined) fields.warmup_increment = body.warmupIncrement
    if (body.warmupTargetCap !== undefined) fields.warmup_target_cap = body.warmupTargetCap
    if (body.dailyCap !== undefined) fields.daily_cap = body.dailyCap
    if (body.profile !== undefined && body.profile !== mailbox.warmup_profile) {
      Object.assign(fields, warmupInsertFields(body.profile, new Date()))
    }

    if (Object.keys(fields).length > 0) {
      await updateMailboxWarmup(admin, id, fields)
      await logEventSafe({
        clientId: mailbox.client_id,
        actor: `human:${appUser.id}`,
        type: 'mailbox.warmup_changed',
        source: 'mailbox',
        payload: { mailboxId: id, changed: Object.keys(fields) },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
