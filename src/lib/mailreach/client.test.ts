import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))

import { connectSmtpAccount, buildOAuthAuthorizeUrl, completeOAuthConnect, disconnectAccount, getAccount, getAccountStats } from './client'

const smtpInput = {
  emailAddress: 'sales@acme.com',
  firstName: 'Jordan',
  lastName: 'Lee',
  username: 'sales@acme.com',
  password: 'app-password',
  smtpHost: 'smtp.acme.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.acme.com',
  imapPort: 993,
  imapSecure: true,
}

describe('connectSmtpAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should POST to /v1/imap_auth with the real field names and return the account id', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 1234 })
    const result = await connectSmtpAccount(smtpInput, 'test-mailreach-key')
    expect(result).toEqual({ accountId: '1234' })
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/imap_auth')
    expect(options.method).toBe('POST')
    expect(options.headers['X-Api-Key']).toBe('Bearer test-mailreach-key')
    const body = JSON.parse(options.body as string)
    expect(body).toEqual({
      email: 'sales@acme.com',
      first_name: 'Jordan',
      last_name: 'Lee',
      provider: 'custom',
      imap_server: 'imap.acme.com',
      imap_server_port: 993,
      imap_server_username: 'sales@acme.com',
      imap_server_password: 'app-password',
      smtp_server: 'smtp.acme.com',
      smtp_server_port: 587,
      smtp_server_username: 'sales@acme.com',
      smtp_server_password: 'app-password',
      smtp_server_starttls: false,
    })
  })

  it('should coerce a string id in the response to the returned accountId unchanged', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 'already-a-string' })
    const result = await connectSmtpAccount(smtpInput, 'test-mailreach-key')
    expect(result).toEqual({ accountId: 'already-a-string' })
  })

  it('should send whichever apiKey the caller resolved, not a hardcoded one', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 1234 })
    await connectSmtpAccount(smtpInput, 'uniforms-fashion-key')
    const [, options] = mockFetchJson.mock.calls[0]!
    expect(options.headers['X-Api-Key']).toBe('Bearer uniforms-fashion-key')
  })
})

describe('buildOAuthAuthorizeUrl', () => {
  it('should build a redirect url carrying the provider, redirect_uri, and state', () => {
    const url = buildOAuthAuthorizeUrl({ provider: 'gmail', redirectUri: 'https://app.example.com/cb', state: 'nonce123' })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://api.mailreach.co/api/v1/connect-account/oauth')
    expect(parsed.searchParams.get('provider')).toBe('google')
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb')
    expect(parsed.searchParams.get('state')).toBe('nonce123')
  })
})

describe('completeOAuthConnect', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should exchange the code and return the account id', async () => {
    mockFetchJson.mockResolvedValueOnce({ account_id: 'acc_456' })
    const result = await completeOAuthConnect({ code: 'auth-code', provider: 'outlook' }, 'test-mailreach-key')
    expect(result).toEqual({ accountId: 'acc_456' })
    const [, options] = mockFetchJson.mock.calls[0]!
    expect(options.headers['X-Api-Key']).toBe('Bearer test-mailreach-key')
    const body = JSON.parse(options.body as string)
    expect(body.code).toBe('auth-code')
    expect(body.provider).toBe('outlook')
  })
})

describe('disconnectAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should DELETE the account by id using the given apiKey', async () => {
    mockFetchJson.mockResolvedValueOnce(undefined)
    await disconnectAccount('acc_123', 'test-mailreach-key')
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/accounts/acc_123')
    expect(options.method).toBe('DELETE')
    expect(options.headers['X-Api-Key']).toBe('Bearer test-mailreach-key')
  })
})

describe('getAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return the reputation score', async () => {
    mockFetchJson.mockResolvedValueOnce({ score: 82 })
    const result = await getAccount('acc_123', 'test-mailreach-key')
    expect(result).toEqual({ reputationScore: 82 })
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/accounts/acc_123')
    expect(options.method).toBe('GET')
  })

  it('should return null when the score is absent', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const result = await getAccount('acc_123', 'test-mailreach-key')
    expect(result).toEqual({ reputationScore: null })
  })

  it('should send the given apiKey in the request header', async () => {
    mockFetchJson.mockResolvedValueOnce({ score: 50 })
    await getAccount('acc_123', 'uniforms-fashion-key')
    const [, options] = mockFetchJson.mock.calls[0]!
    expect(options.headers['X-Api-Key']).toBe('Bearer uniforms-fashion-key')
  })
})

describe('getAccountStats', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return the messaging-volume fields with the real field names', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_messages_sent: 120,
      total_messages_received: 95,
      total_spam: 2,
      config_current_conversation_running: 8,
    })
    const result = await getAccountStats('acc_123', 'test-mailreach-key')
    expect(result).toEqual({
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversationsRunning: 8,
    })
  })

  it('should return null for every field when absent', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const result = await getAccountStats('acc_123', 'test-mailreach-key')
    expect(result).toEqual({
      totalMessagesSent: null,
      totalMessagesReceived: null,
      totalSpam: null,
      currentConversationsRunning: null,
    })
  })

  it('should request the 180-day window and send the given apiKey', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    await getAccountStats('acc_123', 'uniforms-fashion-key')
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/accounts/acc_123/stats?past_days=180')
    expect(options.headers['X-Api-Key']).toBe('Bearer uniforms-fashion-key')
  })
})
