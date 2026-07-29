import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const disconnectMailbox = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ getMailboxById: (...args: unknown[]) => getMailboxById(...args) }))
vi.mock('@/lib/mailreach/enrollment', () => ({ disconnectMailbox: (...args: unknown[]) => disconnectMailbox(...args) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
})

describe('POST /api/mailboxes/[id]/mailreach/disconnect', () => {
  it('should disconnect the mailbox', async () => {
    disconnectMailbox.mockResolvedValue(undefined)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(disconnectMailbox).toHaveBeenCalled()
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(403)
    expect(disconnectMailbox).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })
})
