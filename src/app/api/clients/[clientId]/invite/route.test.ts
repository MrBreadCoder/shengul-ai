import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const insertAppUserMock = vi.fn()
const logEventMock = vi.fn()
const createUserMock = vi.fn()
const deleteUserMock = vi.fn()
const insertInviteLinkMock = vi.fn()
const deleteInviteLinksForUserMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { createUser: (...a: unknown[]) => createUserMock(...a), deleteUser: (...a: unknown[]) => deleteUserMock(...a) } },
  }),
}))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  insertAppUser: (...a: unknown[]) => insertAppUserMock(...a),
}))
vi.mock('@/lib/db/invite-links', () => ({
  insertInviteLink: (...a: unknown[]) => insertInviteLinkMock(...a),
  deleteInviteLinksForUser: (...a: unknown[]) => deleteInviteLinksForUserMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'https://app.example.com' } }))

import { POST } from './route'
import { hashInviteToken } from '@/lib/auth/invite-token'
import { INVITE_TTL_MINUTES } from '@/lib/auth/invite-ttl'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}
function linkFrom(json: { link: string }): URL {
  return new URL(json.link)
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1', name: 'Acme' })
  insertAppUserMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
  createUserMock.mockReset().mockResolvedValue({ data: { user: { id: 'newuser1' } }, error: null })
  deleteUserMock.mockReset().mockResolvedValue({ error: null })
  insertInviteLinkMock.mockReset().mockResolvedValue(undefined)
  deleteInviteLinksForUserMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/invite', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(createUserMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(req({ email: 'a@x.com' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 on validation error', async () => {
    const res = await POST(req({ email: 'not-an-email' }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return 409 when the email is already registered', async () => {
    createUserMock.mockResolvedValue({ data: null, error: { message: 'Email already registered', code: 'email_exists' } })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(409)
  })

  it('should clean up the auth user if the app_users insert fails', async () => {
    insertAppUserMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(500)
    expect(deleteUserMock).toHaveBeenCalledWith('newuser1')
  })

  it('should clean up the auth user if the invite link cannot be stored', async () => {
    insertInviteLinkMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(500)
    // Otherwise the address is consumed by an account with no way to reach it,
    // and the operator cannot even retry with the same email.
    expect(deleteUserMock).toHaveBeenCalledWith('newuser1')
  })

  it('should return a first-party link carrying a raw token', async () => {
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    const json = await res.json()
    const url = linkFrom(json)
    expect(res.status).toBe(200)
    expect(url.origin).toBe('https://app.example.com')
    expect(url.pathname).toBe('/auth/callback')
    expect(url.searchParams.get('next')).toBe('/set-password')
    expect(url.searchParams.get('token')).toBeTruthy()
    expect(json.expiresInMinutes).toBe(INVITE_TTL_MINUTES)
  })

  it('should store only the hash of the token, never the token itself', async () => {
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    const token = linkFrom(await res.json()).searchParams.get('token') ?? ''
    const [, row] = insertInviteLinkMock.mock.calls[0] as [unknown, { token_hash: string }]
    expect(row.token_hash).toBe(hashInviteToken(token))
    expect(row.token_hash).not.toBe(token)
  })

  it('should record the owner, issuer and an expiry in the future', async () => {
    await POST(req({ email: 'a@x.com' }), ctx('c1'))
    const [, row] = insertInviteLinkMock.mock.calls[0] as [
      unknown,
      { user_id: string; client_id: string; created_by: string; expires_at: string },
    ]
    expect(row.user_id).toBe('newuser1')
    expect(row.client_id).toBe('c1')
    expect(row.created_by).toBe('op1')
    expect(new Date(row.expires_at).getTime()).toBeGreaterThan(Date.now())
  })

  it('should drop any earlier link for the user before issuing a new one', async () => {
    await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(deleteInviteLinksForUserMock).toHaveBeenCalledWith(expect.anything(), 'newuser1')
    const [dropOrder] = deleteInviteLinksForUserMock.mock.invocationCallOrder
    const [insertOrder] = insertInviteLinkMock.mock.invocationCallOrder
    expect(dropOrder).toBeDefined()
    expect(insertOrder).toBeDefined()
    expect(dropOrder).toBeLessThan(insertOrder ?? 0)
  })

  it('should issue a different token each time', async () => {
    const first = linkFrom(await (await POST(req({ email: 'a@x.com' }), ctx('c1'))).json())
    const second = linkFrom(await (await POST(req({ email: 'b@x.com' }), ctx('c1'))).json())
    expect(first.searchParams.get('token')).not.toBe(second.searchParams.get('token'))
  })

  it('should link the app_user to the client and audit the invite', async () => {
    await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(insertAppUserMock).toHaveBeenCalledWith(expect.anything(), {
      id: 'newuser1',
      role: 'client',
      client_id: 'c1',
    })
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.user_invited' }),
    )
  })

  it('should still return the link when audit logging fails', async () => {
    logEventMock.mockRejectedValue(new Error('events down'))
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(200)
  })
})
