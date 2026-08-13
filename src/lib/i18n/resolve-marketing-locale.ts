import type { NextRequest } from 'next/server'
import { isSupportedLocale, parseAcceptLanguage } from './resolve-locale'
import type { AppLocale } from '@/types/i18n'

/** Set only by `/api/locale` (Task 4) when a visitor uses the footer switcher. */
export const MARKETING_LOCALE_COOKIE = 'marketing_locale'

/**
 * Locale for the anonymous marketing home page (`/`), used only by
 * `middleware.ts` to decide whether to redirect `/` to `/tr`.
 *
 * Priority: an explicit manual choice (the `marketing_locale` cookie) always
 * wins over automatic detection. Absent that, a visitor's IP-derived country
 * decides ("coming from Turkey" is the literal ask this exists to serve),
 * and only when that signal is unavailable (local dev, or any host that
 * does not set Vercel's edge geo header) does the browser's own language
 * preference decide. If neither signal points to a supported locale,
 * English.
 */
export function resolveMarketingLocale(request: NextRequest): AppLocale {
  const cookie = request.cookies.get(MARKETING_LOCALE_COOKIE)?.value
  if (cookie && isSupportedLocale(cookie)) return cookie
  if (request.headers.get('x-vercel-ip-country') === 'TR') return 'tr'
  return parseAcceptLanguage(request.headers.get('accept-language'))
}
