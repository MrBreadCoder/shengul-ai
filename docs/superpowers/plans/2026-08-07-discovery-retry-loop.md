# Discovery Depth-First Retry Loop Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `daily_target` actually converge on delivered active leads by replacing discovery's fixed first-pass/second-pass/top-up run with a depth-first round loop, and fix the concrete query bug that makes the "find a second contact" phase return 0 candidates today.

**Architecture:** `src/lib/pipeline/discover.ts`'s `runDiscoveryForCampaign` loops rounds of (depth phase → breadth phase) until `verified >= daily_target` or a round adds zero new candidates. The depth phase (`runDepthSearch`, renamed from `runSecondPass`) drops the redundant `q_keywords` filter from its Apollo query. A latent correctness bug in `getVerifiedLeadCompanies` (filters `email_status` instead of `status`) is fixed first since the new loop depends on it every round.

**Tech Stack:** TypeScript, Vitest, Supabase (`@supabase/supabase-js`), existing Apollo client (`src/lib/apollo/`).

**Spec:** `docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md` — read it before starting; this plan implements it exactly.

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (`.claude/QUALITY.md`).
- Every thrown error uses `AppError` with `code`, `message`, `context` — never bare `Error` (`.claude/QUALITY.md` Error Handling). No new error paths are introduced by this plan; existing `AppError` usage in `discover.ts`/`leads.ts` is untouched.
- Data access lives exclusively in `src/lib/db/`; one function per DB operation; map DB `snake_case` columns to TypeScript `camelCase` explicitly (`.claude/BEHAVIORS.md`).
- Tests: Vitest, colocated `feature.test.ts`, Arrange-Act-Assert, `it('should ... when ...')` naming, mock at the boundary — mock Supabase/Apollo clients, never business logic (`.claude/QUALITY.md` Testing).
- No `console.log`, no commented-out code, no `TODO`/`FIXME`/`HACK` comments (`.claude/BEHAVIORS.md`, `.claude/ANTI_LAZY.md`).
- Named exports only (`.claude/QUALITY.md`).
- Early returns over nested conditionals (`.claude/QUALITY.md`).
- Write complete code — no placeholders, no stubs (`.claude/ANTI_LAZY.md`).
- Update `.claude/roadmap.md` every time progress is made (`CLAUDE.md`).
- Don't branch — commit to `master` directly (`CLAUDE.md`: "dont branch use main").

---

## File Structure

- **Modify** `src/lib/apollo/build-search-params.test.ts` — add regression coverage for `q_keywords` being omitted when `keywords: []` is passed alongside `organizationDomains`.
- **Modify** `src/lib/db/leads.ts` — fix `getVerifiedLeadCompanies`'s filter column.
- **Modify** `src/lib/db/leads.test.ts` — update/add coverage for the fixed filter.
- **Modify** `src/lib/pipeline/discover.ts` — replace `DiscoverySummary`, rename+fix `runFirstPass`/`runSecondPass` into `runBreadthSearch`/`runDepthSearch`, replace `runDiscoveryForCampaign`'s orchestration with the round loop.
- **Modify** `src/lib/pipeline/discover.test.ts` — full rewrite of the `describe('runDiscoveryForCampaign', ...)` and `describe('runDiscoveryForCampaign — multi-keyword organization search', ...)` blocks; one-line payload fix in `describe('apollo failure attribution', ...)`; no changes needed elsewhere (traced below).
- **Modify** `src/lib/apollo/build-search-params.ts` — update one stale comment referencing `runSecondPass`.
- **Modify** `.claude/roadmap.md` — record this fix as progress.

---

### Task 1: Regression test for the dropped keyword filter in `buildPeopleSearchParams`

**Files:**
- Modify: `src/lib/apollo/build-search-params.test.ts`

**Interfaces:**
- Consumes: `buildPeopleSearchParams(icp: ApolloIcpFilters, page: number, perPage: number, organizationDomains?: string[])` — existing signature, no change.
- Produces: nothing new — this task only adds test coverage confirming today's existing `icp.keywords.length > 0` guard already does what the depth-phase fix (Task 3) will rely on.

This task requires **no implementation change** — `buildPeopleSearchParams` already omits `q_keywords` whenever `icp.keywords` is empty (`if (icp.keywords.length > 0) { params.q_keywords = ... }`). It's a pure regression-coverage addition so Task 3's depth-phase fix has a guardrail below it.

- [ ] **Step 1: Read the existing test file to find the right insertion point**

Run: `grep -n "describe\|^})" src/lib/apollo/build-search-params.test.ts`

Find the closing `})` of the `describe('buildPeopleSearchParams', ...)` block — the last `it(...)` before it is where the new case gets appended.

- [ ] **Step 2: Write the new test**

Add this `it` block right before the closing `})` of the `describe('buildPeopleSearchParams', ...)` block:

```ts
  it('should omit q_keywords even when organization domains are present, for an ICP with no keywords', () => {
    const icpWithDomainsOnly: ApolloIcpFilters = { ...emptyIcp, keywords: [] }
    const params = buildPeopleSearchParams(icpWithDomainsOnly, 1, 25, ['acme.com'])
    expect(params.q_keywords).toBeUndefined()
    expect(params['q_organization_domains_list[]']).toEqual(['acme.com'])
  })
```

