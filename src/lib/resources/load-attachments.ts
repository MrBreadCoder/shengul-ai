import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { getActiveResourcesByIds } from '@/lib/db/client-resources'
import { downloadClientResource } from '@/lib/storage/client-resources'
import { assertWithinAttachmentLimits, type EmailAttachment } from '@/lib/mailbox/attachments'

/**
 * Turns resource ids into wire-ready attachments. Deliberately fails loudly on
 * every way the set can come up short — a deleted row, an id belonging to
 * another client, a missing storage object — because an email whose body
 * promises "attached are the examples" going out with nothing attached is worse
 * than a failed send the caller can retry or correct.
 *
 * `clientId` scopes the lookup, so an id belonging to another client raises
 * NOT_FOUND rather than leaking a file across tenants.
 */
export async function loadResourceAttachments(
  supabase: SupabaseClient<Database>,
  clientId: string,
  resourceIds: readonly string[],
): Promise<EmailAttachment[]> {
  if (resourceIds.length === 0) return []

  const rows = await getActiveResourcesByIds(supabase, clientId, resourceIds)
  const byId = new Map(rows.map((row) => [row.id, row]))
  // A row that was soft-deleted between the pick and the send drops out of
  // getActiveResourcesByIds. Silently continuing would send the promise without
  // the file, so name the missing ids and let the caller decide.
  const missingResourceIds = resourceIds.filter((id) => !byId.has(id))
  if (missingResourceIds.length > 0) {
    throw new AppError(
      'NOT_FOUND',
      'An attached file is no longer available. Edit the attachments and try again.',
      { clientId, missingResourceIds },
    )
  }

  // Caller ordering wins: the AI's menu order (or the operator's pick order) is
  // the order the recipient should see, and `.in()` gives no ordering guarantee.
  const attachments = await Promise.all(
    resourceIds.map(async (id) => {
      // safe: every id resolved above, so the map lookup cannot be undefined
      const row = byId.get(id)!
      return {
        fileName: row.file_name,
        mimeType: row.mime_type,
        content: await downloadClientResource(supabase, row.storage_path),
      }
    }),
  )

  assertWithinAttachmentLimits(attachments)
  return attachments
}
