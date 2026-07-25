# Apollo Exclude-Filters (Locations + Keywords) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a campaign's ICP exclude companies by HQ location and by keyword (company-name/title match), both in the Apollo discovery pipeline and in the `/campaigns` creation form.

**Architecture:** Extends the existing `src/lib/apollo/` ICP system (`docs/superpowers/plans/2026-07-18-p1-apollo-discovery.md`) with two new filters on `ApolloIcpFilters`. `excludeOrganizationLocations` maps directly to Apollo's `organization_not_locations[]` search parameter (a real, server-side Apollo filter — confirmed below). `excludeKeywords` has **no** confirmed Apollo API equivalent, so it is applied as a post-fetch, client-side filter over the only text fields Apollo's People Search response actually returns for a candidate's employer (`organization.name`) plus the candidate's own `title` — see "Apollo API research" below for why.

**Tech Stack:** Next.js 16 (App Router) · TypeScript 5 (strict) · Zod 4 · Vitest · pnpm. No new dependencies, no DB migration (`campaigns.icp` is `jsonb`, schema-free at the DB layer).

## Apollo API research (do not re-derive — verified this session)

- `organization_not_locations[]` — **confirmed real.** Cross-checked against three independent sources: (1) Apollo's own web-app UI exposes an "Exclude locations" control on company HQ location in People Search; (2) a normalized third-party mirror of Apollo's Organization Search reference (`mindcloud.co/docs/universal/rest/apollo/latest/actions/organization-search`) lists it verbatim as `organizationNotLocations[]` under an explicit "Exclusion Filter" section, with the description "Exclude companies from search results based on the location of the company headquarters"; (3) general web search consensus. People Search and Organization Search share the same underlying organization-filter engine — `organization_locations[]` itself is already documented on both endpoints — so `organization_not_locations[]` is expected to work identically on the People Search endpoint this codebase calls (`POST /mixed_people/api_search`). Apollo's own `docs.apollo.io/reference/people-api-search` page is a JS-rendered ReadMe.io page that returns an incomplete snapshot to automated fetches (it's missing several other already-shipped params like `q_organization_domains_list[]` too, despite this codebase using that param successfully per `build-search-params.ts`) — so its absence from that scrape is not evidence it doesn't exist.
- Keyword exclusion — **no confirmed Apollo API parameter.** The Apollo web app has an "Exclude keywords" UI checkbox, but no mirror or docs source found this session names its underlying API parameter (unlike `organization_not_locations[]`, which a docs mirror names explicitly). Guessing a parameter name and sending it to Apollo would silently no-op (Apollo ignores unknown params) — that's a worse failure mode than not filtering at all, since operators would believe the exclusion is active when it isn't. Separately, `src/lib/apollo/client.ts`'s `organizationSchema` (and Apollo's People Search response shape generally) only exposes `organization.name`, `primary_domain`, `website_url` — no `keywords` or `industry` text — so even a working server-side keyword-exclude param wouldn't have richer text to match against than what's already visible client-side. Given both facts, `excludeKeywords` is implemented as a pure post-fetch filter over `organizationName` + `title`, the same fields already available on every `ApolloSearchCandidate`.
- **If a real Apollo key is later provisioned**, spot-check `organization_not_locations[]` against a live `mixed_people/api_search` call before fully trusting it in production — nothing in this plan requires a live key (same convention as the original P1 plan: every task is unit-tested against mocked HTTP).

## Global Constraints

- TypeScript `strict: true`, no `any` — carried from `.claude/QUALITY.md`.
- Zod validates every external boundary (route bodies, Apollo HTTP responses) — `.claude/QUALITY.md`.
- DB columns are snake_case, TS types are camelCase, mapped explicitly — not relevant here since `campaigns.icp` is `jsonb` (no migration, no column mapping needed).
- Named exports only for `src/lib/**` files; default exports only for Next.js pages/components — `.claude/BEHAVIORS.md`.
- Vitest, Arrange-Act-Assert, colocated `*.test.ts` — `.claude/QUALITY.md`.
- Tick `.claude/roadmap.md` after the relevant task, per `CLAUDE.md`.
- Every task ends in its own commit — no `--amend`, no bundling unrelated files.

---

### Task 1: Add exclude filters to the Apollo ICP schema

