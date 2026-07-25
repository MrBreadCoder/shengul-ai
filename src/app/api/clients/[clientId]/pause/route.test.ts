import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientStatusMock = vi.fn()
const pauseCampaignsMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientStatus: (...a: unknown[]) => updateClientStatusMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ pauseActiveCampaignsForClient: (...a: unknown[]) => pauseCampaignsMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientStatusMock.mockReset()
  pauseCampaignsMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/pause', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should pause campaigns and set status to paused', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'paused' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'Acme', status: 'paused' } })
    expect(pauseCampaignsMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(updateClientStatusMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'paused')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.paused' }))
  })
})
