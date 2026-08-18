import { createConcurrencyLimiter } from '@/lib/http/concurrency-limiter'

// Root-caused 2026-08-10 (see .claude/roadmap.md, "Cluster B — BrightData
// aborts / bad JSON"): with no cap, collectSocialKnowledge's Promise.all
// fan-out (2 + 2×leads Bright Data calls at once) plus the research agent's
// own tool-call concurrency fired more simultaneous Bright Data requests
// than the zone could serve, surfacing as "aborted" / "Unexpected response
// shape" failures. That entry flagged a semaphore as the real fix but left
// it unimplemented, sized to "whatever BrightData's dashboard reports as
// the zone's actual concurrent-connection limit."
//
// That number isn't public — Bright Data's docs confirm the Web
// Unlocker/SERP zone's concurrency ceiling is account-specific and only
// visible in the Control Panel (a zone's Overview tab > Access details),
// which isn't reachable from here. 5 is a conservative placeholder picked
// to be comfortably under any plausible zone limit; raise it once someone
// checks that dashboard page.
export const BRIGHTDATA_MAX_CONCURRENT = 5

// Bounds only search/scrape (brightdata.ts) — the fast, synchronous calls
// the research agent's tool loop makes once per step. Social discovery jobs
// (social-scrape.ts) used to share this same pool; see
// BRIGHTDATA_SOCIAL_MAX_CONCURRENT below for why that was a bug, not just a
// missed optimization.
export const limitBrightdataConcurrency = createConcurrencyLimiter(BRIGHTDATA_MAX_CONCURRENT)

// Root-caused 2026-08-18: social-scrape.ts's discoverPosts() holds its
// concurrency slot for its *entire* trigger-poll-download lifecycle — up to
// POLL_TIMEOUT_MS (180s) — versus a search/scrape call's single HTTP
// round-trip (seconds). Sharing one 5-slot pool between the two meant a
// burst of concurrent cases (each case can fire up to ~4 discovery jobs, one
// per company/person LinkedIn/X target) could fill every slot with jobs that
// sit there for minutes, starving every other case's fast per-step
// search/scrape calls system-wide — exactly the failure mode a shared
// concurrency cap is supposed to prevent, not cause. It's also the wrong
// thing to unify in the first place: discovery jobs hit Bright Data's
// Datasets API (`/datasets/v3/*`), search/scrape hit the SERP/Web Unlocker
// `/request` zone — two different Bright Data products with two different
// account-level quotas, so they were never actually competing for the same
// real limit. A separate, smaller pool here is a conservative placeholder
// (same reasoning as BRIGHTDATA_MAX_CONCURRENT above) — raise once someone
// checks the Datasets API's own concurrency ceiling on the dashboard.
export const BRIGHTDATA_SOCIAL_MAX_CONCURRENT = 2
export const limitBrightdataSocialConcurrency = createConcurrencyLimiter(BRIGHTDATA_SOCIAL_MAX_CONCURRENT)