**Files:**
- Modify: `src/lib/apollo/types.ts`
- Modify: `src/lib/apollo/types.test.ts`
- Modify: `src/lib/apollo/build-search-params.test.ts` (fixture only — kept compiling)
- Modify: `src/lib/pipeline/discover.test.ts` (fixture only — kept compiling)

**Interfaces:**
- Produces: `ApolloIcpFilters` gains `excludeOrganizationLocations: string[]` and `excludeKeywords: string[]`, both Zod-defaulted to `[]`. Consumed by Task 2 (`build-search-params.ts`) and Task 4 (`discover.ts`).

- [ ] **Step 1: Write the failing test**

Add to `src/lib/apollo/types.test.ts`, inside the existing `describe('apolloIcpSchema', ...)` block:

```ts
  it('should default excludeOrganizationLocations and excludeKeywords to empty arrays', () => {
    const result = apolloIcpSchema.parse({})
    expect(result.excludeOrganizationLocations).toEqual([])
    expect(result.excludeKeywords).toEqual([])
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/apollo/types.test.ts`
Expected: FAIL — `result.excludeOrganizationLocations` is `undefined`, not `[]` (the schema has no such field yet).

- [ ] **Step 3: Implement the schema change**

Replace the full contents of `src/lib/apollo/types.ts`:

```ts
import { z } from 'zod'

// Maps directly to Apollo's documented People Search filters
// (POST /mixed_people/api_search). Apollo's public API has no separate
// "industries" filter, so any industry terms an operator wants to target
// go into `keywords` (sent as the free-text `q_keywords` param).
// Apollo's documented enum values for person_seniorities[]
export const apolloPersonSeniorities = [
  'owner', 'founder', 'c_suite', 'partner', 'vp', 'head', 'director', 'manager', 'senior', 'entry', 'intern',
] as const

// Apollo's documented enum values for contact_email_status[]
export const apolloContactEmailStatuses = [
  'verified', 'unverified', 'likely to engage', 'unavailable',
] as const

export const apolloIcpSchema = z.object({
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nonnegative().nullable().default(null),
  employeeRangeMax: z.number().int().nonnegative().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  personSeniorities: z.array(z.enum(apolloPersonSeniorities)).default([]),
  contactEmailStatuses: z.array(z.enum(apolloContactEmailStatuses)).default([]),
  // organization_not_locations[] — confirmed Apollo exclude filter, see
  // "Apollo API research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md.
  excludeOrganizationLocations: z.array(z.string()).default([]),
  // No confirmed Apollo API parameter for keyword exclusion exists — this is
  // applied client-side in src/lib/apollo/exclude-keywords.ts, not sent to Apollo.
  excludeKeywords: z.array(z.string()).default([]),
}).refine(
  (data) => data.employeeRangeMin === null || data.employeeRangeMax === null || data.employeeRangeMin <= data.employeeRangeMax,
  { message: 'employeeRangeMin must be less than or equal to employeeRangeMax', path: ['employeeRangeMin'] },
)

export type ApolloIcpFilters = z.infer<typeof apolloIcpSchema>

export interface ApolloSearchCandidate {
  apolloId: string
  firstName: string
  lastNamePreview: string | null
  title: string | null
  organizationName: string | null
  organizationDomain: string | null
  linkedinUrl: string | null
}

export interface ApolloEnrichedPerson {
  apolloId: string
  firstName: string | null
  lastName: string | null
  title: string | null
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  organizationName: string | null
  organizationDomain: string | null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/types.test.ts`
Expected: PASS

- [ ] **Step 5: Update dependent fixtures so the rest of the suite still compiles**

`ApolloIcpFilters` is now a stricter type (two more required keys), so the two hand-written fixture literals typed as `ApolloIcpFilters` elsewhere need the new keys or `tsc`/Vitest's type-checking will fail.

In `src/lib/apollo/build-search-params.test.ts`, update `emptyIcp`:

```ts
const emptyIcp: ApolloIcpFilters = {
  personTitles: [],
  organizationLocations: [],
  employeeRangeMin: null,
  employeeRangeMax: null,
  keywords: [],
  personSeniorities: [],
  contactEmailStatuses: [],
  excludeOrganizationLocations: [],
  excludeKeywords: [],
}
```

In `src/lib/pipeline/discover.test.ts`, update the top-level `icp` fixture:

