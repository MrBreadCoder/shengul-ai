import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const deleteMailbox = vi.fn()
const removeMailboxFromCampaigns = vi.fn()
const disconnectMailbox = vi.fn()
const logEvent = vi.fn()
const logEventSafe = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  deleteMailbox: (...args: unknown[]) => deleteMailbox(...args),
}))
vi.mock('@/lib/db/campaigns', () => ({
  removeMailboxFromCampaigns: (...args: unknown[]) => removeMailboxFromCampaigns(...args),
}))
vi.mock('@/lib/mailreach/enrollment', () => ({
  disconnectMailbox: (...args: unknown[]) => disconnectMailbox(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...args: unknown[]) => logEvent(...args),
  logEventSafe: (...args: unknown[]) => logEventSafe(...args),
}))

const { DELETE } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }
const mailbox = {
  id: 'm1', client_id: 'c1', email_address: 'a@b.com', provider: 'gmail', mailreach_account_id: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })
  getMailboxById.mockResolvedValue(mailbox)
  deleteMailbox.mockResolvedValue(undefined)
  removeMailboxFromCampaigns.mockResolvedValue(undefined)
  disconnectMailbox.mockResolvedValue(undefined)
  logEvent.mockResolvedValue(undefined)
  logEventSafe.mockResolvedValue(undefined)
})

describe('DELETE /api/mailboxes/[id]', () => {
  it('should let an operator delete any mailbox', async () => {
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(200)
    expect(removeMailboxFromCampaigns).toHaveBeenCalledWith(expect.anything(), 'c1', 'm1')
    expect(deleteMailbox).toHaveBeenCalledWith(expect.anything(), 'm1')
    expect(logEvent).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'mailbox.deleted', payload: expect.objectContaining({ mailboxId: 'm1' }) }),
    )
  })

  it('should let a client delete their own mailbox', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(200)
    expect(deleteMailbox).toHaveBeenCalledWith(expect.anything(), 'm1')
  })

  it('should reject a client deleting another client mailbox', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c2' } })
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(403)
    expect(deleteMailbox).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(404)
    expect(deleteMailbox).not.toHaveBeenCalled()
  })

  it('should disconnect Mailreach first when the mailbox has a live account', async () => {
    getMailboxById.mockResolvedValue({ ...mailbox, mailreach_account_id: 'acct1' })
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(200)
    expect(disconnectMailbox).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ mailreach_account_id: 'acct1' }))
    expect(deleteMailbox).toHaveBeenCalled()
  })

  it('should still delete the mailbox when the Mailreach vendor call fails', async () => {
    getMailboxById.mockResolvedValue({ ...mailbox, mailreach_account_id: 'acct1' })
    disconnectMailbox.mockRejectedValue(new Error('vendor down'))
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(200)
    expect(deleteMailbox).toHaveBeenCalled()
    expect(logEventSafe).toHaveBeenCalledWith(expect.objectContaining({ type: 'mailbox.mailreach_disconnect_failed' }))
  })

  it('should 500 with the AppError code when the delete fails', async () => {
    deleteMailbox.mockRejectedValue(Object.assign(new Error('boom'), { code: 'DB_ERROR', name: 'AppError' }))
    const response = await DELETE(new Request('http://x', { method: 'DELETE' }), context)
    expect(response.status).toBe(500)
  })
})