(Match the existing file's import style for `ApolloIcpFilters` and `emptyIcp` — both are already used by neighboring tests in this file; do not re-import or redefine them.)

- [ ] **Step 3: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: PASS — this confirms the existing implementation already supports what Task 3's depth-phase query fix needs, with no `build-search-params.ts` code change required.

- [ ] **Step 4: Commit**

```bash
git add src/lib/apollo/build-search-params.test.ts
git commit -m "$(cat <<'EOF'
test: cover q_keywords omission with a domain-scoped search

Regression guard for the depth-phase query fix landing in
discover.ts: buildPeopleSearchParams already omits q_keywords when
icp.keywords is empty, even with organizationDomains present. No
implementation change needed here.
EOF
)"
```

---

### Task 2: Fix `getVerifiedLeadCompanies` to filter on `status`, not `email_status`

**Files:**
- Modify: `src/lib/db/leads.ts`
- Test: `src/lib/db/leads.test.ts`

**Interfaces:**
- Produces: `getVerifiedLeadCompanies(supabase: SupabaseClient<Database>, campaignId: string): Promise<LeadCompanyRef[]>` — signature and return shape (`LeadCompanyRef { companyDomain: string | null; companyName: string | null }`) are UNCHANGED. Only the DB filter column changes. Task 3's round loop consumes this function as-is — no signature change to coordinate.

- [ ] **Step 1: Write the failing test**

Open `src/lib/db/leads.test.ts` and find the existing `describe('getVerifiedLeadCompanies', ...)` block (it already has 3 tests: mapped refs, empty array, DB_ERROR on failure — do not remove them). The shared `mockSupabase` helper used by those 3 tests only returns canned data — it doesn't record which column `.eq()` was called with, which is exactly what this test needs to assert (the returned data would look identical whether the query filtered on the old, wrong column or the new, correct one). Add this new test inside the same `describe` block using a small local mock that records its `.eq()` calls instead of reusing `mockSupabase`:

```ts
  it('should filter on status, not email_status, so a parked-but-Apollo-verified row is excluded', async () => {
    const eqCalls: [string, string][] = []
    const localSupabase = {
      from: () => ({
        select: () => ({
          eq: (column: string, value: string) => {
            eqCalls.push([column, value])
            return {
              eq: (column2: string, value2: string) => {
                eqCalls.push([column2, value2])
                return Promise.resolve({ data: [], error: null })
              },
            }
          },
        }),
      }),
    } as unknown as SupabaseClient<Database>

    await getVerifiedLeadCompanies(localSupabase, 'camp1')

    expect(eqCalls).toContainEqual(['status', 'active'])
    expect(eqCalls).not.toContainEqual(['email_status', 'verified'])
  })
```

Check the top of `leads.test.ts` for existing `SupabaseClient` / `Database` type imports (used elsewhere in the file for similar typed mocks) — reuse them; do not re-import if already present under a different local alias.

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: FAIL — `eqCalls` contains `['email_status', 'verified']`, not `['status', 'active']`.

- [ ] **Step 3: Fix `getVerifiedLeadCompanies` in `src/lib/db/leads.ts`**

Find the existing function (currently filters `.eq('email_status', 'verified')`):

```ts
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

Change the last `.eq()` call and update the doc comment above it to reflect what "verified" now means precisely:

```ts
// Used by discovery (src/lib/pipeline/discover.ts) to see which companies
// already have a verified, ACTIVE lead for a campaign — across all days,
// not just today's run — so the depth phase knows which companies to go
// back to for a second contact. Filters on `status`, not `email_status`:
// a row Apollo marked `verified` but that was later parked (suppressed,
// post-enrich excluded, or AI-rejected) must not count as "this company
// has a verified lead" — it was never grouped into a case.
export async function getVerifiedLeadCompanies(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<LeadCompanyRef[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('company_domain, company_name')
    .eq('campaign_id', campaignId)
    .eq('status', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load verified lead companies', { campaignId, cause: error.message })
  }
  return (data ?? []).map((r) => ({ companyDomain: r.company_domain, companyName: r.company_name }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: PASS — all tests in the file green, including the 4 in `describe('getVerifiedLeadCompanies', ...)`.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "$(cat <<'EOF'
fix(discover): filter getVerifiedLeadCompanies on status, not email_status

A row Apollo marked verified but that was later parked (suppressed,
post-enrich excluded, or AI-rejected) was still counted as "this
company has a verified lead" — it was never grouped into a case.
Masked today because pass 2 rarely queried anything useful anyway;
becomes consequential once the depth-first retry loop (next commit)
relies on this list every round.
EOF
)"
```

---

### Task 3: Round-loop rewrite of `runDiscoveryForCampaign`

**Files:**
- Modify: `src/lib/pipeline/discover.ts`
- Modify: `src/lib/pipeline/discover.test.ts`
- Modify: `src/lib/apollo/build-search-params.ts` (one comment)

**Interfaces:**
- Consumes: `getVerifiedLeadCompanies` (Task 2's fixed version, same signature), `buildPeopleSearchParams` (Task 1's confirmed-correct existing behavior), `insertLeads`, `getKnownSourceIds`, `enrichCandidates` (unchanged), `groupVerifiedLead` (unchanged).
- Produces: `DiscoverySummary` with fields `depthCandidates: number`, `breadthCandidates: number`, `rounds: number` replacing `firstPassCandidates` / `secondPassCandidates` / `topUpCandidates`. `runDiscoveryForCampaign`'s own exported signature is unchanged: `(supabase: SupabaseClient<Database>, campaign: CampaignForDiscovery) => Promise<DiscoverySummary>`.

This task is one coupled unit — the test suite and the implementation must land together, since almost every test exercises the single `runDiscoveryForCampaign` entry point (there is no way to unit-test the renamed search functions in isolation; they are not exported).

#### Step 1: Replace the core and multi-keyword test blocks in `discover.test.ts`

Open `src/lib/pipeline/discover.test.ts`. Leave everything from the top of the file through line 76 (imports, `vi.mock` calls, `icp`/`candidate`/`enriched`/`insertedRows`/`verification` helpers, the file-level `beforeEach` for `mockCheckCompanyRelevance`) **unchanged**.

Replace the entire `describe('runDiscoveryForCampaign', () => { ... })` block (originally lines 78–570) with:

```ts
describe('runDiscoveryForCampaign', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    // Safe default for any call beyond what a test explicitly queues via
    // mockResolvedValueOnce — most tests only care about round 1's breadth
    // phase, and the round loop (runDiscoveryForCampaign) always fires at
    // least one more searchPeople call whenever the target isn't met and a
    // round made progress. Without this, an unconfigured extra call
    // resolves to undefined and crashes runBreadthSearch's destructure.
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
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

  it('should search breadth (no domain restriction) in round 1 when there are no existing 1-lead companies to target', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ // round 1 breadth, page 1
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: both targets exhausted
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing left
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, icp })

    const firstCallParams = mockSearchPeople.mock.calls[0]![0] as Record<string, string | string[]>
    expect(firstCallParams['q_organization_domains_list[]']).toBeUndefined()
    expect(summary.breadthCandidates).toBe(2)
    expect(summary.depthCandidates).toBe(0)
    expect(summary.rounds).toBe(2)
    expect(summary.verified).toBe(2)
  })

  it('should use the depth phase to close the remaining shortfall in round 2, skipping breadth once the target is met', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'a.com')] }) // round 1 breadth, page 1: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p3', 'a.com')] }) // round 2 depth: second contact, fills remaining quota
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(3)
    const depthCallParams = mockSearchPeople.mock.calls[2]![0] as Record<string, string | string[]>
    expect(depthCallParams['q_organization_domains_list[]']).toEqual(['a.com'])
    expect(depthCallParams.q_keywords).toBeUndefined()
    expect(summary.depthCandidates).toBe(1)
    expect(summary.breadthCandidates).toBe(1)
    expect(summary.rounds).toBe(2)
    expect(summary.verified).toBe(2)
  })

  it('should fall back to breadth in a later round when depth finds no second contact, still reaching daily_target', async () => {
    // Regression test for the reported production bug: daily_target 15
    // returned only 9 companies, each with 1 lead, because the depth phase
    // never found a second contact and nothing retried the shortfall.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'a.com')] }) // round 1 breadth: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: a.com has no second contact
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p2', 'b.com')] }) // round 2 breadth: fresh company
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp })

    expect(summary.depthCandidates).toBe(0)
    expect(summary.breadthCandidates).toBe(2)
    expect(summary.verified).toBe(2)
    expect(summary.inserted).toBe(2)
  })

  it('should not re-query an exhausted target domain in a later round', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'a.com')] }) // round 1 breadth: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth (targets [a.com]): exhausted
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p2', 'b.com')] }) // round 2 breadth: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 3 depth (targets [b.com] only): exhausted
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 3 breadth: nothing left, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 3, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(7)
    const round3DepthParams = mockSearchPeople.mock.calls[5]![0] as Record<string, string | string[]>
    expect(round3DepthParams['q_organization_domains_list[]']).toEqual(['b.com'])
    expect(summary.verified).toBe(2) // short of daily_target 3 — Apollo genuinely ran dry
    expect(summary.rounds).toBe(3)
  })

  it('should stop without reaching daily_target when a round finds nothing at all', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary.verified).toBe(0)
    expect(summary.rounds).toBe(1)
    expect(summary.inserted).toBe(0)
  })

  it('should pick at most 1 person per brand-new company during a breadth phase, even if two appear on the same page', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ // round 1 breadth, page 1: 2 people at the same brand-new company
        totalEntries: 2,
        candidates: [candidate('p1', 'acme.com'), candidate('p2', 'acme.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: no second contact
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp })

    expect(summary.breadthCandidates).toBe(1)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p1' })])
  })

  it('should target a company from an earlier day that already has exactly 1 verified lead, starting with depth in round 1', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // round 1 depth: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing new
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp })

    const firstCallParams = mockSearchPeople.mock.calls[0]![0] as Record<string, string | string[]>
    expect(firstCallParams['q_organization_domains_list[]']).toEqual(['acme.com'])
    expect(firstCallParams.q_keywords).toBeUndefined()
    expect(summary.depthCandidates).toBe(1)
    expect(summary.breadthCandidates).toBe(0)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p5' })])
  })

  it('should not target a company with exactly 1 verified lead but no known domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: null, companyName: 'No Domain Co' }])
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary.depthCandidates).toBe(0)
  })

  it('should ignore depth-phase candidates whose company does not match any requested target domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p9', 'other.com')] }) // round 1 depth, page 1: off-target
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 depth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp })

    expect(summary.depthCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip candidates whose apolloId is already known for the client', async () => {
    mockGetKnownSourceIds.mockResolvedValue(new Set(['p1']))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
    expect(summary.newCandidates).toBe(0)
  })

  it('should default the quota to 50 when dailyTarget is 0, filling it entirely via breadth across two pages', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => candidate(`c${i}`))
    const page2 = Array.from({ length: 25 }, (_, i) => candidate(`d${i}`))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 25, candidates: page1 })
      .mockResolvedValueOnce({ totalEntries: 25, candidates: page2 })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
        email_status: 'verified', status: 'active',
      })),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 0, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.breadthCandidates).toBe(50)
    expect(summary.newCandidates).toBe(50)
    expect(summary.rounds).toBe(1)
  })

  it('should log a pipeline.discover.completed event with the summary', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, icp })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', type: 'pipeline.discover.completed',
    }))
  })

  it('should log a pipeline.discover.failed event and rethrow when a pipeline step throws', async () => {
    mockSearchPeople.mockRejectedValue(new Error('apollo down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, icp }),
    ).rejects.toThrow('apollo down')

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.failed',
      payload: expect.objectContaining({ campaignId: 'camp1', error: 'apollo down' }),
    }))
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.completed' }))
  })

  it('should still return the summary when the completion audit log throws', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])
    mockLogEvent.mockRejectedValue(new Error('audit db down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, icp }),
    ).resolves.toMatchObject({ campaignId: 'camp1' })
  })

  it('should rethrow the original discovery error even when failure audit logging also throws', async () => {
    mockSearchPeople.mockRejectedValue(new Error('apollo down'))
    mockLogEvent.mockRejectedValue(new Error('audit db down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, icp }),
    ).rejects.toThrow('apollo down')
  })

  it('should isolate a per-lead grouping failure so the rest of the batch is still grouped', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce('case2')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, icp })

    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(2)
    expect(summary.inserted).toBe(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.group_lead_failed' }))
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.completed' }))
  })

  it('should persist round-1 leads before a later round throws, so they are not lost', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'p1.com')] }) // round 1 breadth, page 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockRejectedValueOnce(new Error('apollo down')) // round 2 depth: search throws
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, icp }),
    ).rejects.toThrow('apollo down')

    // insertLeads was still called with the round-1 row even though the
    // whole run ultimately throws — a retried run picks this up via
    // getKnownSourceIds instead of re-discovering and re-enriching it.
    expect(mockInsertLeads).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ source_id: 'p1' }),
    ])
  })

  it('should skip a breadth candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [
          { ...candidate('p1', 'p1.com'), organizationName: 'Acme Staffing Agency' },
          candidate('p2', 'p2.com'),
        ],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.breadthCandidates).toBe(1)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p2' })])
  })

  it('should skip a breadth candidate whose title matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['recruiting'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'p1.com'), title: 'Recruiting Manager' }],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.breadthCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip a depth-phase candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p5', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // round 1 depth: excluded by org name, target dropped immediately
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.depthCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should permanently drop a depth target company whose organization name alone matches an excluded keyword, without waiting for page exhaustion of the other target', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([
      { companyDomain: 'acme.com', companyName: 'Acme' },
      { companyDomain: 'other.com', companyName: 'Other' },
    ])
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // round 1 depth, page 1: acme.com's only candidate excluded by org name -> dropped immediately
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [candidate('p2', 'other.com')],
      }) // round 1 depth, page 2: only other.com is still targeted (page reset — see the narrowed domain filter below)
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth (targets [acme.com]): exhausted
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp: excludingIcp },
    )

    const secondPageParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(secondPageParams['q_organization_domains_list[]']).toEqual(['other.com'])
    expect(summary.depthCandidates).toBe(1)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p2' })])
  })
})
```

Now replace the entire `describe('runDiscoveryForCampaign — multi-keyword organization search', () => { ... })` block (originally lines 946–1043) with:

```ts
describe('runDiscoveryForCampaign — multi-keyword organization search', () => {
  // Apollo's q_keywords field only accepts one free-text phrase at a time —
  // joining multiple organization keywords into one q_keywords string
  // returns 0 results (or HTTP 422 "Value too long" once long enough),
  // confirmed live against Apollo 2026-08-06. An ICP with more than one
  // keyword must search once per keyword instead of joining them. This only
  // applies to the breadth phase — the depth phase drops q_keywords
  // entirely (see the dedicated test below).
  const multiKeywordIcp: ApolloIcpFilters = { ...icp, keywords: ['private school', 'academy'] }

  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
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
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  it('should search Apollo once per organization keyword during a breadth phase, moving to the next keyword when one returns nothing', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] }) // "academy": found, fills quota
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 1, icp: multiKeywordIcp },
    )

    expect(mockSearchPeople.mock.calls[0]![0]).toMatchObject({ q_keywords: 'private school' })
    expect(mockSearchPeople.mock.calls[1]![0]).toMatchObject({ q_keywords: 'academy' })
    expect(summary.breadthCandidates).toBe(1)
  })

  it('should stop calling Apollo once the breadth quota is met, without searching remaining keywords', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 1, icp: multiKeywordIcp },
    )

    // Only the one call that met quota — "academy" is never searched.
    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
  })

  it('should NOT cycle through organization keywords during the depth phase — it searches once per page with no q_keywords', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // round 1 depth: found, no keyword cycling
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, "academy": nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth, "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth, "academy": nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp: multiKeywordIcp },
    )

    const depthCallParams = mockSearchPeople.mock.calls[0]![0] as Record<string, string | string[]>
    expect(depthCallParams.q_keywords).toBeUndefined()
    expect(depthCallParams['q_organization_domains_list[]']).toEqual(['acme.com'])
    expect(summary.depthCandidates).toBe(1)
  })
})
```

#### Step 2: Run the test file to verify the new tests fail

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — `summary.breadthCandidates`/`summary.depthCandidates`/`summary.rounds` are `undefined` (the implementation still produces `firstPassCandidates`/`secondPassCandidates`/`topUpCandidates`), and several tests fail on call-count/call-order assertions since the implementation still splits the quota in half for a fixed first pass.

#### Step 3: Fix the one-line payload assertion in `apollo failure attribution`

In the same file, find `describe('apollo failure attribution', () => { ... })` (unchanged otherwise) and update the one payload assertion:

```ts
    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.search.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', pass: 1, page: 1 },
    })
