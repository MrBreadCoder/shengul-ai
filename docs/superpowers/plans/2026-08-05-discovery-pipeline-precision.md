# Discovery Pipeline Precision & Cost-Efficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop paying for Apollo/Emailable work on people who are already suppressed or excluded, expose two dead ICP filters, and dedup Apollo reveals per client instead of per campaign — per the approved design at `docs/superpowers/specs/2026-08-05-discovery-pipeline-precision-design.md`.

**Architecture:** All four changes live in the Stage 1 discovery pipeline (`src/lib/pipeline/discover.ts`) plus two small upstream libraries (`suppressions.ts`, `leads.ts`, `exclude-keywords.ts`) and the campaign-creation surface (`new-campaign-form.tsx`, `/api/campaigns/route.ts`). A new pre-Emailable filter step in `enrichCandidates()` parks (never drops) suppressed or post-enrich-excluded rows before they reach Emailable, which requires switching three `discover.ts` call sites from reading `email_status` to reading the always-authoritative `status` field.

**Tech Stack:** TypeScript, Next.js Server Actions/Route Handlers, Supabase (Postgres + RLS), Vitest, Zod, Radix `radix-ui` primitives.

## Global Constraints

- No DB migration — no new enum values, no new columns (per design's Rollout section).
- Suppression/dedup DB failures must propagate (`AppError('DB_ERROR', ...)`), never fail open — only Emailable vendor-outage failures fail open, per existing precedent in `discover.ts`.
- Filtered-but-not-Emailable-checked rows are inserted as `status: 'parked'` leads, never dropped, so client-wide dedup actually prevents re-revealing them later.
- `personSeniorities` defaults to none checked in the campaign form; `contactEmailStatuses` defaults to `['verified']` pre-checked.
- This plan does not add campaign editing — the two newly-exposed ICP filters are creation-time-only, same as every other ICP field today.
- This project's Vitest config runs with `environment: 'node'` (`vitest.config.ts:6`) — there is no jsdom/React Testing Library setup, and no existing `.test.tsx` files anywhere in `src/components/ui/` or `src/app/(app)/campaigns/`. UI-only tasks in this plan (Task 5, and the form half of Task 6) have no automated test step, matching that existing convention — verify them by running `npm run typecheck` and `npm run lint`, not a component test.

---

## Task 1: Bulk suppression lookup

**Files:**
- Modify: `src/lib/db/suppressions.ts`
- Test: `src/lib/db/suppressions.test.ts`

**Interfaces:**
- Produces: `getSuppressions(supabase: SupabaseClient<Database>, clientId: string, emails: string[]): Promise<Set<string>>` — returns the **normalized** (trimmed, lowercased) subset of `emails` that has a suppression row for `clientId`. Throws `AppError('DB_ERROR', ...)` on query failure.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/db/suppressions.test.ts`, importing `getSuppressions` alongside the existing imports on line 2, and adding a new mock helper next to `mockSuppressionLookup`:

```ts
import { describe, it, expect } from 'vitest'
import { isSuppressed, addSuppression, getSuppression, getSuppressions } from './suppressions'
import { AppError } from '@/lib/errors/app-error'

function mockInsert(result: { error: unknown }) {
  return { from: () => ({ upsert: () => Promise.resolve(result) }) } as never
}

function mockSuppressionLookup(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

function mockBulkSuppressionLookup(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ in: () => Promise.resolve(result) }) }),
    }),
  } as never
}
```

Then add a new `describe` block at the end of the file:

```ts
describe('getSuppressions', () => {
  it('should return the set of emails that are suppressed for this client', async () => {
    const result = await getSuppressions(
      mockBulkSuppressionLookup({ data: [{ email: 'a@b.com' }, { email: 'c@d.com' }], error: null }),
      'c1',
      ['a@b.com', 'c@d.com', 'e@f.com'],
    )
    expect(result).toEqual(new Set(['a@b.com', 'c@d.com']))
  })

  it('should return an empty set when none of the emails are suppressed', async () => {
    const result = await getSuppressions(mockBulkSuppressionLookup({ data: [], error: null }), 'c1', ['a@b.com'])
    expect(result).toEqual(new Set())
  })

  it('should normalize emails to lowercase and trimmed before querying', async () => {
    let queriedEmails: string[] = []
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            in: (_column: string, values: string[]) => {
              queriedEmails = values
              return Promise.resolve({ data: [], error: null })
            },
          }),
        }),
      }),
    } as never
    await getSuppressions(supabase, 'c1', ['  A@B.com  ', 'C@D.COM'])
    expect(queriedEmails).toEqual(['a@b.com', 'c@d.com'])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getSuppressions(mockBulkSuppressionLookup({ data: null, error: { message: 'boom' } }), 'c1', ['a@b.com']),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/db/suppressions.test.ts`
Expected: FAIL — `getSuppressions is not a function` / `TS2305: Module has no exported member 'getSuppressions'`.

- [ ] **Step 3: Implement `getSuppressions`**

In `src/lib/db/suppressions.ts`, add this function right after `getSuppression` (before `isSuppressed`):

```ts
// Bulk variant of getSuppression, used by discovery (src/lib/pipeline/discover.ts)
// to check every revealed email in one enrich batch with a single round trip
// instead of one query per candidate. Same case-insensitive normalization,
// same client scope. Returns the normalized emails that ARE suppressed —
// callers compare against their own normalized email to decide membership.
export async function getSuppressions(
  supabase: SupabaseClient<Database>,
  clientId: string,
  emails: string[],
): Promise<Set<string>> {
  const normalized = emails.map(normalizeEmail)
  const { data, error } = await supabase
    .from('suppressions')
    .select('email')
    .eq('client_id', clientId)
    .in('email', normalized)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to bulk-check suppressions', {
      clientId, count: emails.length, cause: error.message,
    })
  }
  return new Set((data ?? []).map((r) => r.email))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/db/suppressions.test.ts`
Expected: PASS — all `getSuppressions` tests plus the pre-existing `getSuppression`/`isSuppressed`/`addSuppression` tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/suppressions.ts src/lib/db/suppressions.test.ts
git commit -m "feat(suppressions): add bulk getSuppressions lookup

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: Post-enrich exclude-keyword matching

**Files:**
- Modify: `src/lib/apollo/exclude-keywords.ts`
- Test: `src/lib/apollo/exclude-keywords.test.ts`

**Interfaces:**
- Produces: extended `ExcludeKeywordCandidate` interface with two new **optional** fields (`organizationIndustry?: string | null`, `organizationDescription?: string | null`) and the same `matchesExcludedKeywords(candidate: ExcludeKeywordCandidate, excludeKeywords: string[]): boolean` signature — fully backward compatible with every existing call site that only passes `{ title, organizationName }`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/apollo/exclude-keywords.test.ts`, inside the existing `describe('matchesExcludedKeywords', ...)` block, after the last existing `it`:

