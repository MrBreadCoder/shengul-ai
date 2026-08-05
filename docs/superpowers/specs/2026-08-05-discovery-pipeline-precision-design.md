# Discovery Pipeline Precision & Cost-Efficiency

**Date:** 2026-08-05
**Status:** Approved design, not yet implemented

## Problem

Stage 1 discovery (`src/lib/pipeline/discover.ts`) has four gaps that either
waste paid vendor calls or leave configured-but-dead filters unused:

1. **No suppression check before Emailable spend.** A contact who already
   bounced or unsubscribed for a client (recorded in `suppressions`) can be
   rediscovered by Apollo, cost an Apollo credit to reveal, get run through
   Emailable, and get attached to a new case — only to be blocked at the
   final send step by `mailbox/sender.ts`'s suppression chokepoint. The
   Emailable check (and the case/lead bookkeeping) was wasted.
2. **Two working Apollo ICP filters are wired up but unreachable.**
   `personSeniorities` and `contactEmailStatuses` are defined in
   `apollo/types.ts` and already forwarded to Apollo's search params in
   `build-search-params.ts`, but `new-campaign-form.tsx` has no field for
   either, so every campaign sends `[]`. `contactEmailStatuses` in
   particular could pre-restrict search to Apollo's own `verified` pool
   before a credit is spent revealing anyone.
3. **`exclude-keywords.ts` only sees pre-enrich data.** It matches
   `organizationName` + `title`, because that's all Apollo's free search
   response carries. The enrich call (`bulk_match`) returns richer
   firmographics (`organizationIndustry`, `organizationDescription`, etc. —
   see `rawOrgFieldsSchema` in `group-lead.ts`) that could catch companies
   the thinner pre-enrich match let through, but nothing re-checks against
   them.
4. **Dedup (`getKnownSourceIds`) is scoped to `campaign_id`, not
   `client_id`.** Two campaigns for the same client with overlapping ICPs
   can reveal — and pay Apollo credits for — the same person twice.

## Decisions

- **Client-wide dedup skip (item 4):** if any campaign for a client has
  already revealed an Apollo person, that person is never re-enriched for
  *any* other campaign of that client. A person only ever belongs to one
  campaign's pipeline per client. (Rejected alternative: cache the reveal
  once and still create a per-campaign lead row — adds real complexity for
  a scenario judged not worth supporting.)
- **Filtered-but-not-Emailable-checked rows are still persisted** as
  `status: 'parked'` leads (not dropped), so the client-wide dedup above
  actually prevents re-revealing them on a later run, and so the filter is
  auditable via the same `leads`/`events` trail as everything else.
- **`contactEmailStatuses` defaults to `['verified']` pre-checked** on the
  new campaign form; `personSeniorities` defaults to none checked (no
  natural default). Existing campaigns are unaffected — see Rollout.
- **UI widget: checkbox group**, not a multi-select dropdown — both fields
  are small fixed Apollo enums, not free text, and the form has no existing
  multi-select `Select` pattern to reuse.

## Architecture & Data Flow

### Shared insertion point for items 1 and 3

Both the suppression check and the post-enrich exclude check slot into the
same place in `enrichCandidates()` (`discover.ts`): right after `batchRows`
is built from Apollo's `bulkMatchPeople` response, before `verifyBatch()`
(the Emailable call) runs.

```
for each row in batchRows:
  if row.email is in client's suppressions      → status='parked', reason=suppressed, skip Emailable
  else if row (org name/title/industry/description)
          matches icp.excludeKeywords            → status='parked', reason=excluded_post_enrich, skip Emailable
  else → row proceeds into verifyBatch() as today
```

- **Suppression check:** new `getSuppressions(supabase, clientId, emails: string[]): Promise<Set<string>>`
  in `suppressions.ts`, one bulk `.in('email', normalizedEmails)` query
  scoped by `client_id` — same table, same normalization (`trim().toLowerCase()`)
  as the existing single-email `getSuppression`.
- **Post-enrich exclude:** extend `matchesExcludedKeywords`'s candidate
  shape (`exclude-keywords.ts`) to optionally also accept
  `organizationIndustry` / `organizationDescription`, sourced from the
  already-fetched `ApolloEnrichedPerson`. Same `icp.excludeKeywords` list —
  no new config field, just a second, later-stage check with richer input.
  This runs in addition to the existing pre-enrich check in
  `runFirstPass`/`runSecondPass`, not instead of it (the pre-enrich check
  still saves an Apollo enrich call whenever it alone is enough to exclude).

### Correctness fix required by the above

Three places in `discover.ts` currently treat `row.email_status === 'verified'`
as "this lead is fully cleared to send/group":

