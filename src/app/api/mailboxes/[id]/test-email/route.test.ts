import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const updateMailboxOauth = vi.fn()
const getMailboxProvider = vi.fn()
const logEvent = vi.fn()
const sendEmail = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  updateMailboxOauth: (...args: unknown[]) => updateMailboxOauth(...args),
}))
vi.mock('@/lib/mailbox/registry', () => ({
  getMailboxProvider: (...args: unknown[]) => getMailboxProvider(...args),
}))
vi.mock('@/lib/mailbox/tokens', () => ({
  parseMailboxTokens: (oauth: unknown) => oauth,
  encryptMailboxTokens: (tokens: unknown) => tokens,
}))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
}))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }
const mailboxTokens = { kind: 'smtp', emailAddress: 'a@b.com' }
const mailbox = {
  id: 'm1', client_id: 'c1', email_address: 'a@b.com', provider: 'smtp', oauth: mailboxTokens,
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })
  getMailboxById.mockResolvedValue(mailbox)
  updateMailboxOauth.mockResolvedValue(undefined)
  logEvent.mockResolvedValue(undefined)
  sendEmail.mockResolvedValue({
    result: { providerMessageId: 'msg1', threadId: 'thread1' },
    tokens: mailboxTokens,
  })
  getMailboxProvider.mockReturnValue({ sendEmail })
})

describe('POST /api/mailboxes/[id]/test-email', () => {
  it('should let an operator send a test email for any mailbox', async () => {
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, providerMessageId: 'msg1' })
    expect(sendEmail).toHaveBeenCalledWith(
      mailboxTokens,
      expect.objectContaining({ to: 'a@b.com', subject: 'AI B2B test email' }),
    )
  })

  it('should let a client send a test email for their own mailbox', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(sendEmail).toHaveBeenCalled()
  })

  it('should reject a client sending a test email for another client mailbox', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c2' } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('should reject a client with no client_id', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: null } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(403)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(404)
    expect(sendEmail).not.toHaveBeenCalled()
  })

  it('should persist refreshed tokens when the provider returns new ones', async () => {
    const nextTokens = { kind: 'oauth', accessToken: 'new' }
    sendEmail.mockResolvedValue({ result: { providerMessageId: 'msg2', threadId: 'thread2' }, tokens: nextTokens })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxOauth).toHaveBeenCalledWith(expect.anything(), 'm1', nextTokens, mailboxTokens)
  })

  it('should log mailbox.test_email_sent on success', async () => {
    await POST(new Request('http://x', { method: 'POST' }), context)
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        clientId: 'c1',
        type: 'mailbox.test_email_sent',
        payload: expect.objectContaining({ mailboxId: 'm1', providerMessageId: 'msg1' }),
      }),
    )
  })

  it('should return 500 with the AppError code when sending fails', async () => {
    sendEmail.mockRejectedValue(Object.assign(new Error('boom'), { code: 'EXTERNAL_ERROR', name: 'AppError' }))
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(500)
  })
})
