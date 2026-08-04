import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listSourcesForClient, resetSourceToPending } from '@/lib/db/client-knowledge'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe, logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ clientId: string }> },
) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const sources = await listSourcesForClient(admin, clientId)
  // 'pending' sources already have a scrape job in flight (fresh or a prior
  // re-scrape not yet processed) — re-queuing them would just duplicate work.
  const rescrapable = sources.filter((s) => s.source_type === 'website_page' && s.status !== 'pending')

  let queued = 0
  const failedSourceIds: string[] = []
  for (const source of rescrapable) {
    try {
      // Same idempotency contract as the single-source re-scrape route: the
      // scrape job itself deletes existing chunks before inserting fresh
      // ones, so this reset is just the visible status flip.
      await resetSourceToPending(admin, source.id)
      await publishJson('/api/pipeline/knowledge-scrape', { sourceId: source.id })
      queued += 1
    } catch (error) {
      failedSourceIds.push(source.id)
      await logError({
        clientId, actor: `human:${appUser.id}`, type: 'knowledge.rescrape_all_source_failed',
        source: 'app', error, payload: { sourceId: source.id, url: source.url },
      })
    }
  }

  await logEventSafe({
    clientId, actor: `human:${appUser.id}`, type: 'knowledge.rescrape_all_requested',
    payload: { totalSources: rescrapable.length, queued, failedSourceIds },
  })

  return NextResponse.json({ ok: true, queued, failed: failedSourceIds.length })
}
