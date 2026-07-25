# Apollo Multi-Threaded Discovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Discovery runs in two deliberate passes. Pass 1 (breadth) finds at most 1 person per brand-new company. Pass 2 (depth) goes back with a company-scoped Apollo search to find a second, specific person at every company — from today or an earlier day — that currently has exactly 1 verified contact. A company that never yields a second qualifying person still passes with 1 (case activation is unchanged). The daily quota rises from 30 to 50.

**Architecture:** Purely additive to the existing Stage 1 discovery pipeline (`src/lib/pipeline/discover.ts`, architecture.md §6 Stage 1). No schema change, no new table, no new route.
- A new read-only DB helper (`getVerifiedLeadCompanies`) tells discovery which companies already have exactly how many verified leads, across all days — not just today's run.
- `buildPeopleSearchParams` gains an optional 4th argument, a list of company domains, which adds Apollo's company-domain filter to the search request — this is what lets pass 2 search *within* a specific set of companies instead of broadly.
- `runDiscoveryForCampaign` is split into `runFirstPass` (new companies, 1 pick each, capped at half the quota) and `runSecondPass` (targeted search restricted to companies sitting at exactly 1 verified contact, capped at whatever quota pass 1 didn't use).

**Tech Stack:** TypeScript, Vitest, Supabase (`@supabase/supabase-js`), existing Apollo client (`src/lib/apollo/`).

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (`.claude/QUALITY.md`, `.claude/BEHAVIORS.md`).
- Every thrown error uses `AppError` with `code`, `message`, `context` — never bare `Error` (`.claude/QUALITY.md` Error Handling).
- Data access lives exclusively in `src/lib/db/`; one function per DB operation; map DB `snake_case` columns to TypeScript `camelCase` explicitly, never assume they match (`.claude/BEHAVIORS.md` TypeScript).
- Tests: Vitest, colocated `feature.test.ts`, Arrange-Act-Assert, `it('should ... when ...')` naming, mock at the boundary (mock Supabase/Apollo clients, never your own business logic) (`.claude/QUALITY.md` Testing). DB query functions (`lib/db/`) require ≥80% coverage.
- No `console.log`, no commented-out code, no `TODO`/`FIXME`/`HACK` comments (`.claude/BEHAVIORS.md`, `.claude/ANTI_LAZY.md`).
- Named exports only (default exports reserved for Next.js pages/layouts) (`.claude/QUALITY.md`, `.claude/BEHAVIORS.md`).
- Early returns over nested conditionals (`.claude/QUALITY.md`, `.claude/BEHAVIORS.md`).
- Write complete code — no placeholders, no stubs, no truncated output (`.claude/ANTI_LAZY.md`, `CLAUDE.md` reminder).
- Update `.claude/roadmap.md` every time progress is made (`CLAUDE.md`).
- Known risk carried into this plan (matches the existing note in `.claude/architecture.md` §12): Apollo's exact field name for filtering people-search by company domain is not verified against a live sandbox response in this codebase yet. `q_organization_domains_list[]` is used here to match this codebase's existing bracket-array convention for other Apollo filters (`person_titles[]`, `organization_locations[]`); reconcile against real Apollo data the first time a real `APOLLO_API_KEY` is available, same as the rest of the client (`src/lib/apollo/client.ts` already parses defensively for this reason).

---

## File Structure

- **Modify** `src/lib/db/leads.ts` — add `LeadCompanyRef` type and `getVerifiedLeadCompanies(supabase, campaignId)`, a plain read query returning the company of every verified lead for a campaign (any day, not just today).
- **Modify** `src/lib/db/leads.test.ts` — extend the shared `mockSupabase` helper to support the new query's chain shape and add its test coverage.
- **Modify** `src/lib/apollo/build-search-params.ts` — add an optional `organizationDomains: string[]` 4th argument that adds Apollo's company-domain filter to the search params, used only by pass 2.
- **Modify** `src/lib/apollo/build-search-params.test.ts` — add test coverage for the new argument.
- **Modify** `src/lib/pipeline/discover.ts` — split candidate selection into `runFirstPass` (new companies, 1 each, half the quota) and `runSecondPass` (targeted domain search for companies at exactly 1 verified contact, using the rest of the quota); raise `DEFAULT_DAILY_QUOTA` to 50; extend `DiscoverySummary` with `firstPassCandidates`/`secondPassCandidates`.
- **Modify** `src/lib/pipeline/discover.test.ts` — full rewrite of the test suite for the two-phase flow.
- **Modify** `src/app/api/campaigns/route.ts` — `dailyTarget` Zod default `30` → `50`.
- **Modify** `src/app/campaigns/new-campaign-form.tsx` — form default `30` → `50` (submission fallback and input `defaultValue`).
- **Modify** `.claude/architecture.md` — update "default 30" references (§6, §11) to 50 and describe the two-phase search.
- **Modify** `.claude/roadmap.md` — update "30" references under P1 to 50 and record this change as progress.

---

### Task 1: `getVerifiedLeadCompanies` DB helper

**Files:**
- Modify: `src/lib/db/leads.ts`
- Test: `src/lib/db/leads.test.ts`

**Interfaces:**
- Produces: `interface LeadCompanyRef { companyDomain: string | null; companyName: string | null }` and `getVerifiedLeadCompanies(supabase: SupabaseClient<Database>, campaignId: string): Promise<LeadCompanyRef[]>`, both exported from `src/lib/db/leads.ts`. Task 3 imports `getVerifiedLeadCompanies` from `@/lib/db/leads`.

- [ ] **Step 1: Extend the mock helper and write the failing tests**

Edit `src/lib/db/leads.test.ts`. Replace the import line:

```ts
import { getKnownSourceIds, insertLeads, updateLeadCase } from './leads'
```

with:

```ts
import { getKnownSourceIds, insertLeads, updateLeadCase, getVerifiedLeadCompanies } from './leads'
```

Replace the `mockSupabase` function:

```ts
function mockSupabase(overrides: {
  selectResult?: { data: unknown; error: unknown }
  upsertResult?: { data: unknown; error: unknown }
  updateResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => Promise.resolve(overrides.selectResult ?? { data: [], error: null }),
        }),
      }),
      upsert: () => ({
        select: () => Promise.resolve(overrides.upsertResult ?? { data: [], error: null }),
      }),
      update: () => ({
        eq: () => Promise.resolve(overrides.updateResult ?? { data: null, error: null }),
      }),
    }),
  } as never
}
```

with:

```ts
function mockSupabase(overrides: {
  selectResult?: { data: unknown; error: unknown }
  verifiedCompaniesResult?: { data: unknown; error: unknown }
  upsertResult?: { data: unknown; error: unknown }
  updateResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          not: () => Promise.resolve(overrides.selectResult ?? { data: [], error: null }),
          eq: () => Promise.resolve(overrides.verifiedCompaniesResult ?? { data: [], error: null }),
        }),
      }),
      upsert: () => ({
        select: () => Promise.resolve(overrides.upsertResult ?? { data: [], error: null }),
      }),
      update: () => ({
        eq: () => Promise.resolve(overrides.updateResult ?? { data: null, error: null }),
      }),
    }),
  } as never
}
```

Append this new `describe` block at the end of the file (after the existing `updateLeadCase` block):

```ts

describe('getVerifiedLeadCompanies', () => {
  it('should return mapped company refs for verified leads', async () => {
    const supabase = mockSupabase({
      verifiedCompaniesResult: {
        data: [
          { company_domain: 'acme.com', company_name: 'Acme' },
          { company_domain: null, company_name: 'Beta' },
        ],
        error: null,
      },
    })
    const result = await getVerifiedLeadCompanies(supabase, 'camp1')
    expect(result).toEqual([
      { companyDomain: 'acme.com', companyName: 'Acme' },
      { companyDomain: null, companyName: 'Beta' },
    ])
  })

  it('should return an empty array when there are no verified leads', async () => {
    const supabase = mockSupabase({ verifiedCompaniesResult: { data: [], error: null } })
    const result = await getVerifiedLeadCompanies(supabase, 'camp1')
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = mockSupabase({ verifiedCompaniesResult: { data: null, error: { message: 'boom' } } })
    await expect(getVerifiedLeadCompanies(supabase, 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: FAIL — `getVerifiedLeadCompanies` is not exported from `./leads` (TypeScript/import error), the three new tests error out.

- [ ] **Step 3: Implement `getVerifiedLeadCompanies` in `src/lib/db/leads.ts`**

Insert this after `getKnownSourceIds` and before `insertLeads`:

```ts
export interface LeadCompanyRef {
  companyDomain: string | null
  companyName: string | null
}

// Used by discovery (src/lib/pipeline/discover.ts) to see which companies
// already have a verified lead for a campaign — across all days, not just
// today's run — so the second-pass search knows which companies to go back
// to for a second contact.
export async function getVerifiedLeadCompanies(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<LeadCompanyRef[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('company_domain, company_name')
    .eq('campaign_id', campaignId)
    .eq('email_status', 'verified')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load verified lead companies', { campaignId, cause: error.message })
  }
  return (data ?? []).map((r) => ({ companyDomain: r.company_domain, companyName: r.company_name }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: PASS — all tests in the file green, including the 3 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "$(cat <<'EOF'
feat: add getVerifiedLeadCompanies db helper

Reads which companies already have a verified lead for a campaign
(any day), so discovery's second pass (Task 3) knows which companies
to go back to for a second contact.
EOF
)"
```

---

### Task 2: Company-domain targeting in `buildPeopleSearchParams`

**Files:**
- Modify: `src/lib/apollo/build-search-params.ts`
- Test: `src/lib/apollo/build-search-params.test.ts`

**Interfaces:**
- Produces: `buildPeopleSearchParams(icp: ApolloIcpFilters, page: number, perPage: number, organizationDomains?: string[]): Record<string, string | string[]>` — the 4th argument is new and optional (defaults to `[]`), so every existing call site keeps compiling unchanged. Task 3's `runSecondPass` is the only caller that passes it.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/apollo/build-search-params.test.ts`, inside the existing `describe('buildPeopleSearchParams', ...)` block (after the last `it`, before the closing `})`):

```ts

  it('should omit the organization domains filter when none are given', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['q_organization_domains_list[]']).toBeUndefined()
  })

  it('should pass organization domains through as an array when targeting specific companies', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25, ['acme.com', 'beta.io'])
    expect(params['q_organization_domains_list[]']).toEqual(['acme.com', 'beta.io'])
  })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: FAIL — `buildPeopleSearchParams` only accepts 3 arguments today (TypeScript error on the 4-argument call), and `q_organization_domains_list[]` is never set.

- [ ] **Step 3: Implement the new argument in `src/lib/apollo/build-search-params.ts`**

Replace the whole file with:

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
  if (icp.employeeRangeMin !== null && icp.employeeRangeMax !== null) {
    params['organization_num_employees_ranges[]'] = [`${icp.employeeRangeMin},${icp.employeeRangeMax}`]
  }
  if (icp.keywords.length > 0) {
    params.q_keywords = icp.keywords.join(' ')
  }
  // Second-pass targeting (src/lib/pipeline/discover.ts runSecondPass):
  // restricts the search to specific companies so discovery can go back for
  // a second contact. Field name unverified against a live Apollo sandbox
  // response — see the Global Constraints note at the top of this plan.
  if (organizationDomains.length > 0) {
    params['q_organization_domains_list[]'] = organizationDomains
  }
  return params
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: PASS — all tests green, including the 2 new ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/build-search-params.ts src/lib/apollo/build-search-params.test.ts
git commit -m "$(cat <<'EOF'
feat: add company-domain targeting to buildPeopleSearchParams

Optional 4th argument adds Apollo's q_organization_domains_list[]
filter, letting a search be scoped to a specific set of companies.
Used by discovery's second pass (Task 3) to go back for a second
contact at companies that already have exactly 1 verified lead.
EOF
)"
```

---

### Task 3: Two-phase discovery — breadth pass, then targeted depth pass

**Files:**
- Modify: `src/lib/pipeline/discover.ts`
- Test: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `getVerifiedLeadCompanies(supabase, campaignId): Promise<LeadCompanyRef[]>` (Task 1, `@/lib/db/leads`); `buildPeopleSearchParams(icp, page, perPage, organizationDomains?)` (Task 2, `@/lib/apollo/build-search-params`); `computeCompanyKey(domain: string | null, companyName: string | null): string`, already exported from `./group-lead`.
- Produces: `runDiscoveryForCampaign`'s signature is unchanged. `DiscoverySummary` gains two fields: `firstPassCandidates: number`, `secondPassCandidates: number` (both included in `newCandidates`, which stays `firstPassCandidates + secondPassCandidates`).

- [ ] **Step 1: Replace the test file with the two-phase test suite**

Replace `src/lib/pipeline/discover.test.ts` in full with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSearchPeople = vi.hoisted(() => vi.fn())
const mockBulkMatchPeople = vi.hoisted(() => vi.fn())
const mockGetKnownSourceIds = vi.hoisted(() => vi.fn())
const mockInsertLeads = vi.hoisted(() => vi.fn())
const mockGetVerifiedLeadCompanies = vi.hoisted(() => vi.fn())
const mockGroupVerifiedLead = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apollo/client', () => ({ searchPeople: mockSearchPeople, bulkMatchPeople: mockBulkMatchPeople }))
vi.mock('@/lib/db/leads', () => ({
  getKnownSourceIds: mockGetKnownSourceIds,
  insertLeads: mockInsertLeads,
  getVerifiedLeadCompanies: mockGetVerifiedLeadCompanies,
}))
vi.mock('./group-lead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./group-lead')>()
  return { ...actual, groupVerifiedLead: mockGroupVerifiedLead }
})
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent }))

