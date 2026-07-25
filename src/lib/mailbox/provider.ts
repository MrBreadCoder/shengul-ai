import { AppError } from '@/lib/errors/app-error'

export interface OAuthCredentials {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
}

export interface SmtpCredentials {
  kind: 'smtp'
  // The From address. Lives here rather than being read from
  // mailboxes.email_address because sendEmail only ever receives credentials,
  // not the row. User-entered: SMTP/IMAP have no profile endpoint to discover
  // it from, unlike the Gmail/Graph userinfo lookups in exchangeCode.
  emailAddress: string
  username: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean // true = implicit TLS (465), false = STARTTLS (587)
  imapHost: string
  imapPort: number
  imapSecure: boolean
}

export type MailboxCredentials = OAuthCredentials | SmtpCredentials

export interface SendEmailInput {
  to: string
  subject: string
  body: string
  // Threading (follow-ups only). threadId is the provider conversation id from
  // the first-touch send; inReplyToMessageId/references are RFC 2822 Message-IDs
  // used to build the In-Reply-To / References headers so the reply threads.
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
}

export interface SendEmailResult {
  providerMessageId: string
  threadId: string
}

export interface ExchangeResult {
  // Only ever produced by an OAuth code exchange, so this narrows past the union.
  tokens: OAuthCredentials
  emailAddress: string
  displayName: string | null
}

export interface InboundMessage {
  providerMessageId: string   // Gmail message id / Graph message id / RFC Message-ID — inbound dedup key
  threadId: string            // Gmail threadId / Graph conversationId / root Message-ID
  fromEmail: string           // lowercased sender address
  subject: string | null
  body: string                // plain text
  receivedAt: string          // ISO
  // Lowercased header names -> value (last wins). Gmail and SMTP always
  // populate this from the full message; Graph only when it returns
  // internetMessageHeaders, so consumers must treat {} as "unknown", not "absent".
  headers: Record<string, string>
}

export interface FetchInboundResult {
  // Opaque, provider-specific: Gmail historyId, Outlook delta link, SMTP
  // JSON {uidValidity,lastUid}. Persisted per-mailbox and passed back on the
  // next poll. A null cursor means "baseline now, ingest nothing".
  messages: InboundMessage[]
  cursor: string
}

/**
 * What every mailbox implementation must provide. Deliberately excludes the
 * OAuth handshake: an SMTP mailbox authenticates with a stored password and
 * has no consent screen. sender.ts, reader.ts, and the test-email route all
 * consume this base type via the registry.
 */
export interface MailboxProvider {
  readonly provider: 'gmail' | 'outlook' | 'smtp'
  // Returns the send result plus (possibly refreshed) credentials to persist.
  sendEmail(
    credentials: MailboxCredentials,
    input: SendEmailInput,
  ): Promise<{ result: SendEmailResult; tokens: MailboxCredentials }>
  // Returns new inbound messages since `cursor`, plus the next cursor and any
  // refreshed credentials to persist. A null cursor baselines (empty messages).
  fetchInbound(
    credentials: MailboxCredentials,
    cursor: string | null,
  ): Promise<{ result: FetchInboundResult; tokens: MailboxCredentials }>
}

/** A provider whose connection flow is an OAuth redirect + code exchange. */
export interface OAuthMailboxProvider extends MailboxProvider {
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<ExchangeResult>
}

// The registry hands every provider the same union, so each implementation
// narrows at its entry point. A mismatch means a mailbox row's provider column
// disagrees with its stored credential shape — a data/programming error, not a
// user-recoverable one.
export function requireOAuthCredentials(
  credentials: MailboxCredentials,
  provider: string,
): OAuthCredentials {
  if (credentials.kind !== 'oauth') {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox provider received credentials of the wrong kind', {
      provider,
      expected: 'oauth',
      received: credentials.kind,
    })
  }
  return credentials
}

export function requireSmtpCredentials(
  credentials: MailboxCredentials,
  provider: string,
): SmtpCredentials {
  if (credentials.kind !== 'smtp') {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox provider received credentials of the wrong kind', {
      provider,
      expected: 'smtp',
      received: credentials.kind,
    })
  }
  return credentials
}
