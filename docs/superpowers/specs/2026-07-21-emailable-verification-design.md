# Emailable Deliverability Guard

**Date:** 2026-07-21
**Status:** Approved design, not yet implemented

## Problem

Today a lead is activated on Apollo's word alone. `enrichCandidates`
(`src/lib/pipeline/discover.ts`) maps Apollo's `email_status` through
`mapApolloEmailStatus` and writes `status: 'active'` for anything Apollo calls
`verified`; everything else is parked. Apollo publishes ~>90% accuracy on
`verified`, which means roughly one in ten activated leads may be a bounce
waiting to happen.

The goal is **zero bounces for our clients** and protection of their sending
reputation. This is a deliverability problem, not a yield problem — we are not
trying to rescue parked leads, and Apollo's verified-yield is not currently
believed to be too low.

`.claude/architecture.md §12` and `§13` already park this exact remedy as the
documented backlog option: *"a secondary verifier (e.g. Emailable) layered on
top of Apollo's `verified` status."* This spec activates it.

Emailable therefore acts **only as a narrowing filter**. It can demote a lead
Apollo called verified. It can never promote one Apollo did not.

## Vendor reference (Emailable API, verified 2026-07-21)

| | |
|---|---|
| Base URL | `https://api.emailable.com/v1/` |
| Auth | `api_key` query parameter |
| Endpoint used | `GET /v1/verify?email=…&api_key=…&timeout=5` |
| Other params | `smtp` (default `true`, keep), `accept_all` (default `false`, keep), `timeout` 2–10s |
| Rate limit | 25 req/s on `/v1/verify`; 429 returns `{"message":"Rate Limit Exceeded"}` plus `ratelimit-limit` / `ratelimit-remaining` / `ratelimit-reset` headers |
| Status codes | `249` try again · `400` bad request · `401` no key · `402` insufficient credits · `403` invalid key · `404` not found · `429` too many requests · `500` · `503` |
| Error body | `{ "message": string }` |
| Cost | ~$0.002–0.006 per verification; `unknown` results are free/refunded |

Response fields: `state`, `reason`, `score` (0–100), `accept_all`, `disposable`,
`role`, `free`, `no_reply`, `mailbox_full`, `did_you_mean`, `domain`,
`mx_record`, `smtp_provider`, `user`, `tag`, `duration`, `email`, `first_name`,
`last_name`, `full_name`, `gender`.

`state` values: `deliverable`, `risky`, `undeliverable`, `unknown`, and
`duplicate` (batch lists only — unreachable on `/v1/verify`).

`reason` values by state:

| State | Reasons |
|---|---|
| `deliverable` | `accepted_email` |
| `risky` | `low_quality`, `low_deliverability` |
| `undeliverable` | `invalid_email`, `invalid_domain`, `rejected_email`, `invalid_smtp` |
| `unknown` | `no_connect`, `timeout`, `unavailable_smtp`, `unexpected_error` |

## Decisions

These were settled during brainstorming and are not open questions:

1. **Purpose:** deliverability guard, not yield recovery.
2. **Placement:** at discovery, immediately after Apollo enrichment — a rejected
   lead never consumes Research Agent or Email-Writer LLM cost.
3. **Send policy:** strict. Only `state: 'deliverable'` may be activated.
4. **Failure policy:** **blanket fail open.** Any Emailable call failure — of any
   kind, including a persistent `402` or `403` — falls back to Apollo's verdict
   and activates the lead. Chosen deliberately by the operator so discovery
   never stalls. The residual bounce exposure is recorded under Risks and is
   accepted.
5. **Single endpoint, not batch.** `/v1/batch` needs polling or a publicly
   reachable callback URL; at ≤50 emails per campaign run it buys nothing.
6. **Schema:** one nullable `jsonb` column. Everything else the feature needs
   already exists on `leads`.

### Amendment — 2026-08-08

