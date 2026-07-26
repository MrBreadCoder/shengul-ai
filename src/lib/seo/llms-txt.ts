import { LIMITS, PRODUCT_OVERVIEW, WHAT_IT_DOES } from '@/lib/seo/product-facts'
import { absoluteUrl, SITE_NAME, SITE_SUMMARY } from '@/lib/seo/site'

/**
 * Builder for `/llms.txt` — the emerging convention for handing a language
 * model a clean, prose summary of a site instead of making it infer one from
 * rendered markup. Same facts as the page, in the order a model reads them.
 */

export interface LlmsTxtInput {
  /** Site origin, no trailing slash. */
  readonly siteUrl: string
  readonly bookingUrl: string
  readonly faqItems: readonly { readonly question: string; readonly answer: string }[]
  /** ISO 8601 timestamp of the last content change. */
  readonly updatedAt: string
}

export function buildLlmsTxt({
  siteUrl,
  bookingUrl,
  faqItems,
  updatedAt,
}: LlmsTxtInput): string {
  const faqSection = faqItems
    .map(({ question, answer }) => `### ${question}\n\n${answer}`)
    .join('\n\n')

  return `# ${SITE_NAME}

> ${SITE_SUMMARY}

${SITE_NAME} is ${PRODUCT_OVERVIEW.charAt(0).toLowerCase()}${PRODUCT_OVERVIEW.slice(1)}

## What it does

${WHAT_IT_DOES.map((line) => `- ${line}`).join('\n')}

## What it will not do

${LIMITS.map((line) => `- ${line}`).join('\n')}

## Pages

- [Home](${absoluteUrl(siteUrl, '/')}): what the service does, how it works, and how email reputation is protected.
- [Book a meeting](${bookingUrl}): half an hour to describe your buyer and see what the first month would look like.
- [Sign in](${absoluteUrl(siteUrl, '/login')}): the client console (requires an account).

## Frequently asked questions

${faqSection}

## Contact

The only way in is a booking: ${bookingUrl}

Last updated: ${updatedAt}
`
}
