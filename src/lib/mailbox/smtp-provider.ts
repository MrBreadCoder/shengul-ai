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
