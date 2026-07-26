import { describe, it, expect, vi, beforeEach } from 'vitest'

const exchangeMock = vi.fn()
const verifyOtpMock = vi.fn()
const getInviteLinkMock = vi.fn()
const getAuthUserEmailMock = vi.fn()
const mintSessionMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({
    auth: {
      exchangeCodeForSession: (...a: unknown[]) => exchangeMock(...a),
      verifyOtp: (...a: unknown[]) => verifyOtpMock(...a),
    },
  }),
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({ tag: 'admin' }) }))
vi.mock('@/lib/db/invite-links', () => ({
  getInviteLinkByTokenHash: (...a: unknown[]) => getInviteLinkMock(...a),
}))
vi.mock('@/lib/supabase/auth-admin', () => ({
  getAuthUserEmail: (...a: unknown[]) => getAuthUserEmailMock(...a),
}))
vi.mock('@/lib/auth/mint-session', () => ({
  mintSessionForEmail: (...a: unknown[]) => mintSessionMock(...a),
}))

import { GET } from './route'
import { hashInviteToken } from '@/lib/auth/invite-token'

const TOKEN = 'a-raw-invite-token'
const USER_ID = '22222222-2222-4222-8222-222222222222'
const EMAIL = 'invited@acme.com'

function futureLink() {
  return {
    token_hash: hashInviteToken(TOKEN),
    user_id: USER_ID,
    client_id: 'c1',
    created_by: 'op1',
    expires_at: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    created_at: new Date().toISOString(),
  }
}

beforeEach(() => {
  exchangeMock.mockReset()
  verifyOtpMock.mockReset()
  getInviteLinkMock.mockReset().mockResolvedValue(futureLink())
  getAuthUserEmailMock.mockReset().mockResolvedValue(EMAIL)
  mintSessionMock.mockReset().mockResolvedValue(undefined)
})

describe('GET /auth/callback', () => {
  it('should redirect to /login when no credential is present', async () => {
    const res = await GET(new Request('http://localhost:3000/auth/callback'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login')
  })

  describe('invite token', () => {
    it('should mint a session and land on the next path', async () => {
      const res = await GET(
        new Request(`http://localhost:3000/auth/callback?token=${TOKEN}&next=/set-password`),
      )
      expect(getInviteLinkMock).toHaveBeenCalledWith({ tag: 'admin' }, hashInviteToken(TOKEN))
      expect(mintSessionMock).toHaveBeenCalledWith({ tag: 'admin' }, expect.anything(), EMAIL)
      expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
    })

    it('should never put the raw token in the database lookup', async () => {
      await GET(new Request(`http://localhost:3000/auth/callback?token=${TOKEN}`))
      const [, lookedUp] = getInviteLinkMock.mock.calls[0] as [unknown, string]
      expect(lookedUp).not.toBe(TOKEN)
      expect(lookedUp).toMatch(/^[0-9a-f]{64}$/)
    })

    it('should stay usable on a second open within the window', async () => {
      const url = `http://localhost:3000/auth/callback?token=${TOKEN}`
      const first = await GET(new Request(url))
      const second = await GET(new Request(url))
      expect(first.headers.get('location')).toBe('http://localhost:3000/set-password')
      expect(second.headers.get('location')).toBe('http://localhost:3000/set-password')
      expect(mintSessionMock).toHaveBeenCalledTimes(2)
    })

    it('should send an expired token to the expired page, not to /login', async () => {
      getInviteLinkMock.mockResolvedValue({
        ...futureLink(),
        expires_at: new Date(Date.now() - 1000).toISOString(),
      })
      const res = await GET(new Request(`http://localhost:3000/auth/callback?token=${TOKEN}`))
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/invite-expired?reason=expired')
      expect(mintSessionMock).not.toHaveBeenCalled()
    })

    it('should distinguish an unknown token from an expired one', async () => {
      getInviteLinkMock.mockResolvedValue(null)
      const res = await GET(new Request('http://localhost:3000/auth/callback?token=never-issued'))
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/invite-expired?reason=invalid')
      expect(mintSessionMock).not.toHaveBeenCalled()
    })

    it('should not sign anyone in when the linked auth user is gone', async () => {
      getAuthUserEmailMock.mockResolvedValue(null)
      const res = await GET(new Request(`http://localhost:3000/auth/callback?token=${TOKEN}`))
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/invite-expired?reason=invalid')
      expect(mintSessionMock).not.toHaveBeenCalled()
    })

    it('should send the visitor somewhere actionable when minting fails', async () => {
      mintSessionMock.mockRejectedValue(new Error('supabase down'))
      const res = await GET(new Request(`http://localhost:3000/auth/callback?token=${TOKEN}`))
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/invite-expired?reason=expired')
    })

    it('should refuse an absolute next (open redirect)', async () => {
      const res = await GET(
        new Request(`http://localhost:3000/auth/callback?token=${TOKEN}&next=https://evil.com`),
      )
      expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
    })

    it('should refuse a protocol-relative next (open redirect)', async () => {
      const res = await GET(
        new Request(`http://localhost:3000/auth/callback?token=${TOKEN}&next=//evil.com`),
      )
      expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
    })
  })

  describe('supabase-native otp and pkce', () => {
    it('should verify a token_hash and land on the next path', async () => {
      verifyOtpMock.mockResolvedValue({ error: null })
      const res = await GET(
        new Request('http://localhost:3000/auth/callback?token_hash=tok&type=recovery&next=/crm'),
      )
      expect(verifyOtpMock).toHaveBeenCalledWith({ type: 'recovery', token_hash: 'tok' })
      expect(res.headers.get('location')).toBe('http://localhost:3000/crm')
    })

    it('should reject an unknown otp type rather than forwarding it to the auth server', async () => {
      const res = await GET(new Request('http://localhost:3000/auth/callback?token_hash=tok&type=bogus'))
      expect(verifyOtpMock).not.toHaveBeenCalled()
      expect(res.headers.get('location')).toBe('http://localhost:3000/login')
    })

    it('should exchange a pkce code', async () => {
      exchangeMock.mockResolvedValue({ error: null })
      const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc'))
      expect(exchangeMock).toHaveBeenCalledWith('abc')
      expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
    })

    it('should send a failed exchange to the expired page', async () => {
      exchangeMock.mockResolvedValue({ error: { message: 'bad code' } })
      const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc'))
      expect(res.headers.get('location')).toBe('http://localhost:3000/auth/invite-expired?reason=expired')
    })

    it('should prefer our invite token over a supabase one when both are present', async () => {
      await GET(new Request(`http://localhost:3000/auth/callback?token=${TOKEN}&token_hash=tok&type=invite`))
      expect(mintSessionMock).toHaveBeenCalled()
      expect(verifyOtpMock).not.toHaveBeenCalled()
    })
  })
})
