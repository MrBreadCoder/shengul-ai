/**
 * Which paths are reachable without a session.
 *
 * Kept out of the middleware module so it can be tested without pulling in the
 * environment and a Supabase client. It is the whole of the app's public
 * surface, so a mistake here either exposes the console or hides a page that has
 * to stay reachable — both worth a test rather than a careful read.
 */

/** Matched exactly. `startsWith('/')` would make the entire app public. */
const EXACT_PUBLIC_PATHS: readonly string[] = ['/', '/legal']

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
]

export function isPublicPath(pathname: string): boolean {
  if (EXACT_PUBLIC_PATHS.includes(pathname)) return true
  return PUBLIC_PATH_PREFIXES.some((prefix) => pathname.startsWith(prefix))
}