import { runDiscoveryForCampaign } from './discover'
import type { ApolloIcpFilters } from '@/lib/apollo/types'

const icp: ApolloIcpFilters = {
  personTitles: ['vp sales'], organizationLocations: [], employeeRangeMin: null, employeeRangeMax: null, keywords: [],
}

function candidate(apolloId: string, domain = `${apolloId}.com`) {
  return {
    apolloId, firstName: 'Jo', lastNamePreview: 'D***e', title: 'VP Sales',
    organizationName: 'Acme', organizationDomain: domain, linkedinUrl: null,
  }
}

function enriched(apolloId: string, emailStatus: string) {
  return {
    apolloId, firstName: 'Jo', lastName: 'Doe', title: 'VP Sales', email: `${apolloId}@acme.com`,
    emailStatus, linkedinUrl: null, organizationName: 'Acme', organizationDomain: 'acme.com',
  }
}

function insertedRows(rows: { source_id: string | null | undefined }[]) {
  return rows.map((r, i) => ({
    id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id, email_status: 'verified',
  }))
}

describe('runDiscoveryForCampaign', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
  })

  it('should fill the daily quota across both search phases: new companies, then a second contact for each', async () => {
    // dailyTarget 4 -> firstPassQuota = ceil(4/2) = 2
    mockSearchPeople
      .mockResolvedValueOnce({ // pass 1, page 1
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ // pass 2, page 1
        totalEntries: 2,
        candidates: [candidate('p3', 'p1.com'), candidate('p4', 'p2.com')],
      })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.firstPassCandidates).toBe(2)
    expect(summary.secondPassCandidates).toBe(2)
    expect(summary.newCandidates).toBe(4)
    const secondCallParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(secondCallParams['q_organization_domains_list[]']).toEqual(['p1.com', 'p2.com'])
  })

  it('should pick at most 1 person per brand-new company during pass 1, even if two appear on the same page', async () => {
    // dailyTarget 10 -> firstPassQuota = 5, well above 1, so the skip below
    // can only be explained by the per-company cap, not the overall quota.
    mockSearchPeople
      .mockResolvedValueOnce({ // pass 1, page 1: 2 people at the same brand-new company
        totalEntries: 2,
        candidates: [candidate('p1', 'acme.com'), candidate('p2', 'acme.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop pass 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 1: no second person found
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(3)
    expect(summary.firstPassCandidates).toBe(1)
    expect(summary.secondPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })])
  })

  it('should target a company from an earlier day that has exactly 1 verified lead in pass 2', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // pass 2
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    const secondCallParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(secondCallParams['q_organization_domains_list[]']).toEqual(['acme.com'])
    expect(summary.firstPassCandidates).toBe(0)
    expect(summary.secondPassCandidates).toBe(1)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p5' })])
  })

  it('should not run pass 2 for a company with exactly 1 verified lead but no known domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: null, companyName: 'No Domain Co' }])
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary.secondPassCandidates).toBe(0)
  })

  it('should ignore pass-2 candidates whose company does not match any requested target domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p9', 'other.com')] }) // pass 2, page 1: off-target
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 2: empty, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(3)
    expect(summary.secondPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip candidates whose apolloId is already known for the campaign', async () => {
    mockGetKnownSourceIds.mockResolvedValue(new Set(['p1']))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
    expect(summary.newCandidates).toBe(0)
  })

  it('should default the quota to 50 when dailyTarget is 0, splitting the budget across both phases', async () => {
    // firstPassQuota = ceil(50/2) = 25 -- this only passes if the default is
    // really 50 (not, say, 30, which would give firstPassQuota = 15).
    const page1 = Array.from({ length: 25 }, (_, i) => candidate(`c${i}`))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 25, candidates: page1 }) // pass 1, page 1: exactly fills firstPassQuota
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 1: no second contacts found
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'unverified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id, email_status: 'unverified',
      })),
    )

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 0, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.firstPassCandidates).toBe(25)
    expect(summary.newCandidates).toBe(25)
  })

  it('should log a pipeline.discover.completed event with the summary', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', type: 'pipeline.discover.completed',
    }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — `summary.firstPassCandidates` / `summary.secondPassCandidates` are `undefined` (not on `DiscoverySummary` yet), `mockSearchPeople` is called only once per run today (no second pass exists yet), so call-count and call-args assertions fail across most of the new tests.