```

becomes:

```ts
    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.search.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', phase: 'breadth', round: 1, page: 1 },
    })
```

No other changes in that `describe` block (the `apollo.enrich.failed` test's payload shape is unaffected by this plan).

**No other blocks in this file need changes.** Traced explicitly against the new implementation before writing this plan:
- `describe('runDiscoveryForCampaign — Emailable deliverability guard', ...)` — every test uses `dailyTarget: 2` (or `4`) with a single fresh-company candidate. Under the round loop, round 1's breadth phase produces the exact same first `insertLeads` call the `insertedRow()` helper reads (`mockInsertLeads.mock.calls[0]`), regardless of whether a round 2 fires afterward (any extra calls fall through to the default empty-response mock and don't affect these tests' assertions, none of which count exact `searchPeople` calls).
- `describe('runDiscoveryForCampaign — suppression and post-enrich exclude filters', ...)` — same reasoning; every assertion in this block reads `summary.suppressedSkipped` / `summary.excludedPostEnrich` / `summary.verified` / specific mock call arguments, none of which depend on the old fixed-phase quota split.
- `describe('runDiscoveryForCampaign — AI relevance filter', ...)` — same reasoning for every test **except** `'should call checkCompanyRelevance only once for two eligible rows at the same company in one run'`, which needs its own rewrite (below).

Replace only that one test inside `describe('runDiscoveryForCampaign — AI relevance filter', ...)`:

```ts
  it('should call checkCompanyRelevance only once for two eligible rows at the same company in one run', async () => {
    // Round 1 breadth finds a brand-new company (p1 @ acme.com); it
    // verifies, so round 2's depth phase targets acme.com for a second
    // contact (p5) — both share a company_key within one discovery run,
    // the exact scenario the cache exists for.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] }) // round 1 breadth, page 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: stop
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // round 2 depth: second contact
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockCheckCompanyRelevance.mockResolvedValue({ pass: true, reason: 'Matches target profile.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp },
    )

    expect(mockCheckCompanyRelevance).toHaveBeenCalledTimes(1)
    expect(summary.aiChecked).toBe(2)
    expect(summary.depthCandidates).toBe(1)
  })
```

#### Step 4: Run the full test file again to confirm it still fails for the right reason

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — same shape of failures as Step 2, confirming no test typos before touching the implementation.

#### Step 5: Replace `DiscoverySummary` in `discover.ts`

Find the existing interface (currently has `firstPassCandidates`, `secondPassCandidates`, `topUpCandidates`):

```ts
export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  firstPassCandidates: number
  secondPassCandidates: number
  /** Fresh-company picks made only because pass 2 fell short of its quota (see topUpQuota below). */
  topUpCandidates: number
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
  /** Rows evaluated against the AI relevance filter (cache hits included). */
  aiChecked: number
  /** Rows parked because the AI relevance filter rejected their company. */
  aiRejected: number
  /** Rows that passed through unaffected because the AI relevance check itself failed (timeout/error). */
  aiFailedOpen: number
  inserted: number
}
```

Replace with:

```ts
export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  /** Picks from the depth phase (a second contact at a company already sitting at 1 verified lead), summed across every round this run. */
  depthCandidates: number
  /** Picks from the breadth phase (a brand-new company), summed across every round this run. */
  breadthCandidates: number
  /** Number of depth+breadth round pairs this run executed before hitting daily_target or a round finding nothing new. */
  rounds: number
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
  /** Rows evaluated against the AI relevance filter (cache hits included). */
  aiChecked: number
  /** Rows parked because the AI relevance filter rejected their company. */
  aiRejected: number
  /** Rows that passed through unaffected because the AI relevance check itself failed (timeout/error). */
  aiFailedOpen: number
  inserted: number
}
```

#### Step 6: Replace `runFirstPass` with `runBreadthSearch`

Find the existing function (currently named `runFirstPass`, with its doc comment block above it):

```ts
// Pass 1 (breadth): at most 1 person per brand-new company, regardless of
// how many people from that company appear in the results — a second
// contact is deliberately left to runSecondPass, never picked up here.
// companyPickCounts / domainBackedCompanyKeys are shared, mutated state
// threaded through both passes on purpose: they are how pass 2 learns which
// companies pass 1 (and earlier days) left at exactly 1 verified contact.
//
// Iterates (keyword, page) pairs rather than just pages — see
// searchTargets — cycling to the next keyword once the current one's page
// comes back empty. `call` is the real page-budget counter (MAX_SEARCH_PAGES
// total Apollo calls for the whole pass, same invariant as before this
// keyword-cycling existed); `page` only counts pages within the current
// keyword.
async function runFirstPass(
  campaign: CampaignForDiscovery,
  quota: number,
  known: Set<string>,
  companyPickCounts: Map<string, number>,
  domainBackedCompanyKeys: Set<string>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const targets = searchTargets(icp)
  let targetIndex = 0
  let page = 1
  for (let call = 0; call < MAX_SEARCH_PAGES && picks.length < quota && targetIndex < targets.length; call++) {
    const params = buildPeopleSearchParams(icpForTarget(icp, targets[targetIndex]!), page, SEARCH_PER_PAGE)
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { pass: 1, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) {
      targetIndex += 1
      page = 1
      continue
    }
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
    page += 1
  }
  return { picks, candidatesSeen }
}
```

Replace with:

```ts
// Breadth (new companies): at most 1 person per brand-new company,
// regardless of how many people from that company appear in the results —
// a second contact is deliberately left to runDepthSearch, never picked up
// here. companyPickCounts / domainBackedCompanyKeys are caller-owned,
// mutated state: they are how the caller learns which companies this call
// (and earlier rounds/days) left at exactly 1 pick.
//
// Iterates (keyword, page) pairs rather than just pages — see
// searchTargets — cycling to the next keyword once the current one's page
// comes back empty. `call` is the real page-budget counter (MAX_SEARCH_PAGES
// total Apollo calls for this phase); `page` only counts pages within the
// current keyword.
async function runBreadthSearch(
  campaign: CampaignForDiscovery,
  round: number,
  quota: number,
  known: Set<string>,
  companyPickCounts: Map<string, number>,
  domainBackedCompanyKeys: Set<string>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const targets = searchTargets(icp)
  let targetIndex = 0
  let page = 1
  for (let call = 0; call < MAX_SEARCH_PAGES && picks.length < quota && targetIndex < targets.length; call++) {
    const params = buildPeopleSearchParams(icpForTarget(icp, targets[targetIndex]!), page, SEARCH_PER_PAGE)
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { phase: 'breadth', round, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) {
      targetIndex += 1
      page = 1
      continue
    }
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
    page += 1
  }
  return { picks, candidatesSeen }
}
```

#### Step 7: Replace `runSecondPass` with `runDepthSearch`

Find the existing function and its doc comment (the whole `runSecondPass` block). Replace it entirely with:

```ts
interface DepthSearchResult extends SearchPassResult {
  /** Domains searched this call that came back with zero further Apollo
   * results — not "found nothing yet" but "nothing left to find" for this
   * run. The caller drops these from every later round's depth targets
   * instead of re-querying a domain that already came back empty. A domain
   * dropped only because the page budget ran out (not because Apollo ran
   * dry) is NOT included here — a later round may still find something for
   * it with fresh budget. */
  exhaustedDomains: Set<string>
}

