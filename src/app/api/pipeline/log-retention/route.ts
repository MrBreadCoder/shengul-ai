import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { deleteExpiredEvents, type EventRetention } from '@/lib/db/events'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// `info` rows are the high-volume ones (one per LLM call) and lose value fast.
// `warn`/`error` rows are what an operator goes back to weeks later, so they
// get a longer window.
const RETENTION: EventRetention = { infoDays: 30, problemDays: 90 }

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const summary = await deleteExpiredEvents(admin, new Date(), RETENTION)
    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'logs.retention.completed',
      severity: 'info',
      source: 'db',
      payload: { ...summary, infoDays: RETENTION.infoDays, problemDays: RETENTION.problemDays },
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
