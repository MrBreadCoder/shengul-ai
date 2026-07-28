import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getResourceById } from '@/lib/db/client-resources'
import { readResourceContent } from '@/lib/resources/derive-content'
import {
  upsertResourceKnowledgeSource,
  deleteResourceKnowledgeSource,
  markResourceContentReady,
  markResourceContentFailed,
  markResourceContentUnsupported,
} from '@/lib/db/resource-content'
import { deleteChunksForSource, embedAndStoreChunks } from '@/lib/db/client-knowledge'
import { isAppError, AppError } from '@/lib/errors/app-error'
import { logEventSafe, logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const ACTOR = 'resource_reader'
const bodySchema = z.object({ resourceId: z.string().uuid() })

// Null rather than a throw, so an unreadable body can be answered with a 400.
// A 500 would put a payload that can never succeed through QStash's whole retry
// budget.
function parseResourceId(rawBody: string): string | null {
  try {
    const parsed = bodySchema.safeParse(JSON.parse(rawBody))
    return parsed.success ? parsed.data.resourceId : null
  } catch {
    return null
  }
}

export async function POST(request: Request) {
  let clientId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const resourceId = parseResourceId(rawBody)
    if (resourceId === null) return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    const admin = createAdminClient()

    const resource = await getResourceById(admin, resourceId)
    if (!resource) return NextResponse.json({ error: 'resource_not_found' }, { status: 404 })
    clientId = resource.client_id
    // Deactivated while the job sat in the queue: there is nothing to read, and
    // writing chunks now would resurrect content for a file we can no longer send.
    if (!resource.is_active) return NextResponse.json({ ok: true, skipped: 'inactive' })

    try {
      const result = await readResourceContent(admin, resource)
      if (result.status === 'unsupported') {
        await markResourceContentUnsupported(admin, resourceId)
        await logEventSafe({
          clientId: resource.client_id, actor: ACTOR, type: 'resource.content_unsupported',
          payload: { resourceId, mimeType: resource.mime_type },
        })
        return NextResponse.json({ ok: true })
      }

      const sourceId = await upsertResourceKnowledgeSource(admin, {
        clientId: resource.client_id,
        resourceId,
        createdBy: resource.created_by,
        title: resource.title,
        content: result.content,
      })
      // Delete-then-insert, not append: QStash's automatic retries and the
      // manual re-read both land here and must never leave duplicate chunks.
      await deleteChunksForSource(admin, sourceId)
      await embedAndStoreChunks(admin, {
        clientId: resource.client_id, sourceId, content: result.content, actor: ACTOR,
      })
      // Last, so a row only ever reports 'ready' once its chunks are queryable.
      await markResourceContentReady(admin, {
        resourceId, content: result.content, summary: result.summary,
      })
      await logEventSafe({
        clientId: resource.client_id, actor: ACTOR, type: 'resource.content_read',
        payload: { resourceId, sourceId, charCount: result.content.length },
      })
    } catch (readError) {
      const message = readError instanceof AppError ? readError.message : 'Could not read this file'
      // Content from an earlier successful read goes with the failure. Leaving
      // the chunks in place would keep the agent answering out of a file whose
      // row now says it could not be read and whose menu line has lost its
      // summary — retrievable content no operator can see, explain or re-derive.
      await deleteResourceKnowledgeSource(admin, resourceId)
      await markResourceContentFailed(admin, resourceId, message)
      await logEventSafe({
        clientId: resource.client_id, actor: ACTOR, type: 'resource.content_read_failed',
        severity: 'warn', payload: { resourceId, message },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({ clientId, actor: ACTOR, type: 'resource.read_route_failed', source: 'pipeline', error })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
