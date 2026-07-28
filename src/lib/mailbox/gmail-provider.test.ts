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
import type { SendEmailInput } from './provider'

describe('gmailProvider', () => {
  // Braced body on purpose: `() => mockFetchJson.mockReset()` returns the mock,
  // and vitest treats a function returned from beforeEach as a cleanup hook —
  // it would then call the mock with zero arguments after every test.
  beforeEach(() => {
    mockFetchJson.mockReset()
  })

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

describe('gmail sendEmail with attachments', () => {
  const tokens = {
    kind: 'oauth' as const,
    accessToken: 'at',
    refreshToken: 'rt',
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  }

  beforeEach(() => {
    mockFetchJson.mockReset()
  })

  // Sends through the provider and decodes the `raw` field it posted, so these
  // tests assert on the real wire format rather than an internal helper.
  async function captureRawMessage(input: SendEmailInput): Promise<string> {
    let captured = ''
    mockFetchJson.mockImplementation((_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { raw?: string }
      if (payload.raw) captured = Buffer.from(payload.raw, 'base64url').toString('utf-8')
      return Promise.resolve({ id: 'm1', threadId: 't1' })
    })
    await gmailProvider.sendEmail(tokens, input)
    return captured
  }

  it('should still emit a flat text/plain message when there are no attachments', async () => {
    const raw = await captureRawMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).not.toContain('multipart/mixed')
    expect(raw).toContain('Hello')
  })

  it('should emit multipart/mixed with one part per attachment when attachments exist', async () => {
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [
        { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFBYTES') },
        { fileName: 'hero.png', mimeType: 'image/png', content: Buffer.from('PNGBYTES') },
      ],
    })

    const boundaryMatch = /boundary="([^"]+)"/.exec(raw)
    expect(boundaryMatch).not.toBeNull()
    // safe: asserted non-null on the line above
    const boundary = boundaryMatch![1]!

    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    expect(raw).toContain('Content-Type: application/pdf; name="deck.pdf"')
    expect(raw).toContain('Content-Disposition: attachment; filename="deck.pdf"')
    expect(raw).toContain('Content-Type: image/png; name="hero.png"')
    expect(raw).toContain(Buffer.from('PDFBYTES').toString('base64'))
    expect(raw).toContain(Buffer.from('PNGBYTES').toString('base64'))
    // Terminal boundary closes the message.
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
    // The body survives as its own base64 part.
    expect(raw).toContain(Buffer.from('Hello').toString('base64'))
  })

  it('should base64 the text part rather than claim 7bit for a non-ascii body', async () => {
    const body = 'Happy to help — here’s the deck.'
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body,
      attachments: [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }],
    })

    expect(raw).not.toContain('Content-Transfer-Encoding: 7bit')
    expect(raw).toContain(Buffer.from(body, 'utf-8').toString('base64'))
    // Every octet on the wire stays inside ASCII, which is what the encoding is for.
    expect(/^[\x00-\x7f]*$/.test(raw)).toBe(true)
  })

  it('should preserve threading headers when the message has attachments', async () => {
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Re: Hi',
      body: 'Hello',
      inReplyToMessageId: '<m1@x>',
      references: '<m1@x>',
      attachments: [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }],
    })
    expect(raw).toContain('In-Reply-To: <m1@x>')
    expect(raw).toContain('References: <m1@x>')
  })

  it('should reject a filename carrying a line break', async () => {
    await expect(
      captureRawMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Hello',
        attachments: [
          { fileName: 'a.pdf\r\nX-Evil: 1', mimeType: 'application/pdf', content: Buffer.from('X') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should wrap base64 payload lines at 76 columns', async () => {
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [
        { fileName: 'big.pdf', mimeType: 'application/pdf', content: Buffer.alloc(1000, 0x41) },
      ],
    })
    const longestLine = Math.max(...raw.split('\r\n').map((line) => line.length))
    expect(longestLine).toBeLessThanOrEqual(76)
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
