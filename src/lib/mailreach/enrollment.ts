import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { MailboxRow } from '@/lib/db/mailboxes'
import {
  listMailboxesForClient,
  updateMailboxMailreachConnected,
  updateMailboxMailreachDisconnected,
  clearMailboxMailreachConnection,
} from '@/lib/db/mailboxes'
import { parseMailboxTokens } from '@/lib/mailbox/tokens'
import { logEventSafe } from '@/lib/events/log-event'
import {
  connectSmtpAccount,
  disconnectAccount,
  completeOAuthConnect,
  buildOAuthAuthorizeUrl,
} from './client'

// First-ever enrollment stamps mailreach_started_at; every later
// reconnect (individual or bulk) reuses whatever was already stored, so the
// 14-day gate always resumes from the original date instead of restarting.
function startedAtFor(mailbox: Pick<MailboxRow, 'mailreach_started_at'>, now: Date): string {
  return mailbox.mailreach_started_at ?? now.toISOString()
}

// Legacy fallback only: mailboxes connected before first_name/last_name existed on
// the connect form have null columns here. Every mailbox created after this ships
// always has real values from the required form fields, so this branch only ever
// fires for pre-existing rows.
function legacyNameFallback(
  mailbox: Pick<MailboxRow, 'first_name' | 'last_name' | 'email_address'>,
): { firstName: string; lastName: string } {
  if (mailbox.first_name && mailbox.last_name) {
    return { firstName: mailbox.first_name, lastName: mailbox.last_name }
  }
  const local = mailbox.email_address.split('@')[0] ?? 'Mailbox'
  return { firstName: mailbox.first_name ?? local, lastName: mailbox.last_name ?? local }
}

export async function connectSmtpMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
  now: Date,
): Promise<void> {
  if (mailbox.provider !== 'smtp') {
    throw new AppError('VALIDATION_ERROR', 'Mailreach direct connect requires an SMTP mailbox', {
      mailboxId: mailbox.id, provider: mailbox.provider,
    })
  }
  const credentials = parseMailboxTokens(mailbox.oauth, mailbox.id)
  if (credentials.kind !== 'smtp') {
    throw new AppError('INVARIANT_VIOLATION', 'SMTP mailbox has non-smtp credentials', { mailboxId: mailbox.id })
  }
  const { firstName, lastName } = legacyNameFallback(mailbox)
  const { accountId } = await connectSmtpAccount({
    emailAddress: credentials.emailAddress,
    firstName,
    lastName,
    username: credentials.username,
    password: credentials.password,
    smtpHost: credentials.smtpHost,
    smtpPort: credentials.smtpPort,
    smtpSecure: credentials.smtpSecure,
    imapHost: credentials.imapHost,
    imapPort: credentials.imapPort,
    imapSecure: credentials.imapSecure,
  })
  await updateMailboxMailreachConnected(supabase, mailbox.id, {
    mailreach_account_id: accountId,
    mailreach_status: 'connected',
    mailreach_started_at: startedAtFor(mailbox, now),
    mailreach_enabled: true,
  })
}

export function oauthAuthorizeUrl(params: { provider: 'gmail' | 'outlook'; redirectUri: string; state: string }): string {
  return buildOAuthAuthorizeUrl(params)
}

export async function completeOAuthConnectForMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
  code: string,
  now: Date,
): Promise<void> {
  if (mailbox.provider !== 'gmail' && mailbox.provider !== 'outlook') {
    throw new AppError('VALIDATION_ERROR', 'Mailreach OAuth connect requires a gmail or outlook mailbox', {
      mailboxId: mailbox.id, provider: mailbox.provider,
    })
  }
  const { accountId } = await completeOAuthConnect({ code, provider: mailbox.provider })
  await updateMailboxMailreachConnected(supabase, mailbox.id, {
    mailreach_account_id: accountId,
    mailreach_status: 'connected',
    mailreach_started_at: startedAtFor(mailbox, now),
    mailreach_enabled: true,
  })
}

// Best-effort on the vendor call, same as bulkDisconnectForClient below: the
// remote account may already be gone (404) or unreachable, but the local
// mailbox record must not get stuck showing 'connected' over a vendor failure
// there is no way to retry from the UI.
export async function disconnectMailbox(supabase: SupabaseClient<Database>, mailbox: MailboxRow): Promise<void> {
  if (mailbox.mailreach_account_id) {
    try {
      await disconnectAccount(mailbox.mailreach_account_id)
    } catch (error) {
      await logEventSafe({
        clientId: mailbox.client_id, actor: 'mailreach_disconnect', type: 'mailbox.mailreach_disconnect_failed',
        source: 'mailbox', payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  await updateMailboxMailreachDisconnected(supabase, mailbox.id)
}

export interface BulkResult {
  attempted: number
  succeeded: number
  failed: number
}

// Client master switch OFF: disconnect every currently-connected mailbox.
// Best-effort per mailbox — one vendor failure doesn't strand the rest still
// billed. Each mailbox's own mailreach_enabled intent is left untouched (see
// clearMailboxMailreachConnection) so a later switch-on knows what to resume.
export async function bulkDisconnectForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<BulkResult> {
  const targets = (await listMailboxesForClient(supabase, clientId)).filter((m) => m.mailreach_status === 'connected')
  let succeeded = 0
  let failed = 0
  for (const mailbox of targets) {
    try {
      if (mailbox.mailreach_account_id) await disconnectAccount(mailbox.mailreach_account_id)
      await clearMailboxMailreachConnection(supabase, mailbox.id)
      succeeded += 1
    } catch (error) {
      failed += 1
      await logEventSafe({
        clientId, actor: 'mailreach_bulk_disconnect', type: 'mailbox.mailreach_disconnect_failed', source: 'mailbox',
        payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return { attempted: targets.length, succeeded, failed }
}

// Client master switch ON: silently reconnect every enabled SMTP mailbox (we
// hold the credentials). Gmail/Outlook mailboxes need interactive OAuth
// consent and are deliberately excluded here — they surface a "needs
// reconnect" affordance in the UI instead (see mailreach-controls.tsx).
export async function bulkReconnectSmtpForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  now: Date,
): Promise<BulkResult> {
  const targets = (await listMailboxesForClient(supabase, clientId)).filter(
    (m) => m.mailreach_enabled && m.provider === 'smtp' && m.mailreach_status !== 'connected',
  )
  let succeeded = 0
  let failed = 0
  for (const mailbox of targets) {
    try {
      await connectSmtpMailbox(supabase, mailbox, now)
      succeeded += 1
    } catch (error) {
      failed += 1
      await logEventSafe({
        clientId, actor: 'mailreach_bulk_reconnect', type: 'mailbox.mailreach_reconnect_failed', source: 'mailbox',
        payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return { attempted: targets.length, succeeded, failed }
}
