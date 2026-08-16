import { assertNoHeaderInjection } from '@/lib/mailbox/headers'
import { formatInviteTtl } from '@/lib/auth/invite-ttl'

export interface InviteEmailInput {
  clientName: string
  link: string
  expiresInMinutes: number
}

export interface RenderedInviteEmail {
  subject: string
  text: string
  html: string
}

const SIGNATURE = 'Shengul Yavuz\nFounder of Shengul AI'

function toHtml(text: string): string {
  const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  // white-space: pre-line renders the \n\n paragraph breaks without needing
  // <br>/<p> markup, matching the plain, personal tone used for the report
  // emails (see lib/reports/email-templates.ts).
  return (
    '<div style="font-family: -apple-system, BlinkMacSystemFont, sans-serif; ' +
    'font-size: 14px; line-height: 1.6; color: #1a1a1a; white-space: pre-line;">' +
    `${escaped}</div>`
  )
}

/**
 * Renders the email sent to a client the moment an operator creates their
 * dashboard login. Deliberately separate from `lib/reports/email-templates.ts`:
 * that file rotates through several variants so a weekly recipient never sees
 * the same wording twice, which a one-off account-creation email has no
 * reason to do.
 */
export function renderInviteEmail(input: InviteEmailInput): RenderedInviteEmail {
  const clientName = assertNoHeaderInjection(input.clientName, 'clientName')
  const link = assertNoHeaderInjection(input.link, 'link')
  const ttl = formatInviteTtl(input.expiresInMinutes)
  const subject = assertNoHeaderInjection(`Shengul AI: set up your ${clientName} dashboard login`, 'subject')
  const text =
    `Hi ${clientName} team,\n\n` +
    `Your Shengul AI dashboard is ready. Set your password here to sign in:\n${link}\n\n` +
    `This link works for the next ${ttl} and can be opened more than once in that time. After that it stops working — reply to this email and I'll send a new one.\n\n` +
    `— Shengul\n\n${SIGNATURE}`
  return { subject, text, html: toHtml(text) }
}