```ts
const icp: ApolloIcpFilters = {
  personTitles: ['vp sales'], organizationLocations: [], employeeRangeMin: null, employeeRangeMax: null, keywords: [],
  personSeniorities: [], contactEmailStatuses: [], excludeOrganizationLocations: [], excludeKeywords: [],
}
```

- [ ] **Step 6: Run the full affected suite to confirm no regressions**

Run: `pnpm vitest run src/lib/apollo src/lib/pipeline/discover.test.ts`
Expected: PASS — all existing tests plus the new one green.

- [ ] **Step 7: Commit**

```bash
git add src/lib/apollo/types.ts src/lib/apollo/types.test.ts src/lib/apollo/build-search-params.test.ts src/lib/pipeline/discover.test.ts
git commit -m "feat: add excludeOrganizationLocations and excludeKeywords to Apollo ICP schema"
```

---

### Task 2: Emit `organization_not_locations[]` from `excludeOrganizationLocations`

**Files:**
- Modify: `src/lib/apollo/build-search-params.ts`
- Modify: `src/lib/apollo/build-search-params.test.ts`

**Interfaces:**
- Consumes: `ApolloIcpFilters.excludeOrganizationLocations` (Task 1).
- Produces: `buildPeopleSearchParams` now emits `params['organization_not_locations[]']` when non-empty. No signature change.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/apollo/build-search-params.test.ts`, inside the existing `describe('buildPeopleSearchParams', ...)` block:

```ts
  it('should omit the exclude-locations filter when none are given', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['organization_not_locations[]']).toBeUndefined()
  })

  it('should pass excluded organization locations through as organization_not_locations[]', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, excludeOrganizationLocations: ['ireland', 'india'] }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['organization_not_locations[]']).toEqual(['ireland', 'india'])
  })
```

- [ ] **Step 2: Run tests to verify the second one fails**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: FAIL on "should pass excluded organization locations through" — `params['organization_not_locations[]']` is `undefined` (the builder doesn't read the field yet).

- [ ] **Step 3: Implement**

Replace the full contents of `src/lib/apollo/build-search-params.ts`:

```ts
import type { ApolloIcpFilters } from './types'

export function buildPeopleSearchParams(
  icp: ApolloIcpFilters,
  page: number,
  perPage: number,
  organizationDomains: string[] = [],
): Record<string, string | string[]> {
  const params: Record<string, string | string[]> = {
    page: String(page),
    per_page: String(perPage),
  }
  if (icp.personTitles.length > 0) {
    params['person_titles[]'] = icp.personTitles
  }
  if (icp.organizationLocations.length > 0) {
    params['organization_locations[]'] = icp.organizationLocations
  }
  if (icp.excludeOrganizationLocations.length > 0) {
    // organization_not_locations[] — confirmed Apollo exclude filter, see
    // "Apollo API research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md.
    params['organization_not_locations[]'] = icp.excludeOrganizationLocations
  }
  if (icp.employeeRangeMin !== null && icp.employeeRangeMax !== null) {
    params['organization_num_employees_ranges[]'] = [`${icp.employeeRangeMin},${icp.employeeRangeMax}`]
  }
  if (icp.keywords.length > 0) {
    params.q_keywords = icp.keywords.join(' ')
  }
  if (icp.personSeniorities.length > 0) {
    params['person_seniorities[]'] = icp.personSeniorities
  }
  if (icp.contactEmailStatuses.length > 0) {
    params['contact_email_status[]'] = icp.contactEmailStatuses
  }
  // Second-pass targeting (src/lib/pipeline/discover.ts runSecondPass):
  // restricts the search to specific companies so discovery can go back for
  // a second contact. Confirmed against Apollo's People Search API docs
  // (docs.apollo.io/reference/people-api-search).
  if (organizationDomains.length > 0) {
    params['q_organization_domains_list[]'] = organizationDomains
  }
  return params
}
```

Note: `excludeKeywords` is deliberately **not** referenced here — it has no Apollo query-param equivalent (see plan header). It's consumed in Task 3/4 instead.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/build-search-params.ts src/lib/apollo/build-search-params.test.ts
git commit -m "feat: send excludeOrganizationLocations as Apollo's organization_not_locations[] filter"
```

---

### Task 3: `matchesExcludedKeywords` — client-side keyword-exclude predicate

**Files:**
- Create: `src/lib/apollo/exclude-keywords.ts`
- Test: `src/lib/apollo/exclude-keywords.test.ts`

