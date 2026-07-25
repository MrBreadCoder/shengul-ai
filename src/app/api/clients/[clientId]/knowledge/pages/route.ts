import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { insertPendingWebsiteSources } from '@/lib/db/client-knowledge'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const MAX_URLS_PER_BATCH = 50
const bodySchema = z.object({ urls: z.array(z.string().url()).min(1).max(MAX_URLS_PER_BATCH) })

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const rawBody: unknown = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error', issues: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const inserted = await insertPendingWebsiteSources(
      admin,
      clientId,
      appUser.id,
      parsed.data.urls.map((url) => ({ url, title: url })),
    )

    for (const source of inserted) {
      await publishJson('/api/pipeline/knowledge-scrape', { sourceId: source.id })
    }

    await logEventSafe({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'knowledge.pages_selected',
      payload: { requestedCount: parsed.data.urls.length, insertedCount: inserted.length },
    })

    return NextResponse.json({ ok: true, insertedCount: inserted.length })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
