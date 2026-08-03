import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getSourceById, deleteChunksForSource, embedAndStoreChunks, markSourceReady, markSourceFailed,
  listReadySiblingWebsiteContents,
} from '@/lib/db/client-knowledge'
import { brightdataResearch } from '@/lib/research/brightdata'
import { stripBoilerplateParagraphs } from '@/lib/knowledge/strip-boilerplate'
import { isAppError, AppError } from '@/lib/errors/app-error'
import { logEventSafe, logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const ACTOR = 'knowledge_scrape'
// Sized to store and chunk a whole marketing page, not to fit one LLM
// prompt — deliberately much higher than the research/dossier scraper's
// MAX_SCRAPE_CHARS (6,000), which shares brightdataResearch.scrape but has a
// different, tighter budget need.
const KNOWLEDGE_SCRAPE_MAX_CHARS = 40_000
const bodySchema = z.object({ sourceId: z.string().uuid() })

export async function POST(request: Request) {
  let clientId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const { sourceId } = bodySchema.parse(JSON.parse(rawBody))
    const admin = createAdminClient()

    const source = await getSourceById(admin, sourceId)
    if (!source) return NextResponse.json({ error: 'source_not_found' }, { status: 404 })
    clientId = source.client_id
    if (source.source_type !== 'website_page' || !source.url) {
      return NextResponse.json({ error: 'not_a_website_page' }, { status: 400 })
    }

    try {
      const content = await brightdataResearch.scrape(source.url, KNOWLEDGE_SCRAPE_MAX_CHARS)

      // Boilerplate cleanliness is a quality improvement, not a correctness
      // requirement — a failure here must never turn a working scrape into a
      // failed source, so it's caught locally and degrades to "no siblings".
      let siblingContents: string[] = []
      try {
        siblingContents = await listReadySiblingWebsiteContents(admin, source.client_id, sourceId)
      } catch (siblingError) {
        await logEventSafe({
          clientId: source.client_id, actor: ACTOR, type: 'knowledge.sibling_lookup_failed',
          severity: 'warn',
          payload: { sourceId, message: siblingError instanceof AppError ? siblingError.message : 'unknown' },
        })
      }
      const cleanedContent = stripBoilerplateParagraphs(content, siblingContents)

      // Delete-then-insert (not append) keeps this idempotent across QStash's
      // own automatic retries and the explicit re-scrape action — both funnel
      // through this same route and must never leave duplicate chunks behind.
      await deleteChunksForSource(admin, sourceId)
      await embedAndStoreChunks(admin, { clientId: source.client_id, sourceId, content: cleanedContent, actor: ACTOR })
      // The raw (unstripped) scrape is what's stored on the source row — the
      // audit trail / re-derivation source of truth. Only the text handed to
      // the chunker above is cleaned.
      await markSourceReady(admin, sourceId, content, content.length)
      await logEventSafe({
        clientId: source.client_id, actor: ACTOR, type: 'knowledge.page_scraped',
        payload: { sourceId, url: source.url, charCount: content.length },
      })
    } catch (scrapeError) {
      const message = scrapeError instanceof AppError ? scrapeError.message : 'Scrape failed'
      await markSourceFailed(admin, sourceId, message)
      await logEventSafe({
        clientId: source.client_id, actor: ACTOR, type: 'knowledge.page_scrape_failed',
        severity: 'warn', payload: { sourceId, url: source.url, message },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({ clientId, actor: ACTOR, type: 'knowledge.scrape_route_failed', source: 'pipeline', error })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