Decision 3 above ("only `deliverable` activates") is narrowed, not reversed.
One week of live data showed the `risky` bucket running ~62% of verified
leads, and a direct query of production rows found it was **100%**
`accept_all: true` + `reason: 'low_deliverability'` — i.e. Emailable
reporting "this domain accepts everything, I cannot confirm this specific
mailbox," not "this address is bad." Emailable's own guidance agrees risky
does not mean do-not-send, and recommends segmenting rather than dropping
these. `low_quality` risky results were not seen in the sample and remain
under the original strict policy.

New policy: `risky` activates when, and only when, `reason ===
'low_deliverability'` and `accept_all === true`. Every other case in the
original decision table — `undeliverable`, `unknown`, unrecognized states,
and `risky`/`low_quality` — parks exactly as originally designed. The
existing per-mailbox bounce-rate health monitoring (P4 deliverability
hardening) and DSN-based bounce handling (`handleBounce`) are the safety
net for this cohort; no new guard was added.

Implementation: `docs/superpowers/plans/2026-08-08-emailable-accept-all-catch-all.md`.

## Architecture

New module `src/lib/emailable/`, mirroring `src/lib/apollo/`:

```
src/lib/emailable/
  types.ts             # Zod schema + EmailableResult + VerificationOutcome
  client.ts            # verifyEmail() — GET /v1/verify via fetchJson
  map-verification.ts  # pure: outcome -> { emailStatus, leadStatus, verification }
```

The only call site is `enrichCandidates` in `src/lib/pipeline/discover.ts`.
Both discovery passes already funnel through it, so first-pass and second-pass
picks are guarded by one change. Nothing downstream moves: `groupVerifiedLead`
already keys off `email_status === 'verified'`, and a lead that fails the guard
never reaches `verified`, so it is never grouped into a case and never written
to or sent.

### Decision table

Emailable is called **only** for leads where
`mapApolloEmailStatus(person.emailStatus) === 'verified'` **and** `person.email`
is a non-empty string. Every other lead is parked exactly as it is today, at no
credit cost, because under the strict policy Emailable could not promote it
anyway.

| Apollo verdict | Emailable outcome | `email_status` | `status` | `email_verified_at` |
|---|---|---|---|---|
| not `verified` | *not called* | as mapped today | `parked` | `null` |
| `verified`, email null/empty | *not called* | `not_found` | `parked` | `null` |
| `verified` | `deliverable` | `verified` | `active` | now |
| `verified` | `undeliverable` | `invalid` | `parked` | `null` |
| `verified` | `risky` | `risky` | `parked` | `null` |
| `verified` | `unknown` | `unverified` | `parked` | `null` |
| `verified` | unrecognized `state` | `unverified` | `parked` | `null` |
| `verified` | **call failed** | `verified` | `active` | now |

Two rows deserve emphasis because they look similar and are not:

- **Unrecognized `state`** is a *successful* response we do not understand. It is
  a definite answer, so it parks. This follows the same defensive rule as
  `mapApolloEmailStatus`: a status we cannot positively identify never
  activates a lead.
- **Call failed** is the *absence* of an answer. It fails open per decision 4.

No enum migration is needed for `lead_email_status` — `invalid` already exists in
the enum (`src/types/database.ts:637`) and is currently unused by any code path.

`score` is stored but never branched on. The strict policy is expressed purely in
terms of `state`; adding a score threshold would be a second, redundant
gate. Likewise `role`, `disposable`, `no_reply` and `mailbox_full` are stored
and not acted on — they were considered and explicitly left out of the policy.

## Components

### `src/lib/emailable/types.ts`

```ts
export const emailableResultSchema = z.object({ … }).passthrough()
export type EmailableResult = z.infer<typeof emailableResultSchema>

export type VerificationOutcome =
  | { ok: true; result: EmailableResult }
  | { ok: false; error: string }
```

`state` and `reason` are typed `z.string()`, not a `z.enum`, and narrowed in
`map-verification.ts`. A new vendor state must not turn a parseable response
into a schema error — the decision table already has a safe destination for an
unrecognized state, and that is a better failure mode than falling into the
fail-open branch. `.passthrough()` matches the Apollo client's convention and
keeps unmodelled fields available for the audit column.

