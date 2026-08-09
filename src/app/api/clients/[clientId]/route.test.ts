import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientNameMock = vi.fn()
const updateClientDomainMock = vi.fn()
const updateClientSignatureMock = vi.fn()
const updateClientCompanyInfoMock = vi.fn()
const updateClientEmailStyleMock = vi.fn()
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
  updateClientSignature: (...a: unknown[]) => updateClientSignatureMock(...a),
  updateClientCompanyInfo: (...a: unknown[]) => updateClientCompanyInfoMock(...a),
  updateClientEmailStyle: (...a: unknown[]) => updateClientEmailStyleMock(...a),
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
  updateClientSignatureMock.mockReset()
  updateClientCompanyInfoMock.mockReset()
  updateClientEmailStyleMock.mockReset()
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

  it('should save phone/address/signature name/title together and log the event', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: null, address: null, signature_name: null, signature_title: null,
    })
    updateClientSignatureMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: '123 Main St',
      signature_name: 'John Smith', signature_title: 'Sales Director',
    })
    const res = await PATCH(
      req({ phone: '+1 555 123 4567', address: '123 Main St', signatureName: 'John Smith', signatureTitle: 'Sales Director' }),
      ctx('c1'),
    )
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.phone).toBe('+1 555 123 4567')
    expect(updateClientSignatureMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      phone: '+1 555 123 4567', address: '123 Main St', signatureName: 'John Smith', signatureTitle: 'Sales Director',
    })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.signature_changed' }))
  })

  it('should keep the existing phone when only address is sent', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: null, signature_name: null, signature_title: null,
    })
    updateClientSignatureMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: '123 Main St', signature_name: null, signature_title: null,
    })
    await PATCH(req({ address: '123 Main St' }), ctx('c1'))
    expect(updateClientSignatureMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      phone: '+1 555 123 4567', address: '123 Main St', signatureName: null, signatureTitle: null,
    })
  })

  it('should clear signature fields when sent empty', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: '123 Main St', signature_name: 'John', signature_title: 'CEO',
    })
    updateClientSignatureMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: null, address: null, signature_name: null, signature_title: null,
    })
    const res = await PATCH(req({ phone: '', address: '', signatureName: '', signatureTitle: '' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(updateClientSignatureMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      phone: null, address: null, signatureName: null, signatureTitle: null,
    })
  })

  it('should return 400 for an invalid phone', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', phone: null })
    const res = await PATCH(req({ phone: 'call me maybe' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientSignatureMock).not.toHaveBeenCalled()
  })

  it('should save the company info and log the event', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: null })
    updateClientCompanyInfoMock.mockResolvedValue({
      id: 'c1', name: 'Acme', company_info: 'Acme builds inventory software for retailers.',
    })
    const res = await PATCH(req({ companyInfo: 'Acme builds inventory software for retailers.' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.company_info).toBe('Acme builds inventory software for retailers.')
    expect(updateClientCompanyInfoMock).toHaveBeenCalledWith(
      expect.anything(), 'c1', 'Acme builds inventory software for retailers.',
    )
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.company_info_changed' }))
  })

  it('should clear the company info when sent empty', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: 'Old text' })
    updateClientCompanyInfoMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: null })
    const res = await PATCH(req({ companyInfo: '' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(updateClientCompanyInfoMock).toHaveBeenCalledWith(expect.anything(), 'c1', null)
  })

  it('should return 400 when the company info exceeds the length cap', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: null })
    const res = await PATCH(req({ companyInfo: 'x'.repeat(4001) }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientCompanyInfoMock).not.toHaveBeenCalled()
  })

  const STYLE_ID = '22222222-2222-4222-a222-222222222222'

  it('should save the email style id and log the event on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style_id: null })
    updateClientEmailStyleMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style_id: STYLE_ID })
    const res = await PATCH(req({ emailStyleId: STYLE_ID }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.email_style_id).toBe(STYLE_ID)
    expect(updateClientEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 'c1', STYLE_ID)
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.email_style_changed' }))
  })

  it('should allow clearing the email style id back to null (use the default style)', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style_id: STYLE_ID })
    updateClientEmailStyleMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style_id: null })
    const res = await PATCH(req({ emailStyleId: null }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(updateClientEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 'c1', null)
  })

  it('should return 400 for a non-uuid email style id', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style_id: null })
    const res = await PATCH(req({ emailStyleId: 'not-a-uuid' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientEmailStyleMock).not.toHaveBeenCalled()
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
