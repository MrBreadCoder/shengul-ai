import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSourceById, deleteSource } from '@/lib/db/client-knowledge'
import { deleteClientKnowledgePdfObject } from '@/lib/storage/client-knowledge-pdfs'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function DELETE(
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
  // Cross-client mismatch returns the same 404 as "not found" — no existence leak.
  if (!source || source.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    await deleteSource(admin, sourceId)
    if (source.source_type === 'pdf' && source.storage_path) {
      await deleteClientKnowledgePdfObject(admin, source.storage_path)
    }
    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.source_deleted',
      payload: { sourceId, sourceType: source.source_type, title: source.title },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    await logError({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'knowledge.delete_route_failed',
      source: 'app',
      error,
      payload: { sourceId, sourceType: source.source_type },
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
