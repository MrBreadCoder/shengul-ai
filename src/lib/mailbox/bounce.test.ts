import { describe, it, expect } from 'vitest'
import { detectBounce, detectAutoReply } from './bounce'
import type { InboundMessage } from './provider'

const SELF = 'ops@acmerobotics.com'

function message(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    providerMessageId: 'pm1',
    threadId: 't1',
    fromEmail: 'someone@example.com',
    subject: 'Re: quick question',
    body: 'Sure, happy to chat.',
    receivedAt: '2026-07-22T10:00:00.000Z',
    headers: {},
    ...overrides,
  }
}

const GMAIL_DSN_BODY = [
  'Address not found',
  '',
  'Your message wasn\'t delivered to vp.eng@target.com because the address',
  'couldn\'t be found.',
  '',
  'Final-Recipient: rfc822; vp.eng@target.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
].join('\n')

describe('detectBounce', () => {
  it('should detect a Gmail hard bounce from mailer-daemon', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        body: GMAIL_DSN_BODY,
        headers: { 'content-type': 'multipart/report; report-type=delivery-status; boundary="x"' },
      }),
      SELF,
    )
    expect(report).toEqual({
      kind: 'hard',
      recipient: 'vp.eng@target.com',
      statusCode: '5.1.1',
      diagnostic: 'smtp; 550 5.1.1 The email account does not exist.',
    })
  })

  it('should detect an Exchange NDR from its X-MS header', () => {
    const report = detectBounce(
      message({
        fromEmail: 'postmaster@acmerobotics.com',
        subject: 'Undeliverable: Quick question about your QA process',
        body: 'Your message to cto@target.com couldn\'t be delivered.\nStatus: 5.4.1',
        headers: { 'x-ms-exchange-message-is-ndr': 'true' },
      }),
      SELF,
    )
    expect(report?.kind).toBe('hard')
    expect(report?.recipient).toBe('cto@target.com')
    expect(report?.statusCode).toBe('5.4.1')
  })

  it('should classify a 4.x.x status as a soft bounce', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Delay)',
        body: 'Final-Recipient: rfc822; vp.eng@target.com\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 mailbox full',
      }),
      SELF,
    )
    expect(report?.kind).toBe('soft')
  })

  it('should default to a soft bounce when no status code can be parsed', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Failure notice',
        body: 'Sorry, we were unable to deliver your message to vp.eng@target.com.',
      }),
      SELF,
    )
    expect(report).toEqual({ kind: 'soft', recipient: 'vp.eng@target.com', statusCode: null, diagnostic: null })
  })

  it('should ignore the mailbox own address when guessing the failed recipient', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Failure notice',
        body: `A message sent from ${SELF} could not be delivered to vp.eng@target.com.`,
      }),
      SELF,
    )
    expect(report?.recipient).toBe('vp.eng@target.com')
  })

  it('should return null for an ordinary human reply', () => {
    expect(detectBounce(message({}), SELF)).toBeNull()
  })

  it('should return null for a newsletter from a noreply address', () => {
    const report = detectBounce(
      message({ fromEmail: 'noreply@vendor.com', subject: 'Your weekly digest', body: 'Top stories this week' }),
      SELF,
    )
    expect(report).toBeNull()
  })

  it('should return null for a daemon sender with no bounce subject and no status code', () => {
    const report = detectBounce(
      message({ fromEmail: 'postmaster@vendor.com', subject: 'Mailbox quota notice', body: 'You are using 80% of your quota.' }),
      SELF,
    )
    expect(report).toBeNull()
  })
})

describe('detectAutoReply', () => {
  it('should detect an RFC 3834 auto-replied header', () => {
    expect(detectAutoReply(message({ headers: { 'auto-submitted': 'auto-replied' } }))).toBe(true)
  })

  it('should detect an X-Autoreply header', () => {
    expect(detectAutoReply(message({ headers: { 'x-autoreply': 'yes' } }))).toBe(true)
  })

  it('should detect an auto_reply precedence', () => {
    expect(detectAutoReply(message({ headers: { precedence: 'auto_reply' } }))).toBe(true)
  })

  it('should detect an out-of-office subject when headers are unavailable', () => {
    expect(detectAutoReply(message({ subject: 'Automatic reply: Quick question' }))).toBe(true)
    expect(detectAutoReply(message({ subject: 'Out of Office: back on Monday' }))).toBe(true)
  })

  it('should return false for an ordinary human reply', () => {
    expect(detectAutoReply(message({}))).toBe(false)
  })

  it('should return false when the subject merely mentions being out of office', () => {
    expect(detectAutoReply(message({ subject: 'Re: I am out of office next week' }))).toBe(false)
  })
})
