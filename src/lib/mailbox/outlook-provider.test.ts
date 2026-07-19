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

describe('outlookProvider', () => {
  beforeEach(() => mockFetchJson.mockReset())

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
    const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const { result } = await outlookProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'S', body: 'B' })
    expect(result.providerMessageId).toMatch(/^outlook-/)
    expect(result.threadId).toMatch(/^outlook-/)
  })
})
