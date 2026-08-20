import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MailboxCredentials, SmtpCredentials } from './provider'

const sendSmtpEmailMock = vi.hoisted(() => vi.fn())
vi.mock('./smtp-send', () => ({ sendSmtpEmail: sendSmtpEmailMock }))

const fetchSmtpInboundMock = vi.hoisted(() => vi.fn())
vi.mock('./smtp-inbound', () => ({ fetchSmtpInbound: fetchSmtpInboundMock }))

const appendSentCopyMock = vi.hoisted(() => vi.fn())
vi.mock('./smtp-sent-copy', () => ({ appendSentCopy: appendSentCopyMock }))

const logWarnMock = vi.hoisted(() => vi.fn())
vi.mock('@/lib/events/log-event', () => ({ logWarn: logWarnMock }))

import { smtpProvider } from './smtp-provider'

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

const oauthCredentials: MailboxCredentials = {
  kind: 'oauth',
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

beforeEach(() => {
  sendSmtpEmailMock.mockReset().mockResolvedValue({ providerMessageId: '<m@x>', threadId: '<m@x>' })
  fetchSmtpInboundMock.mockReset().mockResolvedValue({ messages: [], cursor: 'c1' })
  appendSentCopyMock.mockReset().mockResolvedValue(undefined)
  logWarnMock.mockReset().mockResolvedValue(undefined)
})

describe('smtpProvider', () => {
  it('should identify itself as the smtp provider', () => {
    expect(smtpProvider.provider).toBe('smtp')
  })

  it('should return the same credentials reference from sendEmail so nothing is re-persisted', async () => {
    // sender.ts skips the oauth write when the reference is unchanged; SMTP
    // credentials are static, so it must always be unchanged.
    const { tokens } = await smtpProvider.sendEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Hi',
      body: 'b',
    })
    expect(tokens).toBe(credentials)
  })

  it('should return the same credentials reference from fetchInbound', async () => {
    const { tokens } = await smtpProvider.fetchInbound(credentials, null)
    expect(tokens).toBe(credentials)
  })

  it('should pass the send result straight through', async () => {
    const { result } = await smtpProvider.sendEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Hi',
      body: 'b',
    })
    expect(result).toEqual({ providerMessageId: '<m@x>', threadId: '<m@x>' })
  })

  it('should pass the cursor through to the inbound reader', async () => {
    await smtpProvider.fetchInbound(credentials, 'cursor-1')
    expect(fetchSmtpInboundMock).toHaveBeenCalledWith(credentials, 'cursor-1')
  })

  it('should throw INVARIANT_VIOLATION when handed oauth credentials', async () => {
    await expect(
      smtpProvider.sendEmail(oauthCredentials, { to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' })
    expect(sendSmtpEmailMock).not.toHaveBeenCalled()
  })

  it('should file a Sent-folder copy with the real send result after a successful send', async () => {
    const input = { to: 'lead@target.com', subject: 'Hi', body: 'b' }
    await smtpProvider.sendEmail(credentials, input)
    expect(appendSentCopyMock).toHaveBeenCalledWith(credentials, input, '<m@x>')
  })

  it('should still report success when filing the Sent-folder copy fails', async () => {
    appendSentCopyMock.mockRejectedValue(Object.assign(new Error('no imap'), { code: 'EXTERNAL_ERROR' }))
    const { result } = await smtpProvider.sendEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Hi',
      body: 'b',
    })
    expect(result).toEqual({ providerMessageId: '<m@x>', threadId: '<m@x>' })
  })

  it('should log a warning, not throw, when filing the Sent-folder copy fails', async () => {
    const copyError = Object.assign(new Error('no imap'), { code: 'EXTERNAL_ERROR' })
    appendSentCopyMock.mockRejectedValue(copyError)
    await smtpProvider.sendEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' })
    expect(logWarnMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'mailbox.sent_copy_failed',
        source: 'mailbox',
        error: copyError,
      }),
    )
  })

  it('should not attempt a Sent-folder copy when the real send itself fails', async () => {
    sendSmtpEmailMock.mockRejectedValue(Object.assign(new Error('bounced'), { code: 'EXTERNAL_ERROR' }))
    await expect(
      smtpProvider.sendEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toBeDefined()
    expect(appendSentCopyMock).not.toHaveBeenCalled()
  })
})