- [ ] **Step 3: Implement the two-phase flow in `src/lib/pipeline/discover.ts`**

Replace the whole file with:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { searchPeople, bulkMatchPeople } from '@/lib/apollo/client'
import { buildPeopleSearchParams } from '@/lib/apollo/build-search-params'
import { mapApolloEmailStatus } from '@/lib/apollo/map-email-status'
import type { ApolloIcpFilters, ApolloSearchCandidate } from '@/lib/apollo/types'
import { getKnownSourceIds, insertLeads, getVerifiedLeadCompanies, type LeadInsert } from '@/lib/db/leads'
import { groupVerifiedLead, computeCompanyKey } from './group-lead'
import { logEvent } from '@/lib/events/log-event'

const MAX_SEARCH_PAGES = 20
const SEARCH_PER_PAGE = 25
const ENRICH_BATCH_SIZE = 10
const DEFAULT_DAILY_QUOTA = 50

export interface CampaignForDiscovery {
  id: string
  clientId: string
  dailyTarget: number
  icp: ApolloIcpFilters
}

export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  firstPassCandidates: number
  secondPassCandidates: number
  enriched: number
  verified: number
  inserted: number
}

interface FreshCandidate {
  apolloId: string
  firstName: string
  title: string | null
  organizationName: string | null
  organizationDomain: string | null
  linkedinUrl: string | null
}