```ts
  it('should match a keyword that only appears in organizationIndustry', () => {
    expect(
      matchesExcludedKeywords(
        { title: 'VP Sales', organizationName: 'Acme Corp', organizationIndustry: 'Staffing & Recruiting' },
        ['staffing'],
      ),
    ).toBe(true)
  })

  it('should match a keyword that only appears in organizationDescription', () => {
    expect(
      matchesExcludedKeywords(
        {
          title: 'VP Sales',
          organizationName: 'Acme Corp',
          organizationDescription: 'We are a staffing agency for finance teams.',
        },
        ['staffing agency'],
      ),
    ).toBe(true)
  })

  it('should treat missing organizationIndustry and organizationDescription as empty strings rather than throwing', () => {
    expect(
      matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Fintech' }, ['staffing']),
    ).toBe(false)
    expect(
      matchesExcludedKeywords(
        { title: 'VP Sales', organizationName: 'Acme Fintech', organizationIndustry: null, organizationDescription: null },
        ['staffing'],
      ),
    ).toBe(false)
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/apollo/exclude-keywords.test.ts`
Expected: FAIL — TypeScript error, `organizationIndustry` does not exist on type `ExcludeKeywordCandidate` (or, if TS is lenient here due to structural typing on an inline object literal, a runtime assertion failure since the current implementation never reads those fields).

- [ ] **Step 3: Extend `matchesExcludedKeywords`**

Replace the full contents of `src/lib/apollo/exclude-keywords.ts`:

```ts
interface ExcludeKeywordCandidate {
  title: string | null
  organizationName: string | null
  /** Only available after Apollo's enrich call (bulk_match) — absent on pre-enrich search candidates. */
  organizationIndustry?: string | null
  /** Only available after Apollo's enrich call (bulk_match) — absent on pre-enrich search candidates. */
  organizationDescription?: string | null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Apollo's People Search response exposes no server-side keyword-exclude
// filter and no organization keyword/industry text (see "Apollo API
// research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md),
// so pre-enrich exclusion is matched against the only text a search
// candidate carries: their employer's name and their own title. The enrich
// call (bulk_match) later exposes organizationIndustry/organizationDescription
// too — callers that have already enriched a candidate should pass those in
// as well, so a company the thinner pre-enrich text let through can still be
// caught (see src/lib/pipeline/discover.ts's post-enrich check).
//
// Matching is whole-word (\b...\b) so a short keyword like "agency" doesn't
// false-positive inside an unrelated word like "Emergency"; a multi-word
// keyword like "staffing agency" still matches as a literal phrase.
export function matchesExcludedKeywords(
  candidate: ExcludeKeywordCandidate,
  excludeKeywords: string[],
): boolean {
  const keywords = excludeKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
  if (keywords.length === 0) return false
  const haystack = [
    candidate.organizationName,
    candidate.title,
    candidate.organizationIndustry,
    candidate.organizationDescription,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase()
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(haystack))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/apollo/exclude-keywords.test.ts`
Expected: PASS — all new and pre-existing tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/exclude-keywords.ts src/lib/apollo/exclude-keywords.test.ts
git commit -m "feat(apollo): match exclude-keywords against post-enrich firmographics too

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: Client-scoped known-source-id dedup

