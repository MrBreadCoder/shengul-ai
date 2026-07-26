import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const getAppUserMock = vi.fn()
const deleteAppUserMock = vi.fn()
const getAuthUserEmailMock = vi.fn()
const deleteAuthUserMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  deleteAppUser: (...a: unknown[]) => deleteAppUserMock(...a),
}))
vi.mock('@/lib/db/app-users', () => ({ getAppUser: (...a: unknown[]) => getAppUserMock(...a) }))
vi.mock('@/lib/supabase/auth-admin', () => ({
  getAuthUserEmail: (...a: unknown[]) => getAuthUserEmailMock(...a),
  deleteAuthUser: (...a: unknown[]) => deleteAuthUserMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { DELETE } from './route'

const CLIENT_ID = '11111111-1111-4111-8111-111111111111'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const OTHER_CLIENT_ID = '33333333-3333-4333-8333-333333333333'
const EMAIL = 'ops@acme.com'

function req(body: unknown) {
  return new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) })
}
function ctx(clientId: string, userId: string) {
  return { params: Promise.resolve({ clientId, userId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset().mockResolvedValue({ id: CLIENT_ID, name: 'Acme' })
  getAppUserMock.mockReset().mockResolvedValue({ id: USER_ID, role: 'client', client_id: CLIENT_ID })
  deleteAppUserMock.mockReset().mockResolvedValue(undefined)
  getAuthUserEmailMock.mockReset().mockResolvedValue(EMAIL)
  deleteAuthUserMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/clients/[clientId]/users/[userId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(403)
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
    expect(deleteAppUserMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(404)
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the ids are not uuids', async () => {
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx('not-a-uuid', USER_ID))
    expect(res.status).toBe(404)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the app_user does not exist', async () => {
    getAppUserMock.mockResolvedValue(null)
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(404)
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
  })

  it('should refuse to delete a login belonging to a different client', async () => {
    getAppUserMock.mockResolvedValue({ id: USER_ID, role: 'client', client_id: OTHER_CLIENT_ID })
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'not_found' })
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
    expect(deleteAppUserMock).not.toHaveBeenCalled()
  })

  it('should refuse to delete an operator account through the client users route', async () => {
    getAppUserMock.mockResolvedValue({ id: USER_ID, role: 'operator', client_id: CLIENT_ID })
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(404)
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
    expect(deleteAppUserMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the auth user is already gone', async () => {
    getAuthUserEmailMock.mockResolvedValue(null)
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(404)
    expect(deleteAppUserMock).not.toHaveBeenCalled()
  })

  it('should return 400 when the typed email does not match the login', async () => {
    const res = await DELETE(req({ confirmEmail: 'someone@else.com' }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'email_mismatch' })
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
    expect(deleteAppUserMock).not.toHaveBeenCalled()
  })

  it('should return 400 when confirmEmail is missing', async () => {
    const res = await DELETE(req({}), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(400)
    expect((await res.json()).error).toBe('validation_error')
    expect(deleteAuthUserMock).not.toHaveBeenCalled()
  })

  it('should delete the auth user and the app_users row, and log the removal', async () => {
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
    expect(deleteAuthUserMock).toHaveBeenCalledWith({ tag: 'admin' }, USER_ID)
    expect(deleteAppUserMock).toHaveBeenCalledWith({ tag: 'admin' }, USER_ID)
    expect(logEventMock).toHaveBeenCalledWith({
      clientId: CLIENT_ID,
      actor: 'human:op1',
      type: 'client.user_removed',
      payload: { email: EMAIL },
    })
  })

  it('should delete the auth user before the app_users row so a failure stays retryable', async () => {
    const order: string[] = []
    deleteAuthUserMock.mockImplementation(async () => { order.push('auth') })
    deleteAppUserMock.mockImplementation(async () => { order.push('row') })
    await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(order).toEqual(['auth', 'row'])
  })

  it('should leave the app_users row in place when the auth deletion fails', async () => {
    deleteAuthUserMock.mockRejectedValue(new Error('supabase down'))
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(500)
    expect(deleteAppUserMock).not.toHaveBeenCalled()
    expect(logEventMock).not.toHaveBeenCalled()
  })

  it('should still succeed when audit logging fails', async () => {
    logEventMock.mockRejectedValue(new Error('events table down'))
    const res = await DELETE(req({ confirmEmail: EMAIL }), ctx(CLIENT_ID, USER_ID))
    expect(res.status).toBe(200)
    expect(deleteAppUserMock).toHaveBeenCalled()
  })
})
