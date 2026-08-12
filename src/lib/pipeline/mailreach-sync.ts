import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listMailreachConnectedMailboxes, updateMailboxMailreachStats } from '@/lib/db/mailboxes'
import { getAccountStats } from '@/lib/mailreach/client'
import { resolveMailreachApiKey } from '@/lib/mailreach/client-api-keys'
import { logEventSafe } from '@/lib/events/log-event'

export interface MailreachSyncSummary {
  evaluated: number
  failed: number
}

/**
 * Refreshes the cached reputation score for every mailbox currently connected
 * to Mailreach, so /settings can show it to both operator and client without
 * calling the vendor API on every page load. Best-effort per mailbox — one
 * vendor failure doesn't stop the rest of the sweep. Runs the whole sweep
 * concurrently (Promise.all over per-mailbox work, each with its own
 * try/catch) rather than one mailbox at a time, so the sweep's runtime
 * doesn't scale linearly with the number of connected mailboxes.
 */
export async function runMailreachStatsSync(
  supabase: SupabaseClient<Database>,
  { now }: { now: Date },
): Promise<MailreachSyncSummary> {
  const mailboxes = await listMailreachConnectedMailboxes(supabase)
  const outcomes = await Promise.all(
    mailboxes.map(async (mailbox): Promise<boolean> => {
      if (!mailbox.mailreach_account_id) return true
      try {
        const stats = await getAccountStats(mailbox.mailreach_account_id, resolveMailreachApiKey(mailbox.client_id))
        await updateMailboxMailreachStats(supabase, mailbox.id, {
          reputationScore: stats.reputationScore,
          syncedAt: now.toISOString(),
        })
        return true
      } catch (error) {
        await logEventSafe({
          clientId: mailbox.client_id,
          actor: 'mailreach_stats_sync',
          type: 'mailbox.mailreach_stats_sync_failed',
          source: 'mailbox',
          payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
        })
        return false
      }
    }),
  )
  const failed = outcomes.filter((ok) => !ok).length
  return { evaluated: mailboxes.length, failed }
}
