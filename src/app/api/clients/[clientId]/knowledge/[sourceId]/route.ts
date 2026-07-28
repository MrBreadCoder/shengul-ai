import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { canManageOwnRow } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSourceById, deleteSource } from '@/lib/db/client-knowledge'
import { deleteClientKnowledgeFileObject } from '@/lib/storage/client-knowledge-files'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ clientId: string; sourceId: string }> },
) {
  const { appUser } = await requireUser()
  const { clientId, sourceId } = await context.params
  const admin = createAdminClient()
  const source = await getSourceById(admin, sourceId)
  // Cross-client mismatch returns the same 404 as "not found" — no existence leak.
  if (!source || source.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  // Operators may remove anything; a client user may only remove what they
  // uploaded. Checked after the 404 so a non-owner learns nothing about
  // existence beyond what the 404 already tells them.
  if (!canManageOwnRow(appUser, source)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // This source is a resource's derived content, not a curated knowledge entry.
  // Removing it here would leave the resource reporting 'ready' with no chunks
  // behind it; removal belongs to the resource's own delete path.
  if (source.resource_id) {
    return NextResponse.json({ error: 'resource_backed' }, { status: 400 })
  }

  try {
    await deleteSource(admin, sourceId)
    if (source.storage_path) {
      await deleteClientKnowledgeFileObject(admin, source.storage_path)
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
