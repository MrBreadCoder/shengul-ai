import type { InboundMessage } from './provider'

export type BounceKind = 'hard' | 'soft'

export interface BounceReport {
  /** 5.x.x is permanent (suppress); 4.x.x or unparseable is transient (record only). */
  kind: BounceKind
  /** The address that failed, lowercased, or null when it could not be extracted. */
  recipient: string | null
  /** RFC 3463 enhanced status code, e.g. '5.1.1'. */
  statusCode: string | null
  /** The Diagnostic-Code line, truncated — useful in the operator log. */
  diagnostic: string | null
}

// Bounces come from the receiving MTA, not a person. `noreply@` is deliberately
// excluded: it is the single biggest false-positive source (every newsletter).
const DAEMON_SENDER = /^(mailer-daemon|postmaster)@/i

const BOUNCE_SUBJECT =
  /^(undeliverable|delivery status notification|returned mail|mail delivery (failed|subsystem)|failure notice|delivery has failed)/i

const DSN_CONTENT_TYPE = /report-type=["']?delivery-status/i

const STATUS_CODE = /\b([45])\.(\d{1,3})\.(\d{1,3})\b/
const FINAL_RECIPIENT = /^(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>]+@[^\s<>]+?)>?\s*$/im
const DIAGNOSTIC_CODE = /^diagnostic-code:\s*(.+)$/im
// The trailing group is repeated rather than a single [\w.-]+ class so a
// sentence-final period ("...to vp@target.com.") is not swallowed into the address.
const ANY_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const MAX_DIAGNOSTIC_CHARS = 300

function extractRecipient(body: string, mailboxAddress: string): string | null {
  const explicit = FINAL_RECIPIENT.exec(body)
  if (explicit) return explicit[1]!.toLowerCase() // regex group 1 exists on a match

  // Fallback for providers that render the DSN as prose (Exchange often does):
  // the first address in the body that is neither our own mailbox nor a daemon.
  const self = mailboxAddress.toLowerCase()
  for (const candidate of body.match(ANY_EMAIL) ?? []) {
    const address = candidate.toLowerCase()
    if (address !== self && !DAEMON_SENDER.test(address)) return address
  }
  return null
}

/**
 * Whether this inbound message is a delivery status notification, and if so what
 * failed. Returns null for ordinary mail.
 *
 * Detection is deliberately layered because neither provider is reliable alone:
 * Gmail exposes the real `Content-Type: multipart/report`, Exchange exposes
 * `X-MS-Exchange-Message-Is-Ndr`, and Graph sometimes returns neither — so a
 * daemon sender still counts, but only when corroborated by a bounce subject or
 * a parseable status code, so a "mailbox quota" notice from postmaster is not
 * mistaken for a bounce.
 */
export function detectBounce(message: InboundMessage, mailboxAddress: string): BounceReport | null {
  const body = message.body
  const statusMatch = STATUS_CODE.exec(body)

  const hasDsnHeader =
    DSN_CONTENT_TYPE.test(message.headers['content-type'] ?? '') ||
    'x-ms-exchange-message-is-ndr' in message.headers
  const fromDaemon = DAEMON_SENDER.test(message.fromEmail)
  const hasBounceSubject = BOUNCE_SUBJECT.test(message.subject ?? '')

  const isBounce = hasDsnHeader || (fromDaemon && (hasBounceSubject || statusMatch !== null))
  if (!isBounce) return null

  const diagnosticMatch = DIAGNOSTIC_CODE.exec(body)
  return {
    // No parseable code means we do not know it is permanent, and guessing wrong
    // would suppress a live address forever. Treat it as soft and log it.
    kind: statusMatch?.[1] === '5' ? 'hard' : 'soft',
    recipient: extractRecipient(body, mailboxAddress),
    statusCode: statusMatch?.[0] ?? null,
    diagnostic: diagnosticMatch ? diagnosticMatch[1]!.trim().slice(0, MAX_DIAGNOSTIC_CHARS) : null,
  }
}

const AUTO_SUBMITTED = /auto-(replied|generated|notified)/i
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[-\s]?response|autoreply|out of office|ooo)\b/i

/**
 * Whether this is a vacation responder / auto-acknowledgement rather than a real
 * reply. Callers must check detectBounce first — a DSN also carries
 * `Auto-Submitted: auto-replied`.
 *
 * The subject check is anchored to the start of the line so "Re: I am out of
 * office next week" from a real person is not swallowed.
 */
export function detectAutoReply(message: InboundMessage): boolean {
  const { headers } = message
  if (AUTO_SUBMITTED.test(headers['auto-submitted'] ?? '')) return true
  if ('x-autoreply' in headers || 'x-autorespond' in headers) return true
  if ((headers['precedence'] ?? '').toLowerCase() === 'auto_reply') return true
  return AUTO_SUBJECT.test(message.subject ?? '')
}