Nullable fields per the vendor docs: `accept_all`, `did_you_mean`, `first_name`,
`last_name`, `full_name`, `gender`, `smtp_provider`, `tag`.

### `src/lib/emailable/client.ts`

```ts
export async function verifyEmail(email: string): Promise<EmailableResult>
```

Builds `https://api.emailable.com/v1/verify` with `email`, `api_key` (from
`env.EMAILABLE_API_KEY`), and `timeout=5`, and delegates to the existing
`fetchJson` helper with `emailableResultSchema` and a **10s** transport timeout —
headroom over the vendor's own 5s ceiling so our abort never fires before
theirs. `fetchJson` already maps an abort to `EXTERNAL_TIMEOUT` and any non-2xx
to `EXTERNAL_ERROR` with the status and a truncated body, so no status-code
branching is needed here: under blanket fail-open every non-success is treated
identically by the caller.

The API key goes in the query string because that is the only auth mechanism the
documented endpoint accepts. This creates a secret-leak hazard that
`apollo/client.ts` does not have: `fetchJson` puts its `url` argument into
`AppError` context on every failure path, and that context is written to the
events table and rendered on the operator-facing Logs tab.

**Resolution:** add an optional fifth parameter to `fetchJson`:

```ts
export async function fetchJson<T>(
  url: string,
  options: RequestInit,
  schema: ZodType<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  logUrl: string = url,   // used in AppError context instead of `url`
): Promise<T>
```

Additive, defaults to today's behaviour, so no existing caller changes.
`verifyEmail` passes the same URL with `api_key` replaced by `REDACTED`.
Rejected alternatives: `POST /v1/verify` with a form body (the rate-limit table
lists `GET/POST`, but no documented example shows POST parameters — not worth
betting the integration on); and catching-and-rethrowing inside `verifyEmail`
(loses `fetchJson`'s status/body context, and any future caller re-introduces
the leak).

### `src/lib/emailable/map-verification.ts`

```ts
export interface LeadVerificationVerdict {
  emailStatus: Database['public']['Enums']['lead_email_status']
  leadStatus: Database['public']['Enums']['lead_status']
  verification: Json
}

export function mapEmailableVerdict(outcome: VerificationOutcome): LeadVerificationVerdict
```

Pure, no I/O, total over its input — the whole decision table lives here and is
100% unit-testable. It builds the `verification` payload too:

- success → the full `EmailableResult` plus `{ provider: 'emailable' }`
- failure → `{ provider: 'emailable', outcome: 'failed', error, checkedAt }`

### `src/lib/pipeline/discover.ts` (modified)

Inside `enrichCandidates`, after the `bulkMatchPeople` loop builds each row:

1. Partition the batch's rows into those eligible for verification (Apollo
   `verified` **and** non-empty email) and those not.
2. Verify eligible rows in slices of `VERIFY_CONCURRENCY = 5` via `Promise.all`.
   Each verification is individually wrapped so it resolves to a
   `VerificationOutcome` rather than rejecting — `Promise.all` must not
   short-circuit a slice, because every lead needs its own verdict.
   5 concurrent requests against a 25 req/s limit needs no token bucket.
3. Apply `mapEmailableVerdict` to each outcome and overwrite `email_status`,
   `status`, `email_verified_at`, and `email_verification` on the row.

Each `verifyEmail` call is wrapped in
`withExternalLogging('emailable', { clientId, actor: 'system', failureType:
'emailable.verify.failed', payload: { campaignId, domain } })` so a vendor
outage lands on the client's Logs tab exactly like an Apollo outage.
`withExternalLogging` rethrows untouched; the per-lead wrapper catches and
converts to `{ ok: false }`.

The payload carries the email **domain**, never the address — the full address
and full response live in the row's `email_verification` column, which is
access-controlled by the same RLS as the lead itself, whereas events are shown
in an operator-facing feed.

`DiscoverySummary` gains four fields:

