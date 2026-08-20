import { logWarn } from '@/lib/events/log-event'
import {
  requireSmtpCredentials,
  type FetchInboundResult,
  type MailboxCredentials,
  type MailboxProvider,
  type SendEmailInput,
  type SendEmailResult,
} from './provider'
import { fetchSmtpInbound } from './smtp-inbound'
import { sendSmtpEmail } from './smtp-send'
import { appendSentCopy } from './smtp-sent-copy'

/**
 * A password-authenticated mailbox: SMTP out, IMAP in. Implements the base
 * MailboxProvider contract only — there is no consent screen to redirect to,
 * so it is not an OAuthMailboxProvider.
 */
export const smtpProvider: MailboxProvider = {
  provider: 'smtp',

  async sendEmail(
    credentials: MailboxCredentials,
    input: SendEmailInput,
  ): Promise<{ result: SendEmailResult; tokens: MailboxCredentials }> {
    const smtp = requireSmtpCredentials(credentials, 'smtp')
    const result = await sendSmtpEmail(smtp, input)

    // Best-effort, and deliberately not folded into sendSmtpEmail itself: the
    // real send already succeeded by this point, so a failure filing the
    // visible copy must never surface as a send failure — that would read as
    // a delivery failure to the caller and risk a duplicate-send retry for
    // mail that already went out. See smtp-sent-copy.ts for why this step
    // exists at all.
    try {
      await appendSentCopy(smtp, input, result.providerMessageId)
    } catch (error) {
      await logWarn({
        clientId: null,
        actor: 'system',
        type: 'mailbox.sent_copy_failed',
        source: 'mailbox',
        error,
        payload: { mailboxEmail: smtp.emailAddress, providerMessageId: result.providerMessageId },
      })
    }

    // Static credentials, so the same reference goes back out. That is exactly
    // what tells sender.ts and reader.ts there is nothing to re-persist.
    return { result, tokens: credentials }
  },

  async fetchInbound(
    credentials: MailboxCredentials,
    cursor: string | null,
  ): Promise<{ result: FetchInboundResult; tokens: MailboxCredentials }> {
    const smtp = requireSmtpCredentials(credentials, 'smtp')
    const result = await fetchSmtpInbound(smtp, cursor)
    return { result, tokens: credentials }
  },
}