interface SearchPassResult {
  picks: FreshCandidate[]
  candidatesSeen: number
}

function toFreshCandidate(candidate: ApolloSearchCandidate): FreshCandidate {
  return {
    apolloId: candidate.apolloId,
    firstName: candidate.firstName,
    title: candidate.title,
    organizationName: candidate.organizationName,
    organizationDomain: candidate.organizationDomain,
    linkedinUrl: candidate.linkedinUrl,
  }
}

// Pass 1 (breadth): at most 1 person per brand-new company, regardless of
// how many people from that company appear in the results — a second
// contact is deliberately left to runSecondPass, never picked up here.
// companyPickCounts / domainBackedCompanyKeys are shared, mutated state
// threaded through both passes on purpose: they are how pass 2 learns which
// companies pass 1 (and earlier days) left at exactly 1 verified contact.
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

// Pass 2 (depth): a company-scoped search (Apollo domain filter) targeting
// exactly the companies that currently sit at 1 verified contact, trying to
// find a second, different person at each. A company that doesn't surface a
// match here simply stays at 1 — case activation already accepts that
// (group-lead.ts), so it is not treated as a failure.
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
  for (let page = 1; page <= MAX_SEARCH_PAGES && picks.length < quota && remainingTargets.size > 0; page++) {
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE, [...remainingTargets])
    const { candidates } = await searchPeople(params)
    candidatesSeen += candidates.length
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      if (picks.length >= quota) break
      if (known.has(candidate.apolloId)) continue
      if (firstPassPicks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      const companyKey = computeCompanyKey(candidate.organizationDomain, candidate.organizationName)
      if (!remainingTargets.has(companyKey)) continue
      companyPickCounts.set(companyKey, (companyPickCounts.get(companyKey) ?? 0) + 1)
      remainingTargets.delete(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
  }
  return { picks, candidatesSeen }
}

