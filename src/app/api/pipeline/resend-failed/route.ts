import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { sweepFailedFirstTouch } from '@/lib/pipeline/resend-failed'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Deliberately small: this drains every 'waiting' outbound row — first-touch
// and follow-up sends alike, parked by a cap/rate-limit hit rather than
// regenerated — see lib/pipeline/resend-failed.ts and .claude/roadmap.md
// 2026-08-19. 'failed' is reserved for a genuine, non-retryable delivery
// error and is not what this sweep drains. Not a bulk send path: each retry
// is a single sendViaMailbox call (no LLM), so a batch this size comfortably
// finishes well inside a single invocation — no per-item fanout needed,
// unlike write-fanout's LLM-bound work.
const SWEEP_LIMIT = 50

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const results = await sweepFailedFirstTouch(admin, SWEEP_LIMIT)
    const counts = results.reduce<Record<string, number>>((acc, r) => {
      acc[r.outcome] = (acc[r.outcome] ?? 0) + 1
      return acc
    }, {})
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.resend_failed.completed',
        payload: { attempted: results.length, counts },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, attempted: results.length, counts })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
