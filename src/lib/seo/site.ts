/**
 * Canonical identity of the public site.
 *
 * Every machine-readable surface — canonical tags, Open Graph, robots.txt,
 * sitemap.xml, llms.txt and JSON-LD — takes its copy from here, so the answer
 * an AI crawler gets can never drift from the answer the page gives a human.
 *
 * This module is intentionally free of `@/lib/env` so it stays importable from
 * anywhere (including tests) without a fully populated environment. The origin
 * lives in `@/lib/seo/site-url`.
 */

/**
 * Google truncates below 50 and above ~160 rendered characters, and AEO
 * crawlers score the raw length against the same window.
 */
export const META_DESCRIPTION_MIN_LENGTH = 50
export const META_DESCRIPTION_MAX_LENGTH = 160

export const SITE_NAME = 'Shengul AI'

/** Page title for `/`. The root layout appends `· Shengul AI`. */
export const SITE_TITLE = 'More meetings, none of the outbound'

/** Default description, used for every page that does not set its own. */
export const SITE_DESCRIPTION =
  'Shengul AI runs B2B outbound end to end: it finds your buyers, writes the emails from your own mailbox, answers the replies, and books the meetings.'

/** Description for the public marketing page (`/`). */
export const LANDING_DESCRIPTION =
  'You describe the buyer. Shengul AI finds them, writes the emails, answers the replies, and hands you the meetings that get booked. No outbound team required.'

/** One-line summary used at the top of llms.txt and as the OG subtitle. */
export const SITE_SUMMARY =
  'Managed B2B outbound: buyer research, cold email, reply handling and meeting booking, run from your own mailbox.'

export const SITE_LANGUAGE = 'en'
export const SITE_LOCALE = 'en_US'

/**
 * Freshness signals for JSON-LD and `sitemap.xml`. Hard-coded rather than
 * `new Date()` so a redeploy that changes nothing cannot claim the content was
 * updated — bump `CONTENT_UPDATED_AT` when the landing copy actually changes.
 */
export const CONTENT_PUBLISHED_AT = '2026-07-18T00:00:00.000Z'
export const CONTENT_UPDATED_AT = '2026-07-25T00:00:00.000Z'

/**
 * The generated social card. `OG_IMAGE_PATH` is stated explicitly rather than
 * left to Next's file convention: a page inside a route group does not pick up
 * the root `opengraph-image` file, which silently costs `/` its card.
 */
export const OG_IMAGE_PATH = '/opengraph-image'
export const OG_IMAGE_WIDTH = 1200
export const OG_IMAGE_HEIGHT = 630
export const OG_IMAGE_ALT = `${SITE_NAME} — ${SITE_TITLE}`

/**
 * Joins an origin and a path into an absolute URL, tolerating a trailing slash
 * on the origin and a missing leading slash on the path.
 */
export function absoluteUrl(origin: string, path: string): string {
  const base = origin.replace(/\/+$/, '')
  if (path === '' || path === '/') return `${base}/`
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}
