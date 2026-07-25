import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runFollowupStep, MAX_FOLLOWUP_STEP } from '@/lib/pipeline/followup'
import { isAppError } from '@/lib/errors/app-error'
import { getSequenceById } from '@/lib/db/sequences'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({
  sequenceId: z.string().uuid(),
  step: z.number().int().min(1).max(MAX_FOLLOWUP_STEP),
})

export async function POST(request: Request) {
  let sequenceId: string | null = null
  let step: number | null = null
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
    sequenceId = parsed.data.sequenceId
    step = parsed.data.step
    const admin = createAdminClient()
    const summary = await runFollowupStep(admin, parsed.data)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: await resolveSequenceClientId(sequenceId),
      actor: 'system',
      type: 'pipeline.followup.route_failed',
      source: 'pipeline',
      error,
      payload: { sequenceId, step },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

/**
 * Error-path only: `runFollowupStep` owns the sequence lookup on the happy
 * path, so this second read costs nothing until something has already failed.
 * Returns null rather than throwing — a lookup failure here must not replace
 * the original error with a different one.
 */
async function resolveSequenceClientId(sequenceId: string | null): Promise<string | null> {
  if (!sequenceId) return null
  try {
    const sequence = await getSequenceById(createAdminClient(), sequenceId)
    return sequence?.client_id ?? null
  } catch {
    return null
  }
}
