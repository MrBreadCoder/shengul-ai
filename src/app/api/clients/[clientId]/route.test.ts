import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientNameMock = vi.fn()
const updateClientDomainMock = vi.fn()
const deleteClientCascadeMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const deleteAuthUsersMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientName: (...a: unknown[]) => updateClientNameMock(...a),
  updateClientDomain: (...a: unknown[]) => updateClientDomainMock(...a),
  deleteClientCascade: (...a: unknown[]) => deleteClientCascadeMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/supabase/auth-admin', () => ({ deleteAuthUsers: (...a: unknown[]) => deleteAuthUsersMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
}))

import { PATCH, DELETE } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function deleteReq(body: unknown) {
  return new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientNameMock.mockReset()
  updateClientDomainMock.mockReset()
  deleteClientCascadeMock.mockReset()
  listClientRoleAppUsersMock.mockReset()
  deleteAuthUsersMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/clients/[clientId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(req({ name: 'New Name' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await PATCH(req({ name: 'New Name' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 on validation error', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Old' })
    const res = await PATCH(req({ name: '' }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should rename and log the event on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Old' })
    updateClientNameMock.mockResolvedValue({ id: 'c1', name: 'New Name' })
    const res = await PATCH(req({ name: 'New Name' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'New Name' } })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.renamed' }))
  })

  it('should normalize and save the domain on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', domain: null })
    updateClientDomainMock.mockResolvedValue({ id: 'c1', name: 'Acme', domain: 'acme.com' })
    const res = await PATCH(req({ domain: 'https://www.acme.com/pricing' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'Acme', domain: 'acme.com' } })
    expect(updateClientDomainMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'acme.com')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.domain_changed' }))
  })

  it('should clear the domain when sent empty', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', domain: 'acme.com' })
    updateClientDomainMock.mockResolvedValue({ id: 'c1', name: 'Acme', domain: null })
    const res = await PATCH(req({ domain: '' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(updateClientDomainMock).toHaveBeenCalledWith(expect.anything(), 'c1', null)
  })

  it('should return 400 for a domain that fails validation', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', domain: null })
    const res = await PATCH(req({ domain: 'not a domain' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientDomainMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/clients/[clientId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(deleteReq({ confirmName: 'Acme' }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await DELETE(deleteReq({ confirmName: 'Acme' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the confirmation name does not match', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    const res = await DELETE(deleteReq({ confirmName: 'wrong' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(deleteClientCascadeMock).not.toHaveBeenCalled()
  })

  it('should delete the client and its auth users when the name matches', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    listClientRoleAppUsersMock.mockResolvedValue([{ id: 'u1', client_id: 'c1' }, { id: 'u2', client_id: 'other' }])
    deleteClientCascadeMock.mockResolvedValue(undefined)
    deleteAuthUsersMock.mockResolvedValue(undefined)
    const res = await DELETE(deleteReq({ confirmName: 'Acme' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteClientCascadeMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(deleteAuthUsersMock).toHaveBeenCalledWith(expect.anything(), ['u1'])
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.deleted' }))
  })
})
