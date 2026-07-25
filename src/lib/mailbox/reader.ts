import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { updateMailboxOauth, type MailboxRow } from '@/lib/db/mailboxes'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { parseMailboxTokens, encryptMailboxTokens } from '@/lib/mailbox/tokens'
import type { FetchInboundResult } from '@/lib/mailbox/provider'
import { logEventSafe } from '@/lib/events/log-event'
import { withRetry } from '@/lib/http/with-retry'

// Runs a mailbox's provider fetchInbound and persists any refreshed access
// token. Token persistence is best-effort: a persistence failure must not fail
// the read (the messages were already fetched), so it is logged, not thrown.
export async function readInboundForMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
): Promise<FetchInboundResult> {
  const tokens = parseMailboxTokens(mailbox.oauth, mailbox.id)
  const provider = getMailboxProvider(mailbox.provider)
  const { result, tokens: refreshed } = await withRetry(() => provider.fetchInbound(tokens, mailbox.inbound_cursor))

  // ensureFresh returns the exact same tokens reference when no refresh
  // happened, so this both skips a no-op write and, via the conditional update
  // below, refuses to persist over a refresh a concurrent caller already wrote.
  if (refreshed !== tokens) {
    try {
      // Cast is safe: parseMailboxTokens above already proved mailbox.oauth is
      // a well-formed tokens object, not a primitive/array/null.
      await updateMailboxOauth(
        supabase,
        mailbox.id,
        encryptMailboxTokens(refreshed),
        mailbox.oauth as Record<string, Json>,
      )
    } catch (error) {
      await logEventSafe({
        clientId: mailbox.client_id,
        actor: 'mailbox_reader',
        type: 'mailbox.oauth_persist_failed',
        payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }

  return result
}
