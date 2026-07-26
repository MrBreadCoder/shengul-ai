import type { MetadataRoute } from 'next'
import { absoluteUrl } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'

/**
 * Everything behind the auth wall. Listed explicitly rather than allow-listing
 * `/` alone, because a crawler that follows a link into the console only ever
 * gets a redirect to `/login` — wasted budget on both sides.
 */
const PRIVATE_PATHS: readonly string[] = [
  '/api/',
  '/auth/',
  '/analytics',
  '/campaigns',
  '/cases',
  '/clients',
  '/crm',
  '/inbox',
  '/knowledge',
  '/mail',
  '/settings',
  '/set-password',
  '/auth',
]

/**
 * AI and answer-engine crawlers, named explicitly with an `Allow`.
 *
 * A missing rule already means "allowed", but several AEO audits — and some of
 * these agents themselves — only treat a site as opted in when their own token
 * appears. Being named here is the difference between being quotable and being
 * invisible in an AI answer.
 */
const AI_CRAWLERS: readonly string[] = [
  'GPTBot',
  'OAI-SearchBot',
  'ChatGPT-User',
  'ClaudeBot',
  'Claude-User',
  'Claude-SearchBot',
  'anthropic-ai',
  'PerplexityBot',
  'Perplexity-User',
  'Google-Extended',
  'Applebot-Extended',
  'Amazonbot',
  'meta-externalagent',
  'DuckAssistBot',
  'cohere-ai',
  'CCBot',
  'YouBot',
  'Bytespider',
]

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: '*', allow: '/', disallow: [...PRIVATE_PATHS] },
      ...AI_CRAWLERS.map((userAgent) => ({
        userAgent,
        allow: '/',
        disallow: [...PRIVATE_PATHS],
      })),
    ],
    sitemap: absoluteUrl(SITE_URL, '/sitemap.xml'),
    host: SITE_URL,
  }
}
