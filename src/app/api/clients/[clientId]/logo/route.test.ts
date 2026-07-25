import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientLogoUrlMock = vi.fn()
const uploadClientLogoMock = vi.fn()
const deleteClientLogoObjectMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientLogoUrl: (...a: unknown[]) => updateClientLogoUrlMock(...a),
}))
vi.mock('@/lib/storage/logos', () => ({
  uploadClientLogo: (...a: unknown[]) => uploadClientLogoMock(...a),
  deleteClientLogoObject: (...a: unknown[]) => deleteClientLogoObjectMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST, DELETE } from './route'

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
  updateClientLogoUrlMock.mockReset()
  uploadClientLogoMock.mockReset()
  deleteClientLogoObjectMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/logo', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(postReq(new File(['x'], 'logo.png', { type: 'image/png' })), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(postReq(new File(['x'], 'logo.png', { type: 'image/png' })), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when no file is provided', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', logo_url: null })
    const res = await POST(postReq(), ctx('c1'))
    expect(res.status).toBe(400)
    expect(uploadClientLogoMock).not.toHaveBeenCalled()
  })

  it('should return 400 when the upload is rejected as invalid', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', logo_url: null })
    uploadClientLogoMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'Logo must be 2MB or smaller'))
    const res = await POST(postReq(new File(['x'], 'logo.png', { type: 'image/png' })), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should upload, save the url, clean up the old object, and log on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', logo_url: 'https://x.test/old.png' })
    uploadClientLogoMock.mockResolvedValue('https://x.test/new.png')
    updateClientLogoUrlMock.mockResolvedValue({ id: 'c1', logo_url: 'https://x.test/new.png' })

    const res = await POST(postReq(new File(['x'], 'logo.png', { type: 'image/png' })), ctx('c1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', logo_url: 'https://x.test/new.png' } })
    expect(updateClientLogoUrlMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'https://x.test/new.png')
    expect(deleteClientLogoObjectMock).toHaveBeenCalledWith(expect.anything(), 'https://x.test/old.png')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.logo_uploaded' }))
  })

  it('should not attempt cleanup when there was no previous logo', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', logo_url: null })
    uploadClientLogoMock.mockResolvedValue('https://x.test/new.png')
    updateClientLogoUrlMock.mockResolvedValue({ id: 'c1', logo_url: 'https://x.test/new.png' })

    await POST(postReq(new File(['x'], 'logo.png', { type: 'image/png' })), ctx('c1'))
    expect(deleteClientLogoObjectMock).not.toHaveBeenCalled()
  })
})

describe('DELETE /api/clients/[clientId]/logo', () => {
  function deleteReq(): Request {
    return new Request('http://x', { method: 'DELETE' })
  }

  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(deleteReq(), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await DELETE(deleteReq(), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should no-op when the client has no logo set', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', logo_url: null })
    const res = await DELETE(deleteReq(), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', logo_url: null } })
    expect(updateClientLogoUrlMock).not.toHaveBeenCalled()
  })

  it('should clear the logo, delete the object, and log on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', logo_url: 'https://x.test/old.png' })
    updateClientLogoUrlMock.mockResolvedValue({ id: 'c1', logo_url: null })

    const res = await DELETE(deleteReq(), ctx('c1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', logo_url: null } })
    expect(updateClientLogoUrlMock).toHaveBeenCalledWith(expect.anything(), 'c1', null)
    expect(deleteClientLogoObjectMock).toHaveBeenCalledWith(expect.anything(), 'https://x.test/old.png')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.logo_removed' }))
  })
})
