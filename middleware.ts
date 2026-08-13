import { NextResponse, type NextRequest } from 'next/server'
import { resolveMarketingLocale } from '@/lib/i18n/resolve-marketing-locale'
import { updateSession } from '@/lib/supabase/middleware'

/**
 * The marketing home page is the only route this project serves in more
 * than one language at its own URL (`/tr` — see the landing i18n design
 * doc). A visitor requesting the unprefixed `/` who resolves to Turkish is
 * redirected there before anything else runs; `/tr` itself is never
 * redirected away from, and every other path is untouched.
 */
export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl
  if (pathname === '/' && resolveMarketingLocale(request) === 'tr') {
    const url = request.nextUrl.clone()
    url.pathname = '/tr'
    return NextResponse.redirect(url)
  }
  return updateSession(request)
}

/**
 * The crawler-facing files are excluded from the matcher, not added to the
 * `isPublic` list in `updateSession`: they are static assets with no session to
 * refresh, and leaving them matched meant an unauthenticated request for
 * `/robots.txt` was answered with a 302 to `/login`. Naive AEO crawlers score
 * that as "robots.txt present" while real ones see no rules at all.
 */
export const config = {
  matcher: [
    '/((?!_next/static|_next/image|favicon.ico|robots.txt|sitemap.xml|llms.txt|opengraph-image|twitter-image|icon|apple-icon|manifest.webmanifest).*)',
  ],
}
