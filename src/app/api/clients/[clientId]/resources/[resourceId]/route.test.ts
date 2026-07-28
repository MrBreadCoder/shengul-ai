import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getResourceByIdMock = vi.fn()
const deactivateClientResourceMock = vi.fn()
const deleteClientResourceObjectMock = vi.fn()
const logEventSafeMock = vi.fn()
const deleteResourceKnowledgeSourceMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-resources', () => ({
  getResourceById: (...a: unknown[]) => getResourceByIdMock(...a),
  deactivateClientResource: (...a: unknown[]) => deactivateClientResourceMock(...a),
}))
vi.mock('@/lib/storage/client-resources', () => ({
  deleteClientResourceObject: (...a: unknown[]) => deleteClientResourceObjectMock(...a),
}))
vi.mock('@/lib/db/resource-content', () => ({
  deleteResourceKnowledgeSource: (...a: unknown[]) => deleteResourceKnowledgeSourceMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: vi.fn().mockResolvedValue(undefined),
}))

import { DELETE } from './route'

const params = { params: Promise.resolve({ clientId: 'c1', resourceId: 'r1' }) }
const resource = { id: 'r1', client_id: 'c1', created_by: 'u1', storage_path: 'c1/x.pdf', title: 'Deck' }

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
  getResourceByIdMock.mockReset()
  deactivateClientResourceMock.mockReset()
  deleteClientResourceObjectMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
  deleteResourceKnowledgeSourceMock.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/clients/[clientId]/resources/[resourceId]', () => {
  it('should soft delete and log when an operator deletes', async () => {
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)

    const response = await DELETE(new Request('http://x'), params)

    expect(response.status).toBe(200)
    expect(deactivateClientResourceMock).toHaveBeenCalledWith(expect.anything(), 'r1')
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'resource.deleted' }),
    )
  })

  // Emails already sent still point at this object, and the row is retained to
  // record that. Deleting the bytes would leave that history unresolvable.
  it('should keep the storage object so already-sent emails still resolve', async () => {
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)

    await DELETE(new Request('http://x'), params)

    expect(deleteClientResourceObjectMock).not.toHaveBeenCalled()
  })

  it('should allow the client user who uploaded it', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(200)
  })

  it('should reject a client user who did not upload it', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u9', role: 'client', client_id: 'c1' } })
    getResourceByIdMock.mockResolvedValue(resource)
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(403)
    expect(deactivateClientResourceMock).not.toHaveBeenCalled()
  })

  it('should 404 when the resource belongs to another client', async () => {
    getResourceByIdMock.mockResolvedValue({ ...resource, client_id: 'c2' })
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(404)
  })

  it('should not log a second deletion when the row was already deactivated', async () => {
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(null)
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(200)
    expect(logEventSafeMock).not.toHaveBeenCalled()
  })

  it('should delete the derived knowledge source so the agent stops answering from it', async () => {
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)

    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params)

    expect(res.status).toBe(200)
    expect(deleteResourceKnowledgeSourceMock).toHaveBeenCalledWith(expect.anything(), 'r1')
  })

  // A retry after a cleanup failure finds the row already inactive. Skipping the
  // cleanup on that path would strand the chunks for good, leaving the agent
  // answering out of a file nobody can attach any more.
  it('should still clear the knowledge source when the row was already deactivated', async () => {
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(null)

    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params)

    expect(res.status).toBe(200)
    expect(deleteResourceKnowledgeSourceMock).toHaveBeenCalledWith(expect.anything(), 'r1')
    expect(logEventSafeMock).not.toHaveBeenCalled()
  })

  it('should 500 so the caller can retry when the knowledge cleanup fails', async () => {
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)
    deleteResourceKnowledgeSourceMock.mockRejectedValue(new Error('boom'))

    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), params)

    expect(res.status).toBe(500)
  })
})
