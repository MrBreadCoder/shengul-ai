import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import type { WebResearch } from '@/lib/research/provider'
import { discoverSitemapPages } from './sitemap'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function textResponse(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body }
}

const flatSitemap = `<?xml version="1.0"?>
<urlset><url><loc>https://acme.com/</loc></url><url><loc>https://acme.com/pricing</loc></url></urlset>`

const sitemapIndex = `<?xml version="1.0"?>
<sitemapindex><sitemap><loc>https://acme.com/sitemap-pages.xml</loc></sitemap></sitemapindex>`

const childSitemap = `<?xml version="1.0"?>
<urlset><url><loc>https://acme.com/about</loc></url></urlset>`

const stubResearch: WebResearch = { search: vi.fn(), scrape: vi.fn() }

describe('discoverSitemapPages', () => {
  it('should return the loc urls from a flat sitemap', async () => {
    fetchMock.mockResolvedValue(textResponse(flatSitemap))
    const result = await discoverSitemapPages(stubResearch, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/', 'https://acme.com/pricing'])
  })

  it('should follow a sitemap index into its child sitemaps', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse(sitemapIndex))
      .mockResolvedValueOnce(textResponse(childSitemap))
    const result = await discoverSitemapPages(stubResearch, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/about'])
  })

  it('should cap the result at 500 urls', async () => {
    const many = Array.from({ length: 600 }, (_, i) => `<url><loc>https://acme.com/p${i}</loc></url>`).join('')
    fetchMock.mockResolvedValue(textResponse(`<urlset>${many}</urlset>`))
    const result = await discoverSitemapPages(stubResearch, 'https://acme.com')
    expect(result.length).toBe(500)
  })

  it('should fall back to a Brightdata crawl when sitemap.xml 404s', async () => {
    fetchMock.mockResolvedValue(textResponse('not found', false, 404))
    const research: WebResearch = {
      search: vi.fn(),
      scrape: vi.fn().mockResolvedValue('# Acme\n[Pricing](https://acme.com/pricing) [Ext](https://other.com/x)'),
    }
    const result = await discoverSitemapPages(research, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/pricing'])
  })

  it('should throw VALIDATION_ERROR when neither sitemap nor crawl finds anything', async () => {
    fetchMock.mockResolvedValue(textResponse('not found', false, 404))
    const research: WebResearch = { search: vi.fn(), scrape: vi.fn().mockResolvedValue('no links here') }
    await expect(discoverSitemapPages(research, 'https://acme.com')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('should fall back to crawl when the sitemap has no loc entries', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<urlset></urlset>'))
    const research: WebResearch = {
      search: vi.fn(),
      scrape: vi.fn().mockResolvedValue('[Home](https://acme.com/)'),
    }
    const result = await discoverSitemapPages(research, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/'])
  })
})
