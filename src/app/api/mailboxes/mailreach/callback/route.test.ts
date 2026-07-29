import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const completeOAuthConnectForMailbox = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ getMailboxById: (...args: unknown[]) => getMailboxById(...args) }))
vi.mock('@/lib/mailreach/enrollment', () => ({
  completeOAuthConnectForMailbox: (...args: unknown[]) => completeOAuthConnectForMailbox(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'http://localhost:3000' } }))

const { GET } = await import('./route')

function requestWithCookie(nonce: string, mailboxId: string, queryState: string, code = 'auth-code') {
  const cookieValue = encodeURIComponent(JSON.stringify({ nonce, mailboxId }))
  return new Request(`http://localhost:3000/api/mailboxes/mailreach/callback?code=${code}&state=${queryState}`, {
    headers: { cookie: `mailreach_oauth_state=${cookieValue}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'gmail' })
})

describe('GET /api/mailboxes/mailreach/callback', () => {
  it('should complete the connection when the state nonce matches', async () => {
    completeOAuthConnectForMailbox.mockResolvedValue(undefined)
    const response = await GET(requestWithCookie('nonce1', 'm1', 'nonce1'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/settings?mailreach=connected')
    expect(completeOAuthConnectForMailbox).toHaveBeenCalled()
  })

  it('should clear the state cookie at the same path it was set with, so it actually expires', async () => {
    completeOAuthConnectForMailbox.mockResolvedValue(undefined)
    const response = await GET(requestWithCookie('nonce1', 'm1', 'nonce1'))
    const setCookie = response.headers.get('set-cookie') ?? ''
    expect(setCookie).toContain('mailreach_oauth_state=;')
    expect(setCookie).toContain('Path=/api/mailboxes')
  })

  it('should redirect with an oauth error when the state does not match the cookie', async () => {
    const response = await GET(requestWithCookie('nonce1', 'm1', 'wrong-nonce'))
    expect(response.headers.get('location')).toContain('/settings?error=oauth')
    expect(completeOAuthConnectForMailbox).not.toHaveBeenCalled()
  })

  it('should redirect with an oauth error when the cookie is missing', async () => {
    const response = await GET(
      new Request('http://localhost:3000/api/mailboxes/mailreach/callback?code=auth-code&state=nonce1'),
    )
    expect(response.headers.get('location')).toContain('/settings?error=oauth')
  })

  it('should redirect with not_found when the mailbox no longer exists', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await GET(requestWithCookie('nonce1', 'm1', 'nonce1'))
    expect(response.headers.get('location')).toContain('/settings?error=not_found')
  })
})
