# AI Relevance Filter for Discovery (Company Last-Pass)

**Date:** 2026-08-06
**Status:** Approved design, not yet implemented

## Problem

Apollo's deterministic filters (`personTitles`, `keywords`, org-name exclude,
post-enrich industry/description exclude — see
`docs/superpowers/specs/2026-08-05-discovery-pipeline-precision-design.md`)
still let through companies that technically match the configured filters but
are not actually a good-fit prospect for a campaign: wrong business type,
adjacent-but-unrelated industry, a company Apollo mis-categorized. These get
an Emailable-verified contact, group into a case, and get researched/written
to before anyone notices they were never a real fit. There is no judgment
call over whether a genuinely deliverable lead's *company* is worth pursuing
for *this* campaign.

## Decisions

- **Input signal — existing fields only.** The AI judges relevance from
  `campaign.name`, `campaign.value_prop`, `icp.keywords`, and
  `icp.excludeKeywords`. No new campaign field, no migration. (Trade-off
  accepted: `value_prop` is sales copy, not a target-customer description, so
  the judgment leans on whatever signal `keywords`/`excludeKeywords` carry.)
- **Company-level only, not person-level.** The prompt carries company
  firmographics (name, domain, industry, employee count, founded year,
  description, city/state/country) and deliberately excludes the lead's own
  title — Apollo's `personTitles`/`personSeniorities` filters already
  constrain role fit; this filter is scoped to "is this company a real
  prospect at all."
- **Cached per company, per discovery run.** Because the judgment is
  company-only, a `Map<companyKey, RelevanceVerdict>` is created once in
  `runDiscoveryForCampaign` and threaded into both the pass-1 and pass-2
  `enrichCandidates` calls. A pass-2 second contact at a company pass-1
  already approved reuses that verdict — zero extra Gemini calls.
- **Ordering: before Emailable, in the existing skipVerification cascade —
  and gated to the same eligibility Emailable itself requires.** See
  Architecture below. Rejected by user's own final call after weighing the
  alternative (running after Emailable as a literal "last pass") against this
  codebase's existing cost-ordering principle (cheap checks gate expensive
  vendor calls) — Emailable credits are the more expensive resource, and
  nothing about company relevance depends on email deliverability, so there
  is no reason to spend an Emailable credit before the AI has a chance to
  reject the company for free.
- **Reject outcome: `status: 'parked'`.** Existing `lead_status` enum value,
  no migration. Same auditable pattern as the suppression/exclude-keyword
  filters it sits beside.