**Files:**
- Modify: `src/lib/db/leads.ts:8-21`
- Test: `src/lib/db/leads.test.ts:40-57`

**Interfaces:**
- Produces: `getKnownSourceIds(supabase: SupabaseClient<Database>, clientId: string): Promise<Set<string>>` — same return type, param renamed from `campaignId` and the underlying query now filters on `client_id` instead of `campaign_id`.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/leads.test.ts`, update the `describe('getKnownSourceIds', ...)` block (lines 40-57) — rename the argument from `'camp1'` to `'client1'` to reflect the new scope, and add an explicit query-shape assertion:

```ts
describe('getKnownSourceIds', () => {
  it('should return a set of non-null source ids', async () => {
    const supabase = mockSupabase({ selectResult: { data: [{ source_id: 'a' }, { source_id: 'b' }], error: null } })
    const result = await getKnownSourceIds(supabase, 'client1')
    expect(result).toEqual(new Set(['a', 'b']))
  })

  it('should filter out null source ids', async () => {
    const supabase = mockSupabase({ selectResult: { data: [{ source_id: 'a' }, { source_id: null }], error: null } })
    const result = await getKnownSourceIds(supabase, 'client1')
    expect(result).toEqual(new Set(['a']))
  })

  it('should query leads scoped to client_id, not campaign_id', async () => {
    let queriedColumn = ''
    const supabase = {
      from: () => ({
        select: () => ({
          eq: (column: string) => {
            queriedColumn = column
            return { not: () => Promise.resolve({ data: [], error: null }) }
          },
        }),
      }),
    } as never
    await getKnownSourceIds(supabase, 'client1')
    expect(queriedColumn).toBe('client_id')
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = mockSupabase({ selectResult: { data: null, error: { message: 'boom' } } })
    await expect(getKnownSourceIds(supabase, 'client1')).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/leads.test.ts -t "getKnownSourceIds"`
Expected: FAIL on the new "should query leads scoped to client_id" test — current implementation calls `.eq('campaign_id', ...)`.

- [ ] **Step 3: Update `getKnownSourceIds`**

In `src/lib/db/leads.ts`, replace lines 8-21:

```ts
export async function getKnownSourceIds(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('leads')
    .select('source_id')
    .eq('client_id', clientId)
    .not('source_id', 'is', null)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load known lead source ids', { clientId, cause: error.message })
  }
  return new Set((data ?? []).map((r) => r.source_id).filter((v): v is string => v !== null))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/db/leads.test.ts -t "getKnownSourceIds"`
Expected: PASS — all four tests green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat(leads): scope known-source-id dedup to client, not campaign

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: Wire suppression + post-enrich exclude into discovery, fix status-vs-email_status gating

**Files:**
- Modify: `src/lib/pipeline/discover.ts`
- Test: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `getSuppressions` from Task 1 (`src/lib/db/suppressions.ts`), extended `matchesExcludedKeywords` from Task 2 (`src/lib/apollo/exclude-keywords.ts`), client-scoped `getKnownSourceIds` from Task 3 (`src/lib/db/leads.ts`).
- Produces: `DiscoverySummary` and `EnrichResult` both gain `suppressedSkipped: number` and `excludedPostEnrich: number`. `verifyBatch` gains a third parameter `skipVerification: Set<string>`. `enrichCandidates` gains a third parameter `supabase: SupabaseClient<Database>`.

This is the largest task — it touches one file end to end, so it's done as one reviewable unit rather than split, per the plan's task-sizing rule (splitting it would let a reviewer approve half of a single coherent behavior change).

- [ ] **Step 1: Add test mock plumbing for `getSuppressions`**

`discover.test.ts` currently never mocks `@/lib/db/suppressions`, so once `discover.ts` imports and calls `getSuppressions`, every existing test would crash calling the real implementation against a fake `{}` supabase object. Add the mock before any new test is written.

At the top of `src/lib/pipeline/discover.test.ts`, add a new hoisted mock next to the existing ones (after line 11, `mockVerifyEmail`):

```ts
const mockGetSuppressions = vi.hoisted(() => vi.fn())
```

Add a new `vi.mock` call next to the existing `@/lib/emailable/client` mock (after line 24):

```ts
vi.mock('@/lib/db/suppressions', () => ({ getSuppressions: mockGetSuppressions }))
```

Then add `mockGetSuppressions.mockReset()` and a default `mockGetSuppressions.mockResolvedValue(new Set())` to **all three** `beforeEach` blocks in the file:
- The main `describe('runDiscoveryForCampaign', ...)` block's `beforeEach` (currently lines 60-73)
- The `describe('runDiscoveryForCampaign — Emailable deliverability guard', ...)` block's `beforeEach` (currently lines 443-459)
- The `describe('apollo failure attribution', ...)` block's `beforeEach` (currently lines 611-620)

Example for the first block:

```ts
  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
  })
```

Apply the same two added lines (`mockGetSuppressions.mockReset()` in the reset block, `mockGetSuppressions.mockResolvedValue(new Set())` as a default) to the other two `beforeEach` blocks, in the same relative position next to the existing `mockVerifyEmail`/`mockGetKnownSourceIds` lines.

- [ ] **Step 2: Fix the two existing row-mocking helpers that are missing `status`**

Grep confirms three places in `discover.test.ts` manually construct the objects returned by the mocked `insertLeads` without a `status` field — today this doesn't matter because grouping gates on `email_status`, but after Step 6 below switches that gate to `status`, these would silently stop matching `'active'` and break tests that assert `mockGroupVerifiedLead` was called. Fix all three now, before writing new tests, so the later correctness-fix step doesn't need to touch the test file again:

In `src/lib/pipeline/discover.test.ts`, update the shared helper (currently lines 48-53):

```ts
function insertedRows(rows: { source_id: string | null | undefined; email_status?: string; status?: string }[]) {
  return rows.map((r, i) => ({
    id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
    email_status: r.email_status ?? 'verified',
    status: r.status ?? 'active',
  }))
}
```

Update the inline mock in the "should pass each lead's raw Apollo data through to groupVerifiedLead" test (currently lines 113-118):

```ts
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
        email_status: 'verified', status: 'active', raw: rawPayload,
      })),
    )
