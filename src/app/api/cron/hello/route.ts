import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    await logEvent({ clientId: null, actor: 'system', type: 'cron.hello', payload: { at: new Date().toISOString() } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
