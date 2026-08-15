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

// One instance shared by every Bright Data caller (search/scrape in
// brightdata.ts, social discovery jobs in social-scrape.ts) so the cap
// reflects total Bright Data load, not a per-module budget that would let
// each module independently max out the zone at the same time.
export const limitBrightdataConcurrency = createConcurrencyLimiter(BRIGHTDATA_MAX_CONCURRENT)
