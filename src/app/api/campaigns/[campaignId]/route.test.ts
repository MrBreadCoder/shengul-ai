import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const deleteCampaignMock = vi.fn()
const updateCampaignSettingsMock = vi.fn()
const recomputeCampaignNextDiscoverAtMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  deleteCampaign: (...a: unknown[]) => deleteCampaignMock(...a),
  updateCampaignSettings: (...a: unknown[]) => updateCampaignSettingsMock(...a),
  recomputeCampaignNextDiscoverAt: (...a: unknown[]) => recomputeCampaignNextDiscoverAtMock(...a),
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
    discoverTime: null,
    discoverTimezone: null,
    ...overrides,
  }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  deleteCampaignMock.mockReset()
  updateCampaignSettingsMock.mockReset()
  recomputeCampaignNextDiscoverAtMock.mockReset()
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
    recomputeCampaignNextDiscoverAtMock.mockResolvedValue({ ...updated, next_discover_at: '2026-06-16T06:00:00.000Z' })
    const res = await PATCH(patchReq(validPatchBody()), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { ...updated, next_discover_at: '2026-06-16T06:00:00.000Z' } })
    expect(updateCampaignSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      'camp1',
      expect.objectContaining({ name: 'Updated name', daily_target: 25 }),
    )
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.updated' }))
  })

  it('should recompute next_discover_at after a successful update', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Old name' })
    updateCampaignSettingsMock.mockResolvedValue({ id: 'camp1', name: 'Updated name' })
    recomputeCampaignNextDiscoverAtMock.mockResolvedValue({
      id: 'camp1',
      name: 'Updated name',
      next_discover_at: '2026-06-16T09:00:00.000Z',
    })

    const res = await PATCH(
      patchReq(validPatchBody({ discoverTime: '09:00', discoverTimezone: 'Europe/Istanbul' })),
      ctx('camp1'),
    )
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(updateCampaignSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      'camp1',
      expect.objectContaining({ discover_time: '09:00', discover_timezone: 'Europe/Istanbul' }),
    )
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(json).toEqual({
      ok: true,
      campaign: { id: 'camp1', name: 'Updated name', next_discover_at: '2026-06-16T09:00:00.000Z' },
    })
  })
})
