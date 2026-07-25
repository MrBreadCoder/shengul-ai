import { BOOKING_URL } from '@/components/landing/constants'
import { FAQ_ITEMS } from '@/components/landing/faq-items'
import { buildLlmsTxt } from '@/lib/seo/llms-txt'
import { CONTENT_UPDATED_AT } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'

/**
 * `/llms.txt` — a prose description of the site for language models.
 *
 * Served from a route handler rather than `public/` so the copy is generated
 * from the same constants the page renders: the FAQ a model reads here cannot
 * fall out of sync with the FAQ a human reads on `/`.
 */
export const dynamic = 'force-static'

export function GET(): Response {
  const body = buildLlmsTxt({
    siteUrl: SITE_URL,
    bookingUrl: BOOKING_URL,
    faqItems: FAQ_ITEMS,
    updatedAt: CONTENT_UPDATED_AT,
  })

  return new Response(body, {
    status: 200,
    headers: {
      'content-type': 'text/plain; charset=utf-8',
      'cache-control': 'public, max-age=3600, s-maxage=86400',
    },
  })
}
