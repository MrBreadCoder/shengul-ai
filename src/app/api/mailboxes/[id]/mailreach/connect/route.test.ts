import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const updateMailboxMailreachPending = vi.fn()
const connectSmtpMailbox = vi.fn()
const oauthAuthorizeUrl = vi.fn()
const getClientById = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  updateMailboxMailreachPending: (...args: unknown[]) => updateMailboxMailreachPending(...args),
}))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...args: unknown[]) => getClientById(...args) }))
vi.mock('@/lib/mailreach/enrollment', () => ({
  connectSmtpMailbox: (...args: unknown[]) => connectSmtpMailbox(...args),
  oauthAuthorizeUrl: (...args: unknown[]) => oauthAuthorizeUrl(...args),
}))
const logError = vi.fn()
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: () => Promise.resolve(),
  logError: (...args: unknown[]) => logError(...args),
}))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'http://localhost:3000' } }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getClientById.mockResolvedValue({ id: 'c1', mailreach_enabled: true })
})

describe('POST /api/mailboxes/[id]/mailreach/connect', () => {
  it('should connect an smtp mailbox synchronously', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    connectSmtpMailbox.mockResolvedValue(undefined)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, redirect: false })
    expect(connectSmtpMailbox).toHaveBeenCalled()
  })

  it('should return a redirect url for a gmail mailbox without connecting synchronously', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'gmail' })
    oauthAuthorizeUrl.mockReturnValue('https://api.mailreach.co/api/v1/connect-account/oauth?stub=1')
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.redirect).toBe(true)
    expect(body.authorizeUrl).toBe('https://api.mailreach.co/api/v1/connect-account/oauth?stub=1')
    expect(updateMailboxMailreachPending).toHaveBeenCalledWith({}, 'm1')
    expect(response.headers.get('set-cookie')).toContain('mailreach_oauth_state=')
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(403)
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })

  it('should reject connecting a mailbox while the client mailreach switch is off', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    getClientById.mockResolvedValue({ id: 'c1', mailreach_enabled: false })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(400)
    const body = await response.json()
    expect(body.error).toBe('client_mailreach_disabled')
    expect(connectSmtpMailbox).not.toHaveBeenCalled()
  })

  it('should 404 when the mailbox client no longer exists', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    getClientById.mockResolvedValue(null)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })

  it('should return 500 with the AppError code when the smtp connect fails', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    const { AppError } = await import('@/lib/errors/app-error')
    connectSmtpMailbox.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'boom'))
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toBe('EXTERNAL_ERROR')
  })

  it('should log the vendor status and body when the smtp connect fails on a non-2xx response', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    const { AppError } = await import('@/lib/errors/app-error')
    connectSmtpMailbox.mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 401', { url: 'x', status: 401, body: 'invalid api key' }),
    )
    await POST(new Request('http://x', { method: 'POST' }), context)
    expect(logError).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'c1',
        type: 'mailbox.mailreach_connect_failed',
        payload: expect.objectContaining({ mailboxId: 'm1', provider: 'smtp', status: 401, body: 'invalid api key' }),
      }),
    )
  })

  it('should return 500 with the AppError code when the oauth branch fails', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'gmail' })
    const { AppError } = await import('@/lib/errors/app-error')
    updateMailboxMailreachPending.mockRejectedValue(new AppError('DB_ERROR', 'boom'))
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toBe('DB_ERROR')
  })
})
