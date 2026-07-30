export { GET } from '../llms.txt/route'

/**
 * Alias for `/llms.txt` at the singular spelling some crawlers probe instead.
 * Re-exports the same handler rather than duplicating it, so the two paths can
 * never drift. `dynamic` is redeclared because Next.js requires route-segment
 * config to be a static export in the file it applies to, not re-exported.
 */
export const dynamic = 'force-static'