```

Update the inline mock in the "should default the quota to 50 when dailyTarget is 0" test (currently lines 227-231):

```ts
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
        email_status: 'verified', status: 'active',
      })),
    )
```

- [ ] **Step 3: Run the full existing suite to confirm it's still green before adding new behavior**

Run: `npx vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — mock plumbing added but `discover.ts` itself is unchanged, so behavior is identical.

- [ ] **Step 4: Write the failing tests for the new filter behavior**

Add a new `describe` block at the end of `src/lib/pipeline/discover.test.ts` (after the closing `})` of `describe('apollo failure attribution', ...)`):

```ts
describe('runDiscoveryForCampaign — suppression and post-enrich exclude filters', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  function singleCandidateRun() {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
  }

  it('should park a suppressed lead without calling Emailable, and never group it', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ email_status: 'verified', status: 'parked' })
    expect(summary.suppressedSkipped).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it('should log a pipeline.discover.suppressed_skipped event for a suppressed lead', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.suppressed_skipped',
      source: 'pipeline',
      payload: expect.objectContaining({ campaignId: 'camp1', leadSourceId: 'p1' }),
    }))
  })

  it('should park a lead that only matches an exclude keyword in post-enrich firmographics, without calling Emailable', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => ({ ...enriched(d.id, 'verified'), organizationIndustry: 'Staffing & Recruiting' })),
    )
    const icpWithExclude: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp: icpWithExclude },
    )

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ email_status: 'verified', status: 'parked' })
    expect(summary.excludedPostEnrich).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it('should not double-count a lead that is both suppressed and post-enrich excluded', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => ({ ...enriched(d.id, 'verified'), organizationIndustry: 'Staffing & Recruiting' })),
    )
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))
    const icpWithExclude: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp: icpWithExclude },
    )

    // Post-enrich exclude runs first and already parks the row, so the
    // suppression check (scoped to not-yet-skipped rows) never re-checks it.
    expect(summary.excludedPostEnrich).toBe(1)
    expect(summary.suppressedSkipped).toBe(0)
    expect(mockGetSuppressions).not.toHaveBeenCalled()
  })

  it('should never call getSuppressions with an empty email list', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockGetSuppressions).not.toHaveBeenCalled()
  })

  it('should still activate and group a lead that is neither suppressed nor excluded', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.suppressedSkipped).toBe(0)
    expect(summary.excludedPostEnrich).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should pass campaign.clientId, not campaign.id, to getKnownSourceIds', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockGetKnownSourceIds).toHaveBeenCalledWith({}, 'client1')
  })
})
```

Note: `verification` in the last test needs `mockVerifyEmail` set to `'deliverable'` — it already defaults to that in the main describe block's `beforeEach`, but this new describe block's `beforeEach` above does **not** set a `mockVerifyEmail` default, so it must be set explicitly per-test wherever a test expects Emailable to be called (as done above).

- [ ] **Step 5: Run tests to verify they fail**

Run: `npx vitest run src/lib/pipeline/discover.test.ts -t "suppression and post-enrich exclude filters"`
Expected: FAIL — `discover.ts` doesn't yet call `getSuppressions`, doesn't yet check post-enrich exclude keywords, and `summary.suppressedSkipped`/`summary.excludedPostEnrich` don't exist on the returned object.

- [ ] **Step 6: Implement the filter, and the status-vs-email_status correctness fix, in `discover.ts`**

In `src/lib/pipeline/discover.ts`, make the following changes in order:

**6a. Add the `getSuppressions` import** — after line 8 (`import { getKnownSourceIds, ... } from '@/lib/db/leads'`):

```ts
import { getSuppressions } from '@/lib/db/suppressions'
```

**6b. Add the two new counters to `DiscoverySummary`** — replace lines 35-49:

