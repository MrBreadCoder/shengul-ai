import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyQstashSignatureMock = vi.fn()
const listCampaignsDueForDiscoveryMock = vi.fn()
const recomputeCampaignNextDiscoverAtMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  listCampaignsDueForDiscovery: (...a: unknown[]) => listCampaignsDueForDiscoveryMock(...a),
  recomputeCampaignNextDiscoverAt: (...a: unknown[]) => recomputeCampaignNextDiscoverAtMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue('{}')
  listCampaignsDueForDiscoveryMock.mockReset().mockResolvedValue([])
  recomputeCampaignNextDiscoverAtMock.mockReset().mockResolvedValue({ id: 'camp1' })
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/discover-fanout', () => {
  it('should return 401 when the QStash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(listCampaignsDueForDiscoveryMock).not.toHaveBeenCalled()
  })

  it('should publish nothing and return an empty result when no campaign is due', async () => {
    const res = await POST(req())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaignCount: 0, firedCampaignIds: [], failedCampaignIds: [], staleScheduleCampaignIds: [] })
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should publish a discover job and recompute the schedule for each due campaign', async () => {
    listCampaignsDueForDiscoveryMock.mockResolvedValue([{ id: 'camp1' }, { id: 'camp2' }])

    const res = await POST(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/discover', { campaignId: 'camp1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/discover', { campaignId: 'camp2' })
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp1', expect.any(Date))
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp2', expect.any(Date))
    expect(json.firedCampaignIds).toEqual(['camp1', 'camp2'])
    expect(json.failedCampaignIds).toEqual([])
  })

  it('should isolate a publish failure without recomputing that campaign\'s schedule', async () => {
    listCampaignsDueForDiscoveryMock.mockResolvedValue([{ id: 'camp1' }, { id: 'camp2' }])
    publishJsonMock.mockImplementation((path: string, body: { campaignId: string }) => {
      if (body.campaignId === 'camp2') return Promise.reject(new Error('qstash down'))
      return Promise.resolve('msg1')
    })

    const res = await POST(req())
    const json = await res.json()

    expect(json.firedCampaignIds).toEqual(['camp1'])
    expect(json.failedCampaignIds).toEqual(['camp2'])
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledTimes(1)
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp1', expect.any(Date))
  })

  it('should track a recompute failure separately, without re-firing that campaign next tick', async () => {
    listCampaignsDueForDiscoveryMock.mockResolvedValue([{ id: 'camp1' }])
    recomputeCampaignNextDiscoverAtMock.mockRejectedValue(new Error('db down'))

    const res = await POST(req())
    const json = await res.json()

    // The publish already succeeded — camp1 must NOT be in failedCampaignIds
    // (that list drives nothing here, but conflating it with a recompute
    // failure would be indistinguishable from "never fired," which is false
    // and would risk a second, duplicate discover run once the DB recovers).
    expect(json.firedCampaignIds).toEqual(['camp1'])
    expect(json.failedCampaignIds).toEqual([])
    expect(json.staleScheduleCampaignIds).toEqual(['camp1'])
  })
})
