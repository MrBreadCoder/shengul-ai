import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { canManageOwnRow } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getResourceById } from '@/lib/db/client-resources'
import { resetResourceContentToPending, markResourceContentFailed } from '@/lib/db/resource-content'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Re-reads a resource whose content is missing or failed. Also the backfill
// entry point for rows uploaded before 0019.
export async function POST(
  _request: Request,
  context: { params: Promise<{ clientId: string; resourceId: string }> },
) {
  const { appUser } = await requireUser()
  const { clientId, resourceId } = await context.params

  const admin = createAdminClient()
  const resource = await getResourceById(admin, resourceId)
  // A cross-client mismatch and a removed resource both return the same 404 as
  // "not found" — no existence leak, and nothing to read either way.
  if (!resource || resource.client_id !== clientId || !resource.is_active) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  // This route writes with the service-role client, which bypasses RLS — this
  // check is the authorization boundary, not the policy.
  if (!canManageOwnRow(appUser, resource)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // A read is already queued for this row. Publishing a second one would put two
  // workers on the same resource, racing the delete-then-insert that keeps its
  // chunks unique — one worker's delete can land between the other's delete and
  // its insert, leaving duplicates or nothing at all.
  if (resource.content_status === 'pending') {
    return NextResponse.json({ error: 'already_reading' }, { status: 409 })
  }

  try {
    await resetResourceContentToPending(admin, resourceId)
    try {
      await publishJson('/api/pipeline/resource-read', { resourceId })
    } catch (publishError) {
      // The row was just reset to pending, so leaving it there would show a
      // spinner for a job that will never run. Put it back into a state the
      // operator can act on and surface the failure.
      await markResourceContentFailed(admin, resourceId, 'Could not start reading this file')
      throw publishError
    }
    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'resource.read_requested',
      payload: { resourceId, title: resource.title },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    await logError({
      clientId, actor: `human:${appUser.id}`, type: 'resource.read_route_failed',
      source: 'app', error, payload: { resourceId },
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
