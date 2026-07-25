import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const insertClientMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ insertClient: (...a: unknown[]) => insertClientMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset()
  insertClientMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ name: 'Acme' }))
    expect(res.status).toBe(403)
    expect(insertClientMock).not.toHaveBeenCalled()
  })

  it('should return 400 on validation error', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    const res = await POST(req({ name: '' }))
    expect(res.status).toBe(400)
  })

  it('should create the client and log the event on success', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertClientMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    const res = await POST(req({ name: 'Acme' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'Acme' } })
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.created' }),
    )
  })
})
