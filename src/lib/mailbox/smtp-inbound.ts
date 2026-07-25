import { simpleParser } from 'mailparser'
import type { ImapFlow } from 'imapflow'
import { AppError } from '@/lib/errors/app-error'
import type { FetchInboundResult, InboundMessage, SmtpCredentials } from './provider'
import { createImapClient } from './smtp-connection'
import { toMailAppError } from './smtp-errors'

/** Safety cap on how many messages one poll will pull down. */
export const MAX_MESSAGES_PER_POLL = 200

interface SmtpCursor {
  // Decimal string, not a number: the library returns a BigInt, which throws
  // on JSON.stringify.
  uidValidity: string
  lastUid: number
}

function parseSmtpCursor(cursor: string | null): SmtpCursor | null {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { uidValidity, lastUid } = parsed as { uidValidity?: unknown; lastUid?: unknown }
    if (typeof uidValidity !== 'string' || typeof lastUid !== 'number') return null
    return { uidValidity, lastUid }
  } catch {
    return null
  }
}

function serializeCursor(cursor: SmtpCursor): string {
  return JSON.stringify(cursor)
}

function firstReference(references: unknown): string | null {
  if (typeof references === 'string') return references.split(/\s+/)[0] ?? null
  if (Array.isArray(references)) {
    const first: unknown = references[0]
    return typeof first === 'string' ? first : null
  }
  return null
}

async function toInboundMessage(
  source: Buffer,
  uid: number,
  uidValidity: string,
): Promise<InboundMessage | null> {
  const parsed = await simpleParser(source)

  const address = parsed.from?.value[0]?.address
  if (!address) return null

  // The inbound dedup key, so it must be stable across polls. A bare UID is
  // not — uidValidity can reset — hence it is part of the synthetic fallback.
  const messageId = parsed.messageId ?? `smtp-uid-${uidValidity}-${uid}`

  const headers: Record<string, string> = {}
  for (const { key, line } of parsed.headerLines) {
    const separator = line.indexOf(':')
    headers[key.toLowerCase()] = separator === -1 ? '' : line.slice(separator + 1).trim()
  }

  return {
    providerMessageId: messageId,
    // Message-ID chaining, matching what smtp-send writes: the root of the
    // References chain identifies the conversation, and a new thread roots on
    // itself.
    threadId: firstReference(parsed.references) ?? parsed.inReplyTo ?? messageId,
    fromEmail: address.trim().toLowerCase(),
    subject: parsed.subject ?? null,
    body: parsed.text ?? '',
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    headers,
  }
}

async function collectInbound(client: ImapFlow, cursor: string | null): Promise<FetchInboundResult> {
  // client.mailbox is `MailboxObject | false` — false until a mailbox is open.
  const mailbox = client.mailbox
  if (!mailbox) {
    throw new AppError('EXTERNAL_ERROR', 'IMAP server did not report INBOX state', {
      status: 502,
      stage: 'imap',
    })
  }

  const uidValidity = mailbox.uidValidity.toString()
  const previous = parseSmtpCursor(cursor)

  // A null/unreadable cursor baselines. A uidValidity change means the mailbox
  // was recreated and every stored UID is meaningless, so it re-baselines the
  // same way — mirroring Gmail's expired-historyId and Graph's expired-delta
  // recovery.
  if (!previous || previous.uidValidity !== uidValidity) {
    return {
      messages: [],
      cursor: serializeCursor({ uidValidity, lastUid: mailbox.uidNext - 1 }),
    }
  }

  const messages: InboundMessage[] = []
  let highestUid = previous.lastUid
  let examined = 0

  for await (const message of client.fetch(
    `${previous.lastUid + 1}:*`,
    { uid: true, flags: true, source: true },
    { uid: true },
  )) {
    // IMAP returns the newest message for a range that starts past the end, so
    // an empty poll still yields one row. Without this guard it would be
    // re-ingested on every cycle.
    if (message.uid <= previous.lastUid) continue

    if (examined >= MAX_MESSAGES_PER_POLL) break
    examined += 1

    // Advance past every UID examined, mapped or not. Advancing only past
    // mapped messages would replay skipped drafts on every poll, and a
    // trailing run of them would wedge the cursor permanently.
    if (message.uid > highestUid) highestUid = message.uid

    const flags = message.flags ?? new Set<string>()
    if (flags.has('\\Deleted') || flags.has('\\Draft')) continue

    // A server can answer a source fetch with nothing; there is no message to
    // map without it, and the cursor has already moved past this UID.
    if (!message.source) continue

    const mapped = await toInboundMessage(message.source, message.uid, uidValidity)
    if (mapped) messages.push(mapped)
  }

  return { messages, cursor: serializeCursor({ uidValidity, lastUid: highestUid }) }
}

export async function fetchSmtpInbound(
  credentials: SmtpCredentials,
  cursor: string | null,
): Promise<FetchInboundResult> {
  const client = createImapClient(credentials)
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      return await collectInbound(client, cursor)
    } finally {
      lock.release()
    }
  } catch (error) {
    throw toMailAppError(error, 'imap')
  } finally {
    // close() rather than logout(): logout() throws when the connection never
    // came up, which would leak the socket for the rest of the invocation.
    client.close()
  }
}
