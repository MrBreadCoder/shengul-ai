import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSourceById, resetSourceToPending } from '@/lib/db/client-knowledge'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ clientId: string; sourceId: string }> },
) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId, sourceId } = await context.params
  const admin = createAdminClient()
  const source = await getSourceById(admin, sourceId)
  if (!source || source.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (source.source_type !== 'website_page') {
    return NextResponse.json({ error: 'validation_error', issues: 'only website pages can be re-scraped' }, { status: 400 })
  }

  try {
    // The scrape route itself deletes the source's existing chunks before
    // inserting fresh ones, so resetting to 'pending' here doesn't need to
    // touch client_knowledge_chunks — this is just the visible status flip.
    await resetSourceToPending(admin, sourceId)
    await publishJson('/api/pipeline/knowledge-scrape', { sourceId })
    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.page_rescrape_requested',
      payload: { sourceId, url: source.url },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    await logError({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'knowledge.rescrape_route_failed',
      source: 'app',
      error,
      payload: { sourceId, url: source.url },
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
