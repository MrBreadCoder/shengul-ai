import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const deleteCampaignMock = vi.fn()
const updateCampaignSettingsMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  deleteCampaign: (...a: unknown[]) => deleteCampaignMock(...a),
  updateCampaignSettings: (...a: unknown[]) => updateCampaignSettingsMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { DELETE, PATCH } from './route'

function deleteReq(body: unknown) {
  return new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) })
}
function patchReq(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}
function validPatchBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Updated name',
    valueProp: 'Updated value prop',
    bookingLink: null,
    dailyTarget: 25,
    personTitles: [],
    organizationLocations: [],
    employeeRangeMin: null,
    employeeRangeMax: null,
    keywords: [],
    excludeOrganizationLocations: [],
    excludeKeywords: [],
    personSeniorities: [],
    contactEmailStatuses: [],
    ...overrides,
  }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  deleteCampaignMock.mockReset()
  updateCampaignSettingsMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/campaigns/[campaignId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(deleteReq({ confirmName: 'Acme launch' }), ctx('camp1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await DELETE(deleteReq({ confirmName: 'Acme launch' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the confirmation name does not match', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    const res = await DELETE(deleteReq({ confirmName: 'wrong' }), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(deleteCampaignMock).not.toHaveBeenCalled()
  })

  it('should delete the campaign and log the event when the name matches', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    deleteCampaignMock.mockResolvedValue(undefined)
    const res = await DELETE(deleteReq({ confirmName: 'Acme launch' }), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteCampaignMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.deleted' }))
  })
})

describe('PATCH /api/campaigns/[campaignId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(patchReq(validPatchBody()), ctx('camp1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await PATCH(patchReq(validPatchBody()), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the body fails validation', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    const res = await PATCH(patchReq(validPatchBody({ name: '' })), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(updateCampaignSettingsMock).not.toHaveBeenCalled()
  })

  it('should update the campaign and log the event on success', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    const updated = { id: 'camp1', client_id: 'c1', name: 'Updated name' }
    updateCampaignSettingsMock.mockResolvedValue(updated)
    const res = await PATCH(patchReq(validPatchBody()), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: updated })
    expect(updateCampaignSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      'camp1',
      expect.objectContaining({ name: 'Updated name', daily_target: 25 }),
    )
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.updated' }))
  })
})