**Interfaces:**
- Produces: `matchesExcludedKeywords(candidate: { title: string | null; organizationName: string | null }, excludeKeywords: string[]): boolean`. Consumed by Task 4 (`discover.ts`), which also calls it with `title: null` to test organization-name-only matches (see Task 4 for why).

Matching is **whole-word**, not substring — a naive `haystack.includes(keyword)` makes `"agency"` match inside `"Emergency"`, which is a real false-positive risk for short keywords. Each keyword is also `trim()`ed and empty entries are dropped defensively (an empty string would otherwise match every candidate via `\b\b`), since this function may be called with data that reached it through an API boundary, not just the trimmed/filtered form-CSV path.

- [ ] **Step 1: Write the failing test**

Create `src/lib/apollo/exclude-keywords.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { matchesExcludedKeywords } from './exclude-keywords'

describe('matchesExcludedKeywords', () => {
  it('should return false when no keywords are excluded', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing' }, [])).toBe(false)
  })

  it('should return true when the organization name contains an excluded keyword, case-insensitively', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing Agency' }, ['staffing'])).toBe(true)
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'ACME STAFFING' }, ['Staffing'])).toBe(true)
  })

  it('should return true when the title contains an excluded keyword', () => {
    expect(matchesExcludedKeywords({ title: 'Recruiting Consultant', organizationName: 'Acme' }, ['recruiting'])).toBe(true)
  })

  it('should return false when neither field contains any excluded keyword', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Fintech' }, ['staffing', 'agency'])).toBe(false)
  })

  it('should treat null title and organizationName as empty strings rather than throwing', () => {
    expect(matchesExcludedKeywords({ title: null, organizationName: null }, ['staffing'])).toBe(false)
  })

  it('should not match a keyword that only appears as a substring of a larger word', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Emergency Medical Group' }, ['agency'])).toBe(false)
  })

  it('should match a multi-word keyword phrase as a whole unit', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing Agency' }, ['staffing agency'])).toBe(true)
  })

  it('should trim whitespace and ignore blank keywords', () => {
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Staffing' }, ['  staffing  '])).toBe(true)
    expect(matchesExcludedKeywords({ title: 'VP Sales', organizationName: 'Acme Fintech' }, ['', '   '])).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/apollo/exclude-keywords.test.ts`
Expected: FAIL — `Cannot find module './exclude-keywords'`

- [ ] **Step 3: Implement**

Create `src/lib/apollo/exclude-keywords.ts`:

```ts
interface ExcludeKeywordCandidate {
  title: string | null
  organizationName: string | null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Apollo's People Search response exposes no server-side keyword-exclude
// filter and no organization keyword/industry text (see "Apollo API
// research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md),
// so exclusion is matched against the only text a candidate actually
// carries: their employer's name and their own title. Matching is
// whole-word (\b...\b) so a short keyword like "agency" doesn't
// false-positive inside an unrelated word like "Emergency"; a multi-word
// keyword like "staffing agency" still matches as a literal phrase.
export function matchesExcludedKeywords(
  candidate: ExcludeKeywordCandidate,
  excludeKeywords: string[],
): boolean {
  const keywords = excludeKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
  if (keywords.length === 0) return false
  const haystack = `${candidate.organizationName ?? ''} ${candidate.title ?? ''}`.toLowerCase()
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(haystack))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/exclude-keywords.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/exclude-keywords.ts src/lib/apollo/exclude-keywords.test.ts
git commit -m "feat: add matchesExcludedKeywords client-side filter for Apollo candidates"
```

---

### Task 4: Apply exclusions inside the discovery pipeline

**Files:**
- Modify: `src/lib/pipeline/discover.ts`
- Modify: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `matchesExcludedKeywords` (Task 3), `ApolloIcpFilters.excludeKeywords` (Task 1). `excludeOrganizationLocations` needs no code change here — it already flows to Apollo transparently via `buildPeopleSearchParams` (Task 2), which both `runFirstPass` and `runSecondPass` already call.