export async function runDiscoveryForCampaign(
  supabase: SupabaseClient<Database>,
  campaign: CampaignForDiscovery,
): Promise<DiscoverySummary> {
  const quota = campaign.dailyTarget > 0 ? campaign.dailyTarget : DEFAULT_DAILY_QUOTA
  const known = await getKnownSourceIds(supabase, campaign.id)
  const existingCompanies = await getVerifiedLeadCompanies(supabase, campaign.id)

  const companyPickCounts = new Map<string, number>()
  const domainBackedCompanyKeys = new Set<string>()
  for (const company of existingCompanies) {
    const key = computeCompanyKey(company.companyDomain, company.companyName)
    companyPickCounts.set(key, (companyPickCounts.get(key) ?? 0) + 1)
    if (company.companyDomain) domainBackedCompanyKeys.add(key)
  }

  const firstPassQuota = Math.ceil(quota / 2)
  const firstPass = await runFirstPass(campaign.icp, firstPassQuota, known, companyPickCounts, domainBackedCompanyKeys)

  const targetDomains = [...companyPickCounts.entries()]
    .filter(([key, count]) => count === 1 && domainBackedCompanyKeys.has(key))
    .map(([key]) => key)
  const secondPassQuota = quota - firstPass.picks.length
  const secondPass = targetDomains.length > 0 && secondPassQuota > 0
    ? await runSecondPass(campaign.icp, secondPassQuota, known, firstPass.picks, targetDomains, companyPickCounts)
    : { picks: [] as FreshCandidate[], candidatesSeen: 0 }

  const fresh = [...firstPass.picks, ...secondPass.picks]
  const candidatesSeen = firstPass.candidatesSeen + secondPass.candidatesSeen

  const enrichedRows: LeadInsert[] = []
  let verifiedCount = 0
  for (let i = 0; i < fresh.length; i += ENRICH_BATCH_SIZE) {
    const batch = fresh.slice(i, i + ENRICH_BATCH_SIZE)
    const enrichedPeople = await bulkMatchPeople(
      batch.map((c) => ({
        id: c.apolloId,
        organizationName: c.organizationName ?? undefined,
        domain: c.organizationDomain ?? undefined,
        linkedinUrl: c.linkedinUrl ?? undefined,
      })),
    )
    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      if (emailStatus === 'verified') verifiedCount += 1
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      enrichedRows.push({
        client_id: campaign.clientId,
        campaign_id: campaign.id,
        source_id: person.apolloId,
        full_name: fullName,
        title: person.title ?? source?.title ?? null,
        company_name: person.organizationName ?? source?.organizationName ?? null,
        company_domain: person.organizationDomain ?? source?.organizationDomain ?? null,
        linkedin_url: person.linkedinUrl ?? source?.linkedinUrl ?? null,
        source: 'apollo',
        raw: { ...person },
        email: person.email,
        email_status: emailStatus,
        email_verified_at: emailStatus === 'verified' ? new Date().toISOString() : null,
        status: emailStatus === 'verified' ? 'active' : 'parked',
      })
    }
  }

  const inserted = await insertLeads(supabase, enrichedRows)

  for (const lead of inserted) {
    if (lead.email_status === 'verified') {
      await groupVerifiedLead(supabase, {
        id: lead.id,
        clientId: lead.client_id,
        campaignId: lead.campaign_id,
        companyName: lead.company_name,
        companyDomain: lead.company_domain,
      })
    }
  }

  const summary: DiscoverySummary = {
    campaignId: campaign.id,
    candidatesSeen,
    newCandidates: fresh.length,
    firstPassCandidates: firstPass.picks.length,
    secondPassCandidates: secondPass.picks.length,
    enriched: enrichedRows.length,
    verified: verifiedCount,
    inserted: inserted.length,
  }

  await logEvent({
    clientId: campaign.clientId,
    actor: 'system',
    type: 'pipeline.discover.completed',
    payload: { ...summary },
  })

  return summary
}
```

- [ ] **Step 4: Run tests to verify they all pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "$(cat <<'EOF'
feat: two-phase Apollo discovery for multi-threading

Pass 1 finds at most 1 person per brand-new company (never a second
pick here). Pass 2 runs a company-scoped search restricted to every
company - today's or an earlier day's - that currently has exactly 1
verified contact, trying to find a second person there. A company
that never surfaces a second qualifying candidate still passes with
1 verified contact; case activation is unchanged (group-lead.ts).
EOF
)"
```

