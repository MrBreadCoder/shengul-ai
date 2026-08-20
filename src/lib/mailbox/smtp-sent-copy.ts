import type { ImapFlow } from 'imapflow'
import MailComposer from 'nodemailer/lib/mail-composer'
import { AppError } from '@/lib/errors/app-error'
import type { SendEmailInput, SmtpCredentials } from './provider'
import { createImapClient } from './smtp-connection'
import { toMailAppError, withMailDeadline } from './smtp-errors'

/**
 * Common Sent-folder names across SMTP/IMAP providers that don't advertise
 * the RFC 6154 SPECIAL-USE \Sent flag. Checked, in order, only after the
 * flag lookup comes up empty.
 */
const SENT_FOLDER_FALLBACKS = ['Sent', 'Sent Items', 'Sent Mail', 'Sent Messages', 'INBOX.Sent', 'INBOX/Sent']

/** Finds the account's Sent folder, preferring the RFC 6154 \Sent special-use flag. */
async function resolveSentFolderPath(client: ImapFlow): Promise<string | null> {
  const mailboxes = await client.list()

  const bySpecialUse = mailboxes.find((mailbox) => mailbox.specialUse === '\\Sent')
  if (bySpecialUse) return bySpecialUse.path

  const byName = mailboxes.find((mailbox) =>
    SENT_FOLDER_FALLBACKS.some((name) => name.toLowerCase() === mailbox.path.toLowerCase()),
  )
  return byName?.path ?? null
}

/**
 * Rebuilds the exact RFC 822 message this app sent over SMTP, so the copy
 * filed into Sent carries the same Message-ID as the one the recipient
 * received (the caller passes back `providerMessageId` from the real send —
 * see appendSentCopy). Message-ID chaining is how this app threads
 * follow-ups, so a mismatch here would make the visible Sent copy look like
 * a different, unrelated message to anyone reading it in their own mailbox.
 */
function buildRawMessage(
  credentials: SmtpCredentials,
  input: SendEmailInput,
  providerMessageId: string,
): Promise<Buffer> {
  const attachments = (input.attachments ?? []).map((attachment) => ({
    filename: attachment.fileName,
    content: attachment.content,
    contentType: attachment.mimeType,
  }))

  const composer = new MailComposer({
    from: credentials.emailAddress,
    to: input.to,
    subject: input.subject,
    text: input.body,
    messageId: providerMessageId,
    date: new Date(),
    ...(input.inReplyToMessageId ? { inReplyTo: input.inReplyToMessageId } : {}),
    ...(input.references ? { references: input.references } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  })

  return composer.compile().build()
}

/**
 * Files a copy of an already-sent SMTP message into the mailbox's own Sent
 * folder over IMAP.
 *
 * Plain SMTP submission is a one-way relay to the recipient's mail server —
 * it never touches the sending account's own IMAP store. Gmail's and Graph's
 * send APIs save a Sent copy as an inherent part of sending; generic SMTP has
 * no equivalent, so without this extra step a client reading their own
 * mailbox never sees mail this app sent on their behalf, even though the send
 * itself succeeded.
 *
 * Best-effort by contract: the message has already been delivered by the time
 * this runs, so every caller must treat a rejection here as "the send still
 * succeeded, only the visible copy is missing" and must never fail the send
 * over it (see smtp-provider.ts).
 */
export async function appendSentCopy(
  credentials: SmtpCredentials,
  input: SendEmailInput,
  providerMessageId: string,
): Promise<void> {
  const raw = await buildRawMessage(credentials, input, providerMessageId)
  const client = createImapClient(credentials)
  try {
    await withMailDeadline('imap', () => client.connect())

    const sentPath = await withMailDeadline('imap', () => resolveSentFolderPath(client))
    if (!sentPath) {
      throw new AppError('EXTERNAL_ERROR', 'Could not find a Sent folder on this IMAP account', {
        status: 502,
        stage: 'imap',
      })
    }

    // \Seen: an unread flag on the sender's own copy of their own outgoing
    // mail would misrepresent it as something the client hasn't looked at.
    await withMailDeadline('imap', () => client.append(sentPath, raw, ['\\Seen']))
  } catch (error) {
    throw toMailAppError(error, 'imap')
  } finally {
    // close() rather than logout(): logout() throws when the connection never
    // came up, which would leak the socket for the rest of the invocation.
    client.close()
  }
}
