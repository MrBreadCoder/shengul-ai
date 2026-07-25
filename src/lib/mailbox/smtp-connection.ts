import nodemailer, { type Transporter } from 'nodemailer'
import { ImapFlow } from 'imapflow'
import type { SmtpCredentials } from './provider'
import { MAIL_DEADLINE_MS, toMailAppError, withMailDeadline } from './smtp-errors'

/**
 * A single-use transport. Deliberately unpooled: sends are jittered and spread
 * across a client's mailboxes, so a pooled connection would sit idle far
 * longer than a serverless invocation lives.
 */
export function createSmtpTransport(credentials: SmtpCredentials): Transporter {
  return nodemailer.createTransport({
    host: credentials.smtpHost,
    port: credentials.smtpPort,
    // true = implicit TLS (465); false = plaintext connect then STARTTLS (587).
    secure: credentials.smtpSecure,
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: MAIL_DEADLINE_MS,
    greetingTimeout: MAIL_DEADLINE_MS,
    socketTimeout: MAIL_DEADLINE_MS,
  })
}

export function createImapClient(credentials: SmtpCredentials): ImapFlow {
  return new ImapFlow({
    host: credentials.imapHost,
    port: credentials.imapPort,
    secure: credentials.imapSecure,
    auth: { user: credentials.username, pass: credentials.password },
    // ImapFlow logs the full protocol conversation at info level by default,
    // which includes the AUTH exchange. Never enable this.
    logger: false,
    socketTimeout: MAIL_DEADLINE_MS,
  })
}

/** Authenticates against the SMTP server without sending anything. */
export async function verifySmtpConnection(credentials: SmtpCredentials): Promise<void> {
  const transport = createSmtpTransport(credentials)
  try {
    await withMailDeadline('smtp', () => transport.verify())
  } catch (error) {
    throw toMailAppError(error, 'smtp')
  } finally {
    transport.close()
  }
}

/** Authenticates against the IMAP server. connect() performs the login. */
export async function verifyImapConnection(credentials: SmtpCredentials): Promise<void> {
  const client = createImapClient(credentials)
  try {
    await withMailDeadline('imap', () => client.connect())
  } catch (error) {
    throw toMailAppError(error, 'imap')
  } finally {
    // close() rather than logout(): logout() throws when the connection never
    // came up, which would leak the socket for the rest of the invocation.
    client.close()
  }
}