```ts
emailableChecked: number      // eligible leads sent to Emailable
emailableDeliverable: number  // state === 'deliverable'
emailableRejected: number     // parked by a definite Emailable verdict
emailableFailedOpen: number   // activated on Apollo's word after a failure
```

The existing `verified` field is redefined as **the number of leads that ended
at `email_status: 'verified'`** — i.e. the count actually activated, including
fail-open ones. This keeps the existing Logs sentence
(`"N leads found, M with a verified email"`) truthful without touching it.

## Data model

One migration: `supabase/migrations/0011_lead_email_verification.sql`

```sql
-- Emailable's per-lead verdict, kept out of `raw` (documented as the Apollo
-- person object). Nullable with no backfill: an existing row reads NULL,
-- meaning "discovered before the deliverability guard existed", which is
-- accurate. Under blanket fail-open this column is the only durable record of
-- whether a lead was actually guarded — the events log is purged at 30/90 days.
alter table leads add column email_verification jsonb;

-- `withExternalLogging('emailable', ...)` writes events.source, which is this
-- enum. Adding a value is allowed inside a transaction on PG12+ so long as the
-- value is not *used* in the same transaction; nothing below references it.
alter type log_source add value if not exists 'emailable';
```

No index. Nothing queries this column on a hot path; it is read per-lead for
audit. An index would be speculative.

Why this column is justified at all — the guard makes three existing
`email_status` values ambiguous, and one of those matters:

| Value | Means | …or |
|---|---|---|
| `risky` | Apollo `catch_all` | Emailable `low_quality` / `low_deliverability` |
| `unverified` | Apollo `unverified` / `update_required` | Emailable `unknown` |
| `verified` | Emailable confirmed deliverable | **Emailable was unreachable; Apollo's word alone** |

The last row is a direct consequence of decision 4. Without a per-lead record,
"which of my active leads were never actually verified" is unanswerable once
`0010_event_logging.sql`'s retention cron has purged the run events.

Regenerate `src/types/database.ts` after the migration: `leads.Row` /
`leads.Insert` gain `email_verification`, and `log_source` gains `'emailable'`.

## Observability

- `src/types/logs.ts` — add `'emailable'` to `LOG_SOURCES`.
- `src/lib/ui/log.ts` — add an `emailable` entry to `LOG_SOURCE_META`:
  `{ label: 'Emailable', color: 'var(--status-hot-handoff)' }`. That is the one
  `--status-*` variable no other `LOG_SOURCE_META` entry uses, so the eight
  existing sources keep distinct colours. `Record<LogSource, …>` makes this a
  compile error if forgotten, which is the desired behaviour.
- `src/lib/ui/log.ts` — add a `SENTENCE_BUILDERS` entry:
  `'emailable.verify.failed': (p) => \`Email verification failed for a lead at ${domain}: ${errorMessage}.\``
- `pipeline.discover.completed` already logs the whole `DiscoverySummary`, so the
  four new counters land in the events payload with no change. Extend its
  sentence builder to name the guard when it was bypassed, e.g. append
  `" N activated without verification."` when `emailableFailedOpen > 0` — this
  is the operator's only in-product signal that the guard was off.

## Environment

- `src/lib/env.ts` — add `EMAILABLE_API_KEY: nonEmpty` to `envSchema`.
- `src/lib/env.test.ts` — add the key to the `complete` fixture and assert it is
  rejected when blank, matching the existing per-key pattern.
- `.env.example` — add `EMAILABLE_API_KEY=` under the pipeline providers block.
- `.claude/settings.local.json` — the two allowlisted `pnpm dev` / `pnpm build`
  commands already carry `EMAILABLE_API_KEY=fake` from before the key was
  removed; verify both still match after any edit.

## Testing

TDD, no network in any test.

**`map-verification.test.ts`** — 100% coverage, it is a pure function:
every row of the decision table; each of the four `undeliverable` reasons; each
of the four `unknown` reasons; both `risky` reasons; an unrecognized `state`
string parks rather than fails open; a failure outcome produces
`verified`/`active` and a `verification` payload with `outcome: 'failed'`.

