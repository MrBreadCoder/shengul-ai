import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const uploadClientKnowledgePdfMock = vi.fn()
const extractPdfTextMock = vi.fn()
const insertPdfSourceReadyMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/storage/client-knowledge-pdfs', () => ({
  uploadClientKnowledgePdf: (...a: unknown[]) => uploadClientKnowledgePdfMock(...a),
}))
vi.mock('@/lib/knowledge/pdf-extract', () => ({ extractPdfText: (...a: unknown[]) => extractPdfTextMock(...a) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  insertPdfSourceReady: (...a: unknown[]) => insertPdfSourceReadyMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function postReq(file?: File): Request {
  const formData = new FormData()
  if (file) formData.set('file', file)
  return new Request('http://x', { method: 'POST', body: formData })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  uploadClientKnowledgePdfMock.mockReset()
  extractPdfTextMock.mockReset()
  insertPdfSourceReadyMock.mockReset()
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/pdf', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when no file is provided', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    const res = await POST(postReq(), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return 400 when the upload is rejected as invalid', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    uploadClientKnowledgePdfMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'PDF must be 10MB or smaller'))
    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should upload, extract, embed, insert the ready source, and log on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    uploadClientKnowledgePdfMock.mockResolvedValue('c1/x.pdf')
    extractPdfTextMock.mockResolvedValue('Extracted PDF text')
    insertPdfSourceReadyMock.mockResolvedValue({ id: 's1', title: 'doc.pdf' })

    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('c1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, source: { id: 's1', title: 'doc.pdf' } })
    expect(insertPdfSourceReadyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', title: 'doc.pdf', storagePath: 'c1/x.pdf', content: 'Extracted PDF text', charCount: 18,
    }))
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', sourceId: 's1', content: 'Extracted PDF text',
    }))
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'knowledge.pdf_uploaded' }))
  })
})
