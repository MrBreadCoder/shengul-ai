import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const getResourceByIdMock = vi.fn()
const resetResourceContentToPendingMock = vi.fn()
const markResourceContentFailedMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-resources', () => ({
  getResourceById: (...a: unknown[]) => getResourceByIdMock(...a),
}))
vi.mock('@/lib/db/resource-content', () => ({
  resetResourceContentToPending: (...a: unknown[]) => resetResourceContentToPendingMock(...a),
  markResourceContentFailed: (...a: unknown[]) => markResourceContentFailedMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: vi.fn().mockResolvedValue(undefined),
}))

import { POST } from './route'

const params = { params: Promise.resolve({ clientId: 'c1', resourceId: 'r1' }) }
const request = () => new Request('http://x/api/clients/c1/resources/r1/read', { method: 'POST' })

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  getResourceByIdMock.mockReset().mockResolvedValue({
    id: 'r1', client_id: 'c1', created_by: 'u1', is_active: true, title: 'Deck',
    content_status: 'failed',
  })
  resetResourceContentToPendingMock.mockReset().mockResolvedValue(undefined)
  markResourceContentFailedMock.mockReset().mockResolvedValue(undefined)
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/resources/[resourceId]/read', () => {
  it('should reset the row and enqueue the job when an operator asks for a re-read', async () => {
    const res = await POST(request(), params)

    expect(res.status).toBe(200)
    expect(resetResourceContentToPendingMock).toHaveBeenCalledWith(expect.anything(), 'r1')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/resource-read', { resourceId: 'r1' })
  })

  it('should allow the client user who uploaded the resource', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const res = await POST(request(), params)
    expect(res.status).toBe(200)
  })

  it('should reject a client user who did not upload it', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    const res = await POST(request(), params)
    expect(res.status).toBe(403)
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should re-read a resource whose format was unsupported', async () => {
    getResourceByIdMock.mockResolvedValue({
      id: 'r1', client_id: 'c1', created_by: 'u1', is_active: true, title: 'Deck',
      content_status: 'unsupported',
    })
    const res = await POST(request(), params)
    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalled()
  })

  it('should refuse a second read while one is already queued', async () => {
    getResourceByIdMock.mockResolvedValue({
      id: 'r1', client_id: 'c1', created_by: 'u1', is_active: true, title: 'Deck',
      content_status: 'pending',
    })

    const res = await POST(request(), params)

    expect(res.status).toBe(409)
    expect(resetResourceContentToPendingMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the resource belongs to another client', async () => {
    getResourceByIdMock.mockResolvedValue({
      id: 'r1', client_id: 'c2', created_by: 'u1', is_active: true, title: 'Deck',
      content_status: 'failed',
    })
    const res = await POST(request(), params)
    expect(res.status).toBe(404)
  })

  it('should return 404 when the resource does not exist', async () => {
    getResourceByIdMock.mockResolvedValue(null)
    const res = await POST(request(), params)
    expect(res.status).toBe(404)
  })

  it('should return 404 for a resource that has been removed', async () => {
    getResourceByIdMock.mockResolvedValue({
      id: 'r1', client_id: 'c1', created_by: 'u1', is_active: false, title: 'Deck',
    })
    const res = await POST(request(), params)
    expect(res.status).toBe(404)
    expect(resetResourceContentToPendingMock).not.toHaveBeenCalled()
  })

  it('should mark the row failed and return 500 when the job cannot be queued', async () => {
    publishJsonMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'QStash publish failed'))

    const res = await POST(request(), params)

    expect(res.status).toBe(500)
    expect(markResourceContentFailedMock).toHaveBeenCalledWith(
      expect.anything(), 'r1', 'Could not start reading this file',
    )
  })
})
