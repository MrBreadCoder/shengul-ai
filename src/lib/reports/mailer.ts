import nodemailer from 'nodemailer'
import { env } from '@/lib/env'
import { assertNoHeaderInjection } from '@/lib/mailbox/headers'
import { MAIL_DEADLINE_MS, toMailAppError, withMailDeadline } from '@/lib/mailbox/smtp-errors'

export interface ReportEmailInput {
  to: string
  subject: string
  text: string
  html: string
}

// Deliberately not lib/mailbox/smtp-connection.ts's createSmtpTransport —
// that helper requires a full SmtpCredentials (host/port/secure *and*
// imapHost/imapPort/imapSecure), which fits the outreach mailbox connect
// flow, not this one-off transactional sender that never reads mail. Reuses
// only the generic, provider-agnostic pieces (error mapping, deadline,
// header-injection guard) — see spec §6.
function createReportsTransport() {
  return nodemailer.createTransport({
    host: env.REPORTS_SMTP_HOST,
    port: env.REPORTS_SMTP_PORT,
    secure: env.REPORTS_SMTP_SECURE,
    auth: { user: env.REPORTS_SMTP_USERNAME, pass: env.REPORTS_SMTP_PASSWORD },
    connectionTimeout: MAIL_DEADLINE_MS,
    greetingTimeout: MAIL_DEADLINE_MS,
    socketTimeout: MAIL_DEADLINE_MS,
  })
}

/**
 * Sends one report notification email. Always BCC'd to the sender address
 * itself — with no operator UI for reports (spec § Out of scope), this is
 * how the sender gets visibility into what actually went out.
 */
export async function sendReportEmail(input: ReportEmailInput): Promise<void> {
  const to = assertNoHeaderInjection(input.to, 'to')
  const subject = assertNoHeaderInjection(input.subject, 'subject')
  const transport = createReportsTransport()
  try {
    await withMailDeadline('smtp', () =>
      transport.sendMail({
        from: `"${env.REPORTS_FROM_NAME}" <${env.REPORTS_FROM_EMAIL}>`,
        to,
        bcc: env.REPORTS_FROM_EMAIL,
        subject,
        text: input.text,
        html: input.html,
      }),
    )
  } catch (error) {
    throw toMailAppError(error, 'smtp')
  } finally {
    transport.close()
  }
}