---

### Task 4: Raise the default daily quota to 50 and record progress

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Modify: `src/app/campaigns/new-campaign-form.tsx`
- Modify: `.claude/architecture.md`
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Raise the campaign-creation default**

Edit `src/app/api/campaigns/route.ts`. Replace:

```ts
  dailyTarget: z.number().int().min(1).max(100).default(30),
```

with:

```ts
  dailyTarget: z.number().int().min(1).max(100).default(50),
```

- [ ] **Step 2: Raise the form default**

Edit `src/app/campaigns/new-campaign-form.tsx`. Replace:

```ts
      dailyTarget: Number(formData.get('dailyTarget') ?? 30),
```

with:

```ts
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
```

Replace:

```tsx
      <input name="dailyTarget" type="number" placeholder="Daily Apollo target" defaultValue={30} min={1} max={100} />
```

with:

```tsx
      <input name="dailyTarget" type="number" placeholder="Daily Apollo target" defaultValue={50} min={1} max={100} />
```

- [ ] **Step 3: Update architecture.md**

Edit `.claude/architecture.md`. Replace this line (§6 Stage 1):

```
- Daily quota = `campaigns.daily_target` (default 30/day, per campaign). Candidates whose Apollo person id (`leads.source_id`) is already known for that campaign are skipped **before** the enrich call, so credits are only spent on genuinely new people.
```

