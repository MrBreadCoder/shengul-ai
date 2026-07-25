import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError, isAppError } from '@/lib/errors/app-error'
import {
  listMailboxesByIds,
  claimMailboxSend,
  updateMailboxOauth,
  setMailboxHealth,
  type MailboxRow,
} from '@/lib/db/mailboxes'
import { getSuppression } from '@/lib/db/suppressions'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { parseMailboxTokens, encryptMailboxTokens } from '@/lib/mailbox/tokens'
import { effectiveDailyCap } from '@/lib/mailbox/warmup'
import { HEALTH_REASON } from '@/lib/mailbox/health'
import { logEventSafe, logWarn } from '@/lib/events/log-event'
import { withExternalLogging } from '@/lib/events/with-external-logging'
import { withRetry } from '@/lib/http/with-retry'

const DEFAULT_MAX_JITTER_MS = 4_000

/**
 * Why we are sending. 'outreach' is anything unsolicited (first touch,
 * follow-up); 'reply' is a response to mail the recipient sent us. The two
 * differ only in how suppression is enforced.
 */
export type SendPurpose = 'outreach' | 'reply'

export interface SendViaMailboxInput {
  clientId: string
  mailboxIds: string[]
  to: string
  subject: string
  body: string
  purpose: SendPurpose
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
  maxJitterMs?: number
}

export interface SendViaMailboxResult {
  mailboxId: string
  providerMessageId: string
  threadId: string
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Rotation: least-used-first, so sends spread evenly across a campaign's
// mailboxes and warm them uniformly. 'warning' is a soft flag that still sends;
// only 'blocked' takes a mailbox out of rotation.
function rotationOrder(mailboxes: MailboxRow[]): MailboxRow[] {
  return [...mailboxes]
    .filter((m) => m.health !== 'blocked')
    .sort((a, b) => a.sent_today - b.sent_today)
}

export async function sendViaMailbox(
  supabase: SupabaseClient<Database>,
  input: SendViaMailboxInput,
): Promise<SendViaMailboxResult> {
  if (input.mailboxIds.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Campaign has no mailboxes configured', { clientId: input.clientId })
  }

  // The single suppression chokepoint. Every send path in the app funnels
  // through here, so an unsuppressed caller cannot leak an outreach email —
  // callers may still pre-check to skip work, but this is the enforcement.
  // A 'bounced' suppression blocks even a reply: the address is dead, and
  // sending to it again is exactly what drives the mailbox bounce rate up.
  const suppression = await getSuppression(supabase, input.clientId, input.to)
  if (suppression && (input.purpose === 'outreach' || suppression.reason === 'bounced')) {
    const error = new AppError('FORBIDDEN', 'Recipient is suppressed', {
      clientId: input.clientId, reason: suppression.reason, purpose: input.purpose,
    })
    await logWarn({
      clientId: input.clientId,
      actor: 'system',
      type: 'mailbox.send.suppressed',
      source: 'mailbox',
      error,
      payload: { reason: suppression.reason, purpose: input.purpose },
    })
    throw error
  }

  const mailboxes = await listMailboxesByIds(supabase, input.mailboxIds)
  const ordered = rotationOrder(mailboxes)
  if (ordered.length === 0) {
    const error = new AppError('RATE_LIMITED', 'No healthy mailbox available', { clientId: input.clientId })
    // A warning, not an error: this is an expected daily-cap/health condition
    // the pipeline handles, but the operator still needs to see that this
    // client stopped sending.
    await logWarn({
      clientId: input.clientId,
      actor: 'system',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      error,
      payload: { mailboxCount: mailboxes.length },
    })
    throw error
  }

  const now = new Date()
  for (const candidate of ordered) {
    const cap = effectiveDailyCap({
      profile: candidate.warmup_profile,
      warmupStartedAt: candidate.warmup_started_at,
      dailyCap: candidate.daily_cap,
      now,
    })
    const claimed = await claimMailboxSend(supabase, candidate.id, cap)
    if (!claimed) continue // at cap for today, or turned unhealthy — try the next

    const tokens = parseMailboxTokens(claimed.oauth, claimed.id)
    const provider = getMailboxProvider(claimed.provider)
    const jitter = Math.floor(Math.random() * (input.maxJitterMs ?? DEFAULT_MAX_JITTER_MS))
    if (jitter > 0) await sleep(jitter)

    let sendResult: Awaited<ReturnType<typeof provider.sendEmail>>
    try {
      sendResult = await withExternalLogging(
        'mailbox',
        {
          clientId: input.clientId,
          actor: 'system',
          failureType: 'mailbox.send.failed',
          payload: { mailboxId: claimed.id, provider: claimed.provider },
        },
        () =>
          withRetry(() =>
            provider.sendEmail(tokens, {
              to: input.to,
              subject: input.subject,
              body: input.body,
              threadId: input.threadId ?? null,
              inReplyToMessageId: input.inReplyToMessageId ?? null,
              references: input.references ?? null,
            }),
          ),
      )
    } catch (error) {
      // The provider refreshes the access token immediately before sending, so a
      // 401 here means the grant itself was revoked (user removed the app,
      // password change, admin policy). Every future send will fail the same way,
      // so block the mailbox and make the operator reconnect it.
      if (isAppError(error) && error.context.status === 401) {
        await setMailboxHealth(supabase, claimed.id, 'blocked', HEALTH_REASON.authFailure)
      }
      throw error
    }
    const { result, tokens: refreshed } = sendResult

    // Persist any refreshed access token so the next send doesn't re-refresh.
    // Best-effort: the email is already sent, so a persistence failure here
    // must not reject the call — that would look like a send failure to the
    // caller and risk a duplicate-send retry for mail that already went out.
    try {
      // Cast is safe: parseMailboxTokens above already proved claimed.oauth is a
      // well-formed tokens object, not a primitive/array/null. The CAS guard
      // avoids clobbering a token a concurrent reader already refreshed.
      await updateMailboxOauth(
        supabase,
        claimed.id,
        encryptMailboxTokens(refreshed),
        claimed.oauth as Record<string, Json>,
      )
    } catch (error) {
      await logEventSafe({
        clientId: input.clientId,
        actor: 'mailbox_sender',
        type: 'mailbox.oauth_persist_failed',
        payload: { mailboxId: claimed.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }

    return {
      mailboxId: claimed.id,
      providerMessageId: result.providerMessageId,
      threadId: result.threadId,
    }
  }

  throw new AppError('RATE_LIMITED', 'All mailboxes at daily cap', { clientId: input.clientId })
}