```ts
export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  firstPassCandidates: number
  secondPassCandidates: number
  enriched: number
  /** Leads that ended at `status: 'active'` — i.e. cleared for sending. */
  verified: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  /** Apollo-verified leads parked without an Emailable call: suppressed for this client. */
  suppressedSkipped: number
  /** Apollo-verified leads parked without an Emailable call: matched an exclude keyword post-enrich. */
  excludedPostEnrich: number
  inserted: number
}
```

**6c. Extend `verifyBatch` to accept a skip set** — replace lines 238-248 (the function signature and the `verifiable` build-up in `verifyBatch`):

```ts
/**
 * Runs the deliverability guard over one enrichment batch and returns the rows
 * with their final status applied.
 *
 * Emailable is called only for rows Apollo already marked `verified`, that
 * carry a real address, and that are not in `skipVerification` (already
 * parked upstream as suppressed or post-enrich excluded — see
 * enrichCandidates). Untouched rows keep the verdict Apollo (or the upstream
 * filter) gave them.
 */
async function verifyBatch(
  campaign: CampaignForDiscovery,
  batchRows: LeadInsert[],
  skipVerification: Set<string>,
): Promise<VerifyBatchResult> {
  const verifiable: VerifiableRow[] = []
  batchRows.forEach((row, index) => {
    if (row.email_status !== 'verified') return
    if (row.source_id && skipVerification.has(row.source_id)) return
    const { email } = row
    if (typeof email !== 'string' || email.length === 0) return
    verifiable.push({ index, row, email })
  })
```

(The rest of `verifyBatch`, from the `const verdicts = new Map...` line through its closing `return { rows, checked: ... }`, is unchanged.)

**6d. Delete the old doc comment above `verifyBatch`** that Step 6c already replaced (the original 4-line `/** ... */` comment starting `Runs the deliverability guard...` right before the old signature) — Step 6c's replacement includes the full new comment, so there should be exactly one comment block above the function, not two.

**6e. Add the `logDiscoveryFilterEvent` helper and rewrite `enrichCandidates`** — replace lines 288-364 (`EnrichResult` interface through the end of `enrichCandidates`):

```ts
interface EnrichResult {
  rows: LeadInsert[]
  /** Rows that ended at `status: 'active'` — i.e. actually cleared to send. */
  verifiedCount: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  suppressedSkipped: number
  excludedPostEnrich: number
}

// Best-effort, same reasoning as the pipeline.discover.group_lead_failed
// logging further down: a logging failure must never turn an
// already-decided filter outcome (the row is parked either way) into a
// failed discovery run.
async function logDiscoveryFilterEvent(
  campaign: CampaignForDiscovery,
  type: 'pipeline.discover.suppressed_skipped' | 'pipeline.discover.excluded_post_enrich',
  leadSourceId: string,
  companyKey: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type,
      source: 'pipeline',
      payload: { campaignId: campaign.id, leadSourceId, companyKey },
    })
  } catch {
    // Audit logging is best-effort.
  }
}

async function enrichCandidates(
  candidates: FreshCandidate[],
  campaign: CampaignForDiscovery,
  supabase: SupabaseClient<Database>,
): Promise<EnrichResult> {
  const { icp } = campaign
  const rows: LeadInsert[] = []
  let verifiedCount = 0
  let emailableChecked = 0
  let emailableDeliverable = 0
  let emailableRejected = 0
  let emailableFailedOpen = 0
  let suppressedSkipped = 0
  let excludedPostEnrich = 0

  for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + ENRICH_BATCH_SIZE)
    const enrichedPeople = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.enrich.failed', { batchSize: batch.length }),
      () =>
        withRetry(() =>
          bulkMatchPeople(
            batch.map((c) => ({
              id: c.apolloId,
              organizationName: c.organizationName ?? undefined,
              domain: c.organizationDomain ?? undefined,
              linkedinUrl: c.linkedinUrl ?? undefined,
            })),
          ),
        ),
    )

    const batchRows: LeadInsert[] = []
    // Apollo person ids parked without ever reaching Emailable — either the
    // post-enrich exclude-keyword check below matched, or the suppression
    // check further down matched. Apollo's raw email_status stays on the row
    // untouched (it may still read 'verified' — that is Apollo's true
    // verdict, not a lie), but `status` is forced to 'parked' so nothing
    // downstream mistakes these for send-eligible. `status`, not
    // `email_status`, is what every caller below and in
    // runDiscoveryForCampaign now checks for exactly this reason.
    const skipVerification = new Set<string>()

    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      const title = person.title ?? source?.title ?? null
      const companyName = person.organizationName ?? source?.organizationName ?? null
      const companyDomain = person.organizationDomain ?? source?.organizationDomain ?? null

      // Post-enrich exclude check: catches companies the pre-enrich pass-1/
      // pass-2 title+org-name check couldn't see, because industry and
      // description only exist after this enrich call.
      if (
        matchesExcludedKeywords(
          {
            title,
            organizationName: companyName,
            organizationIndustry: person.organizationIndustry,
            organizationDescription: person.organizationDescription,
          },
          icp.excludeKeywords,
        )
      ) {
        skipVerification.add(person.apolloId)
        excludedPostEnrich += 1
        await logDiscoveryFilterEvent(
          campaign,
          'pipeline.discover.excluded_post_enrich',
          person.apolloId,
          computeCompanyKey(companyDomain, companyName),
        )
      }

      batchRows.push({
        client_id: campaign.clientId,
        campaign_id: campaign.id,
        source_id: person.apolloId,
        full_name: fullName,
        title,
        company_name: companyName,
        company_domain: companyDomain,
        linkedin_url: person.linkedinUrl ?? source?.linkedinUrl ?? null,
        source: 'apollo',
        raw: { ...person },
        email: person.email,
        email_status: emailStatus,
        email_verified_at: null,
        status: 'parked',
        email_verification: null,
      })
    }

    // Suppression check: one bulk lookup per batch, client-scoped, for every
    // row not already parked above — a contact who already bounced or
    // unsubscribed for this client must never reach Emailable spend or case
    // grouping, no matter which campaign rediscovers them.
    const emailsToCheck = batchRows
      .filter((row) => row.source_id !== null && !skipVerification.has(row.source_id))
      .map((row) => row.email)
      .filter((email): email is string => typeof email === 'string' && email.length > 0)
    if (emailsToCheck.length > 0) {
      const suppressed = await getSuppressions(supabase, campaign.clientId, emailsToCheck)
      for (const row of batchRows) {
        if (row.source_id && row.email && suppressed.has(row.email.trim().toLowerCase())) {
          skipVerification.add(row.source_id)
          suppressedSkipped += 1
          await logDiscoveryFilterEvent(
            campaign,
            'pipeline.discover.suppressed_skipped',
            row.source_id,
            computeCompanyKey(row.company_domain, row.company_name),
          )
        }
      }
    }

    // The deliverability guard, not Apollo, has the final say on activation —
    // for every row not already parked above.
    const verified = await verifyBatch(campaign, batchRows, skipVerification)
    emailableChecked += verified.checked
    emailableDeliverable += verified.deliverable
    emailableRejected += verified.rejected
    emailableFailedOpen += verified.failedOpen
    for (const row of verified.rows) {
      if (row.status === 'active') verifiedCount += 1
      rows.push(row)
    }
  }

  return {
    rows,
    verifiedCount,
    emailableChecked,
    emailableDeliverable,
    emailableRejected,
    emailableFailedOpen,
    suppressedSkipped,
    excludedPostEnrich,
  }
}
```

