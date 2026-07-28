import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { getActiveResourcesByIds, type ClientResourceRow } from '@/lib/db/client-resources'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'

/**
 * Validates an operator's picks before anything is written.
 *
 * The counterpart to applyAttachmentBudget: that one silently trims for the
 * automated path, which has no human to ask. Here there is one, so an
 * impossible selection is rejected while it is still a form the operator can
 * correct — rather than being discovered at send time, where the only outcome
 * left is a failed email.
 *
 * `clientId` scopes the lookup, so an id belonging to another client is
 * indistinguishable from one that does not exist.
 */
export async function resolveSelectedResources(
  supabase: SupabaseClient<Database>,
  clientId: string,
  resourceIds: readonly string[],
): Promise<ClientResourceRow[]> {
  if (resourceIds.length === 0) return []

  if (resourceIds.length > MAX_ATTACHMENTS_PER_EMAIL) {
    throw new AppError(
      'VALIDATION_ERROR',
      `An email may carry at most ${MAX_ATTACHMENTS_PER_EMAIL} attachments`,
      { clientId, count: resourceIds.length },
    )
  }

  const rows = await getActiveResourcesByIds(supabase, clientId, resourceIds)
  const byId = new Map(rows.map((row) => [row.id, row]))
  const missingResourceIds = resourceIds.filter((id) => !byId.has(id))
  if (missingResourceIds.length > 0) {
    throw new AppError(
      'VALIDATION_ERROR',
      'One of the selected files is no longer available',
      { clientId, missingResourceIds },
    )
  }

  // Caller ordering wins — the operator's pick order is the order the recipient
  // should see, and `.in()` gives no ordering guarantee.
  // safe: every id resolved above, so the map lookup cannot be undefined
  const ordered = resourceIds.map((id) => byId.get(id)!)

  // Checked against the stored byte_size rather than the downloaded bytes: the
  // point is to reject the selection now, not after paying for the downloads.
  const totalBytes = ordered.reduce((sum, row) => sum + row.byte_size, 0)
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Attachments exceed the 3MB per-email limit',
      { clientId, totalBytes, limitBytes: MAX_TOTAL_ATTACHMENT_BYTES },
    )
  }

  return ordered
}
