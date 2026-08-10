# Discovery: Configurable `contactsPerCompany` (fixing "N companies × 1 lead")

**Date:** 2026-08-10
**Status:** Implemented

## Problem

Reported by the user: a campaign with `daily_target` 4 returned 4 different
companies with 1 lead each, instead of the expected 2 companies with 2
people each.

Root cause, traced in `src/lib/pipeline/discover.ts`'s round loop
(`runDiscoveryForCampaign`): the breadth phase was always handed the *entire*
remaining quota (`quota - verifiedSoFar`) as its pick budget, and breadth
picks at most 1 person per brand-new company (`companyPickCounts`, capped in
`runBreadthSearch`). So a fully-successful round 1 opens exactly `quota`
distinct companies at 1 lead each and hits quota immediately — the round
loop (`while (verifiedSoFar < quota)`) then exits before a second round ever
runs, and the depth phase (the only code path that finds a 2nd contact at an
existing company) never gets a turn. This matched the design intent
described in `2026-08-07-discovery-retry-loop-design.md` §"Round 1 naturally
behaves like pure breadth", but that intent produced a result the user
explicitly didn't want.

There was also no config field anywhere (DB, Zod schema, API, UI) for "how
many contacts per company" — the ~2-per-company outcome the depth phase
implicitly aimed for was hardcoded and never guaranteed.

## Fix

1. **New campaign setting**, `contactsPerCompany` (DB: `contacts_per_company
   integer not null default 2`, 1–10): how many verified contacts to aim for
   at each company before opening a new one.
2. **Depth-target filter generalized**: `runDiscoveryForCampaign` now targets
   any company sitting at `count < campaign.contactsPerCompany` (was the
   fixed `count === 1`), so depth keeps returning to a company across rounds
   until it either hits the target or Apollo runs dry for that domain.
3. **Breadth reservation**: instead of handing breadth the full remaining
   quota, the round loop now computes
   `newCompanyQuota = Math.ceil(breadthQuota / contactsPerCompany)` and
   passes that as breadth's pick budget. This opens only as many new
   companies as necessary to eventually reach quota at `contactsPerCompany`
   contacts each, leaving room for depth to fill the rest in later rounds
   instead of relying on breadth picks failing verification to ever trigger
   a second round.

Net effect for `daily_target = 4`, `contactsPerCompany = 2`, on a campaign
with no existing leads: round 1 breadth opens 2 new companies (1 person
each); round 2 depth returns to those same 2 companies for a 2nd contact
each. `contactsPerCompany = 1` reproduces the old behavior exactly
(`ceil(x / 1) = x`, and `count < 1` never matches an already-verified
company, so depth never engages).

## Not addressed

Depth still picks at most 1 additional contact per company per call
(`runDepthSearch`'s `remainingTargets.delete(companyKey)` after the first
match) — for `contactsPerCompany > 2` this means reaching the full target at
a given company takes one extra round per additional contact. Acceptable:
the round loop already runs until quota is met or a round finds nothing, and
`contactsPerCompany` is capped at 10 to bound how many rounds that could take
in the worst case.
