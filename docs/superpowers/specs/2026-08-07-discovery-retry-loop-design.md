# Discovery: Depth-First Retry Loop to Actually Reach `daily_target`

**Date:** 2026-08-07
**Status:** Approved design, not yet implemented

## Problem

Investigated a real production run: campaign "Otel ve Turizm" (`859462fc-…`),
`daily_target` 15 at run time, `pipeline.discover.completed` event:

```json
{
  "firstPassCandidates": 8, "secondPassCandidates": 0, "topUpCandidates": 7,
  "newCandidates": 15, "inserted": 15, "verified": 9,
  "emailableChecked": 15, "emailableRejected": 6, "emailableDeliverable": 9
}
```

15 requested → 15 candidates picked → 9 survived Emailable → **9 companies,
each with exactly 1 lead**. Two confirmed causes, both working as coded
today, neither desirable:

1. **`daily_target` budgets Apollo search *attempts*, not delivered *active*
   leads.** `runDiscoveryForCampaign` (`src/lib/pipeline/discover.ts`) spends
   the whole quota on picks in one fixed pass, hands them to Emailable, and
   stops — regardless of how many actually verify. Whatever fraction
   Emailable/AI-relevance/suppression reject is simply lost; nothing tries
   again to make up the shortfall.
2. **Pass 2 (the "find a second contact at an existing company" step) has
   found 0 candidates in every one of the 9 `pipeline.discover.completed`
   events ever logged in this project**, across all 8 campaigns. Root cause:
   `runSecondPass` ANDs the domain restriction (`q_organization_domains_list[]`,
   which already pins one exact company) together with a single ICP keyword
   from `q_keywords`, cycling through the ICP's keyword list one at a time.
   A real second contact at that company is missed whenever their Apollo org
   profile doesn't literally contain that keyword's text — common, since the
   keyword match was designed for *finding* companies broadly, not for
   re-confirming one Apollo already resolved by domain. Because pass 2 never
   contributes, 100% of leftover quota falls through to the top-up path
   (`b52eb38` — fresh companies, one contact each), which is why every
   company in the result has exactly 1 lead, never 2.

## Goals

- A discovery run keeps working — within a self-bounding effort — until
  `verified` (active leads) reaches `daily_target`, not just until the pick
  quota is spent.
- Depth (a second ICP-matching contact at an existing 1-lead company) is
  tried before breadth (a brand-new company) in every round, so campaigns
  actually accumulate 2-contact companies when Apollo has a second contact
  to give.
- Fix the concrete query bug that makes depth always return 0 today.

## Non-Goals

- Relaxing `icp.personTitles` for the second contact — a second contact must
  still be a real ICP persona, not just any employee at the company.
