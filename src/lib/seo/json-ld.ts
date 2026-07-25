import {
  absoluteUrl,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_LANGUAGE,
  SITE_NAME,
  SITE_SUMMARY,
} from '@/lib/seo/site'

/**
 * Structured data for the public marketing page.
 *
 * Emitted as a single `@graph` rather than several disconnected scripts so the
 * nodes can reference each other by `@id` — an AI crawler that reads the
 * `FAQPage` then knows which organisation is answering.
 */

export interface FaqEntry {
  readonly question: string
  readonly answer: string
}

export interface LandingJsonLdInput {
  /** Site origin, no trailing slash. */
  readonly siteUrl: string
  readonly faqItems: readonly FaqEntry[]
  /** ISO 8601 timestamps. Surfaced as the page's freshness signal. */
  readonly publishedAt: string
  readonly updatedAt: string
}

type JsonLdNode = Record<string, unknown>

export function buildLandingJsonLd({
  siteUrl,
  faqItems,
  publishedAt,
  updatedAt,
}: LandingJsonLdInput): JsonLdNode {
  const organizationId = `${siteUrl}/#organization`
  const websiteId = `${siteUrl}/#website`
  const webPageId = `${siteUrl}/#webpage`
  const imageId = `${siteUrl}/#primaryimage`
  const homeUrl = absoluteUrl(siteUrl, '/')

  const organization: JsonLdNode = {
    '@type': 'Organization',
    '@id': organizationId,
    name: SITE_NAME,
    url: homeUrl,
    description: SITE_SUMMARY,
    logo: { '@id': imageId },
    image: { '@id': imageId },
  }

  const image: JsonLdNode = {
    '@type': 'ImageObject',
    '@id': imageId,
    url: absoluteUrl(siteUrl, OG_IMAGE_PATH),
    contentUrl: absoluteUrl(siteUrl, OG_IMAGE_PATH),
    width: OG_IMAGE_WIDTH,
    height: OG_IMAGE_HEIGHT,
    caption: `${SITE_NAME} — ${SITE_SUMMARY}`,
  }

  const website: JsonLdNode = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: homeUrl,
    name: SITE_NAME,
    description: SITE_SUMMARY,
    publisher: { '@id': organizationId },
    inLanguage: SITE_LANGUAGE,
  }

  const webPage: JsonLdNode = {
    '@type': 'WebPage',
    '@id': webPageId,
    url: homeUrl,
    name: `${SITE_NAME} — ${SITE_SUMMARY}`,
    description: SITE_SUMMARY,
    isPartOf: { '@id': websiteId },
    about: { '@id': organizationId },
    primaryImageOfPage: { '@id': imageId },
    datePublished: publishedAt,
    dateModified: updatedAt,
    inLanguage: SITE_LANGUAGE,
  }

  const faqPage: JsonLdNode = {
    '@type': 'FAQPage',
    '@id': `${siteUrl}/#faq`,
    isPartOf: { '@id': webPageId },
    inLanguage: SITE_LANGUAGE,
    dateModified: updatedAt,
    mainEntity: faqItems.map(({ question, answer }) => ({
      '@type': 'Question',
      name: question,
      acceptedAnswer: { '@type': 'Answer', text: answer },
    })),
  }

  return {
    '@context': 'https://schema.org',
    '@graph': [organization, image, website, webPage, faqPage],
  }
}

/**
 * Serialises a JSON-LD node for injection into a `<script>` tag.
 *
 * `<`, `>` and `&` are escaped to their JSON unicode forms: without it, copy
 * containing `</script>` would close the tag early and turn page content into
 * executable markup.
 */
export function serializeJsonLd(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}
