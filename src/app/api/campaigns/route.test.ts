import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const insertCampaignMock = vi.fn()
const logEventMock = vi.fn()
const getClientByIdMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({ insertCampaign: (...a: unknown[]) => insertCampaignMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

const validBody = {
  clientId: '11111111-1111-4111-8111-111111111111',
  name: 'Q3 campaign',
  valueProp: 'We save you time',
}

beforeEach(() => {
  requireUserMock.mockReset()
  insertCampaignMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
  getClientByIdMock.mockReset().mockResolvedValue({ id: validBody.clientId, reply_mode: 'human_approve' })
})

describe('POST /api/campaigns', () => {
  it('should return 403 when the caller has the client role', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should return 400 on validation error', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    const res = await POST(req({ ...validBody, name: '' }))
    expect(res.status).toBe(400)
  })

  it('should create the campaign for an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })
    const res = await POST(req(validBody))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', name: 'Q3 campaign' } })
  })

  it('should pass exclude filters through into the stored ICP', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({
      ...validBody,
      excludeOrganizationLocations: ['ireland'],
      excludeKeywords: ['staffing'],
    }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({
          excludeOrganizationLocations: ['ireland'],
          excludeKeywords: ['staffing'],
        }),
      }),
    )
  })

  it('should use the client current reply_mode as the new campaign default', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({ id: validBody.clientId, reply_mode: 'auto_send' })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ reply_mode: 'auto_send' }),
    )
  })

  it('should return 404 when the client does not exist', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue(null)

    const res = await POST(req(validBody))

    expect(res.status).toBe(404)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should pass personSeniorities and contactEmailStatuses through into the stored ICP', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({
      ...validBody,
      personSeniorities: ['vp', 'director'],
      contactEmailStatuses: ['verified'],
    }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({
          personSeniorities: ['vp', 'director'],
          contactEmailStatuses: ['verified'],
        }),
      }),
    )
  })

  it('should default personSeniorities and contactEmailStatuses to empty arrays when omitted', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({ personSeniorities: [], contactEmailStatuses: [] }),
      }),
    )
  })

  it('should reject an unrecognized seniority value with a 400', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })

    const res = await POST(req({ ...validBody, personSeniorities: ['not_a_real_seniority'] }))

    expect(res.status).toBe(400)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })
})
