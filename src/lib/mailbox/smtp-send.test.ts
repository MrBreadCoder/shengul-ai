import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SmtpCredentials } from './provider'

const sendMailMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
const createSmtpTransportMock = vi.hoisted(() =>
  vi.fn(() => ({ sendMail: sendMailMock, close: closeMock })),
)
vi.mock('./smtp-connection', () => ({ createSmtpTransport: createSmtpTransportMock }))

import { sendSmtpEmail } from './smtp-send'

const credentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

function sentOptions(): Record<string, unknown> {
  // safe: every test that calls this has asserted or awaited exactly one send
  return sendMailMock.mock.calls[0]?.[0] as Record<string, unknown>
}

beforeEach(() => {
  sendMailMock.mockReset().mockResolvedValue({ messageId: '<generated@client.com>' })
  closeMock.mockReset()
  createSmtpTransportMock.mockClear()
})

describe('sendSmtpEmail', () => {
  it('should send from the credentials email address as plain text', async () => {
    await sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'Body text' })
    expect(sentOptions()).toMatchObject({
      from: 'ops@client.com',
      to: 'lead@target.com',
      subject: 'Hi',
      text: 'Body text',
    })
  })

  it('should return the generated Message-ID as both ids when starting a thread', async () => {
    const result = await sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' })
    expect(result).toEqual({
      providerMessageId: '<generated@client.com>',
      threadId: '<generated@client.com>',
    })
  })

  it('should preserve the incoming threadId when replying so the thread stays stable', async () => {
    const result = await sendSmtpEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Re: Hi',
      body: 'b',
      threadId: '<root@target.com>',
      inReplyToMessageId: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    })
    expect(result.threadId).toBe('<root@target.com>')
    expect(result.providerMessageId).toBe('<generated@client.com>')
  })

  it('should set inReplyTo and references headers when threading', async () => {
    await sendSmtpEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Re: Hi',
      body: 'b',
      inReplyToMessageId: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    })
    expect(sentOptions()).toMatchObject({
      inReplyTo: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    })
  })

  it('should omit threading headers entirely on a first touch', async () => {
    await sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' })
    expect(sentOptions()).not.toHaveProperty('inReplyTo')
    expect(sentOptions()).not.toHaveProperty('references')
  })

  it.each([
    ['to', { to: 'a@b.com\nBcc: attacker@evil.com', subject: 's', body: 'b' }],
    ['subject', { to: 'a@b.com', subject: 's\r\nBcc: attacker@evil.com', body: 'b' }],
    ['inReplyToMessageId', { to: 'a@b.com', subject: 's', body: 'b', inReplyToMessageId: '<a>\n<b>' }],
    ['references', { to: 'a@b.com', subject: 's', body: 'b', references: '<a>\r<b>' }],
  ])('should reject a line break in %s before opening a connection', async (_field, input) => {
    await expect(sendSmtpEmail(credentials, input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(createSmtpTransportMock).not.toHaveBeenCalled()
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('should map an auth failure to UNAUTHORIZED so the mailbox gets blocked', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('bad login'), { code: 'EAUTH' }))
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', context: expect.objectContaining({ status: 401 }) })
  })

  it('should map a transient SMTP 4xx reply to a retryable status', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('busy'), { responseCode: 451 }))
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ status: 503 }) })
  })

  it('should close the transport even when the send fails', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('busy'), { responseCode: 550 }))
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toBeDefined()
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should fail loudly when the server accepts the message without a Message-ID', async () => {
    // Without an id there is nothing stable to thread follow-ups against, so
    // treating this as success would silently break the conversation.
    sendMailMock.mockResolvedValue({ messageId: undefined })
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })
})
