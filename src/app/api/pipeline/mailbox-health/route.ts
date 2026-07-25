import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runMailboxHealthSweep } from '@/lib/pipeline/mailbox-health'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const summary = await runMailboxHealthSweep(admin, { now: new Date() })
    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'mailbox.health_sweep.completed',
      source: 'pipeline',
      payload: { ...summary },
    })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
