import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getSourceByIdMock = vi.fn()
const deleteSourceMock = vi.fn()
const deleteClientKnowledgePdfObjectMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  deleteSource: (...a: unknown[]) => deleteSourceMock(...a),
}))
vi.mock('@/lib/storage/client-knowledge-pdfs', () => ({
  deleteClientKnowledgePdfObject: (...a: unknown[]) => deleteClientKnowledgePdfObjectMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { DELETE } from './route'

function ctx(clientId: string, sourceId: string) {
  return { params: Promise.resolve({ clientId, sourceId }) }
}
function req(): Request {
  return new Request('http://x', { method: 'DELETE' })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getSourceByIdMock.mockReset()
  deleteSourceMock.mockReset()
  deleteClientKnowledgePdfObjectMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/clients/[clientId]/knowledge/[sourceId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the source does not exist', async () => {
    getSourceByIdMock.mockResolvedValue(null)
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(404)
  })

  it('should return 404 when the source belongs to a different client', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'other-client' })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(404)
  })

  it('should delete a website_page source without touching storage', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'website_page', storage_path: null })
    deleteSourceMock.mockResolvedValue({ id: 's1' })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(200)
    expect(deleteClientKnowledgePdfObjectMock).not.toHaveBeenCalled()
  })

  it('should delete a pdf source and its storage object', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'pdf', storage_path: 'c1/x.pdf' })
    deleteSourceMock.mockResolvedValue({ id: 's1' })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(200)
    expect(deleteClientKnowledgePdfObjectMock).toHaveBeenCalledWith(expect.anything(), 'c1/x.pdf')
  })
})
