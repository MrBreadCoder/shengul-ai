import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({
  env: {
    MICROSOFT_OAUTH_CLIENT_ID: 'mid',
    MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
    APP_URL: 'http://localhost:3000',
  },
}))

import { outlookProvider } from './outlook-provider'
import type { SendEmailInput } from './provider'

describe('outlookProvider', () => {
  // Braced body on purpose: `() => mockFetchJson.mockReset()` returns the mock,
  // and vitest treats a function returned from beforeEach as a cleanup hook —
  // it would then call the mock with zero arguments after every test.
  beforeEach(() => {
    mockFetchJson.mockReset()
  })

  it('should build an auth url with Mail.Send and offline_access', () => {
    const url = outlookProvider.buildAuthUrl('st')
    expect(url).toContain('login.microsoftonline.com')
    expect(url).toContain('state=st')
    expect(decodeURIComponent(url)).toContain('Mail.Send')
    expect(decodeURIComponent(url)).toContain('offline_access')
  })

  it('should exchange a code into tokens and profile', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      .mockResolvedValueOnce({ mail: 'me@outlook.com', displayName: 'Me O' })
    const result = await outlookProvider.exchangeCode('c')
    expect(result.emailAddress).toBe('me@outlook.com')
    expect(result.displayName).toBe('Me O')
    expect(result.tokens.refreshToken).toBe('rt')
  })

  it('should fall back to userPrincipalName when mail is null', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      .mockResolvedValueOnce({ mail: null, userPrincipalName: 'me@corp.com', displayName: null })
    const result = await outlookProvider.exchangeCode('c')
    expect(result.emailAddress).toBe('me@corp.com')
  })

  it('should send mail and synthesize ids (Graph sendMail returns 202 no body)', async () => {
    mockFetchJson.mockResolvedValueOnce({}) // sendMail: empty/accepted
    const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
    const { result } = await outlookProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'S', body: 'B' })
    expect(result.providerMessageId).toMatch(/^outlook-/)
    expect(result.threadId).toMatch(/^outlook-/)
  })

  it('should include internetMessageHeaders when threading a follow-up', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
    await outlookProvider.sendEmail(tokens, {
      to: 'x@y.com', subject: 'Re: S', body: 'B',
      threadId: 'thr1', inReplyToMessageId: '<abc@mail>', references: '<abc@mail>',
    })
    // safe: mockResolvedValueOnce above guarantees exactly one recorded call
    const sendCall = mockFetchJson.mock.calls[0]!
    const body = JSON.parse((sendCall[1] as { body: string }).body)
    expect(body.message.internetMessageHeaders).toEqual([
      { name: 'In-Reply-To', value: '<abc@mail>' },
      { name: 'References', value: '<abc@mail>' },
    ])
  })

  it('should omit internetMessageHeaders when not threading', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }
    await outlookProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'S', body: 'B' })
    // safe: mockResolvedValueOnce above guarantees exactly one recorded call
    const sendCall = mockFetchJson.mock.calls[0]!
    const body = JSON.parse((sendCall[1] as { body: string }).body)
    expect(body.message.internetMessageHeaders).toBeUndefined()
  })
})

describe('outlook sendEmail with attachments', () => {
  const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }

  beforeEach(() => {
    mockFetchJson.mockReset()
  })

  async function captureSentMessage(input: SendEmailInput): Promise<Record<string, unknown>> {
    let captured: Record<string, unknown> = {}
    mockFetchJson.mockImplementation((_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { message?: Record<string, unknown> }
      if (payload.message) captured = payload.message
      return Promise.resolve({})
    })
    await outlookProvider.sendEmail(tokens, input)
    return captured
  }

  it('should omit the attachments key entirely when there are none', async () => {
    const message = await captureSentMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
    expect(message).not.toHaveProperty('attachments')
  })

  it('should serialize each attachment as a graph fileAttachment when attachments exist', async () => {
    const message = await captureSentMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [
        { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFBYTES') },
      ],
    })
    expect(message.attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        contentBytes: Buffer.from('PDFBYTES').toString('base64'),
      },
    ])
  })

  it('should reject a filename carrying a line break', async () => {
    await expect(
      captureSentMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Hello',
        attachments: [{ fileName: 'a\r\nb.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('outlookProvider.fetchInbound', () => {
  const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }

  // This describe block previously relied on the sibling 'outlookProvider'
  // describe's beforeEach, which doesn't run for tests here — harmless while
  // no test asserted on call counts, but the 410 re-baseline tests below do.
  beforeEach(() => mockFetchJson.mockReset())

  it('should baseline (no messages) when cursor is null', async () => {
    mockFetchJson.mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'https://graph/delta?token=xyz' })
    const { result } = await outlookProvider.fetchInbound(tokens, null)
    expect(result).toEqual({ messages: [], cursor: 'https://graph/delta?token=xyz' })
  })

  it('should map delta messages and return the next delta link', async () => {
    mockFetchJson.mockResolvedValueOnce({
      value: [
        {
          id: 'g1', conversationId: 'conv1', subject: 'Re: Quick idea',
          from: { emailAddress: { address: 'Jane@Acme.com' } },
          receivedDateTime: '2026-07-19T10:00:00Z',
          body: { content: 'Interested' }, isDraft: false,
        },
      ],
      '@odata.deltaLink': 'https://graph/delta?token=next',
    })
    const { result } = await outlookProvider.fetchInbound(tokens, 'https://graph/delta?token=prev')
    expect(result.cursor).toBe('https://graph/delta?token=next')
    expect(result.messages[0]).toMatchObject({
      providerMessageId: 'g1', threadId: 'conv1', fromEmail: 'jane@acme.com', body: 'Interested',
    })
  })

  it('should skip drafts and messages without a sender', async () => {
    mockFetchJson.mockResolvedValueOnce({
      value: [
        { id: 'd1', isDraft: true, from: { emailAddress: { address: 'x@y.com' } } },
        { id: 'n1', isDraft: false, from: null },
      ],
      '@odata.deltaLink': 'https://graph/delta?token=next',
    })
    const { result } = await outlookProvider.fetchInbound(tokens, 'https://graph/delta?token=prev')
    expect(result.messages).toHaveLength(0)
  })

  it('should re-baseline when the delta link has expired (410 resyncRequired)', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockFetchJson
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 410', { status: 410 }))
      .mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'https://graph/delta?token=rebaselined' })
    const { result } = await outlookProvider.fetchInbound(tokens, 'https://graph/delta?token=expired')
    expect(result).toEqual({ messages: [], cursor: 'https://graph/delta?token=rebaselined' })
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
    // The re-baseline call must start from the base delta URL, not the expired cursor.
    expect(mockFetchJson.mock.calls[1]![0]).toBe(
      'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta' +
        '?$select=id,conversationId,subject,from,receivedDateTime,body,isDraft,internetMessageHeaders',
    )
  })

  it('should rethrow non-410 errors without re-baselining', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockFetchJson.mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 500', { status: 500 }))
    await expect(outlookProvider.fetchInbound(tokens, 'https://graph/delta?token=prev')).rejects.toThrow('HTTP 500')
    expect(mockFetchJson).toHaveBeenCalledTimes(1)
  })
})