**6f. Switch `runDiscoveryForCampaign` to client-scoped dedup** — in the function body, replace the line (originally line 372):

```ts
    const known = await getKnownSourceIds(supabase, campaign.id)
```

with:

```ts
    const known = await getKnownSourceIds(supabase, campaign.clientId)
```

**6g. Pass `supabase` into both `enrichCandidates` calls** — replace the pass-1 enrich line (originally line 392):

```ts
    const firstPassEnriched = await enrichCandidates(firstPass.picks, campaign, supabase)
```

and the pass-2 enrich line (originally line 424):

```ts
    const secondPassEnriched = await enrichCandidates(secondPass.picks, campaign, supabase)
```

**6h. Fix the `verifiedApolloIds` correctness bug** — replace lines 405-407:

```ts
    const verifiedApolloIds = new Set(
      firstPassEnriched.rows.filter((row) => row.status === 'active').map((row) => row.source_id),
    )
```

**6i. Fix the grouping-gate correctness bug** — replace line 435 (`if (lead.email_status !== 'verified') continue`):

```ts
      if (lead.status !== 'active') continue
```

**6j. Add the two new counters to the final summary** — in the `summary` object construction (originally lines 467-480), add two lines after `emailableFailedOpen`:

```ts
    const summary: DiscoverySummary = {
      campaignId: campaign.id,
      candidatesSeen,
      newCandidates: fresh.length,
      firstPassCandidates: firstPass.picks.length,
      secondPassCandidates: secondPass.picks.length,
      enriched: enrichedRows.length,
      verified: verifiedCount,
      emailableChecked: firstPassEnriched.emailableChecked + secondPassEnriched.emailableChecked,
      emailableDeliverable: firstPassEnriched.emailableDeliverable + secondPassEnriched.emailableDeliverable,
      emailableRejected: firstPassEnriched.emailableRejected + secondPassEnriched.emailableRejected,
      emailableFailedOpen: firstPassEnriched.emailableFailedOpen + secondPassEnriched.emailableFailedOpen,
      suppressedSkipped: firstPassEnriched.suppressedSkipped + secondPassEnriched.suppressedSkipped,
      excludedPostEnrich: firstPassEnriched.excludedPostEnrich + secondPassEnriched.excludedPostEnrich,
      inserted: inserted.length,
    }
```

- [ ] **Step 7: Run the new tests to verify they pass**

Run: `npx vitest run src/lib/pipeline/discover.test.ts -t "suppression and post-enrich exclude filters"`
Expected: PASS — all 8 new tests green.

- [ ] **Step 8: Run the entire discover.test.ts suite as a regression check**