- Changing Emailable's `risky` → `parked` policy. That is a deliberate,
  separate decision (see `map-verification.ts`'s own comment) — not a bug.
- A hard cap on total Apollo/Emailable calls per run, on top of the
  self-bounding round logic below (see Termination).

## Architecture

Replace the fixed three-phase run (`runFirstPass` half-quota →
`runSecondPass` → `topUp`) with a **round loop**. Each round runs two
ordered phases against the current shortfall (`dailyTarget - verifiedSoFar`):

1. **Depth phase** (`runDepthSearch`, renamed from `runSecondPass`) —
   targets every company currently sitting at exactly 1 verified lead
   (`getVerifiedLeadCompanies`, all-time for the campaign, not just this
   run's own picks), searching for a second ICP-matching contact. Uses the
   corrected query (see below). Capped at the round's remaining shortfall.
2. **Breadth phase** (`runBreadthSearch`, renamed from `runFirstPass`) —
   whatever shortfall the depth phase didn't close gets filled with
   brand-new companies, one contact each, unchanged from today's logic.

After both phases: enrich, verify (Emailable), insert — persisted
immediately per phase, same durability reasoning as today (a later phase
throwing must never discard already-durable work from an earlier one).
Then:

- `verifiedSoFar >= dailyTarget` → stop. Target met.
- The round picked **zero** candidates total (depth + breadth combined) →
  stop. Apollo has no more supply for this ICP right now.
- Otherwise → another round.

Round 1 naturally behaves like pure breadth: a campaign's first-ever round
has zero 1-lead companies to deepen (`getVerifiedLeadCompanies` returns
`[]`), so the depth phase finds nothing to target and the round is
effectively breadth-only — identical in effect to today's bootstrap
behavior, but arrived at without an artificial `ceil(quota/2)` pre-split.
Depth only ever engages once a prior round (this run or an earlier day)
left a real 1-lead company behind.

### Per-company exhaustion vs. per-round stop

These are different things:

- **Per-company**: if the depth search for one target domain comes back
  with no matching second contact, that domain is added to an
  `exhaustedDomains` set (scoped to this run) and dropped from every later
  round's depth targets — no point re-querying a domain that already came
  back empty within the same run. It permanently stays at 1 lead, same as
  today's documented behavior ("a company that doesn't surface a match here
  simply stays at 1 ... not treated as a failure").
- **Per-round**: the loop only stops early when an entire round — depth
  across every remaining target domain, plus breadth — returns zero new
  picks combined. One exhausted company never stops the run by itself;
  depth moves on to other target domains in the same batched call, and
  breadth keeps filling from fresh companies regardless.

### Termination bound

No separate hard call-count cap is needed: a round only continues when it
added at least 1 new candidate toward a shortfall that started at
`dailyTarget`, so the run can never exceed roughly `dailyTarget` rounds in
the worst case (one net new candidate per round). A campaign whose ICP is
simply too narrow to ever reach target converges to a stop on its own —
the first fully-empty round — without unbounded spend.

## Correctness Fix Required: `getVerifiedLeadCompanies`

Self-review turned up a latent bug this redesign would otherwise inherit and
make consequential. `getVerifiedLeadCompanies` (`src/lib/db/leads.ts`)
currently filters `.eq('email_status', 'verified')` — Apollo's raw verdict —
not `.eq('status', 'active')`, the field the 2026-08-05 precision-design spec
already established as authoritative for "actually cleared and grouped into
a case." A row that Apollo marked `verified` but that was later parked
(suppressed, post-enrich excluded, or AI-rejected) would still be counted as
a "verified lead company" by this query, even though it was never grouped
into a case.

Today this bug is masked: pass 2 never ran a useful query anyway (the
`q_keywords` bug above), so which companies it targeted barely mattered. In
the new design, the depth phase's correctness depends directly on this list
being accurate every round — targeting a parked company's domain wastes a
depth-phase search slot on a company that was never actually a 1-lead case
in the first place. Fix: change the query to `.eq('status', 'active')`.
`LeadCompanyRef`'s shape and every call site's usage are unaffected — only
the filter column changes.

## Query Fix (Depth Phase)

`runDepthSearch` drops `q_keywords` entirely from its search params — the
domain restriction already pins the exact company, so an additional
company-level keyword match is redundant and produces false negatives.
`person_titles[]`, the employee-count range, and
`contact_email_status[]` still apply, so a second contact still has to be a
legitimate ICP-matching persona. This also removes the keyword-cycling loop
(`searchTargets`/`targetIndex`) from the depth phase — it becomes a plain
paginated search over the batched target-domain list, up to
`MAX_SEARCH_PAGES` calls per round. `buildPeopleSearchParams` needs no
signature change: the depth phase simply passes an ICP with `keywords: []`
(so `q_keywords` is omitted, per its existing `icp.keywords.length > 0`
check) alongside the domain list.

The keyword-cycling loop stays in `runBreadthSearch` unchanged — that
problem (`q_keywords` only accepting one free-text value, confirmed live
2026-08-06) is real for *breadth* search, which has no domain restriction to
fall back on.

## Data Flow (pseudocode)

```
verifiedSoFar = 0
exhaustedDomains = new Set()
known = getKnownSourceIds(clientId)   // extended with this run's own picks as we go

loop:
  shortfall = dailyTarget - verifiedSoFar
  if shortfall <= 0: break            // target met

  existingCompanies = getVerifiedLeadCompanies(campaignId)  // all-time
  targetDomains = existingCompanies
    .filter(count === 1 && domainBacked && not in exhaustedDomains)

  depthPicks = runDepthSearch(shortfall, known, targetDomains, exhaustedDomains)
  depthEnriched = enrichCandidates(depthPicks, ...)
  insertLeads(depthEnriched.rows)
  verifiedSoFar += depthEnriched.verifiedCount
  known += depthPicks.apolloIds

  shortfall = dailyTarget - verifiedSoFar
  if shortfall <= 0: break

  breadthPicks = runBreadthSearch(shortfall, known, ...)
  breadthEnriched = enrichCandidates(breadthPicks, ...)
  insertLeads(breadthEnriched.rows)
  verifiedSoFar += breadthEnriched.verifiedCount
  known += breadthPicks.apolloIds

  if depthPicks.length + breadthPicks.length === 0: break   // no supply left
  // else: loop
```

`aiVerdictCache` continues to be created once per `runDiscoveryForCampaign`
call and threaded through every phase of every round, unchanged.

## Error Handling

Unchanged pattern. Every external call already goes through
`withExternalLogging` + `withRetry`; a thrown error after retries fails the
whole `runDiscoveryForCampaign` call (caught at the top, logged as
`pipeline.discover.failed`, rethrown) — same as today. The loop introduces
no new failure mode: if a depth or breadth search throws mid-round, leads
already inserted in prior rounds/phases stay durable, matching today's
insert-as-you-go reasoning for pass 1 / pass 2.

## Observability

- `DiscoverySummary` fields `firstPassCandidates` / `secondPassCandidates` /
  `topUpCandidates` are replaced with `depthCandidates`, `breadthCandidates`
  (summed across all rounds), and a new `rounds` count.
- `vendorContext`'s Apollo-failure payload changes from `{ pass: 1, page }` /
  `{ pass: 2, page }` to `{ phase: 'depth' | 'breadth', round, page }`.
- The operator-facing Logs sentence in `src/lib/ui/log.ts`
  (`pipeline.discover.completed` → `"Discovery run finished — N leads found,
  M with a verified email"`) is unchanged — still driven by `inserted` /
  `verified`, which keep their existing meaning.
- No DB migration. `DiscoverySummary` and the event payload are JSON with no
  backward-compat requirement — historical events keep their old shape,
  new events use the new field names.

## Testing

- `discover.test.ts` (currently structured entirely around the fixed
  first/second/top-up phases) requires a full rewrite for the round loop —
  same precedent as the original two-phase migration
  (`docs/superpowers/plans/2026-07-19-apollo-multi-thread-discovery.md`).
  New cases to add:
  - Multi-round convergence: round 1 is breadth-only (bootstrap, no 1-lead
    companies yet), round 2's depth phase finds a second contact at a
    company round 1 created.
  - A company with no second matching title is marked exhausted and
    dropped from later rounds' depth targets, without stopping the round.
  - A fully-empty round (depth + breadth both return 0) stops the loop even
    though `verifiedSoFar < dailyTarget`.
  - `known` / `exhaustedDomains` correctly accumulate and dedupe across
    multiple rounds within one run.
  - Target met mid-round (depth alone closes the shortfall) skips the
    breadth phase for that round.
- `build-search-params.test.ts`: assert `q_keywords` is omitted when the
  depth phase's ICP has `keywords: []`, even with `organizationDomains`
  present (should already pass given the existing `icp.keywords.length > 0`
  guard — add the case for regression coverage).
- `leads.test.ts`: update `getVerifiedLeadCompanies`'s existing tests for
  the `status = 'active'` filter (mock chain shape is unaffected — only the
  `.eq()` column/value asserted, if the test asserts it at all), and add a
  case confirming a `status: 'parked'`, `email_status: 'verified'` row is
  excluded from the result.

## Rollout

No DB migration, no new tables/columns, no feature flag — straight deploy,
same as how the original two-phase work and the `b52eb38` top-up fix
shipped. No campaign data changes required.

## Out of Scope

- Relaxing `person_titles` for the second contact.
- Changing Emailable's `risky` → `parked` activation policy.
- A hard cap on total Apollo/Emailable calls per run beyond the
  self-bounding round logic (see Termination).
- Any change to `enrichCandidates`, AI relevance, suppression, or exclude-
  keyword logic — those already operate per-row/per-company independently
  of which phase produced the row.
