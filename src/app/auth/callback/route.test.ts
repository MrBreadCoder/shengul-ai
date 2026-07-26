import { describe, it, expect, vi, beforeEach } from 'vitest'

const exchangeMock = vi.fn()
const verifyOtpMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({
    auth: {
      exchangeCodeForSession: (...a: unknown[]) => exchangeMock(...a),
      verifyOtp: (...a: unknown[]) => verifyOtpMock(...a),
    },
  }),
}))

import { GET } from './route'

beforeEach(() => { exchangeMock.mockReset(); verifyOtpMock.mockReset() })

describe('GET /auth/callback', () => {
  it('should redirect to /login when no code is present', async () => {
    const res = await GET(new Request('http://localhost:3000/auth/callback'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login')
    expect(exchangeMock).not.toHaveBeenCalled()
  })

  it('should redirect to /login?error=invite_expired when the exchange fails', async () => {
    exchangeMock.mockResolvedValue({ error: { message: 'expired' } })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=invite_expired')
  })

  it('should redirect to the default next path on success', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should redirect to a custom next path when provided', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc&next=/crm'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/crm')
  })

  it('should fall back to the default next path when next is an absolute URL (open redirect)', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc&next=https://evil.com'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should fall back to the default next path when next is protocol-relative (open redirect)', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc&next=//evil.com'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should fall back to the default next path when next has no leading slash', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc&next=crm'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should verify an invite token_hash and land on the next path', async () => {
    verifyOtpMock.mockResolvedValue({ error: null })
    const res = await GET(
      new Request('http://localhost:3000/auth/callback?token_hash=tok123&type=invite&next=/set-password'),
    )
    expect(verifyOtpMock).toHaveBeenCalledWith({ type: 'invite', token_hash: 'tok123' })
    expect(exchangeMock).not.toHaveBeenCalled()
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should redirect to /login?error=invite_expired when the token_hash is spent', async () => {
    verifyOtpMock.mockResolvedValue({ error: { message: 'Token has expired or is invalid' } })
    const res = await GET(new Request('http://localhost:3000/auth/callback?token_hash=tok123&type=invite'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=invite_expired')
  })

  it('should reject an unknown otp type rather than forwarding it to the auth server', async () => {
    const res = await GET(new Request('http://localhost:3000/auth/callback?token_hash=tok123&type=bogus'))
    expect(verifyOtpMock).not.toHaveBeenCalled()
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login')
  })

  it('should ignore a token_hash with no type and fall through to the code flow', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?token_hash=tok123&code=abc'))
    expect(verifyOtpMock).not.toHaveBeenCalled()
    expect(exchangeMock).toHaveBeenCalledWith('abc')
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should not let a token_hash flow follow an absolute next (open redirect)', async () => {
    verifyOtpMock.mockResolvedValue({ error: null })
    const res = await GET(
      new Request('http://localhost:3000/auth/callback?token_hash=tok123&type=invite&next=https://evil.com'),
    )
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })
})
