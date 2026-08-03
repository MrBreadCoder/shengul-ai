import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCrmSync } from '@/lib/crm/sync'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({
  caseId: z.string().uuid(),
  reason: z.enum(['qualified', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead']),
})

export async function POST(request: Request): Promise<NextResponse> {
  let caseId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsed = bodySchema.safeParse(JSON.parse(rawBody))
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    caseId = parsed.data.caseId

    const outcome = await runCrmSync(createAdminClient(), {
      caseId: parsed.data.caseId,
      reason: parsed.data.reason,
      now: new Date(),
    })

    switch (outcome.kind) {
      case 'synced':
        return NextResponse.json({ ok: true })
      case 'skipped':
        return NextResponse.json({ ok: true, skipped: outcome.reason })
      case 'permanent_failure':
        // 200 on purpose: retrying an invalid payload or a revoked grant just
        // burns quota. The failure is already recorded on the link row.
        return NextResponse.json({ ok: false, error: outcome.message })
      case 'busy':
        // 500 on purpose: another worker holds the claim, so this delivery must
        // come back rather than be dropped.
        return NextResponse.json({ error: 'sync_in_progress' }, { status: 500 })
      default: {
        const exhaustive: never = outcome
        throw new AppError('INVARIANT_VIOLATION', 'Unhandled CRM sync outcome', {
          outcome: String(exhaustive),
        })
      }
    }
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    await logError({
      clientId: null,
      caseId,
      actor: 'system:crm',
      type: 'crm.sync_route_failed',
      source: 'crm',
      error,
    })
    return NextResponse.json({ error: 'sync_failed' }, { status: 500 })
  }
}
