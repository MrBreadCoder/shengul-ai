import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const discoverSitemapPagesMock = vi.fn()
vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/knowledge/sitemap', () => ({ discoverSitemapPages: (...a: unknown[]) => discoverSitemapPagesMock(...a) }))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: {} }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  discoverSitemapPagesMock.mockReset()
})

describe('POST /api/clients/[clientId]/knowledge/discover-sitemap', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ websiteUrl: 'https://acme.com' }))
    expect(res.status).toBe(403)
    expect(discoverSitemapPagesMock).not.toHaveBeenCalled()
  })

  it('should return 400 for an invalid url', async () => {
    const res = await POST(req({ websiteUrl: 'not-a-url' }))
    expect(res.status).toBe(400)
  })

  it('should return the discovered urls on success', async () => {
    discoverSitemapPagesMock.mockResolvedValue(['https://acme.com/', 'https://acme.com/pricing'])
    const res = await POST(req({ websiteUrl: 'https://acme.com' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, urls: ['https://acme.com/', 'https://acme.com/pricing'] })
  })

  it('should return 400 when discovery finds nothing', async () => {
    discoverSitemapPagesMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'Could not discover any pages for this site'))
    const res = await POST(req({ websiteUrl: 'https://acme.com' }))
    expect(res.status).toBe(400)
  })
})
