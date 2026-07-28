import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { canManageOwnRow } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getResourceById, deactivateClientResource } from '@/lib/db/client-resources'
import { deleteResourceKnowledgeSource } from '@/lib/db/resource-content'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ clientId: string; resourceId: string }> },
) {
  const { appUser } = await requireUser()
  const { clientId, resourceId } = await context.params

  const admin = createAdminClient()
  const resource = await getResourceById(admin, resourceId)
  // Cross-client mismatch returns the same 404 as "not found" — no existence leak.
  if (!resource || resource.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  // Operators may remove anything; a client user only what they uploaded.
  if (!canManageOwnRow(appUser, resource)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    // Soft delete: emails already sent still reference this row, and the
    // RESTRICT FK on email_attachments would reject a hard delete anyway.
    //
    // The storage object is deliberately left in place. Deactivating hides the
    // resource from every menu and picker immediately, which is what "remove"
    // means here; deleting the bytes as well would leave every email that
    // already carried this file pointing at nothing, gutting the audit trail
    // the retained row exists to preserve.
    const deactivated = await deactivateClientResource(admin, resourceId)
    // The derived content goes with it: leaving the chunks in place would let
    // the agent keep answering from a file it can no longer attach.
    //
    // Deliberately outside the deactivation claim. There is no transaction
    // spanning both statements, so a cleanup that fails after a successful
    // deactivation leaves the row inactive with its chunks intact — and the
    // retry that fixes it finds the row already inactive and gets null back.
    // Gating this on the claim would make that state permanent. Deleting by
    // resource_id is idempotent, so the concurrent-delete case costs a no-op.
    await deleteResourceKnowledgeSource(admin, resourceId)
    // null means a concurrent delete already won — do not log it twice.
    if (deactivated) {
      await logEventSafe({
        clientId, actor: `human:${appUser.id}`, type: 'resource.deleted',
        payload: { resourceId, title: resource.title },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    await logError({
      clientId, actor: `human:${appUser.id}`, type: 'resource.delete_route_failed',
      source: 'app', error, payload: { resourceId },
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
