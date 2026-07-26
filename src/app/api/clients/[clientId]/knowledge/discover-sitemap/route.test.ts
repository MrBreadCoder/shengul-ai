import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const discoverSitemapPagesMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/knowledge/sitemap', () => ({ discoverSitemapPages: (...a: unknown[]) => discoverSitemapPagesMock(...a) }))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: {} }))
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  discoverSitemapPagesMock.mockReset()
  logErrorMock.mockReset()
})

describe('POST /api/clients/[clientId]/knowledge/discover-sitemap', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ websiteUrl: 'https://acme.com' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(discoverSitemapPagesMock).not.toHaveBeenCalled()
  })

  it('should return 400 for an invalid url', async () => {
    const res = await POST(req({ websiteUrl: 'not-a-url' }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return the discovered urls on success', async () => {
    discoverSitemapPagesMock.mockResolvedValue(['https://acme.com/', 'https://acme.com/pricing'])
    const res = await POST(req({ websiteUrl: 'https://acme.com' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, urls: ['https://acme.com/', 'https://acme.com/pricing'] })
  })

  // A site with no discoverable pages is the operator's problem to fix, so it
  // returns 400 without leaving a row in the client's Logs tab.
  it('should return 400 when discovery finds nothing', async () => {
    discoverSitemapPagesMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'Could not discover any pages for this site'))
    const res = await POST(req({ websiteUrl: 'https://acme.com' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(logErrorMock).not.toHaveBeenCalled()
  })

  it('should log the failure against the client when discovery breaks unexpectedly', async () => {
    discoverSitemapPagesMock.mockRejectedValue(new Error('brightdata unreachable'))
    const res = await POST(req({ websiteUrl: 'https://acme.com' }), ctx('c1'))
    expect(res.status).toBe(500)
    expect(logErrorMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      actor: 'human:op1',
      type: 'knowledge.discover_sitemap_route_failed',
      source: 'app',
      payload: { websiteUrl: 'https://acme.com' },
    }))
  })
})