with:

```
- Daily quota = `campaigns.daily_target` (default 50/day, per campaign), split into two search passes (`src/lib/pipeline/discover.ts`): pass 1 finds at most 1 person per brand-new company (up to half the quota); pass 2 runs a company-scoped Apollo search targeting every company — today's or an earlier day's — that currently has exactly 1 verified contact, trying to find a second person there for multi-threading. A company that never yields a second qualifying candidate still passes with 1. Candidates whose Apollo person id (`leads.source_id`) is already known for that campaign are skipped **before** the enrich call, so credits are only spent on genuinely new people.
```

Replace this line (§11 Frontend):

```
- **/campaigns** — operator setup: client, name, value prop, booking link, Apollo ICP filters (`personTitles`, `organizationLocations`, employee range, `keywords`), daily Apollo quota (default 30). Reply/handoff modes and mailbox assignment stay at their schema defaults until P2 needs them in the UI.
```

with:

```
- **/campaigns** — operator setup: client, name, value prop, booking link, Apollo ICP filters (`personTitles`, `organizationLocations`, employee range, `keywords`), daily Apollo quota (default 50). Reply/handoff modes and mailbox assignment stay at their schema defaults until P2 needs them in the UI.
```

- [ ] **Step 4: Update roadmap.md**

Edit `.claude/roadmap.md`. Replace:

```
**Goal:** every active campaign pulls up to 30 new ICP-matching people a day from **Apollo.io**, gets each email revealed *and* verified by Apollo in the same call (no separate verifier), groups verified people into cases, and appears in `/crm`. This validates the riskiest assumption (real, verifiable emails) before any outreach is built.
```

with:

