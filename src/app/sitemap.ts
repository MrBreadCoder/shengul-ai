import type { MetadataRoute } from 'next'
import { LEGAL_DOCUMENTS, LEGAL_PATH_PREFIX, legalDocumentPath } from '@/lib/legal/registry'
import { absoluteUrl, CONTENT_UPDATED_AT } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'

/**
 * `/` plus the published legal documents: every other route is either behind
 * auth or a sign-in form carrying `noindex`, and a sitemap that advertises
 * unindexable URLs is a negative quality signal rather than a neutral one.
 *
 * The legal pages belong here despite being unglamorous — somebody who wants to
 * know where we got their details should be able to reach that page from a
 * search engine, not only from a link inside the email that prompted the
 * question.
 *
 * `lastModified` is the freshness signal AI crawlers read, so it tracks
 * hand-maintained dates rather than the deploy time.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteUrl(SITE_URL, '/'),
      lastModified: new Date(CONTENT_UPDATED_AT),
      changeFrequency: 'monthly',
      priority: 1,
    },
    {
      url: absoluteUrl(SITE_URL, LEGAL_PATH_PREFIX),
      lastModified: new Date(CONTENT_UPDATED_AT),
      changeFrequency: 'yearly',
      priority: 0.3,
    },
    ...LEGAL_DOCUMENTS.map((document) => ({
      url: absoluteUrl(SITE_URL, legalDocumentPath(document.slug)),
      lastModified: new Date(document.updatedAt),
      changeFrequency: 'yearly' as const,
      priority: 0.3,
    })),
  ]
}
