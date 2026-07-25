import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const countCasesForCampaignMock = vi.fn()
const countLeadsForCampaignMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ countCasesForCampaign: (...a: unknown[]) => countCasesForCampaignMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ countLeadsForCampaign: (...a: unknown[]) => countLeadsForCampaignMock(...a) }))

import { GET } from './route'

function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  countCasesForCampaignMock.mockReset()
  countLeadsForCampaignMock.mockReset()
})

describe('GET /api/campaigns/[campaignId]/stats', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await GET(new Request('http://x'), ctx('camp1'))
    expect(res.status).toBe(403)
    expect(getCampaignByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await GET(new Request('http://x'), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return the case and lead counts', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', name: 'Acme launch' })
    countCasesForCampaignMock.mockResolvedValue(3)
    countLeadsForCampaignMock.mockResolvedValue(7)
    const res = await GET(new Request('http://x'), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, caseCount: 3, leadCount: 7 })
    expect(countCasesForCampaignMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(countLeadsForCampaignMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
  })
})