```
**Goal:** every active campaign pulls up to 50 new ICP-matching people a day from **Apollo.io**, gets each email revealed *and* verified by Apollo in the same call (no separate verifier), groups verified people into cases, and appears in `/crm`. This validates the riskiest assumption (real, verifiable emails) before any outreach is built.
```

Replace:

```
- [x] **Discovery pipeline**: `/api/pipeline/discover-fanout` (daily QStash cron) → one QStash message per active campaign → `/api/pipeline/discover`. Pulls up to `campaigns.daily_target` (default 30) new people per campaign per day, skips already-known Apollo ids before enriching (saves credits), inserts `leads`.
```

with:

```
- [x] **Discovery pipeline**: `/api/pipeline/discover-fanout` (daily QStash cron) → one QStash message per active campaign → `/api/pipeline/discover`. Pulls up to `campaigns.daily_target` (default 50) new people per campaign per day, skips already-known Apollo ids before enriching (saves credits), inserts `leads`.
```

Replace this line:

```
- [x] **Grouping** system: deterministic `company_key` (domain, else normalized company name) → case; 1+ Apollo-verified person activates a case. Optional LLM tiebreaker for ambiguous no-domain names remains backlog (unchanged from original design).
```

with:

```
- [x] **Grouping** system: deterministic `company_key` (domain, else normalized company name) → case; 1+ Apollo-verified person activates a case. Optional LLM tiebreaker for ambiguous no-domain names remains backlog (unchanged from original design).
- [x] **Multi-threading**: discovery runs in two passes (`src/lib/pipeline/discover.ts`) — pass 1 picks at most 1 person per brand-new company; pass 2 runs a domain-scoped Apollo search targeting every company (today's or an earlier day's) sitting at exactly 1 verified contact, trying to find a second person there. A company with only 1 qualifying candidate still passes — case activation is unchanged. See `docs/superpowers/plans/2026-07-19-apollo-multi-thread-discovery.md`.
```

- [ ] **Step 5: Full verification**

Run: `pnpm test`
Expected: PASS — every suite green, no regressions.

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/campaigns/route.ts src/app/campaigns/new-campaign-form.tsx .claude/architecture.md .claude/roadmap.md
git commit -m "$(cat <<'EOF'
feat: raise default daily Apollo quota from 30 to 50

Updates the campaign-creation default (API + form) and the docs that
describe it (architecture.md, roadmap.md), and records the two-phase
multi-threaded discovery work as progress on the roadmap.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage:** "in the first call only 1 person for a company" → `runFirstPass` skips any candidate whose company key is already in `companyPickCounts`, so it never picks a 2nd person for a company it just picked from, tested explicitly. "then do a second search with the companies we have if we have a 2nd person for that company" → `runSecondPass` builds its target list from every company at exactly 1 pick (today's pass-1 picks *and* earlier-day companies from `getVerifiedLeadCompanies`) and issues a domain-scoped Apollo search for exactly those, tested for both the today-discovered and earlier-day cases. "make the daily limit 50" → `DEFAULT_DAILY_QUOTA = 50` plus every UI/API/doc default that mirrored the old `30`. "if only 1 qualified person, that's ok, still pass" → unchanged: `group-lead.ts` activates a case on 1+ verified lead; pass 2 simply not finding a match leaves the company at 1, never blocking or erroring, tested explicitly (`should not run pass 2 for a company... no known domain`, and pass-2-finds-nothing implicitly covered in the "pick at most 1 person per brand-new company" test).
- **No placeholders:** every step shows the literal before/after code or the full new file.
- **Type consistency:** `LeadCompanyRef` (Task 1: `companyDomain`/`companyName`) → consumed identically in Task 3's `existingCompanies: LeadCompanyRef[]` loop. `buildPeopleSearchParams`'s new 4th parameter (Task 2: `organizationDomains: string[] = []`) → called as `buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE, [...remainingTargets])` in Task 3's `runSecondPass`, an array of `string`, matching. `SearchPassResult` (`{ picks: FreshCandidate[]; candidatesSeen: number }`) is returned identically by both `runFirstPass` and `runSecondPass` and consumed the same way in `runDiscoveryForCampaign`.