`runSecondPass` additionally gets an efficiency fix: when an excluded candidate's **organization name alone** (not their title) matches an excluded keyword, the company is permanently dropped from `remainingTargets` immediately, instead of staying in the domain-scoped search until `MAX_SEARCH_PAGES` is exhausted. This is safe specifically because `organizationName` is a company-level attribute — every employee Apollo returns for that domain will carry the same name, so no future page can ever produce a non-excluded candidate there. A **title-only** match is person-specific (a different employee at the same company can have a different title), so it only skips that one candidate and leaves the company in `remainingTargets` for a possible different second contact. `runFirstPass` doesn't get this optimization: it has no `remainingTargets`-style persistent per-company search budget to short-circuit — each page is a broad ICP sweep, not a query scoped to a fixed set of companies, so there's nothing to prune ahead of time.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/pipeline/discover.test.ts`, inside the existing `describe('runDiscoveryForCampaign', ...)` block:

```ts
  it('should skip a pass-1 candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [
          { ...candidate('p1', 'p1.com'), organizationName: 'Acme Staffing Agency' },
          candidate('p2', 'p2.com'),
        ],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2: no second contacts
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.firstPassCandidates).toBe(1)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p2' })])
  })

  it('should skip a pass-1 candidate whose title matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['recruiting'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'p1.com'), title: 'Recruiting Manager' }],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2: nothing
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.firstPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip a pass-2 candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p5', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // pass 2, page 1: excluded
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 2: empty, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.secondPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should permanently drop a pass-2 target company whose organization name alone matches an excluded keyword, without waiting for page exhaustion', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([
      { companyDomain: 'acme.com', companyName: 'Acme' },
      { companyDomain: 'other.com', companyName: 'Other' },
    ])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // pass 2, page 1: acme.com's only candidate is excluded by org name -> dropped immediately
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [candidate('p2', 'other.com')],
      }) // pass 2, page 2: only other.com is still targeted
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    const secondPageParams = mockSearchPeople.mock.calls[2]![0] as Record<string, string | string[]>
    expect(secondPageParams['q_organization_domains_list[]']).toEqual(['other.com'])
    expect(summary.secondPassCandidates).toBe(1)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p2' })])
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL on all four new tests — `excludeKeywords` isn't read anywhere yet, so the "Acme Staffing Agency" / "Recruiting Manager" candidates get picked instead of skipped (`summary.firstPassCandidates` is `2`/`1` instead of the expected `1`/`0`, etc), and the org-name-only drop test fails because `acme.com` is never removed early, so page 2's `q_organization_domains_list[]` still includes it instead of only `['other.com']`.

- [ ] **Step 3: Implement**

In `src/lib/pipeline/discover.ts`, add the import (alongside the existing ones near the top of the file):

```ts
import { matchesExcludedKeywords } from '@/lib/apollo/exclude-keywords'
```

Replace `runFirstPass` with:

```ts
async function runFirstPass(
  icp: ApolloIcpFilters,
  quota: number,
  known: Set<string>,
  companyPickCounts: Map<string, number>,
  domainBackedCompanyKeys: Set<string>,
): Promise<SearchPassResult> {
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  for (let page = 1; page <= MAX_SEARCH_PAGES && picks.length < quota; page++) {
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE)
    const { candidates } = await searchPeople(params)
    candidatesSeen += candidates.length
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      if (picks.length >= quota) break
      if (matchesExcludedKeywords(candidate, icp.excludeKeywords)) continue
      if (known.has(candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      const companyKey = computeCompanyKey(candidate.organizationDomain, candidate.organizationName)
      if (companyPickCounts.has(companyKey)) continue
      companyPickCounts.set(companyKey, 1)
      if (candidate.organizationDomain) domainBackedCompanyKeys.add(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
  }
  return { picks, candidatesSeen }
}
```

Replace `runSecondPass` with:

```ts
async function runSecondPass(
  icp: ApolloIcpFilters,
  quota: number,
  known: Set<string>,
  firstPassPicks: FreshCandidate[],
  targetDomains: string[],
  companyPickCounts: Map<string, number>,
): Promise<SearchPassResult> {
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const remainingTargets = new Set(targetDomains)
  let page = 1
  for (let pagesSearched = 0; pagesSearched < MAX_SEARCH_PAGES && picks.length < quota && remainingTargets.size > 0; pagesSearched++) {
    const targetsBefore = remainingTargets.size
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE, [...remainingTargets])
    const { candidates } = await searchPeople(params)
    candidatesSeen += candidates.length
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      if (picks.length >= quota) break
      const companyKey = computeCompanyKey(candidate.organizationDomain, candidate.organizationName)
      // Organization-name-only check: this is a company-level attribute, so
      // if it alone disqualifies the candidate, no other employee at the
      // same domain will ever pass either — drop the target now instead of
      // re-querying this company on every remaining page.
      if (matchesExcludedKeywords({ title: null, organizationName: candidate.organizationName }, icp.excludeKeywords)) {
        remainingTargets.delete(companyKey)
        continue
      }
      // Title-only (or title+org) match: person-specific, so only this
      // candidate is skipped — a different employee at the same company may
      // still be a valid second contact.
      if (matchesExcludedKeywords(candidate, icp.excludeKeywords)) continue
      if (known.has(candidate.apolloId)) continue
      if (firstPassPicks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (!remainingTargets.has(companyKey)) continue
      companyPickCounts.set(companyKey, (companyPickCounts.get(companyKey) ?? 0) + 1)
      remainingTargets.delete(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
    page = remainingTargets.size === targetsBefore ? page + 1 : 1
  }
  return { picks, candidatesSeen }
}
```

(`runFirstPass` only gains the `if (matchesExcludedKeywords(...)) continue` line, placed right after the quota check. `runSecondPass` additionally moves `companyKey` computation earlier and adds the organization-name-only pre-check described above — `page` still resets to `1` whenever `remainingTargets` shrinks, whether from an early drop or a real pick, so the existing page-reset logic in the last line needs no change.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — all prior tests plus the 4 new ones green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "feat: skip Apollo candidates matching an excluded keyword in both discovery passes"
```

---

### Task 5: Accept exclude filters in the campaign-creation API route

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Modify: `src/app/api/campaigns/route.test.ts`

**Interfaces:**
- Consumes: `apolloIcpSchema` (Task 1).
- Produces: `POST /api/campaigns` request body accepts `excludeOrganizationLocations: string[]` and `excludeKeywords: string[]`, stored in `campaigns.icp`.

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/campaigns/route.test.ts`, inside the existing `describe('POST /api/campaigns', ...)` block:

```ts
  it('should pass exclude filters through into the stored ICP', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({
      ...validBody,
      excludeOrganizationLocations: ['ireland'],
      excludeKeywords: ['staffing'],
    }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        icp: expect.objectContaining({
          excludeOrganizationLocations: ['ireland'],
          excludeKeywords: ['staffing'],
        }),
      }),
    )
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/campaigns/route.test.ts`
Expected: FAIL — `createCampaignSchema` doesn't have these keys, so they're silently dropped before reaching `apolloIcpSchema.parse`, and the stored `icp.excludeOrganizationLocations` / `icp.excludeKeywords` default to `[]` instead of the submitted values.

- [ ] **Step 3: Implement**

In `src/app/api/campaigns/route.ts`, replace `createCampaignSchema`:

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
})
```

And replace the `apolloIcpSchema.parse(...)` call inside `POST`:

```ts
    const icp = apolloIcpSchema.parse({
      personTitles: body.personTitles,
      organizationLocations: body.organizationLocations,
      employeeRangeMin: body.employeeRangeMin,
      employeeRangeMax: body.employeeRangeMax,
      keywords: body.keywords,
      excludeOrganizationLocations: body.excludeOrganizationLocations,
      excludeKeywords: body.excludeKeywords,
    })
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/campaigns/route.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/app/api/campaigns/route.ts src/app/api/campaigns/route.test.ts
git commit -m "feat: accept excludeOrganizationLocations and excludeKeywords in POST /api/campaigns"
```

---

### Task 6: Campaign-creation UI fields

**Files:**
- Modify: `src/app/(app)/campaigns/new-campaign-form.tsx`

**Interfaces:**
- Consumes: `POST /api/campaigns` body shape from Task 5.

No test file exists for this client component today (consistent with the project's "React components: critical paths only" coverage target), so this task is verified manually in the browser per `CLAUDE.md`'s UI-change rule, not via Vitest.

- [ ] **Step 1: Add the two new form fields to the ICP fieldset**

In `src/app/(app)/campaigns/new-campaign-form.tsx`, insert a new `Field` immediately after the existing `organizationLocations` field:

```tsx
        <Field id="organizationLocations" label="Company locations" hint="Comma-separated.">
          <Input
            id="organizationLocations"
            name="organizationLocations"
            placeholder="united states, united kingdom"
          />
        </Field>

        <Field
          id="excludeOrganizationLocations"
          label="Exclude company locations"
          hint="Comma-separated. Companies headquartered here are skipped."
        >
          <Input
            id="excludeOrganizationLocations"
            name="excludeOrganizationLocations"
            placeholder="ireland, india"
          />
        </Field>
```

And insert a new `Field` immediately after the existing `keywords` field:

```tsx
        <Field id="keywords" label="Keywords" hint="Comma-separated.">
          <Input id="keywords" name="keywords" placeholder="saas, logistics, fintech" />
        </Field>

        <Field
          id="excludeKeywords"
          label="Exclude keywords"
          hint="Comma-separated. Matched against company name and title — Apollo doesn't expose company keyword/industry text at search time, so this filter runs after Apollo returns results, not inside Apollo's own search."
        >
          <Input id="excludeKeywords" name="excludeKeywords" placeholder="staffing, agency, recruiting" />
        </Field>
```

- [ ] **Step 2: Submit the new fields in the request body**

In the same file, replace the `body` object inside `onSubmit`:

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
    }
```

- [ ] **Step 3: Manually verify in the browser**

Run: `pnpm dev`

1. Sign in as an operator, navigate to `/campaigns`.
2. Fill the form: a client, a name, a value prop, and in the new fields enter `ireland, india` for "Exclude company locations" and `staffing, agency` for "Exclude keywords".
3. Open the browser's Network tab, submit the form, and inspect the `POST /api/campaigns` request payload — confirm it includes `"excludeOrganizationLocations":["ireland","india"]` and `"excludeKeywords":["staffing","agency"]`.
4. Confirm the success toast ("Campaign created") appears and the new campaign row shows up in the "All campaigns" list.

Expected: the request payload contains both new arrays with the entered values, and the campaign is created without a validation error.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/campaigns/new-campaign-form.tsx"
git commit -m "feat: add exclude-locations and exclude-keywords fields to campaign creation form"
```

---

### Task 7: Update the roadmap

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Append the exclude-filters note to the existing ICP-mapping line**

In `.claude/roadmap.md`, find the P1 line that starts with `- [x] ICP → Apollo filter mapping (` (currently line 36) and append a new sentence to the end of it, before the closing of that bullet:

```
 Exclude filters added: `excludeOrganizationLocations` → Apollo's `organization_not_locations[]` (confirmed real via a third-party Organization Search docs mirror — Apollo's own reference page under-documents this endpoint); `excludeKeywords` has no confirmed Apollo API equivalent, so it's matched client-side against candidate `organizationName`/`title` post-fetch (`src/lib/apollo/exclude-keywords.ts`). Both surfaced in the `/campaigns` creation form. See `docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: update roadmap.md with Apollo exclude-filters progress"
```

---

## Self-Review

- **Spec coverage:** exclude company locations → Task 1 (schema) + Task 2 (Apollo param) + Task 6 (UI). Exclude keywords → Task 1 (schema) + Task 3 (predicate) + Task 4 (pipeline wiring) + Task 6 (UI). Campaign creation → Task 5 (API) + Task 6 (form). Roadmap → Task 7. No gaps.
- **Placeholder scan:** no `TODO`/`TBD`/"add appropriate handling" anywhere; every step shows real, complete code or an exact manual-verification procedure.
- **Type consistency:** `ApolloIcpFilters.excludeOrganizationLocations` / `excludeKeywords` (Task 1) match the field names used in `build-search-params.ts` (Task 2), `exclude-keywords.ts`'s parameter (Task 3), `discover.ts` (Task 4), `route.ts` (Task 5), and the form field `name` attributes (Task 6) — verified identical spelling throughout.
- **Review-feedback fixes incorporated (this revision):** (1) `matchesExcludedKeywords` now matches whole-word via `\b...\b` instead of raw substring, so `"agency"` no longer false-positives inside `"Emergency"` — regex-escaped to avoid treating user-entered keyword characters as regex syntax; (2) keywords are `trim()`ed and blank entries dropped inside the matcher itself, not just relied on from the form's `splitCsv`, since the API route is a second, un-trimmed entry point; (3) `runSecondPass` drops a target company immediately on an organization-name-only match (company-level, applies to every future candidate at that domain) but *not* on a title-only match (person-level, other employees may still qualify) — new test verifies page 2 no longer queries the dropped company.
