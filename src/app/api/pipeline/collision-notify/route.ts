import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCollisionNotice } from '@/lib/pipeline/collision-notify'
import { isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({
  caseId: z.string().uuid(),
  leadId: z.string().uuid(),
  triggeringLeadId: z.string().uuid(),
})

export async function POST(request: Request) {
  let payload: z.infer<typeof bodySchema> | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    payload = parsed.data
    const admin = createAdminClient()
    const summary = await runCollisionNotice(admin, payload)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: null,
      caseId: payload?.caseId ?? null,
      actor: 'system',
      type: 'pipeline.collision_notify.route_failed',
      source: 'pipeline',
      error,
      payload: { ...payload },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
