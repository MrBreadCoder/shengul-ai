import { describe, it, expect, vi, beforeEach } from 'vitest'

const exchangeMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({ auth: { exchangeCodeForSession: (...a: unknown[]) => exchangeMock(...a) } }),
}))

import { GET } from './route'

beforeEach(() => { exchangeMock.mockReset() })

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
})