- **Failure mode: fail-open.** A Gemini error/timeout treats the company as
  passing (never blocks Emailable), counted and logged separately — mirrors
  Emailable's own existing fail-open convention
  (`emailable/map-verification.ts`: "any failure... falls back... rather than
  stalling discovery").
- **Always-on for every campaign.** No toggle, no migration. YAGNI — no
  stated need yet to disable it per campaign.
- **Model: `gemini-3.1-flash-lite`, not the pipeline's shared default**
  (`gemini-3-flash-preview` in `src/lib/llm/client.ts`). This check can run
  once per distinct new company on every active campaign's every discovery
  run — a lighter/cheaper model is the right choice for a single yes/no
  classification with a ~150-token output ceiling.

## Architecture & Data Flow

### `src/lib/llm/client.ts` — small shared change

`generateJson`'s `GenerateJsonArgs<T>` gains an optional `modelId?: string`
field. When present, the call uses `google(modelId)` instead of the
module-level default `model` (built from `MODEL_ID`). `logUsage`/
`logLlmFailure` record the *effective* model id used (the override, or
`MODEL_ID` when omitted), not always the module constant, so the Logs tab
correctly attributes usage to whichever model actually ran. Every existing
caller (`research.ts`, `write.ts`, `followup.ts`, etc.) omits the field and
is unaffected.

### New module: `src/lib/pipeline/ai-relevance.ts`

- `RelevanceVerdict = { pass: boolean; reason: string }`
- `CompanySnapshot` — company name/domain/industry/employeeCount/
  foundedYear/description/city/state/country, sourced directly from the
  already-typed `ApolloEnrichedPerson` fields available in `enrichCandidates`
  (no re-parsing `leads.raw` JSON needed, unlike `group-lead.ts`'s post-hoc
  parse).
- `checkCompanyRelevance(context: LlmCallContext, campaign: CampaignForDiscovery, company: CompanySnapshot): Promise<RelevanceVerdict>`
  — calls `generateJson` with `modelId: 'gemini-3.1-flash-lite'`, a small
  schema (`z.object({ pass: z.boolean(), reason: z.string().min(1).max(300) })`),
  and a fixed instructions string framing the model as a lead-qualification
  judge: reject only on a clear mismatch (wrong industry/business type/
  clearly unrelated); when uncertain, pass. `maxOutputTokens` kept small
  (~150) since the schema is tiny.

### Integration in `discover.ts`'s `enrichCandidates`

Extends the existing `skipVerification` cascade (suppression check → post-
enrich exclude-keywords check — see the 2026-08-05 precision spec) with a
third stage, in this order:

```
for each row not already in skipVerification:
  1. suppression check            (existing)
  2. post-enrich exclude-keywords (existing)
  3. AI relevance check           (new)         ← only rows still eligible
                                                    for Emailable reach this
  then → verifyBatch (Emailable), unchanged
```

The AI stage only runs on rows that are **also** still eligible for
Emailable — `email_status === 'verified'` (Apollo's own verdict), not
already in `skipVerification`, with a non-empty `email` — mirroring
`verifyBatch`'s own `verifiable` filter exactly. A row that can never reach
`active` regardless of company relevance (because Apollo itself didn't mark
its email verified) is not worth an AI call either.

Within that eligible set:
1. Group by `computeCompanyKey(row.company_domain, row.company_name)` (same
   helper `group-lead.ts` already exports).
2. For each distinct company_key not already in the run-level
   `aiVerdictCache`, call `checkCompanyRelevance`, concurrency-capped by a
   new `AI_RELEVANCE_CONCURRENCY = 5` constant (mirrors `VERIFY_CONCURRENCY`'s
   reasoning: conservative default, not tuned to a documented Gemini RPM
   ceiling).
3. Store the verdict in `aiVerdictCache` (a real verdict, or the fail-open
   placeholder — see Error Handling) and apply it to every eligible row
   sharing that company_key: `pass` → row proceeds to `verifyBatch`
   unchanged; `!pass` → added to `skipVerification`, `status: 'parked'`,
   `email_status` left as Apollo's raw verdict (same "raw verdict stays,
   only `status` flips" pattern the suppression/exclude checks already use).

`verifiedApolloIds`/`verifiedCompanyCounts` (pass-2 targeting) already key
off `row.status === 'active'` — the correctness fix the 2026-08-05 spec
already made. An AI-rejected pass-1 pick therefore automatically drops out of
pass-2 targeting with no extra code.

## Error Handling

- `checkCompanyRelevance` calls `generateJson`, which already wraps Gemini
  errors/timeouts as `AppError`. The `discover.ts` caller catches per
  company_key: on failure, cache `{ pass: true, reason: 'ai_check_failed' }`
  for that key (fail-open), increment `aiFailedOpen`, and log
  `pipeline.discover.ai_check_failed` (best-effort, same
  `logDiscoveryFilterEvent`-style helper already in `discover.ts`).
- A rejection (`pass: false`) is not an error — same non-throwing shape as
  every other filter in this file.

## Observability

- `DiscoverySummary` gains `aiChecked`, `aiRejected`, `aiFailedOpen` (mirrors
  the existing `emailableChecked`/`emailableRejected`/`emailableFailedOpen`
  triad).
- Each rejection logs `pipeline.discover.ai_rejected` with
  `payload: { leadSourceId, companyKey, reason }` (the model's own reason
  string) — visible on the campaign's Logs tab, same as
  `excluded_post_enrich`/`suppressed_skipped`.
- Each fail-open logs `pipeline.discover.ai_check_failed` with
  `payload: { companyKey, error }`.
- `generateJson`'s own `llm.completed`/`llm.failed` logging (token usage,
  duration, effective model id) already fires for every call via
  `logUsage`/`logLlmFailure` — nothing new needed there beyond the model-id
  fix described above.

## Testing

Extends `discover.test.ts` (mocking `checkCompanyRelevance`, same pattern as
the existing `verifyEmail`/`bulkMatchPeople` mocks):

- AI rejects a company → row inserted `parked`, Emailable **never called**
  for that row, never reaches `groupVerifiedLead`, `pipeline.discover.ai_rejected`
  logged, `aiRejected` counter incremented.
- AI approves → row proceeds to Emailable unchanged.
- Two eligible rows sharing a company_key (a pass-1 pick and a pass-2 second
  contact at the same company) → `checkCompanyRelevance` called exactly once
  for that company_key (cache-hit asserted via mock call count).
- A row already parked by suppression or post-enrich exclude before reaching
  this stage never triggers a `checkCompanyRelevance` call.
- A row Apollo did not mark `email_status: 'verified'` never triggers a
  `checkCompanyRelevance` call (eligibility gate matches `verifyBatch`).
- AI call throws → row proceeds to Emailable unchanged (fail-open),
  `aiFailedOpen` incremented, `pipeline.discover.ai_check_failed` logged.

New unit test file `ai-relevance.test.ts` for `checkCompanyRelevance` itself:
prompt/schema construction, pass path, reject path, mocking `generateJson`.

`llm/client.test.ts` (or equivalent) gains a case for `generateJson`'s new
`modelId` override: passing it calls `google(modelId)` instead of the
default, and the usage log records the override, not `MODEL_ID`.

## Rollout

No DB migration. No new campaign field. No new env var (`GEMINI_API_KEY`
already required for the module's existing calls). Applies to every
campaign's next discovery run automatically. Not retroactive — existing
`active`/`parked` leads and already-created cases from prior runs are
untouched; this is a discovery-time filter only.

## Out of Scope

- Retroactively re-checking existing `active` leads/cases against this
  filter.
- A campaign-level on/off toggle (rejected — always-on).
- Surfacing the AI's reason in any client/operator-facing UI beyond the
  existing Logs tab (no new UI component).
- Person-level (title/seniority) AI judgment — Apollo's own filters already
  constrain that; this filter is company-relevance only, which is also why
  the verdict is cacheable per company.
- Changing `generateText`/`generateWithTools`/`embedTexts` to accept a model
  override — only `generateJson` needs it for this feature; the others are
  left as-is.
