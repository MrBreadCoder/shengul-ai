import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const updateCampaignStatusMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  updateCampaignStatus: (...a: unknown[]) => updateCampaignStatusMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  updateCampaignStatusMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/campaigns/[campaignId]/stop', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    expect(res.status).toBe(403)
    expect(getCampaignByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the campaign is not active', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(updateCampaignStatusMock).not.toHaveBeenCalled()
  })

  it('should stop an active campaign and log the event', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active' })
    updateCampaignStatusMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' } })
    expect(updateCampaignStatusMock).toHaveBeenCalledWith(expect.anything(), 'camp1', 'paused')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.stopped' }))
  })
})
