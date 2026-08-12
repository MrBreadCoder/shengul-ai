import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listActiveClients } from '@/lib/db/clients'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const clients = await listActiveClients(admin)
    const firedClientIds: string[] = []
    const failedClientIds: string[] = []

    for (const client of clients) {
      try {
        await publishJson('/api/pipeline/reports-generate', { clientId: client.id, type: 'weekly' })
        firedClientIds.push(client.id)
      } catch {
        // Isolate per-client publish failures — one bad QStash publish
        // doesn't stop the rest of this week's clients.
        failedClientIds.push(client.id)
      }
    }

    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'reports.weekly_fanout.completed',
        payload: { clientCount: clients.length, firedClientIds, failedClientIds },
      })
    } catch {
      // Audit logging is best-effort — it must not turn a completed fanout into a 500.
    }
    return NextResponse.json({ ok: true, clientCount: clients.length, firedClientIds, failedClientIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