**`client.test.ts`** — mocked `fetch`: valid response parses; response missing a
required field throws `EXTERNAL_ERROR`; `402`, `403`, `429`, `500`, `503` and
`249` each throw `EXTERNAL_ERROR` with the status in context; an abort throws
`EXTERNAL_TIMEOUT`; and the API key never appears in the thrown `AppError`'s
serialized context.

**`fetch-json.test.ts`** (extended) — the new `logUrl` parameter appears in
`AppError` context in place of `url` on both the non-2xx and the abort paths,
and omitting it preserves today's behaviour for every existing caller.

**`discover.test.ts`** (extended) —
`deliverable` → `active`, grouped into a case, `email_verification` populated;
`undeliverable` → `parked`, `email_status: 'invalid'`, `groupVerifiedLead` not
called; `risky` and `unknown` → `parked`; `verifyEmail` throws → lead is
`active` with `outcome: 'failed'` recorded and `emailableFailedOpen` incremented;
**`verifyEmail` is never called for a lead Apollo did not mark verified**;
`verifyEmail` is never called when `person.email` is null;
one lead's verification failure does not affect the other leads in its slice;
`DiscoverySummary` counters are correct across a mixed batch spanning both
discovery passes.

## Documentation to update

`.claude/architecture.md` currently asserts in four places that Emailable is
removed. All four need real edits, not a footnote:

- §3 diagram — the line `"reveals + verifies email in the same call — no LLM, no Emailable"`
- §4 component inventory — add the guard as a deterministic system; revise the
  "Changed from v1" note
- §5 `leads` — document `email_verification`
- §12 risk entry and §13 out-of-scope entry — both name Emailable as a
  *deferred* option; move it to shipped and record the fail-open decision

`.claude/roadmap.md` — new entry, per the standing instruction to update it on
every increment.

## Out of scope

Deliberately excluded, each considered and rejected during design:

- **Rescuing parked leads.** Emailable never promotes. This is a guard, not a
  yield fix.
- **Re-verification / staleness re-check** before follow-up sends.
- **Auto re-verification of fail-open leads** on a later discovery run.
- **Score thresholds** and shape-based blocking on `role`, `disposable`,
  `no_reply`, `mailbox_full` — stored, not acted on.
- **`/v1/batch`** and the `/v1/account` credit-balance endpoint.
- **Retry/backoff on 429.** Our own concurrency ceiling of 5 keeps us at ~5 req/s
  against a 25 req/s limit, so a 429 would indicate a bug, not normal load — and
  under blanket fail-open it resolves to activation regardless.
- **`email_verification_source` column.** Derivable from the jsonb; adding it
  would be indexing for a query nobody has written.

## Risks

1. **Yield drop of unknown magnitude.** Accept-all corporate domains — very
   common on Microsoft 365 — return `risky` and will now be parked. This is the
   intended behaviour of a strict policy, but the size of the effect is unknown
   until it runs against live data. `emailableRejected` in the discovery summary
   measures it from day one; revisit the policy with that number in hand rather
   than by guessing now.
2. **Blanket fail-open leaves the guard silently off.** A persistent `402`
   (out of credits) or `403` (rotated/invalid key) does not stall discovery and
   does not stop activation — it disables bounce protection for as long as it
   lasts, which for a billing or credentials problem can be days. The only
   signals are the `emailable.verify.failed` error events and the
   `emailableFailedOpen` counter. Accepted by explicit operator decision; noted
   here so the trade is on the record and re-openable with real bounce data.
3. **Cost.** ~$0.002–0.006 per Apollo-verified lead, charged on top of Apollo
   credits. Only Apollo-verified leads are checked, which bounds it; `unknown`
   results are free.
4. **Second vendor in the discovery hot path.** Discovery now depends on two
   external services instead of one. Fail-open means an outage degrades quality
   rather than availability, which is the correct direction for uptime and the
   wrong one for the stated goal — see risk 2.