Run: `npx vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — every pre-existing test (main describe, Emailable guard describe, apollo failure attribution describe) still green, confirming Step 2's row-mock fixes and the `status`-based gating change didn't break anything.

- [ ] **Step 9: Typecheck**

Run: `npm run typecheck`
Expected: no errors — confirms `enrichCandidates`'s new `supabase` parameter and `verifyBatch`'s new `skipVerification` parameter are threaded correctly at every call site.

- [ ] **Step 10: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "feat(discover): filter suppressed/excluded leads before Emailable spend

Parks Apollo-verified leads that are suppressed for the client or match an
exclude keyword only visible post-enrich, without spending an Emailable
call on them. Fixes three call sites that incorrectly treated Apollo's raw
email_status as the final send-eligibility signal instead of status.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: Checkbox UI primitive

**Files:**
- Create: `src/components/ui/checkbox.tsx`

**Interfaces:**
- Produces: `Checkbox` component, `React.ComponentProps<typeof CheckboxPrimitive.Root>` props (so it accepts `name`, `value`, `defaultChecked`, `id`, `className`, `required`, etc., matching plain HTML checkbox semantics via Radix).

No test step — see the Global Constraints note: this project has no jsdom/component-test setup, and no existing `.test.tsx` file to model one on. Verify via typecheck/lint instead.

- [ ] **Step 1: Create the component**

Write `src/components/ui/checkbox.tsx`, following the exact same construction pattern as `src/components/ui/select.tsx` (the `radix-ui` combined package, `cn` from `@/lib/utils`, `data-slot` attributes, standard shadcn token classes already used throughout this UI kit):

```tsx
"use client"

import * as React from "react"
import { Checkbox as CheckboxPrimitive } from "radix-ui"
import { Check as CheckIcon } from "@phosphor-icons/react"

import { cn } from "@/lib/utils"

function Checkbox({
  className,
  ...props
}: React.ComponentProps<typeof CheckboxPrimitive.Root>) {
  return (
    <CheckboxPrimitive.Root
      data-slot="checkbox"
      className={cn(
        "peer border-input dark:bg-input/30 data-[state=checked]:bg-primary data-[state=checked]:text-primary-foreground dark:data-[state=checked]:bg-primary data-[state=checked]:border-primary focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive size-4 shrink-0 rounded-[4px] border shadow-xs transition-shadow outline-none focus-visible:ring-[3px] disabled:cursor-not-allowed disabled:opacity-50",
        className
      )}
      {...props}
    >
      <CheckboxPrimitive.Indicator
        data-slot="checkbox-indicator"
        className="flex items-center justify-center text-current transition-none"
      >
        <CheckIcon className="size-3.5" weight="bold" />
      </CheckboxPrimitive.Indicator>
    </CheckboxPrimitive.Root>
  )
}

export { Checkbox }
```

- [ ] **Step 2: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/checkbox.tsx
git commit -m "feat(ui): add Checkbox primitive

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: Expose personSeniorities and contactEmailStatuses end to end

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Test: `src/app/api/campaigns/route.test.ts`
- Modify: `src/app/(app)/campaigns/new-campaign-form.tsx`

**Interfaces:**
- Consumes: `Checkbox` from Task 5, `apolloPersonSeniorities` and `apolloContactEmailStatuses` (already exported from `src/lib/apollo/types.ts`).

`createCampaignSchema` in `route.ts` currently does not declare `personSeniorities`/`contactEmailStatuses` at all, and the object passed to `apolloIcpSchema.parse({...})` only lists the six fields that exist today — so even if the form sent these two fields, the route would silently drop them before they ever reach `apolloIcpSchema`. Both the route and the form need fixing for this filter to actually take effect; fixing only the form would leave the route as a second, hidden dead end.

- [ ] **Step 1: Write the failing route test**

Add to `src/app/api/campaigns/route.test.ts`, after the existing "should pass exclude filters through into the stored ICP" test:

```ts
  it('should pass personSeniorities and contactEmailStatuses through into the stored ICP', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({
      ...validBody,
      personSeniorities: ['vp', 'director'],
      contactEmailStatuses: ['verified'],
    }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({
          personSeniorities: ['vp', 'director'],
          contactEmailStatuses: ['verified'],
        }),
      }),
    )
  })

  it('should default personSeniorities and contactEmailStatuses to empty arrays when omitted', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({ personSeniorities: [], contactEmailStatuses: [] }),
      }),
    )
  })

  it('should reject an unrecognized seniority value with a 400', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })

    const res = await POST(req({ ...validBody, personSeniorities: ['not_a_real_seniority'] }))

    expect(res.status).toBe(400)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/app/api/campaigns/route.test.ts`
Expected: FAIL — the first two new tests fail because `icp.personSeniorities`/`icp.contactEmailStatuses` are `undefined` (never forwarded), the third fails because there is no validation on that field yet to reject with 400 (an unrecognized string is silently accepted, or the field is dropped entirely so nothing is even validated).

- [ ] **Step 3: Fix the route**

In `src/app/api/campaigns/route.ts`, update the import (line 7) to also bring in the enum arrays:

```ts
import { apolloIcpSchema, apolloPersonSeniorities, apolloContactEmailStatuses } from '@/lib/apollo/types'
```

Add the two fields to `createCampaignSchema` (after `excludeKeywords` on line 25):

```ts
const createCampaignSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1),
  valueProp: z.string().min(1),
  bookingLink: z.string().url().nullable().default(null),
  dailyTarget: z.number().int().min(1).max(100).default(50),
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nullable().default(null),
  employeeRangeMax: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  excludeOrganizationLocations: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  personSeniorities: z.array(z.enum(apolloPersonSeniorities)).default([]),
  contactEmailStatuses: z.array(z.enum(apolloContactEmailStatuses)).default([]),
})
```

Forward both fields into the `apolloIcpSchema.parse({...})` call (currently lines 36-44):

```ts
    const icp = apolloIcpSchema.parse({
      personTitles: body.personTitles,
      organizationLocations: body.organizationLocations,
      employeeRangeMin: body.employeeRangeMin,
      employeeRangeMax: body.employeeRangeMax,
      keywords: body.keywords,
      excludeOrganizationLocations: body.excludeOrganizationLocations,
      excludeKeywords: body.excludeKeywords,
      personSeniorities: body.personSeniorities,
      contactEmailStatuses: body.contactEmailStatuses,
    })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/app/api/campaigns/route.test.ts`
Expected: PASS — all tests green, including the pre-existing ones (unaffected by the additive schema change).

- [ ] **Step 5: Commit the route fix**

```bash
git add src/app/api/campaigns/route.ts src/app/api/campaigns/route.test.ts
git commit -m "fix(campaigns): forward personSeniorities and contactEmailStatuses to Apollo ICP

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

