import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCasesByStatus } from '@/lib/db/cases'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const FANOUT_LIMIT = 200

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const cases = await listCasesByStatus(admin, 'new', FANOUT_LIMIT)
    const failedCaseIds: string[] = []
    for (const c of cases) {
      try {
        await publishJson('/api/pipeline/research', { caseId: c.id })
      } catch {
        failedCaseIds.push(c.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.research_fanout.completed',
        payload: { caseCount: cases.length, failedCaseIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, caseCount: cases.length, failedCaseIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
