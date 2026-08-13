/**
 * Which paths are reachable without a session.
 *
 * Kept out of the middleware module so it can be tested without pulling in the
 * environment and a Supabase client. It is the whole of the app's public
 * surface, so a mistake here either exposes the console or hides a page that has
 * to stay reachable — both worth a test rather than a careful read.
 */

/**
 * Matched exactly. `startsWith('/')` would make the entire app public.
 * `/tr` is the Turkish mirror of `/` — see the landing i18n design doc.
 * `/api/locale` is the footer language switcher's target — same trust level
 * as the page itself (anonymous, unauthenticated), so it must not be gated
 * behind a session or clicking "Türkçe"/"English" would 307 to `/login`
 * instead of switching the language.
 */
const EXACT_PUBLIC_PATHS: readonly string[] = ['/', '/legal', '/tr', '/api/locale']

/**
 * Matched as prefixes.
 *
 * `/legal/` is public because the documents are written for people who do not
 * have an account and never will: somebody who received a cold email and wants
 * it to stop must not be answered with a sign-in form.
 *
 * `/api/pipeline/` and `/api/inbound/` are public to the *middleware* only —
 * every route under them verifies an `upstash-signature` at entry, which is
 * strictly stronger than a cookie for a machine-to-machine caller that has no
 * cookies. Gating them on the session did not reject QStash's delivery, it
 * redirected it: the 307 preserves the POST, QStash follows it, and the
 * sign-in page answers 405 until the message exhausts its retries.
 *
 * The trailing slashes matter — without them a future `/api/pipelines-admin`
 * page would be served to anyone.
 */
const PUBLIC_PATH_PREFIXES: readonly string[] = [
  '/legal/',
  '/login',
  '/api/cron/',
  '/api/pipeline/',
  '/api/inbound/',
  '/auth/callback',
  // Reached only by someone holding a dead invite link, who by definition has
  // no session. Gating it on one would answer "your link expired" with a
  // sign-in form they cannot use.
  '/auth/invite-expired',
]

export function isPublicPath(pathname: string): boolean {
  if (EXACT_PUBLIC_PATHS.includes(pathname)) return true
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