// Depth (2nd contact): a company-scoped search (Apollo domain filter)
// targeting exactly the companies that currently sit at 1 verified
// contact, trying to find a second, different person at each. A company
// that doesn't surface a match here simply stays at 1 — case activation
// already accepts that (group-lead.ts), so it is not treated as a failure.
//
// Deliberately omits icp.keywords / q_keywords: the domain restriction
// already pins the exact company, so an additional free-text company-level
// keyword match is redundant and produces false negatives whenever that
// company's Apollo org profile doesn't literally contain the keyword text
// (confirmed live 2026-08-06 — see
// docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md).
// person_titles / employee range / contact_email_status still apply, so a
// second contact still has to be a legitimate ICP-matching persona.
//
// The domain filter narrows every time a target is found (remainingTargets
// shrinks), so `page` is reset to 1 whenever that happens — page N of a
// freshly narrowed filter is not a continuation of page N against the old,
// wider filter, and would silently skip results. `call` is the real
// page-budget counter since `page` no longer counts monotonically.
async function runDepthSearch(
  campaign: CampaignForDiscovery,
  round: number,
  quota: number,
  known: Set<string>,
  targetDomains: string[],
): Promise<DepthSearchResult> {
  const { icp } = campaign
  const searchIcp: ApolloIcpFilters = { ...icp, keywords: [] }
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const remainingTargets = new Set(targetDomains)
  let page = 1
  let ranOutOfResults = false
  for (let call = 0; call < MAX_SEARCH_PAGES && picks.length < quota && remainingTargets.size > 0; call++) {
    const targetsBefore = remainingTargets.size
    const params = buildPeopleSearchParams(searchIcp, page, SEARCH_PER_PAGE, [...remainingTargets])
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { phase: 'depth', round, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) {
      ranOutOfResults = true
      break
    }
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
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (!remainingTargets.has(companyKey)) continue
      remainingTargets.delete(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
    page = remainingTargets.size === targetsBefore ? page + 1 : 1
  }
  const exhaustedDomains = ranOutOfResults ? new Set(remainingTargets) : new Set<string>()
  return { picks, candidatesSeen, exhaustedDomains }
}
```

#### Step 8: Replace `runDiscoveryForCampaign`'s orchestration

Find the existing function (the whole body from `export async function runDiscoveryForCampaign(` through its closing `}`). Replace the **entire function** with:

```ts
export async function runDiscoveryForCampaign(
  supabase: SupabaseClient<Database>,
  campaign: CampaignForDiscovery,
): Promise<DiscoverySummary> {
  try {
    const quota = campaign.dailyTarget > 0 ? campaign.dailyTarget : DEFAULT_DAILY_QUOTA
    const known = await getKnownSourceIds(supabase, campaign.clientId)
    const existingCompanies = await getVerifiedLeadCompanies(supabase, campaign.id)
    // Shared across every phase of every round so a company judged once by
    // the AI relevance filter is never re-judged for a second contact
    // discovered at the same company later in this run.
    const aiVerdictCache = new Map<string, RelevanceVerdict>()

    // Persist and mutate across every round of this run — see
    // docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md
    // ("Architecture"). verifiedCompanyCounts is only ever updated from a
    // phase's REAL post-verification outcome (never an optimistic guess made
    // at pick time), so every round's depth-targeting decision stays
    // accurate even across many rounds.
    const verifiedCompanyCounts = new Map<string, number>()
    const domainBackedCompanyKeys = new Set<string>()
    for (const company of existingCompanies) {
      const key = computeCompanyKey(company.companyDomain, company.companyName)
      verifiedCompanyCounts.set(key, (verifiedCompanyCounts.get(key) ?? 0) + 1)
      if (company.companyDomain) domainBackedCompanyKeys.add(key)
    }
    // A domain that came back with zero further Apollo results in an
    // earlier round of THIS run — never retried, since Apollo's answer for
    // an unchanged, unnarrowed domain-restricted query will not change
    // within the same run.
    const exhaustedDomains = new Set<string>()

    const inserted: LeadRow[] = []
    let candidatesSeen = 0
    let depthCandidates = 0
    let breadthCandidates = 0
    let enrichedCount = 0
    let verifiedSoFar = 0
    let emailableChecked = 0
    let emailableDeliverable = 0
    let emailableRejected = 0
    let emailableFailedOpen = 0
    let suppressedSkipped = 0
    let excludedPostEnrich = 0
    let aiChecked = 0
    let aiRejected = 0
    let aiFailedOpen = 0
    let rounds = 0

    // Folds one phase's enrichCandidates() output into the run's running
    // totals, persists its rows (durable immediately — a later phase or
    // round throwing must never discard already-durable work), and updates
    // verifiedCompanyCounts/domainBackedCompanyKeys from the real
    // post-verification outcome.
    const applyEnrichResult = async (picks: FreshCandidate[], result: EnrichResult): Promise<void> => {
      enrichedCount += result.rows.length
      emailableChecked += result.emailableChecked
      emailableDeliverable += result.emailableDeliverable
      emailableRejected += result.emailableRejected
      emailableFailedOpen += result.emailableFailedOpen
      suppressedSkipped += result.suppressedSkipped
      excludedPostEnrich += result.excludedPostEnrich
      aiChecked += result.aiChecked
      aiRejected += result.aiRejected
      aiFailedOpen += result.aiFailedOpen
      verifiedSoFar += result.verifiedCount

      const insertedRows = await insertLeads(supabase, result.rows)
      inserted.push(...insertedRows)

      const verifiedApolloIds = new Set(
        result.rows.filter((row) => row.status === 'active').map((row) => row.source_id),
      )
      for (const pick of picks) {
        if (!verifiedApolloIds.has(pick.apolloId)) continue
        const key = computeCompanyKey(pick.organizationDomain, pick.organizationName)
        verifiedCompanyCounts.set(key, (verifiedCompanyCounts.get(key) ?? 0) + 1)
        if (pick.organizationDomain) domainBackedCompanyKeys.add(key)
      }
    }

    while (verifiedSoFar < quota) {
      rounds += 1
      let roundPicks = 0

      const targetDomains = [...verifiedCompanyCounts.entries()]
        .filter(([key, count]) => count === 1 && domainBackedCompanyKeys.has(key) && !exhaustedDomains.has(key))
        .map(([key]) => key)

      if (targetDomains.length > 0) {
        const depthQuota = quota - verifiedSoFar
        const depth = await runDepthSearch(campaign, rounds, depthQuota, known, targetDomains)
        candidatesSeen += depth.candidatesSeen
        depthCandidates += depth.picks.length
        roundPicks += depth.picks.length
        for (const domain of depth.exhaustedDomains) exhaustedDomains.add(domain)
        for (const pick of depth.picks) known.add(pick.apolloId)
        const depthEnriched = await enrichCandidates(depth.picks, campaign, supabase, aiVerdictCache)
        await applyEnrichResult(depth.picks, depthEnriched)
      }

      const breadthQuota = quota - verifiedSoFar
      if (breadthQuota > 0) {
        // Throwaway snapshot: runBreadthSearch mutates it optimistically
        // (immediate +1 on pick, before verification is known) purely to
        // avoid picking two people from the same brand-new company within
        // this one call — never merged back into verifiedCompanyCounts,
        // which is only ever updated from a real outcome above.
        const breadthPickCounts = new Map(verifiedCompanyCounts)
        const breadth = await runBreadthSearch(
          campaign,
          rounds,
          breadthQuota,
          known,
          breadthPickCounts,
          domainBackedCompanyKeys,
        )
        candidatesSeen += breadth.candidatesSeen
        breadthCandidates += breadth.picks.length
        roundPicks += breadth.picks.length
        for (const pick of breadth.picks) known.add(pick.apolloId)
        const breadthEnriched = await enrichCandidates(breadth.picks, campaign, supabase, aiVerdictCache)
        await applyEnrichResult(breadth.picks, breadthEnriched)
      }

      if (roundPicks === 0) break
    }

    for (const lead of inserted) {
      if (lead.status !== 'active') continue
      try {
        await groupVerifiedLead(supabase, {
          id: lead.id,
          clientId: lead.client_id,
          campaignId: lead.campaign_id,
          companyName: lead.company_name,
          companyDomain: lead.company_domain,
          raw: lead.raw,
        })
      } catch (error) {
        // Isolate one lead's grouping failure so the rest of the batch (already
        // inserted) still gets grouped instead of the whole run failing.
        try {
          await logEvent({
            clientId: campaign.clientId,
            actor: 'system',
            type: 'pipeline.discover.group_lead_failed',
            severity: 'error',
            source: 'pipeline',
            payload: {
              campaignId: campaign.id,
              leadId: lead.id,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        } catch {
          // Audit logging is best-effort.
        }
      }
    }

    const summary: DiscoverySummary = {
      campaignId: campaign.id,
      candidatesSeen,
      newCandidates: depthCandidates + breadthCandidates,
      depthCandidates,
      breadthCandidates,
      rounds,
      enriched: enrichedCount,
      verified: verifiedSoFar,
      emailableChecked,
      emailableDeliverable,
      emailableRejected,
      emailableFailedOpen,
      suppressedSkipped,
      excludedPostEnrich,
      aiChecked,
      aiRejected,
      aiFailedOpen,
      inserted: inserted.length,
    }

    try {
      await logEvent({
        clientId: campaign.clientId,
        actor: 'system',
        type: 'pipeline.discover.completed',
        source: 'pipeline',
        payload: { ...summary },
      })
    } catch {
      // Audit logging is best-effort — it must not turn a completed discovery
      // run into a rejected operation.
    }

    return summary
  } catch (error) {
    try {
      await logEvent({
        clientId: campaign.clientId,
        actor: 'system',
        type: 'pipeline.discover.failed',
        severity: 'error',
        source: 'pipeline',
        payload: {
          campaignId: campaign.id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } catch {
      // Audit logging is best-effort — it must not mask the original
      // discovery failure being rethrown below.
    }
    throw error
  }
}
```

Nothing else in `discover.ts` changes — `VerifiableRow`, `VerifyBatchResult`, `verifyRow`, `verifyBatch`, `EnrichResult`, `isVerifiableRow`, `logDiscoveryFilterEvent`, `logAiRejectedEvent`, `logAiCheckFailedEvent`, `enrichCandidates`, `vendorContext`, `searchTargets`, `icpForTarget`, `toFreshCandidate`, `CampaignForDiscovery`, `FreshCandidate`, `SearchPassResult`, and all constants are untouched.

#### Step 9: Run the test file to verify everything passes

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — every test in the file green.

If any test fails, re-trace the specific mock call sequence against the new round loop (each test's comments document the expected round/phase/call breakdown) before changing implementation code — a failing assertion here almost always means a miscounted mock response in the test, not a wrong loop.

#### Step 10: Update the stale comment in `build-search-params.ts`

Find:

```ts
  // Second-pass targeting (src/lib/pipeline/discover.ts runSecondPass):
  // restricts the search to specific companies so discovery can go back for
  // a second contact. Confirmed against Apollo's People Search API docs
  // (docs.apollo.io/reference/people-api-search).
```

Replace with:

```ts
  // Depth-phase targeting (src/lib/pipeline/discover.ts runDepthSearch):
  // restricts the search to specific companies so discovery can go back for
  // a second contact. Confirmed against Apollo's People Search API docs
  // (docs.apollo.io/reference/people-api-search).
```

#### Step 11: Run the full repo test suite for regressions

Run: `pnpm vitest run`
Expected: PASS — no other file references `runFirstPass`/`runSecondPass`/`firstPassCandidates`/`secondPassCandidates`/`topUpCandidates`/`DiscoverySummary` (confirmed by repo-wide grep before writing this plan — only `discover.ts` and `discover.test.ts` use these names), so no other test file should be affected. If something unexpected breaks, stop and investigate before proceeding — do not silence or skip the failing test.

#### Step 12: Typecheck

Run: `pnpm tsc --noEmit` (or the project's existing typecheck script if different — check `package.json`'s `scripts` block first)
Expected: PASS — no `any`, no implicit-any regressions, `DiscoverySummary`'s new field names match everywhere they're constructed and read.

#### Step 13: Update `.claude/roadmap.md`

Open `.claude/roadmap.md`, find the entry (or section) describing discovery's pass-1/pass-2/top-up quota behavior, and add a note recording this change — the exact wording depends on the file's existing format; match its style. At minimum record: root cause found and fixed (quota-vs-active-leads gap, and the pass-2 query bug), replaced with a depth-first retry loop, and the `getVerifiedLeadCompanies` correctness fix.

#### Step 14: Commit

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts src/lib/apollo/build-search-params.ts .claude/roadmap.md
git commit -m "$(cat <<'EOF'
fix(discover): depth-first retry loop to actually reach daily_target

Root cause (investigated against production event logs): daily_target
budgeted Apollo search attempts, not delivered active leads, and the
"find a second contact" phase had returned 0 candidates in every one
of the 9 discover.completed events ever logged, because it ANDed a
redundant free-text keyword filter onto an already-exact domain
restriction.

Replaces the fixed first-pass/second-pass/top-up run with a round
loop: each round tries depth (a second contact at a company already
sitting at 1 verified lead) before breadth (a brand-new company),
and keeps rounding until daily_target is met or a round finds
nothing new. The depth phase drops the redundant q_keywords filter.

DiscoverySummary fields firstPassCandidates/secondPassCandidates/
topUpCandidates are replaced with depthCandidates/breadthCandidates/
rounds.

See docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md
for the full design.
EOF
)"
```

---

## Post-Implementation Verification

After all three tasks are committed:

- [ ] Run `pnpm vitest run` once more from a clean state to confirm the full suite is green.
- [ ] Skim the `pipeline.discover.completed` events for the next few real campaign runs (same query pattern used during investigation: `select * from events where type = 'pipeline.discover.completed' order by created_at desc`) and confirm `depthCandidates` is nonzero at least sometimes, and `rounds` is sometimes `> 1` — both were structurally impossible before this fix.
