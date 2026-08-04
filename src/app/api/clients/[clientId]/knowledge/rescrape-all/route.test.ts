import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const listSourcesForClientMock = vi.fn()
const resetSourceToPendingMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()
const logErrorMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  listSourcesForClient: (...a: unknown[]) => listSourcesForClientMock(...a),
  resetSourceToPending: (...a: unknown[]) => resetSourceToPendingMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
}))

import { POST } from './route'

function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}
function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

function source(overrides: Record<string, unknown> = {}) {
  return { id: 's1', client_id: 'c1', source_type: 'website_page', status: 'ready', url: 'https://a.com/1', ...overrides }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  listSourcesForClientMock.mockReset().mockResolvedValue([])
  resetSourceToPendingMock.mockReset().mockResolvedValue(undefined)
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
  logErrorMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/rescrape-all', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(), ctx('c1'))
    expect(res.status).toBe(403)
    expect(listSourcesForClientMock).not.toHaveBeenCalled()
  })

  it('should reset and republish a scrape job for every website-page source', async () => {
    listSourcesForClientMock.mockResolvedValue([
      source({ id: 's1' }),
      source({ id: 's2', status: 'failed' }),
    ])
    const res = await POST(req(), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, queued: 2, failed: 0 })
    expect(resetSourceToPendingMock).toHaveBeenCalledWith(expect.anything(), 's1')
    expect(resetSourceToPendingMock).toHaveBeenCalledWith(expect.anything(), 's2')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's2' })
  })

  it('should skip non-website-page sources and sources already pending', async () => {
    listSourcesForClientMock.mockResolvedValue([
      source({ id: 's1', source_type: 'pdf' }),
      source({ id: 's2', status: 'pending' }),
      source({ id: 's3' }),
    ])
    const res = await POST(req(), ctx('c1'))
    const json = await res.json()
    expect(json).toEqual({ ok: true, queued: 1, failed: 0 })
    expect(resetSourceToPendingMock).toHaveBeenCalledTimes(1)
    expect(resetSourceToPendingMock).toHaveBeenCalledWith(expect.anything(), 's3')
  })

  it('should count a per-source failure without aborting the rest and log it', async () => {
    resetSourceToPendingMock
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(undefined)
    listSourcesForClientMock.mockResolvedValue([source({ id: 's1' }), source({ id: 's2' })])

    const res = await POST(req(), ctx('c1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, queued: 1, failed: 1 })
    expect(logErrorMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.rescrape_all_source_failed', payload: expect.objectContaining({ sourceId: 's1' }) }),
    )
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'knowledge.rescrape_all_requested',
        payload: expect.objectContaining({ totalSources: 2, queued: 1, failedSourceIds: ['s1'] }),
      }),
    )
  })

  it('should return zero counts when there is nothing rescrapable', async () => {
    listSourcesForClientMock.mockResolvedValue([source({ source_type: 'pdf' })])
    const res = await POST(req(), ctx('c1'))
    const json = await res.json()
    expect(json).toEqual({ ok: true, queued: 0, failed: 0 })
    expect(resetSourceToPendingMock).not.toHaveBeenCalled()
  })
})
