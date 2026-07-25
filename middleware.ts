import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
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
