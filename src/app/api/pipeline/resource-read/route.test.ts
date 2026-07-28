import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const RESOURCE_ID = 'f47ac10b-58cc-4372-a567-0e02b2c3d479'

const verifyQstashSignatureMock = vi.fn()
const getResourceByIdMock = vi.fn()
const readResourceContentMock = vi.fn()
const upsertResourceKnowledgeSourceMock = vi.fn()
const deleteResourceKnowledgeSourceMock = vi.fn()
const deleteChunksForSourceMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
const markReadyMock = vi.fn()
const markFailedMock = vi.fn()
const markUnsupportedMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({
  verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-resources', () => ({
  getResourceById: (...a: unknown[]) => getResourceByIdMock(...a),
}))
vi.mock('@/lib/resources/derive-content', () => ({
  readResourceContent: (...a: unknown[]) => readResourceContentMock(...a),
}))
vi.mock('@/lib/db/resource-content', () => ({
  upsertResourceKnowledgeSource: (...a: unknown[]) => upsertResourceKnowledgeSourceMock(...a),
  deleteResourceKnowledgeSource: (...a: unknown[]) => deleteResourceKnowledgeSourceMock(...a),
  markResourceContentReady: (...a: unknown[]) => markReadyMock(...a),
  markResourceContentFailed: (...a: unknown[]) => markFailedMock(...a),
  markResourceContentUnsupported: (...a: unknown[]) => markUnsupportedMock(...a),
}))
vi.mock('@/lib/db/client-knowledge', () => ({
  deleteChunksForSource: (...a: unknown[]) => deleteChunksForSourceMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

const resource = {
  id: RESOURCE_ID, client_id: 'c1', title: 'Deck', mime_type: 'application/pdf',
  storage_path: 'c1/deck.pdf', is_active: true, created_by: 'u1',
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue(JSON.stringify({ resourceId: RESOURCE_ID }))
  getResourceByIdMock.mockReset().mockResolvedValue(resource)
  readResourceContentMock.mockReset().mockResolvedValue({
    status: 'ready', content: 'twelve brand projects', summary: 'Twelve brand projects',
  })
  upsertResourceKnowledgeSourceMock.mockReset().mockResolvedValue('s1')
  deleteResourceKnowledgeSourceMock.mockReset().mockResolvedValue(undefined)
  deleteChunksForSourceMock.mockReset().mockResolvedValue(undefined)
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
  markReadyMock.mockReset().mockResolvedValue(undefined)
  markFailedMock.mockReset().mockResolvedValue(undefined)
  markUnsupportedMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/resource-read', () => {
  it('should return 401 when the qstash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req({ resourceId: RESOURCE_ID }))
    expect(res.status).toBe(401)
    expect(readResourceContentMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the resource does not exist', async () => {
    getResourceByIdMock.mockResolvedValue(null)
    const res = await POST(req({ resourceId: RESOURCE_ID }))
    expect(res.status).toBe(404)
  })

  it('should skip a resource deactivated while the job was queued', async () => {
    getResourceByIdMock.mockResolvedValue({ ...resource, is_active: false })
    const res = await POST(req({ resourceId: RESOURCE_ID }))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true, skipped: 'inactive' })
    expect(readResourceContentMock).not.toHaveBeenCalled()
  })

  it('should derive the content, replace the chunks and mark the row ready', async () => {
    const res = await POST(req({ resourceId: RESOURCE_ID }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(upsertResourceKnowledgeSourceMock).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', resourceId: RESOURCE_ID, createdBy: 'u1', title: 'Deck',
      content: 'twelve brand projects',
    })
    expect(deleteChunksForSourceMock).toHaveBeenCalledWith(expect.anything(), 's1')
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', sourceId: 's1', content: 'twelve brand projects',
    }))
    expect(markReadyMock).toHaveBeenCalledWith(expect.anything(), {
      resourceId: RESOURCE_ID, content: 'twelve brand projects', summary: 'Twelve brand projects',
    })
    expect(markFailedMock).not.toHaveBeenCalled()
  })

  it('should delete old chunks before embedding so a retry cannot duplicate them', async () => {
    const order: string[] = []
    deleteChunksForSourceMock.mockImplementation(async () => { order.push('delete') })
    embedAndStoreChunksMock.mockImplementation(async () => { order.push('embed') })

    await POST(req({ resourceId: RESOURCE_ID }))

    expect(order).toEqual(['delete', 'embed'])
  })

  it('should mark the row unsupported and write no chunks for a format it cannot read', async () => {
    readResourceContentMock.mockResolvedValue({ status: 'unsupported' })

    const res = await POST(req({ resourceId: RESOURCE_ID }))

    expect(res.status).toBe(200)
    expect(markUnsupportedMock).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID)
    expect(embedAndStoreChunksMock).not.toHaveBeenCalled()
    expect(markReadyMock).not.toHaveBeenCalled()
  })

  it('should record the message and still return 200 when reading throws', async () => {
    readResourceContentMock.mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'LLM call timed out'))

    const res = await POST(req({ resourceId: RESOURCE_ID }))

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(markFailedMock).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, 'LLM call timed out')
    expect(embedAndStoreChunksMock).not.toHaveBeenCalled()
  })

  it('should tear down content from an earlier read when a re-read fails', async () => {
    readResourceContentMock.mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'LLM call timed out'))
    const order: string[] = []
    deleteResourceKnowledgeSourceMock.mockImplementation(async () => { order.push('deleteSource') })
    markFailedMock.mockImplementation(async () => { order.push('markFailed') })

    await POST(req({ resourceId: RESOURCE_ID }))

    expect(deleteResourceKnowledgeSourceMock).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID)
    // The chunks go before the row admits the failure, so no window exists where
    // a row reading 'failed' still has retrievable content behind it.
    expect(order).toEqual(['deleteSource', 'markFailed'])
  })

  it('should leave the source in place when the read succeeds', async () => {
    await POST(req({ resourceId: RESOURCE_ID }))

    expect(deleteResourceKnowledgeSourceMock).not.toHaveBeenCalled()
  })

  it('should record a generic message when the failure is not an AppError', async () => {
    readResourceContentMock.mockRejectedValue(new Error('socket hang up'))

    await POST(req({ resourceId: RESOURCE_ID }))

    expect(markFailedMock).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, 'Could not read this file')
  })

  it('should record the failure when embedding throws after the content was derived', async () => {
    embedAndStoreChunksMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'LLM embedMany failed'))

    const res = await POST(req({ resourceId: RESOURCE_ID }))

    expect(res.status).toBe(200)
    expect(markFailedMock).toHaveBeenCalledWith(expect.anything(), RESOURCE_ID, 'LLM embedMany failed')
    expect(markReadyMock).not.toHaveBeenCalled()
  })

  // 400, not 500: QStash retries a 5xx, and a body this worker cannot read will
  // not become readable on the third attempt.
  it('should return 400 when the body is not a valid resource id', async () => {
    verifyQstashSignatureMock.mockResolvedValue(JSON.stringify({ resourceId: 'not-a-uuid' }))
    const res = await POST(req({ resourceId: 'not-a-uuid' }))
    expect(res.status).toBe(400)
    expect(getResourceByIdMock).not.toHaveBeenCalled()
  })

  it('should return 400 when the body is not valid json', async () => {
    verifyQstashSignatureMock.mockResolvedValue('not json at all')
    const res = await POST(req({}))
    expect(res.status).toBe(400)
    expect(getResourceByIdMock).not.toHaveBeenCalled()
  })
})
