import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listStuckCases, updateCaseStatus } from '@/lib/db/cases'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// A research/write loop over a case's leads should finish well within this
// window; anything older is treated as stranded. Comfortably exceeds the worst
// case loop time so we never fight a still-running (merely slow) loop.
const STUCK_THRESHOLD_MINUTES = 30
const SWEEP_LIMIT = 100

// Re-queuing is safe under the existing claims: 'researching' → 'new' re-runs
// research (idempotent knowledge upserts); 'contacted' → 'ready' re-runs write,
// where claimOutboundEmail dedupes already-sent leads so only un-emailed leads
// get picked up — no double-send.
function requeueTarget(status: string): { resetTo: 'new' | 'ready'; path: string } | null {
  if (status === 'researching') return { resetTo: 'new', path: '/api/pipeline/research' }
  if (status === 'contacted') return { resetTo: 'ready', path: '/api/pipeline/write' }
  return null
}

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MINUTES * 60 * 1000).toISOString()
    const cases = await listStuckCases(admin, cutoff, SWEEP_LIMIT)

    const requeuedCaseIds: string[] = []
    const failedCaseIds: string[] = []
    for (const c of cases) {
      const target = requeueTarget(c.status)
      if (!target) continue
      try {
        await updateCaseStatus(admin, c.id, target.resetTo)
        await publishJson(target.path, { caseId: c.id })
        requeuedCaseIds.push(c.id)
      } catch {
        // Best-effort per case — the next sweep retries any that failed here.
        failedCaseIds.push(c.id)
      }
    }

    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'pipeline.stuck_sweep.completed',
      payload: { candidateCount: cases.length, requeuedCaseIds, failedCaseIds },
    })
    return NextResponse.json({ ok: true, candidateCount: cases.length, requeuedCaseIds, failedCaseIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
