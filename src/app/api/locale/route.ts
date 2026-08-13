import { NextResponse } from 'next/server'
import { env } from '@/lib/env'
import { MARKETING_LOCALE_COOKIE } from '@/lib/i18n/resolve-marketing-locale'
import { localeSchema } from '@/lib/validation/locale'

/** A manual language choice should stick for a long time. */
const MARKETING_LOCALE_COOKIE_MAX_AGE_SECONDS = 60 * 60 * 24 * 365

const REDIRECT_PATH_BY_LOCALE: Record<'en' | 'tr', string> = { en: '/', tr: '/tr' }

/**
 * Sets the visitor's manual language override for the marketing home page
 * and sends them to the matching URL. Linked to directly from the footer's
 * language switcher — plain `<a href>`, no client JS required.
 *
 * The cookie is what stops `middleware.ts`'s geo/Accept-Language detection
 * from immediately bouncing the visitor back to their detected locale on
 * the very next request to `/` (see the landing i18n design doc, §8).
 *
 * No auth check — this is public, anonymous-visitor infrastructure, the
 * same trust level as the page itself.
 */
export async function GET(request: Request): Promise<NextResponse> {
  const requested = new URL(request.url).searchParams.get('locale')
  const parsed = localeSchema.safeParse(requested)
  if (!parsed.success) {
    return NextResponse.json({ error: 'invalid_locale' }, { status: 400 })
  }

  const locale = parsed.data
  const response = NextResponse.redirect(new URL(REDIRECT_PATH_BY_LOCALE[locale], env.APP_URL))
  response.cookies.set(MARKETING_LOCALE_COOKIE, locale, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MARKETING_LOCALE_COOKIE_MAX_AGE_SECONDS,
  })
  return response
}
