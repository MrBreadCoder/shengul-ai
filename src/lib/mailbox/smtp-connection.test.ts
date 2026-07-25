import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SmtpCredentials } from './provider'

const verifyMock = vi.hoisted(() => vi.fn())
const closeTransportMock = vi.hoisted(() => vi.fn())
const createTransportMock = vi.hoisted(() =>
  vi.fn((_options: unknown) => ({ verify: verifyMock, close: closeTransportMock })),
)
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }))

const connectMock = vi.hoisted(() => vi.fn())
const closeImapMock = vi.hoisted(() => vi.fn())
const imapConstructorMock = vi.hoisted(() => vi.fn())
vi.mock('imapflow', () => ({
  ImapFlow: class {
    connect = connectMock
    close = closeImapMock
    constructor(options: unknown) {
      imapConstructorMock(options)
    }
  },
}))

import {
  createImapClient,
  createSmtpTransport,
  verifyImapConnection,
  verifySmtpConnection,
} from './smtp-connection'

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

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(true)
  closeTransportMock.mockReset()
  createTransportMock.mockClear()
  connectMock.mockReset().mockResolvedValue(undefined)
  closeImapMock.mockReset()
  imapConstructorMock.mockReset()
})

describe('createSmtpTransport', () => {
  it('should pass host, port, secure, and auth through to nodemailer', () => {
    createSmtpTransport(credentials)
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.client.com',
        port: 587,
        secure: false,
        auth: { user: 'ops@client.com', pass: 'pw' },
      }),
    )
  })

  it('should set every timeout option so a connection cannot hang unbounded', () => {
    createSmtpTransport(credentials)
    const options = createTransportMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.connectionTimeout).toBeGreaterThan(0)
    expect(options.greetingTimeout).toBeGreaterThan(0)
    expect(options.socketTimeout).toBeGreaterThan(0)
  })
})

describe('createImapClient', () => {
  it('should use the imap host and port, not the smtp ones', () => {
    createImapClient(credentials)
    expect(imapConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'imap.client.com',
        port: 993,
        secure: true,
        auth: { user: 'ops@client.com', pass: 'pw' },
      }),
    )
  })

  it('should disable the library logger so credentials never reach stdout', () => {
    createImapClient(credentials)
    const options = imapConstructorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.logger).toBe(false)
  })
})

describe('verifySmtpConnection', () => {
  it('should resolve when the transport verifies', async () => {
    await expect(verifySmtpConnection(credentials)).resolves.toBeUndefined()
    expect(verifyMock).toHaveBeenCalledTimes(1)
  })

  it('should close the transport even when verification fails', async () => {
    verifyMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'EAUTH' }))
    await expect(verifySmtpConnection(credentials)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(closeTransportMock).toHaveBeenCalledTimes(1)
  })

  it('should map an auth rejection to UNAUTHORIZED with the smtp stage', async () => {
    verifyMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'EAUTH' }))
    await expect(verifySmtpConnection(credentials)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      context: expect.objectContaining({ stage: 'smtp' }),
    })
  })

  it('should never send a message', async () => {
    await verifySmtpConnection(credentials)
    const transport = createTransportMock.mock.results[0]?.value as Record<string, unknown>
    expect(transport.sendMail).toBeUndefined()
  })
})

describe('verifyImapConnection', () => {
  it('should resolve and close the client when the connection authenticates', async () => {
    await expect(verifyImapConnection(credentials)).resolves.toBeUndefined()
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(closeImapMock).toHaveBeenCalledTimes(1)
  })

  it('should map an auth rejection to UNAUTHORIZED with the imap stage', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('nope'), { authenticationFailed: true }))
    await expect(verifyImapConnection(credentials)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      context: expect.objectContaining({ stage: 'imap' }),
    })
  })

  it('should close the client even when the connection fails', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ECONNECTION' }))
    await expect(verifyImapConnection(credentials)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
    expect(closeImapMock).toHaveBeenCalledTimes(1)
  })
})
