import { env } from '@/lib/env'

/**
 * Public origin of the site, without a trailing slash.
 *
 * Server-only: it reads the validated `APP_URL`, which is the same origin the
 * OAuth callbacks are registered against, so canonical tags, Open Graph URLs
 * and the sitemap can never point at a host the app does not actually serve.
 */
export const SITE_URL: string = env.APP_URL.replace(/\/+$/, '')
