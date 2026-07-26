import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const insertAppUserMock = vi.fn()
const logEventMock = vi.fn()
const generateLinkMock = vi.fn()
const deleteUserMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink: (...a: unknown[]) => generateLinkMock(...a), deleteUser: (...a: unknown[]) => deleteUserMock(...a) } },
  }),
}))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  insertAppUser: (...a: unknown[]) => insertAppUserMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'https://app.example.com' } }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  insertAppUserMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
  generateLinkMock.mockReset()
  deleteUserMock.mockReset()
})

describe('POST /api/clients/[clientId]/invite', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(req({ email: 'a@x.com' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 on validation error', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    const res = await POST(req({ email: 'not-an-email' }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return 409 when the email is already registered', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({ data: null, error: { message: 'Email already registered', code: 'email_exists' } })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(409)
  })

  it('should return 500 when the generated link carries no hashed token', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({
      data: { user: { id: 'newuser1' }, properties: { action_link: 'https://x/verify?token=abc' } },
      error: null,
    })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'invite_failed' })
    expect(insertAppUserMock).not.toHaveBeenCalled()
  })

  it('should clean up the auth user if the app_users insert fails', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({
      data: { user: { id: 'newuser1' }, properties: { hashed_token: 'tok123' } },
      error: null,
    })
    insertAppUserMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(500)
    expect(deleteUserMock).toHaveBeenCalledWith('newuser1')
  })

  it('should not send the caller the hosted verify link, which lands on the site root', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({
      data: {
        user: { id: 'newuser1' },
        properties: {
          hashed_token: 'tok123',
          action_link: 'https://ref.supabase.co/auth/v1/verify?token=tok123&type=invite&redirect_to=https://app.example.com',
        },
      },
      error: null,
    })
    insertAppUserMock.mockResolvedValue(undefined)
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    const json = await res.json()
    expect(json.link).not.toContain('/auth/v1/verify')
    expect(generateLinkMock).toHaveBeenCalledWith({ type: 'invite', email: 'a@x.com' })
  })

  it('should create the invite and return a first-party callback link on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({
      data: { user: { id: 'newuser1' }, properties: { hashed_token: 'tok123' } },
      error: null,
    })
    insertAppUserMock.mockResolvedValue(undefined)
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({
      ok: true,
      link: 'https://app.example.com/auth/callback?token_hash=tok123&type=invite&next=%2Fset-password',
      email: 'a@x.com',
    })
    expect(insertAppUserMock).toHaveBeenCalledWith(expect.anything(), { id: 'newuser1', role: 'client', client_id: 'c1' })
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.user_invited' }),
    )
  })
})
