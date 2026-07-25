import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const setMailboxHealth = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  setMailboxHealth: (...args: unknown[]) => setMailboxHealth(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', email_address: 'a@b.com', health: 'ok' })
})

describe('POST /api/mailboxes/[id]/pause', () => {
  it('should block the mailbox with the operator_paused reason', async () => {
    const response = await POST(new Request('http://x/api/mailboxes/m1/pause', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(setMailboxHealth).toHaveBeenCalledWith(expect.anything(), 'm1', 'blocked', 'operator_paused')
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(new Request('http://x/api/mailboxes/m1/pause', { method: 'POST' }), context)
    expect(response.status).toBe(403)
    expect(setMailboxHealth).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x/api/mailboxes/m1/pause', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })
})
