import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runMailreachStatsSync } from '@/lib/pipeline/mailreach-sync'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const summary = await runMailreachStatsSync(admin, { now: new Date() })
    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'mailbox.mailreach_sync.completed',
      source: 'pipeline',
      payload: { ...summary },
    })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: null,
      actor: 'system',
      type: 'mailbox.mailreach_sync.failed',
      source: 'pipeline',
      error,
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
