import type { MetadataRoute } from 'next'
import { absoluteUrl, CONTENT_UPDATED_AT } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'

/**
 * Only `/` is listed: every other route is either behind auth or a sign-in
 * form carrying `noindex`, and a sitemap that advertises unindexable URLs is
 * a negative quality signal rather than a neutral one.
 *
 * `lastModified` is the freshness signal AI crawlers read, so it tracks the
 * hand-maintained `CONTENT_UPDATED_AT` rather than the deploy time.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  return [
    {
      url: absoluteUrl(SITE_URL, '/'),
      lastModified: new Date(CONTENT_UPDATED_AT),
      changeFrequency: 'monthly',
      priority: 1,
    },
  ]
}
