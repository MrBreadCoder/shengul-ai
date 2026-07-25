import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getSourceByIdMock = vi.fn()
const resetSourceToPendingMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  resetSourceToPending: (...a: unknown[]) => resetSourceToPendingMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function ctx(clientId: string, sourceId: string) {
  return { params: Promise.resolve({ clientId, sourceId }) }
}
function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getSourceByIdMock.mockReset()
  resetSourceToPendingMock.mockReset().mockResolvedValue(undefined)
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/[sourceId]/rescrape', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the source is missing or belongs to a different client', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'other', source_type: 'website_page' })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(404)
  })

  it('should return 400 for a pdf source', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'pdf' })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(400)
    expect(resetSourceToPendingMock).not.toHaveBeenCalled()
  })

  it('should reset to pending and republish a scrape job', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'website_page', url: 'https://a.com/1' })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(200)
    expect(resetSourceToPendingMock).toHaveBeenCalledWith(expect.anything(), 's1')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's1' })
  })
})
