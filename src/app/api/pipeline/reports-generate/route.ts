import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { generateReport } from '@/lib/reports/generate'
import { isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({
  clientId: z.string().uuid(),
  type: z.enum(['weekly', 'monthly']),
})

export async function POST(request: Request) {
  // Captured as the handler progresses so the catch block can attribute the
  // failure — matches discover/route.ts's pattern.
  let clientId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsedBody = bodySchema.parse(JSON.parse(rawBody))
    clientId = parsedBody.clientId

    const admin = createAdminClient()
    const report = await generateReport(admin, { clientId: parsedBody.clientId, type: parsedBody.type, now: new Date() })
    return NextResponse.json({ ok: true, reportId: report.id, status: report.status })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (isAppError(error) && error.code === 'NOT_FOUND') {
      return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
    }
    await logError({
      clientId,
      actor: 'system',
      type: 'pipeline.reports_generate.route_failed',
      source: 'pipeline',
      error,
      payload: {},
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
