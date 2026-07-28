import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const uploadClientResourceMock = vi.fn()
const deleteClientResourceObjectMock = vi.fn()
const insertClientResourceMock = vi.fn()
const logEventSafeMock = vi.fn()
const publishJsonMock = vi.fn()
const markResourceContentFailedMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/storage/client-resources', () => ({
  uploadClientResource: (...a: unknown[]) => uploadClientResourceMock(...a),
  deleteClientResourceObject: (...a: unknown[]) => deleteClientResourceObjectMock(...a),
}))
vi.mock('@/lib/db/client-resources', () => ({
  insertClientResource: (...a: unknown[]) => insertClientResourceMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/db/resource-content', () => ({
  markResourceContentFailed: (...a: unknown[]) => markResourceContentFailedMock(...a),
}))

import { POST } from './route'

function formRequest(fields: Record<string, string | File>): Request {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return new Request('http://x/api/clients/c1/resources', { method: 'POST', body })
}

const pdf = () => new File([new Uint8Array(10)], 'deck.pdf', { type: 'application/pdf' })
const params = { params: Promise.resolve({ clientId: 'c1' }) }

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1', name: 'Acme' })
  uploadClientResourceMock.mockReset().mockResolvedValue({ storagePath: 'c1/x.pdf', fileName: 'deck.pdf' })
  insertClientResourceMock.mockReset().mockResolvedValue({ id: 'r1', title: 'Deck', byte_size: 10 })
  deleteClientResourceObjectMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  markResourceContentFailedMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/resources', () => {
  it('should create the resource when an operator uploads', async () => {
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(200)
    expect(insertClientResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'c1', createdBy: 'op1', title: 'Deck', description: 'examples' }),
    )
  })

  it('should create the resource when a client uploads to their own client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(200)
  })

  it('should reject a client uploading to another client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c2' } })
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(403)
    expect(uploadClientResourceMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(404)
  })

  it('should accept an upload with no description at all', async () => {
    const response = await POST(formRequest({ title: 'Deck', file: pdf() }), params)
    expect(response.status).toBe(200)
    expect(insertClientResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ title: 'Deck', description: null }),
    )
  })

  it('should store a blank description as null rather than an empty string', async () => {
    const response = await POST(formRequest({ title: 'Deck', description: '   ', file: pdf() }), params)
    expect(response.status).toBe(200)
    expect(insertClientResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ description: null }),
    )
  })

  it('should return 400 when the title is missing', async () => {
    const response = await POST(formRequest({ description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(400)
  })

  it('should enqueue the read job for the new resource', async () => {
    await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/resource-read', { resourceId: 'r1' })
  })

  it('should keep the upload and mark the row failed when the read job cannot be queued', async () => {
    publishJsonMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'QStash publish failed'))

    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)

    expect(response.status).toBe(200)
    expect(markResourceContentFailedMock).toHaveBeenCalledWith(
      expect.anything(), 'r1', 'Could not start reading this file',
    )
    expect(deleteClientResourceObjectMock).not.toHaveBeenCalled()
  })

  it('should return 400 when no file was sent', async () => {
    const response = await POST(formRequest({ title: 'Deck', description: 'examples' }), params)
    expect(response.status).toBe(400)
  })

  it('should return 400 when the file type is not allowed', async () => {
    uploadClientResourceMock.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'Unsupported file type', { contentType: 'application/x-msdownload' }),
    )
    const response = await POST(
      formRequest({
        title: 'x',
        description: 'y',
        file: new File([new Uint8Array(1)], 'a.exe', { type: 'application/x-msdownload' }),
      }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('should remove the uploaded object when the row insert fails', async () => {
    insertClientResourceMock.mockRejectedValue(new AppError('DB_ERROR', 'boom', {}))
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(500)
    expect(deleteClientResourceObjectMock).toHaveBeenCalledWith(expect.anything(), 'c1/x.pdf')
  })
})
