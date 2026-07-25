import { fetchText } from '@/lib/http/fetch-text'
import { AppError } from '@/lib/errors/app-error'
import type { WebResearch } from '@/lib/research/provider'

const MAX_SITEMAP_URLS = 500
const MAX_SITEMAP_CHILD_FILES = 20
const SITEMAP_TIMEOUT_MS = 8000

const LOC_REGEX = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
const MARKDOWN_LINK_REGEX = /\]\((https?:\/\/[^\s)]+)\)/g

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(LOC_REGEX)].map((m) => m[1]!.trim())
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml)
}

function dedupeCap(urls: string[], cap: number): string[] {
  return Array.from(new Set(urls)).slice(0, cap)
}

function extractSameDomainLinks(markdown: string, origin: string): string[] {
  const host = new URL(origin).host
  const links = [...markdown.matchAll(MARKDOWN_LINK_REGEX)].map((m) => m[1]!)
  const sameDomain = links.filter((link) => {
    try {
      return new URL(link).host === host
    } catch {
      return false
    }
  })
  return dedupeCap(sameDomain, MAX_SITEMAP_URLS)
}

async function discoverViaCrawlFallback(research: WebResearch, origin: string): Promise<string[]> {
  const markdown = await research.scrape(origin)
  const links = extractSameDomainLinks(markdown, origin)
  if (links.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Could not discover any pages for this site', { origin })
  }
  return links
}

async function fetchSitemapXml(url: string): Promise<string | null> {
  try {
    return await fetchText(url, { method: 'GET' }, SITEMAP_TIMEOUT_MS)
  } catch {
    return null
  }
}

// Sitemap.xml first (fast, no Brightdata credits — sitemaps are almost never
// bot-blocked), falling back to a Brightdata homepage crawl when no sitemap
// exists or it has no <loc> entries. Never returns an empty array: throws
// VALIDATION_ERROR if discovery genuinely finds nothing, so the route can
// surface a clear message instead of an empty picker.
export async function discoverSitemapPages(research: WebResearch, websiteUrl: string): Promise<string[]> {
  const origin = new URL(websiteUrl).origin
  const rootXml = await fetchSitemapXml(`${origin}/sitemap.xml`)
  if (rootXml === null) return discoverViaCrawlFallback(research, origin)

  const rootLocs = extractLocs(rootXml)
  if (rootLocs.length === 0) return discoverViaCrawlFallback(research, origin)

  if (!isSitemapIndex(rootXml)) {
    return dedupeCap(rootLocs, MAX_SITEMAP_URLS)
  }

  const childSitemaps = rootLocs.slice(0, MAX_SITEMAP_CHILD_FILES)
  const allUrls: string[] = []
  for (const childUrl of childSitemaps) {
    const childXml = await fetchSitemapXml(childUrl)
    if (childXml) allUrls.push(...extractLocs(childXml))
    if (allUrls.length >= MAX_SITEMAP_URLS) break
  }
  if (allUrls.length === 0) return discoverViaCrawlFallback(research, origin)
  return dedupeCap(allUrls, MAX_SITEMAP_URLS)
}
