import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SendEmailInput, SmtpCredentials } from './provider'

const connectMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
const listMock = vi.hoisted(() => vi.fn())
const appendMock = vi.hoisted(() => vi.fn())
const createImapClientMock = vi.hoisted(() =>
  vi.fn(() => ({ connect: connectMock, close: closeMock, list: listMock, append: appendMock })),
)
vi.mock('./smtp-connection', () => ({ createImapClient: createImapClientMock }))

const buildMock = vi.hoisted(() => vi.fn())
const compileMock = vi.hoisted(() => vi.fn(() => ({ build: buildMock })))
const mailComposerConstructorMock = vi.hoisted(() => vi.fn())
vi.mock('nodemailer/lib/mail-composer', () => ({
  default: class {
    constructor(mail: unknown) {
      mailComposerConstructorMock(mail)
    }
    compile = compileMock
  },
}))

import { appendSentCopy } from './smtp-sent-copy'

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

const rawMessage = Buffer.from('raw-mime-bytes')

function mailbox(path: string, specialUse?: string): Record<string, unknown> {
  return { path, specialUse }
}

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined)
  closeMock.mockReset()
  listMock.mockReset().mockResolvedValue([mailbox('INBOX'), mailbox('Sent', '\\Sent'), mailbox('Trash', '\\Trash')])
  appendMock.mockReset().mockResolvedValue({ destination: 'Sent' })
  buildMock.mockReset().mockResolvedValue(rawMessage)
  compileMock.mockClear()
  mailComposerConstructorMock.mockReset()
})

describe('appendSentCopy', () => {
  it('should build the raw message with the real provider Message-ID, not a new one', async () => {
    const input: SendEmailInput = { to: 'lead@target.com', subject: 'Hi', body: 'Body text' }
    await appendSentCopy(credentials, input, '<real@client.com>')
    expect(mailComposerConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: 'ops@client.com',
        to: 'lead@target.com',
        subject: 'Hi',
        text: 'Body text',
        messageId: '<real@client.com>',
      }),
    )
  })

  it('should include inReplyTo and references when threading a follow-up', async () => {
    const input: SendEmailInput = {
      to: 'lead@target.com',
      subject: 'Re: Hi',
      body: 'b',
      inReplyToMessageId: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    }
    await appendSentCopy(credentials, input, '<real@client.com>')
    expect(mailComposerConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        inReplyTo: '<prev@target.com>',
        references: '<root@target.com> <prev@target.com>',
      }),
    )
  })

  it('should omit threading headers entirely on a first touch', async () => {
    const input: SendEmailInput = { to: 'lead@target.com', subject: 'Hi', body: 'b' }
    await appendSentCopy(credentials, input, '<real@client.com>')
    const mail = mailComposerConstructorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(mail).not.toHaveProperty('inReplyTo')
    expect(mail).not.toHaveProperty('references')
  })

  it('should map attachments to the nodemailer filename/content/contentType shape', async () => {
    const content = Buffer.from('PDFBYTES')
    const input: SendEmailInput = {
      to: 'lead@target.com',
      subject: 'Hi',
      body: 'b',
      attachments: [{ fileName: 'deck.pdf', mimeType: 'application/pdf', content }],
    }
    await appendSentCopy(credentials, input, '<real@client.com>')
    expect(mailComposerConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        attachments: [{ filename: 'deck.pdf', content, contentType: 'application/pdf' }],
      }),
    )
  })

  it('should append the built raw message to the \\Sent special-use folder', async () => {
    await appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>')
    expect(appendMock).toHaveBeenCalledWith('Sent', rawMessage, ['\\Seen'])
  })

  it('should fall back to a common Sent folder name when no server reports the \\Sent flag', async () => {
    listMock.mockResolvedValue([mailbox('INBOX'), mailbox('Sent Items'), mailbox('Trash')])
    await appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>')
    expect(appendMock).toHaveBeenCalledWith('Sent Items', rawMessage, ['\\Seen'])
  })

  it('should match the fallback folder name case-insensitively', async () => {
    listMock.mockResolvedValue([mailbox('INBOX'), mailbox('SENT')])
    await appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>')
    expect(appendMock).toHaveBeenCalledWith('SENT', rawMessage, ['\\Seen'])
  })

  it('should reject when no Sent folder can be identified, without appending anything', async () => {
    listMock.mockResolvedValue([mailbox('INBOX'), mailbox('Archive')])
    await expect(
      appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>'),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
    expect(appendMock).not.toHaveBeenCalled()
  })

  it('should map an IMAP auth failure to UNAUTHORIZED with the imap stage', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('bad login'), { authenticationFailed: true }))
    await expect(
      appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>'),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', context: expect.objectContaining({ stage: 'imap' }) })
  })

  it('should close the IMAP client even when the connection fails', async () => {
    connectMock.mockRejectedValue(new Error('timed out'))
    await expect(
      appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>'),
    ).rejects.toBeDefined()
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should close the IMAP client even when the append fails', async () => {
    appendMock.mockRejectedValue(Object.assign(new Error('quota'), { responseCode: 550 }))
    await expect(
      appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>'),
    ).rejects.toBeDefined()
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should close the IMAP client after a successful append', async () => {
    await appendSentCopy(credentials, { to: 'a@b.com', subject: 's', body: 'b' }, '<real@client.com>')
    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})
