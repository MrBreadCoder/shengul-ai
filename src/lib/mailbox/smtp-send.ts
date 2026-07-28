import { AppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from './headers'
import type { SendEmailInput, SendEmailResult, SmtpCredentials } from './provider'
import { createSmtpTransport } from './smtp-connection'
import { toMailAppError, withMailDeadline } from './smtp-errors'

/**
 * Sends one message over SMTP.
 *
 * Threading is Message-ID chaining, because IMAP has no server-side thread id
 * the way Gmail and Graph do. A first touch roots the thread on its own
 * generated Message-ID; a reply carries the incoming threadId through
 * unchanged so it stays stable for the life of the conversation.
 */
export async function sendSmtpEmail(
  credentials: SmtpCredentials,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  // Validated before a connection is opened: a rejected header is the caller's
  // bug, and there is no reason to touch the network to discover that.
  const to = assertNoHeaderInjection(input.to, 'to')
  const subject = assertNoHeaderInjection(input.subject, 'subject')
  const inReplyTo = input.inReplyToMessageId
    ? assertNoHeaderInjection(input.inReplyToMessageId, 'inReplyToMessageId')
    : undefined
  const references = input.references
    ? assertNoHeaderInjection(input.references, 'references')
    : undefined
  const attachments = (input.attachments ?? []).map((attachment) => ({
    filename: assertNoHeaderInjection(attachment.fileName, 'attachmentFileName'),
    content: attachment.content,
    contentType: assertNoHeaderInjection(attachment.mimeType, 'attachmentMimeType'),
  }))

  const transport = createSmtpTransport(credentials)
  try {
    const info = await withMailDeadline('smtp', () =>
      transport.sendMail({
        from: credentials.emailAddress,
        to,
        subject,
        text: input.body,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
    )

    const messageId: unknown = info.messageId
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new AppError(
        'EXTERNAL_ERROR',
        'SMTP server accepted the message without returning a Message-ID',
        { status: 502, stage: 'smtp' },
      )
    }

    return { providerMessageId: messageId, threadId: input.threadId ?? messageId }
  } catch (error) {
    throw toMailAppError(error, 'smtp')
  } finally {
    transport.close()
  }
}
