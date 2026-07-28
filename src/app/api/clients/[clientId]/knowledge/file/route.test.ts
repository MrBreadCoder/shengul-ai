import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const assertValidKnowledgeFileMock = vi.fn()
const uploadClientKnowledgeFileMock = vi.fn()
const extractKnowledgeTextMock = vi.fn()
const insertFileSourceReadyMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/storage/client-knowledge-files', () => ({
  assertValidKnowledgeFile: (...a: unknown[]) => assertValidKnowledgeFileMock(...a),
  uploadClientKnowledgeFile: (...a: unknown[]) => uploadClientKnowledgeFileMock(...a),
  extractKnowledgeText: (...a: unknown[]) => extractKnowledgeTextMock(...a),
}))
vi.mock('@/lib/db/client-knowledge', () => ({
  insertFileSourceReady: (...a: unknown[]) => insertFileSourceReadyMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from './route'

const pdfFile = () => new File(['x'], 'doc.pdf', { type: 'application/pdf' })
const mdFile = () => new File(['# hi'], 'notes.md', { type: 'text/markdown' })
const pngFile = () => new File(['x'], 'a.png', { type: 'image/png' })

function postReq(file?: File): Request {
  const formData = new FormData()
  if (file) formData.set('file', file)
  return new Request('http://x', { method: 'POST', body: formData })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1' })
  assertValidKnowledgeFileMock.mockReset()
  uploadClientKnowledgeFileMock.mockReset().mockResolvedValue('c1/x.pdf')
  extractKnowledgeTextMock.mockReset().mockResolvedValue('Extracted text')
  insertFileSourceReadyMock.mockReset().mockResolvedValue({ id: 's1', title: 'doc.pdf' })
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/file', () => {
  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(postReq(pdfFile()), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when no file is provided', async () => {
    const res = await POST(postReq(), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return 400 when the upload is rejected as invalid', async () => {
    uploadClientKnowledgeFileMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'File must be 10MB or smaller'))
    const res = await POST(postReq(pdfFile()), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should upload, extract, embed, insert the ready source, and log on success', async () => {
    const res = await POST(postReq(pdfFile()), ctx('c1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, source: { id: 's1', title: 'doc.pdf' } })
    expect(insertFileSourceReadyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', title: 'doc.pdf', storagePath: 'c1/x.pdf', content: 'Extracted text', charCount: 14,
      sourceType: 'pdf',
    }))
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', sourceId: 's1', content: 'Extracted text',
    }))
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'knowledge.file_uploaded' }))
  })

  it('should record source_type file when the upload is markdown', async () => {
    const res = await POST(postReq(mdFile()), ctx('c1'))
    expect(res.status).toBe(200)
    expect(insertFileSourceReadyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      sourceType: 'file',
    }))
  })

  it('should reject a client user uploading to another client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c2' } })
    const res = await POST(postReq(pdfFile()), ctx('c1'))
    expect(res.status).toBe(403)
    expect(uploadClientKnowledgeFileMock).not.toHaveBeenCalled()
  })

  it('should accept a client user uploading to their own client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const res = await POST(postReq(pdfFile()), ctx('c1'))
    expect(res.status).toBe(200)
  })

  it('should reject an image, which is a resource not knowledge', async () => {
    assertValidKnowledgeFileMock.mockImplementation(() => {
      throw new AppError('VALIDATION_ERROR', 'File must be a PDF, .txt or .md')
    })
    const res = await POST(postReq(pngFile()), ctx('c1'))
    expect(res.status).toBe(400)
  })
})
