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
//
// Deliberately NOT a multiple of the cron's own dispatch interval (15 min,
// see scripts/schedule-stuck-sweep-cron.ts's default `*/15 * * * *`). A
// requeue's actual DB write lands a few seconds to tens-of-seconds after the
// tick that triggered it (QStash delivery + route latency, worse for larger
// batches) — with a 30-minute threshold, the tick meant to catch it again is
// exactly 2 cron intervals later and fires at that same few-seconds-past-
// the-mark offset, so the requeue's claim delay routinely outran the next
// check's own jitter and the case was missed by single-digit seconds, over
// and over, every cycle (see 2026-08-20 incident, .claude/roadmap.md). Any
// threshold off the 15-minute grid — this one included — gives the first
// tick that can possibly cross it several minutes of real margin instead of
// a few seconds, so batch-claim delay can never eat it again.
const STUCK_THRESHOLD_MINUTES = 22
const SWEEP_LIMIT = 100

// Re-queuing is safe under the existing claims: 'researching' → 'new' re-runs
// research (idempotent knowledge upserts); 'writing'/'contacted' → 'ready'
// re-run write, where claimOutboundEmail dedupes already-sent leads so only
// un-emailed leads get picked up — no double-send. 'writing' (added 0040) is
// the normal in-progress write claim going forward; 'contacted' is kept only
// as a backstop for cases stranded there from before that migration shipped
// — see find_stuck_cases()'s own comment for why it needs the extra
// no-step-0-email check that 'writing' doesn't.
function requeueTarget(status: string): { resetTo: 'new' | 'ready'; path: string } | null {
  if (status === 'researching') return { resetTo: 'new', path: '/api/pipeline/research' }
  if (status === 'writing') return { resetTo: 'ready', path: '/api/pipeline/write' }
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