- the `groupVerifiedLead` gate in `runDiscoveryForCampaign`
- `verifiedApolloIds` (drives pass-2 multi-threading company targeting)
- `verifiedCount` returned from `enrichCandidates`

This was safe before this change because every row reaching those checks
had already been through Emailable, so `email_status` and `status` always
agreed. A suppressed/excluded row now keeps Apollo's **raw**
`email_status: 'verified'` (that's precisely why it matched) while carrying
`status: 'parked'`. All three call sites must switch from
`row.email_status === 'verified'` to `row.status === 'active'` — the field
that is already authoritative for "cleared to send" everywhere else
(`listActiveLeadsForCase`, the compose-contact filter on the case page).
Without this fix, a suppressed contact would still get grouped into a case
and counted as a live second-thread contact.

### Client-scoped dedup (item 4)

`getKnownSourceIds(supabase, campaignId)` becomes
`getKnownSourceIds(supabase, clientId)`, querying `.eq('client_id', clientId)`
instead of `.eq('campaign_id', campaignId)` — uses the existing
`idx_leads_client` index, no migration needed. Every call site in
`discover.ts` passes `campaign.clientId` instead of `campaign.id`.
`getVerifiedLeadCompanies` (which drives pass-2's *company* targeting, not
person dedup) stays campaign-scoped — cases are still keyed by
`(campaign_id, company_key)`, so per-campaign company-multi-threading logic
is unaffected.

### Campaign form (item 2)

Add a checkbox group to `new-campaign-form.tsx` for:
- `personSeniorities` — all `apolloPersonSeniorities` values, none checked
  by default
- `contactEmailStatuses` — all `apolloContactEmailStatuses` values,
  `'verified'` pre-checked by default

Both submit as string arrays through the existing form-to-`FormData`
pattern and validate against the existing `apolloIcpSchema` (already
accepts these fields — no schema change).

## Error Handling

- The new bulk suppression lookup is a DB query, not a vendor call — it
  follows the same pattern as `getKnownSourceIds`/`insertLeads` elsewhere
  in this file: on failure it throws `AppError('DB_ERROR', ...)`, which
  propagates to `runDiscoveryForCampaign`'s existing handling. **No
  fail-open here** — unlike Emailable (an external vendor whose outage
  shouldn't stall discovery), a failed suppression check must not silently
  let a possibly-bounced address through to Emailable spend and case
  creation. A DB failure fails the whole run, same as any other DB error
  in this file today.
- The post-enrich exclude check is pure in-memory string matching — no new
  failure mode.

## Observability

- Extend `DiscoverySummary` with two counters, mirroring the existing
  `emailableChecked`/`emailableDeliverable` style:
  `suppressedSkipped` and `excludedPostEnrich`.
- Each filtered row also gets its own `events` row —
  `pipeline.discover.suppressed_skipped` /
  `pipeline.discover.excluded_post_enrich` — with
  `payload: { leadSourceId, companyKey }`, same pattern as the existing
  `emailable.verify.failed` / `emailableFailedOpen` logging, visible on the
  campaign's Logs tab.

## Testing

Extends `discover.test.ts`, `group-lead.test.ts`, and the campaign-form
tests:

- Suppressed revealed email → row inserted `parked`, Emailable **never
  called** for that row (assert mock not invoked), event logged, never
  reaches `groupVerifiedLead`.
- Post-enrich exclude match (on industry/description only — not caught by
  the pre-enrich title/org-name check) → same parked/skip/event behavior.
- Regression test for the correctness fix: a suppressed row Apollo marked
  `verified` must not appear in `verifiedApolloIds`, must not increment
  `verifiedCount`, and must not trigger grouping.
- Client-scoped dedup: two campaigns under the same client, same Apollo
  person id → the second campaign's `runFirstPass` skips it.
- Campaign form: `personSeniorities`/`contactEmailStatuses` checkboxes
  round-trip through `apolloIcpSchema`; new-campaign default state has
  `contactEmailStatuses: ['verified']` pre-checked, `personSeniorities: []`.

## Rollout

No DB migration — no new enum values, no new columns, only application
logic plus one new form section. Backward compatible: existing campaigns'
`icp.personSeniorities` / `icp.contactEmailStatuses` stay `[]` (unchanged
search behavior) because **there is no campaign-edit UI today** — only
`new-campaign-form.tsx` exists. This spec does not add campaign editing;
these two filters are only settable at creation time for campaigns created
after this ships, same as every other ICP field today.

## Out of Scope

- Campaign editing (no such UI exists; not added here).
- Caching a single Apollo reveal for reuse across campaigns for the same
  person (rejected alternative for item 4 — see Decisions).
- Generic/role-based address filtering (`info@`, `sales@`, etc.) and
  operator-facing visibility into "found but never verified" companies —
  raised in prior discussion as separate follow-up ideas, not part of this
  spec.