- [ ] **Step 6: Add the checkbox groups to the campaign form**

In `src/app/(app)/campaigns/new-campaign-form.tsx`:

Add imports (after the existing `Select` import block, currently ending line 17):

```ts
import { Checkbox } from '@/components/ui/checkbox'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from '@/lib/apollo/types'
```

Add two label maps and a `getAll`-based read helper near the top of the file, after `splitCsv` (currently lines 26-31):

```ts
const SENIORITY_LABELS: Record<(typeof apolloPersonSeniorities)[number], string> = {
  owner: 'Owner',
  founder: 'Founder',
  c_suite: 'C-Suite',
  partner: 'Partner',
  vp: 'VP',
  head: 'Head',
  director: 'Director',
  manager: 'Manager',
  senior: 'Senior',
  entry: 'Entry',
  intern: 'Intern',
}

const CONTACT_EMAIL_STATUS_LABELS: Record<(typeof apolloContactEmailStatuses)[number], string> = {
  verified: 'Verified',
  unverified: 'Unverified',
  'likely to engage': 'Likely to engage',
  unavailable: 'Unavailable',
}

function getAllStrings(formData: FormData, name: string): string[] {
  return formData.getAll(name).map(String)
}
```

Read both fields in `onSubmit` — add two lines to the `body` object (currently lines 73-86), right after `excludeKeywords`:

```ts
    const body = {
      clientId,
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
    }
```

Add the two checkbox groups to the ICP `fieldset`, right before its closing `</fieldset>` tag (currently right after the "Exclude keywords" `Field`, before line 280):

```tsx
        <Field id="personSeniorities" label="Target seniority" hint="Leave all unchecked to search every seniority.">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {apolloPersonSeniorities.map((value) => (
              <label key={value} htmlFor={`personSeniorities-${value}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`personSeniorities-${value}`}
                  name="personSeniorities"
                  value={value}
                  toolparamdescription="One seniority level to include. Leave all unchecked to search every level Apollo recognizes."
                />
                {SENIORITY_LABELS[value]}
              </label>
            ))}
          </div>
        </Field>

        <Field
          id="contactEmailStatuses"
          label="Contact email status"
          hint="Restricts Apollo's own search to contacts already at this status, before a credit is spent revealing them. Leave all unchecked to search every status."
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {apolloContactEmailStatuses.map((value) => (
              <label key={value} htmlFor={`contactEmailStatuses-${value}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`contactEmailStatuses-${value}`}
                  name="contactEmailStatuses"
                  value={value}
                  defaultChecked={value === 'verified'}
                  toolparamdescription="One Apollo contact-email-status value to restrict search to. 'Verified' is checked by default. Leave all unchecked to search every status."
                />
                {CONTACT_EMAIL_STATUS_LABELS[value]}
              </label>
            ))}
          </div>
        </Field>
```

- [ ] **Step 7: Typecheck and lint**

Run: `npm run typecheck && npm run lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add src/app/\(app\)/campaigns/new-campaign-form.tsx
git commit -m "feat(campaigns): expose personSeniorities and contactEmailStatuses filters

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final Verification

- [ ] Run the full test suite: `npm run test`
  Expected: PASS, zero failures.
- [ ] Run the typechecker: `npm run typecheck`
  Expected: no errors.
- [ ] Run the linter: `npm run lint`
  Expected: no errors.
- [ ] Update `.claude/roadmap.md` with what shipped, per the project's standing instruction to update it on every increment of progress.
