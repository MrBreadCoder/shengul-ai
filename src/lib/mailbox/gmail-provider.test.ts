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
    const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const { result } = await gmailProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'Hi', body: 'Body' })
    expect(result).toEqual({ providerMessageId: 'msg1', threadId: 'thr1' })
  })

  it('should refresh the token before sending when expired', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ access_token: 'new-at', expires_in: 3600 }) // refresh
      .mockResolvedValueOnce({ id: 'msg2', threadId: 'thr2' })             // send
    const expired = { accessToken: 'old', refreshToken: 'rt', expiresAt: new Date(Date.now() - 1000).toISOString() }
    const { result, tokens } = await gmailProvider.sendEmail(expired, { to: 'x@y.com', subject: 'S', body: 'B' })
    expect(tokens.accessToken).toBe('new-at')
    expect(result.providerMessageId).toBe('msg2')
    expect(mockFetchJson).toHaveBeenCalledTimes(2)
  })
})
