import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientStatusMock = vi.fn()
const resumeCampaignsMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const unbanAuthUsersMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientStatus: (...a: unknown[]) => updateClientStatusMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ resumeCampaignsForClient: (...a: unknown[]) => resumeCampaignsMock(...a) }))
vi.mock('@/lib/supabase/auth-admin', () => ({ unbanAuthUsers: (...a: unknown[]) => unbanAuthUsersMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientStatusMock.mockReset()
  resumeCampaignsMock.mockReset().mockResolvedValue(undefined)
  listClientRoleAppUsersMock.mockReset().mockResolvedValue([])
  unbanAuthUsersMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/resume', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should resume campaigns and set status to active without unbanning from a paused state', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'paused' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(resumeCampaignsMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(unbanAuthUsersMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.resumed' }))
  })

  it('should unban every client-role user when resuming from archived', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'archived' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    listClientRoleAppUsersMock.mockResolvedValue([
      { id: 'u1', client_id: 'c1' },
      { id: 'u2', client_id: 'other' },
    ])
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(unbanAuthUsersMock).toHaveBeenCalledWith(expect.anything(), ['u1'])
  })
})
