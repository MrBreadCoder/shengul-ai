import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const verifyQstashSignatureMock = vi.fn()
const getSourceByIdMock = vi.fn()
const deleteChunksForSourceMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
const markSourceReadyMock = vi.fn()
const markSourceFailedMock = vi.fn()
const scrapeMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  deleteChunksForSource: (...a: unknown[]) => deleteChunksForSourceMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
  markSourceReady: (...a: unknown[]) => markSourceReadyMock(...a),
  markSourceFailed: (...a: unknown[]) => markSourceFailedMock(...a),
}))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: { scrape: (...a: unknown[]) => scrapeMock(...a) } }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue(JSON.stringify({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
  getSourceByIdMock.mockReset()
  deleteChunksForSourceMock.mockReset().mockResolvedValue(undefined)
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
  markSourceReadyMock.mockReset().mockResolvedValue(undefined)
  markSourceFailedMock.mockReset().mockResolvedValue(undefined)
  scrapeMock.mockReset()
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/knowledge-scrape', () => {
  it('should return 401 when the qstash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
    expect(res.status).toBe(401)
  })

  it('should return 404 when the source does not exist', async () => {
    getSourceByIdMock.mockResolvedValue(null)
    const res = await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
    expect(res.status).toBe(404)
  })

  it('should scrape, delete old chunks, embed, and mark ready on success', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockResolvedValue('# Acme\nWe build widgets')
    const res = await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteChunksForSourceMock).toHaveBeenCalledWith(expect.anything(), 'f47ac10b-58cc-4372-a567-0e02b2c3d479')
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', content: '# Acme\nWe build widgets',
    }))
    expect(markSourceReadyMock).toHaveBeenCalledWith(expect.anything(), 'f47ac10b-58cc-4372-a567-0e02b2c3d479', '# Acme\nWe build widgets', 23)
    expect(markSourceFailedMock).not.toHaveBeenCalled()
  })

  it('should mark the source failed when the scrape throws', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'Brightdata scrape failed'))
    const res = await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(markSourceFailedMock).toHaveBeenCalledWith(expect.anything(), 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'Brightdata scrape failed')
    expect(embedAndStoreChunksMock).not.toHaveBeenCalled()
  })
})
