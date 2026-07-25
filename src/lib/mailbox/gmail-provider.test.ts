import { describe, it, expect, vi, beforeEach } from 'vitest'

// vi.mock() factories are hoisted above regular const declarations; vi.hoisted()
// hoists this value's initializer along with them so the factory can reference it.
const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({
  env: {
    GOOGLE_OAUTH_CLIENT_ID: 'gid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
    APP_URL: 'http://localhost:3000',
  },
}))

import { gmailProvider } from './gmail-provider'

describe('gmailProvider', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should build an auth url with the send scope and state', () => {
    const url = gmailProvider.buildAuthUrl('state123')
    expect(url).toContain('accounts.google.com')
    expect(url).toContain('state=state123')
    expect(decodeURIComponent(url)).toContain('gmail.send')
    expect(decodeURIComponent(url)).toContain('access_type=offline')
  })

  it('should exchange a code into tokens and profile', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      .mockResolvedValueOnce({ email: 'me@gmail.com', name: 'Me' })
    const result = await gmailProvider.exchangeCode('code1')
    expect(result.emailAddress).toBe('me@gmail.com')
    expect(result.displayName).toBe('Me')
    expect(result.tokens.accessToken).toBe('at')
    expect(result.tokens.refreshToken).toBe('rt')
    expect(new Date(result.tokens.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('should send an email and return provider + thread ids', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 'msg1', threadId: 'thr1' })
    const tokens = {
      kind: 'oauth' as const,
      accessToken: 'at',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    }
    const { result } = await gmailProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'Hi', body: 'Body' })
    expect(result).toEqual({ providerMessageId: 'msg1', threadId: 'thr1' })
  })

  it('should refresh the token before sending when expired', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ access_token: 'new-at', expires_in: 3600 }) // refresh
      .mockResolvedValueOnce({ id: 'msg2', threadId: 'thr2' })             // send
    const expired = {
      kind: 'oauth' as const,
      accessToken: 'old',
      refreshToken: 'rt',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    }
    const { result, tokens } = await gmailProvider.sendEmail(expired, { to: 'x@y.com', subject: 'S', body: 'B' })
    expect(tokens).toMatchObject({ accessToken: 'new-at' })
    expect(result.providerMessageId).toBe('msg2')
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
  })

  it('should include threadId in the send request body when threading a follow-up', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 'msg1', threadId: 'thr1' })
    const tokens = {
      kind: 'oauth' as const,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }
    await gmailProvider.sendEmail(tokens, {
      to: 'x@y.com', subject: 'Re: hi', body: 'b', threadId: 'thr1', inReplyToMessageId: '<abc@mail>',
    })
    // safe: mockResolvedValueOnce above guarantees exactly one recorded call
    const sendCall = mockFetchJson.mock.calls[0]!
    const body = JSON.parse((sendCall[1] as { body: string }).body)
    expect(body.threadId).toBe('thr1')
  })

  it('should include In-Reply-To and References headers in the encoded message when threading', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 'msg1', threadId: 'thr1' })
    const tokens = {
      kind: 'oauth' as const,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }
    await gmailProvider.sendEmail(tokens, {
      to: 'x@y.com', subject: 'Re: hi', body: 'b',
      threadId: 'thr1', inReplyToMessageId: '<abc@mail>', references: '<abc@mail> <def@mail>',
    })
    // safe: mockResolvedValueOnce above guarantees exactly one recorded call
    const sendCall = mockFetchJson.mock.calls[0]!
    const body = JSON.parse((sendCall[1] as { body: string }).body)
    const decoded = Buffer.from(body.raw, 'base64url').toString('utf-8')
    expect(decoded).toContain('In-Reply-To: <abc@mail>')
    expect(decoded).toContain('References: <abc@mail> <def@mail>')
  })

  it('should reject a subject containing a header injection payload', async () => {
    const tokens = {
      kind: 'oauth' as const,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }
    await expect(
      gmailProvider.sendEmail(tokens, {
        to: 'x@y.com', subject: 'Hi\r\nBcc: attacker@evil.com', body: 'b',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  it('should reject a To address containing a header injection payload', async () => {
    const tokens = {
      kind: 'oauth' as const,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }
    await expect(
      gmailProvider.sendEmail(tokens, {
        to: 'x@y.com\nBcc: attacker@evil.com', subject: 'Hi', body: 'b',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should reject an In-Reply-To header containing a line break', async () => {
    const tokens = {
      kind: 'oauth' as const,
      accessToken: 'a',
      refreshToken: 'r',
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    }
    await expect(
      gmailProvider.sendEmail(tokens, {
        to: 'x@y.com', subject: 'Hi', body: 'b', inReplyToMessageId: '<abc@mail>\r\nX-Injected: 1',
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('gmailProvider.fetchInbound', () => {
  const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  }

  it('should baseline (no messages) when cursor is null', async () => {
    mockFetchJson.mockResolvedValueOnce({ historyId: '1000' }) // profile
    const { result } = await gmailProvider.fetchInbound(tokens, null)
    expect(result).toEqual({ messages: [], cursor: '1000' })
  })

  it('should return inbound messages and the latest historyId', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ // history.list
        history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
        historyId: '1050',
      })
      .mockResolvedValueOnce({ // messages.get m1
        id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: '1700000000000',
        payload: {
          headers: [
            { name: 'From', value: 'Jane Doe <jane@acme.com>' },
            { name: 'Subject', value: 'Re: Quick idea' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from('Sounds interesting', 'utf-8').toString('base64url') },
        },
      })
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result.cursor).toBe('1050')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      providerMessageId: 'm1', threadId: 't1', fromEmail: 'jane@acme.com',
      subject: 'Re: Quick idea', body: 'Sounds interesting',
    })
  })

  it('should skip messages we sent (SENT label)', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }], historyId: '1050' })
      .mockResolvedValueOnce({ id: 'm1', threadId: 't1', labelIds: ['SENT'], payload: { headers: [] } })
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result.messages).toHaveLength(0)
  })

  it('should re-baseline when the history cursor is too old (404)', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockFetchJson
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 404', { status: 404 }))
      .mockResolvedValueOnce({ historyId: '2000' }) // profile re-baseline
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result).toEqual({ messages: [], cursor: '2000' })
  })

  it('should advance the cursor to the terminal page historyId across multiple pages', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ history: [], historyId: '1020', nextPageToken: 'page2' }) // non-terminal page
      .mockResolvedValueOnce({ history: [], historyId: '1050' }) // terminal page
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result.cursor).toBe('1050')
  })

  it('should preserve the original cursor when MAX_HISTORY_PAGES truncates pagination mid-walk', async () => {
    // Every page still has a nextPageToken, so the do-while only stops because
    // the safety cap (25 pages) is hit — never reaching a terminal page.
    mockFetchJson.mockImplementation(() =>
      Promise.resolve({ history: [], historyId: '9999', nextPageToken: 'more' }),
    )
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result.cursor).toBe('1000')
  })
})
