import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const insertPendingWebsiteSourcesMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  insertPendingWebsiteSources: (...a: unknown[]) => insertPendingWebsiteSourcesMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  insertPendingWebsiteSourcesMock.mockReset()
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/pages', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ urls: ['https://a.com/1'] }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(req({ urls: ['https://a.com/1'] }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when more than 50 urls are submitted', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    const urls = Array.from({ length: 51 }, (_, i) => `https://a.com/${i}`)
    const res = await POST(req({ urls }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should insert pending sources and fan out one qstash job per new source', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    insertPendingWebsiteSourcesMock.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    const res = await POST(req({ urls: ['https://a.com/1', 'https://a.com/2'] }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, insertedCount: 2 })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's2' })
  })

  it('should return insertedCount 0 without publishing when every url already existed', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    insertPendingWebsiteSourcesMock.mockResolvedValue([])
    const res = await POST(req({ urls: ['https://a.com/1'] }), ctx('c1'))
    const json = await res.json()
    expect(json).toEqual({ ok: true, insertedCount: 0 })
    expect(publishJsonMock).not.toHaveBeenCalled()
  })
})
