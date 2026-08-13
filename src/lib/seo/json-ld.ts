import { absoluteUrl, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH, SITE_NAME } from '@/lib/seo/site'
import type { AppLocale } from '@/types/i18n'

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
  /** `/` or `/tr` — which marketing page this graph describes. */
  readonly pagePath: string
  readonly locale: AppLocale
  /** Locale-appropriate one-line summary — `SITE_SUMMARY` or `SITE_SUMMARY_TR`. */
  readonly summary: string
  readonly faqItems: readonly FaqEntry[]
  /** ISO 8601 timestamps. Surfaced as the page's freshness signal. */
  readonly publishedAt: string
  readonly updatedAt: string
}

type JsonLdNode = Record<string, unknown>

export function buildLandingJsonLd({
  siteUrl,
  pagePath,
  locale,
  summary,
  faqItems,
  publishedAt,
  updatedAt,
}: LandingJsonLdInput): JsonLdNode {
  // Organization/Website identity is anchored to the canonical root
  // regardless of which page renders it — it is the same organisation on
  // every page. WebPage/FAQPage are anchored to the page actually rendering,
  // so each locale's crawl gets its own resolvable node.
  const homeUrl = absoluteUrl(siteUrl, '/')
  const pageUrl = absoluteUrl(siteUrl, pagePath)
  const organizationId = `${homeUrl}#organization`
  const websiteId = `${homeUrl}#website`
  const webPageId = `${pageUrl}#webpage`
  const imageId = `${homeUrl}#primaryimage`

  const organization: JsonLdNode = {
    '@type': 'Organization',
    '@id': organizationId,
    name: SITE_NAME,
    url: homeUrl,
    description: summary,
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
    caption: `${SITE_NAME} — ${summary}`,
  }

  const website: JsonLdNode = {
    '@type': 'WebSite',
    '@id': websiteId,
    url: homeUrl,
    name: SITE_NAME,
    description: summary,
    publisher: { '@id': organizationId },
    inLanguage: locale,
  }

  const webPage: JsonLdNode = {
    '@type': 'WebPage',
    '@id': webPageId,
    url: pageUrl,
    name: `${SITE_NAME} — ${summary}`,
    description: summary,
    isPartOf: { '@id': websiteId },
    about: { '@id': organizationId },
    primaryImageOfPage: { '@id': imageId },
    datePublished: publishedAt,
    dateModified: updatedAt,
    inLanguage: locale,
  }

  const faqPage: JsonLdNode = {
    '@type': 'FAQPage',
    '@id': `${pageUrl}#faq`,
    isPartOf: { '@id': webPageId },
    inLanguage: locale,
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
