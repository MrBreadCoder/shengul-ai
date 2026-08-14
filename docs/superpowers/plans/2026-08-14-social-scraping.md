# Person + Company Social Scraping Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture Apollo's already-paid-for social/growth fields, scrape fresh LinkedIn/X posts for every lead and their company via Bright Data, store them in `case_knowledge` with correct person/company attribution, and fix the one line in `write.ts` that makes shipping attributed data safe.

**Architecture:** Two new leaf modules (`social-scrape.ts` — a thin Bright Data Datasets v3 client; `social-knowledge.ts` — deterministic cutoff+mapping orchestration) feed into the existing `runResearchForCase` concurrency alongside the untouched company research agent. A `case_knowledge` migration adds `lead_id`/`event_date`; `write.ts`'s dossier assembly filters on `lead_id` per-lead before prompting. No LLM involved in acquisition — every mapping is deterministic, which is what makes attribution safe by construction.

**Tech Stack:** TypeScript, Zod, Vitest, Supabase (Postgres), Bright Data Datasets v3 API, Apollo API.

**Spec:** `docs/superpowers/specs/2026-08-14-social-scraping-design.md`

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (QUALITY.md).
- Every external call wrapped in a timeout and mapped to `AppError` on failure — never let a raw SDK/fetch error escape.
- Zod validation on every external response; `.safeParse`/`.passthrough()` per this codebase's existing Apollo/Bright Data client conventions.
- DB columns snake_case, TypeScript camelCase — mapped explicitly, never assumed to match.
- Facebook is out of scope entirely (no bounded discovery mode exists on that platform).
- `ENABLE_PERSON_RESEARCH` in `src/lib/pipeline/research.ts` stays `false` — untouched by this plan.
- Posts older than 90 days are hard-discarded, never stored.
- Every active lead in a case gets scraped, not just the primary contact.
- `pnpm typecheck && pnpm lint && pnpm test` must be clean at the end of every task, not just at the end of the plan.

---

## Task 1: `case_knowledge` migration — attribution + recency columns

**Files:**
- Create: `supabase/migrations/0044_case_knowledge_attribution.sql`
- Modify: `src/types/database.ts:292-315` (`case_knowledge` table types)

**Interfaces:**
- Produces: `case_knowledge.lead_id: string | null`, `case_knowledge.event_date: string | null` on `Database['public']['Tables']['case_knowledge']['Row']` / `['Insert']` — every later task that reads/writes `case_knowledge` relies on these two fields existing on `KnowledgeRow`/`KnowledgeInsert` (`src/lib/db/case-knowledge.ts:5-6`).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0044_case_knowledge_attribution.sql`:

```sql
-- Fixes the root cause behind the 2026-08-11 person-research attribution bug
-- (.claude/roadmap.md same date): case_knowledge had no way to record *whose*
-- a person-kind fact was, so write.ts handed every case's full knowledge set
-- to every lead's prompt unfiltered. lead_id is null for company-level facts,
-- set for person-level facts. event_date supports a hard recency cutoff for
-- dated facts (e.g. scraped social posts) — null for evergreen firmographics.
-- See docs/superpowers/specs/2026-08-14-social-scraping-design.md.
alter table case_knowledge add column lead_id    uuid references leads(id) on delete set null;
alter table case_knowledge add column event_date timestamptz;

create index case_knowledge_lead_id_idx on case_knowledge(lead_id) where lead_id is not null;
```

No RLS policy changes — `case_knowledge`'s existing policies (`supabase/migrations/0002_rls_policies.sql:36-41`) key entirely off `client_id`, unaffected by additive nullable columns.

- [ ] **Step 2: Apply the migration locally and verify it applies cleanly**

Run: `pnpm supabase db reset` (or your project's equivalent local-apply command)
Expected: migration `0044_case_knowledge_attribution.sql` applies with no errors; `case_knowledge` now has `lead_id` and `event_date` columns.

Verify with:
```bash
pnpm supabase db diff --schema public 2>&1 | grep -i case_knowledge || echo "no pending diff — migration matches applied schema"
```

- [ ] **Step 3: Update the hand-authored database types**

Edit `src/types/database.ts:292-315`:

```ts
      case_knowledge: {
        Row: {
          id: string
          client_id: string
          case_id: string
          kind: Database['public']['Enums']['knowledge_kind']
          content: string
          source_url: string | null
          citation: string | null
          created_by: Database['public']['Enums']['author_kind']
          created_at: string
          lead_id: string | null
          event_date: string | null
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          kind: Database['public']['Enums']['knowledge_kind']
          content: string
          source_url?: string | null
          citation?: string | null
          created_by?: Database['public']['Enums']['author_kind']
          created_at?: string
          lead_id?: string | null
          event_date?: string | null
        }
        Update: Partial<Database['public']['Tables']['case_knowledge']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'case_knowledge_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
```
(leave the rest of the `Relationships` array and everything after it exactly as-is — only the `Row`/`Insert` object literals above gain the two new fields).

- [ ] **Step 4: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: PASS (no consumer of `KnowledgeRow`/`KnowledgeInsert` yet reads the new optional fields, so nothing can break at this point).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0044_case_knowledge_attribution.sql src/types/database.ts
git commit -m "feat(db): add lead_id and event_date to case_knowledge"
```

---

## Task 2: `write.ts` attribution fix (the safety fix)

**Files:**
- Modify: `src/lib/pipeline/write.ts:277-291` (`runWriteForCase`)
- Test: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `KnowledgeRow.lead_id: string | null` (Task 1).
- Produces: no new exports — `runWriteForCase`'s external signature is unchanged; only its internal per-lead knowledge filtering changes.

This is the regression test for the 2026-08-11 bug: two leads sharing one case, one `lead_id`-tagged knowledge row each, plus one company-wide row — each lead's prompt must include the company row and only its own person row.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/pipeline/write.test.ts`, inside (or near) `describe('runWriteForCase', ...)`:

```ts
  it('should only include a lead_id-tagged knowledge row in the prompt for the lead it belongs to', async () => {
    const leadA = { ...lead, id: 'lead-a', full_name: 'Jane Doe', email: 'jane@acme.com' }
    const leadB = { ...lead, id: 'lead-b', full_name: 'Sam Lee', email: 'sam@acme.com' }
    listActiveLeadsMock.mockResolvedValue([leadA, leadB])
    listKnowledgeMock.mockResolvedValue([
      { kind: 'company', content: 'Acme builds workflow automation.', lead_id: null },
      { kind: 'news', content: "Jane's LinkedIn post about hiring", lead_id: 'lead-a' },
      { kind: 'news', content: "Sam's LinkedIn post about a new role", lead_id: 'lead-b' },
    ])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(generateJsonMock).toHaveBeenCalledTimes(2)
    const [janeCall, samCall] = generateJsonMock.mock.calls as [unknown, { prompt: string }][2]
    expect(janeCall[1].prompt).toContain("Jane's LinkedIn post about hiring")
    expect(janeCall[1].prompt).not.toContain("Sam's LinkedIn post about a new role")
    expect(janeCall[1].prompt).toContain('Acme builds workflow automation.')
    expect(samCall[1].prompt).toContain("Sam's LinkedIn post about a new role")
    expect(samCall[1].prompt).not.toContain("Jane's LinkedIn post about hiring")
    expect(samCall[1].prompt).toContain('Acme builds workflow automation.')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/pipeline/write.test.ts -t "should only include a lead_id-tagged knowledge row"`
Expected: FAIL — both calls' prompts currently contain both leads' facts (no filtering happens today).

- [ ] **Step 3: Implement the filter**

Edit `src/lib/pipeline/write.ts:287-291` (inside `runWriteForCase`):

```ts
  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    // `k.lead_id ?? null` (not a bare `=== null` check) treats a row that
    // omits the field entirely the same as one that explicitly has it null —
    // both existing test fixtures and any case_knowledge row inserted before
    // this migration lack the key outright, and both mean "company-wide
    // fact," never "silently excluded."
    const leadKnowledge = knowledge.filter((k) => (k.lead_id ?? null) === null || k.lead_id === lead.id)
    const outcome = await processLead(supabase, input, lead, leadKnowledge, client)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
  }
```

(Only the `for` loop body changes — `knowledge`/`leads`/`client` fetches above it at lines 281-283 are unchanged.)

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/pipeline/write.test.ts -t "should only include a lead_id-tagged knowledge row"`
Expected: PASS

- [ ] **Step 5: Run the full write.test.ts file to confirm no regression**

Run: `pnpm test src/lib/pipeline/write.test.ts`
Expected: PASS — every existing test still passes, including the ones relying on the default fixture `listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])` (no `lead_id` key at all — the `?? null` in Step 3 is what keeps this row reaching every lead, exactly as before this change).

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "fix(write): filter case_knowledge by lead_id before building each lead's prompt"
```

---

## Task 3: Apollo schema widening — person `twitter_url`, org social/growth fields

**Files:**
- Modify: `src/lib/apollo/client.ts:26-37,52-60,88-101,142-166`
- Modify: `src/lib/apollo/types.ts:45-72`
- Test: `src/lib/apollo/client.test.ts`

**Interfaces:**
- Produces: `ApolloEnrichedPerson.twitterUrl`, `.organizationLinkedinUrl`, `.organizationTwitterUrl`, `.organizationRevenue`, `.organizationHeadcountGrowth6Month`, `.organizationHeadcountGrowth12Month`, `.organizationHeadcountGrowth24Month` (all `string | null` or `number | null`); `ApolloSearchCandidate.twitterUrl: string | null`. Task 4's raw-parsers and Task 8's route wiring both read these exact field names off `leads.raw`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/apollo/client.test.ts`, inside `describe('bulkMatchPeople', ...)`:

```ts
  it('should map twitter_url and organization social/growth fields from the enriched response', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{
        id: 'p6',
        twitter_url: 'https://x.com/janedoe',
        organization: {
          name: 'Acme', primary_domain: 'acme.com',
          linkedin_url: 'https://linkedin.com/company/acme',
          twitter_url: 'https://x.com/acme',
          organization_revenue: 1_200_000,
          organization_headcount_six_month_growth: 0.05,
          organization_headcount_twelve_month_growth: 0.12,
          organization_headcount_twenty_four_month_growth: 0.30,
        },
      }],
    })
    const result = await bulkMatchPeople([{ id: 'p6' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      twitterUrl: 'https://x.com/janedoe',
      organizationLinkedinUrl: 'https://linkedin.com/company/acme',
      organizationTwitterUrl: 'https://x.com/acme',
      organizationRevenue: 1_200_000,
      organizationHeadcountGrowth6Month: 0.05,
      organizationHeadcountGrowth12Month: 0.12,
      organizationHeadcountGrowth24Month: 0.30,
    })
  })

  it('should return null for twitter_url and organization social/growth fields when absent', async () => {
    mockFetchJson.mockResolvedValueOnce({ matches: [{ id: 'p7' }] })
    const result = await bulkMatchPeople([{ id: 'p7' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      twitterUrl: null,
      organizationLinkedinUrl: null,
      organizationTwitterUrl: null,
      organizationRevenue: null,
      organizationHeadcountGrowth6Month: null,
      organizationHeadcountGrowth12Month: null,
      organizationHeadcountGrowth24Month: null,
    })
  })
```

Add to `describe('searchPeople', ...)`:

```ts
  it('should map twitter_url onto the search candidate', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_entries: 1,
      people: [{ id: 'p8', first_name: 'Al', twitter_url: 'https://x.com/al', organization: { name: 'Beta' } }],
    })
    const { candidates } = await searchPeople({})
    // the mocked response above contains exactly one person
    expect(candidates[0]!.twitterUrl).toBe('https://x.com/al')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/apollo/client.test.ts -t "twitter_url"`
Expected: FAIL — the current `ApolloEnrichedPerson`/`ApolloSearchCandidate` mapping doesn't produce these fields, and TypeScript will also flag `toMatchObject`'s keys as not present on the mapped type once `types.ts` is checked at build time (this test file currently compiles because `toMatchObject` accepts a partial object without strict key checking against the full return type — the test itself will still fail at the assertion, not at compile time).

- [ ] **Step 3: Widen the Zod schemas and types**

Edit `src/lib/apollo/client.ts:26-37` (`organizationSchema`):

```ts
const organizationSchema = z.object({
  name: z.string().nullable().optional(),
  primary_domain: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  estimated_num_employees: z.number().nullable().optional(),
  founded_year: z.number().nullable().optional(),
  short_description: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  organization_revenue: z.number().nullable().optional(),
  organization_headcount_six_month_growth: z.number().nullable().optional(),
  organization_headcount_twelve_month_growth: z.number().nullable().optional(),
  organization_headcount_twenty_four_month_growth: z.number().nullable().optional(),
}).nullable().optional()
```

Edit `src/lib/apollo/client.ts:52-60` (`searchPersonSchema`) — add one line:

```ts
const searchPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  last_name_obfuscated: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  organization: organizationSchema,
}).passthrough()
```

Edit `src/lib/apollo/client.ts:76-84` (`searchPeople`'s mapping) — add one line:

```ts
  const candidates: ApolloSearchCandidate[] = (res.people ?? []).map((p) => ({
    apolloId: p.id,
    firstName: p.first_name ?? '',
    lastNamePreview: p.last_name ?? p.last_name_obfuscated ?? null,
    title: p.title ?? null,
    organizationName: p.organization?.name ?? null,
    organizationDomain: domainFromOrg(p.organization),
    linkedinUrl: p.linkedin_url ?? null,
    twitterUrl: p.twitter_url ?? null,
  }))
```

Edit `src/lib/apollo/client.ts:88-101` (`enrichedPersonSchema`) — add one line:

```ts
const enrichedPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  email_status: z.string().nullable().optional(),
  contact_emails: z.array(z.object({
    email: z.string().nullable().optional(),
    email_status: z.string().nullable().optional(),
  })).optional(),
  organization: organizationSchema,
}).passthrough()
```

Edit `src/lib/apollo/client.ts:148-165` (`bulkMatchPeople`'s per-person mapping):

```ts
    return {
      apolloId: p.id,
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
      title: p.title ?? null,
      email,
      emailStatus,
      linkedinUrl: p.linkedin_url ?? null,
      twitterUrl: p.twitter_url ?? null,
      organizationName: p.organization?.name ?? null,
      organizationDomain: domainFromOrg(p.organization),
      organizationIndustry: p.organization?.industry ?? null,
      organizationEmployeeCount: p.organization?.estimated_num_employees ?? null,
      organizationFoundedYear: p.organization?.founded_year ?? null,
      organizationDescription: p.organization?.short_description ?? null,
      organizationCity: p.organization?.city ?? null,
      organizationState: p.organization?.state ?? null,
      organizationCountry: p.organization?.country ?? null,
      organizationLinkedinUrl: p.organization?.linkedin_url ?? null,
      organizationTwitterUrl: p.organization?.twitter_url ?? null,
      organizationRevenue: p.organization?.organization_revenue ?? null,
      organizationHeadcountGrowth6Month: p.organization?.organization_headcount_six_month_growth ?? null,
      organizationHeadcountGrowth12Month: p.organization?.organization_headcount_twelve_month_growth ?? null,
      organizationHeadcountGrowth24Month: p.organization?.organization_headcount_twenty_four_month_growth ?? null,
    }
```

Edit `src/lib/apollo/types.ts:45-72`:

```ts
export interface ApolloSearchCandidate {
  apolloId: string
  firstName: string
  lastNamePreview: string | null
  title: string | null
  organizationName: string | null
  organizationDomain: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
}

export interface ApolloEnrichedPerson {
  apolloId: string
  firstName: string | null
  lastName: string | null
  title: string | null
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
  organizationName: string | null
  organizationDomain: string | null
  organizationIndustry: string | null
  organizationEmployeeCount: number | null
  organizationFoundedYear: number | null
  organizationDescription: string | null
  organizationCity: string | null
  organizationState: string | null
  organizationCountry: string | null
  organizationLinkedinUrl: string | null
  organizationTwitterUrl: string | null
  organizationRevenue: number | null
  organizationHeadcountGrowth6Month: number | null
  organizationHeadcountGrowth12Month: number | null
  organizationHeadcountGrowth24Month: number | null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/apollo/client.test.ts`
Expected: PASS — including every pre-existing test in the file (the two new schema fields are `.optional()`, so no existing fixture breaks).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/apollo/client.ts src/lib/apollo/types.ts src/lib/apollo/client.test.ts
git commit -m "feat(apollo): capture twitter_url and org social/growth fields (zero extra credits)"
```

---

## Task 4: Raw-parsers for company/person socials

**Files:**
- Modify: `src/lib/apollo/format-company-summary.ts`
- Test: `src/lib/apollo/format-company-summary.test.ts`

**Interfaces:**
- Consumes: `Json` type from `@/types/database`; the camelCase field names produced by Task 3 (`organizationLinkedinUrl`, `organizationTwitterUrl`, `twitterUrl`) as they appear inside `leads.raw` (already-mapped `ApolloEnrichedPerson`, per the existing comment at `format-company-summary.ts:14-17`).
- Produces: `parseCompanySocialsFromRaw(raw: Json): { linkedinUrl: string | null; twitterUrl: string | null }`, `parsePersonSocialsFromRaw(raw: Json): { twitterUrl: string | null }` — Task 8's route wiring calls both.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/apollo/format-company-summary.test.ts`:

```ts
import { parseCompanySocialsFromRaw, parsePersonSocialsFromRaw } from './format-company-summary'

describe('parseCompanySocialsFromRaw', () => {
  it('should map organizationLinkedinUrl and organizationTwitterUrl when present', () => {
    const result = parseCompanySocialsFromRaw({
      organizationLinkedinUrl: 'https://linkedin.com/company/acme',
      organizationTwitterUrl: 'https://x.com/acme',
    })
    expect(result).toEqual({ linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' })
  })

  it('should return all-null when the fields are absent', () => {
    const result = parseCompanySocialsFromRaw({ organizationName: 'Acme' })
    expect(result).toEqual({ linkedinUrl: null, twitterUrl: null })
  })

  it('should return all-null (not throw) for a non-object raw value', () => {
    const result = parseCompanySocialsFromRaw(null)
    expect(result).toEqual({ linkedinUrl: null, twitterUrl: null })
  })
})

describe('parsePersonSocialsFromRaw', () => {
  it('should map twitterUrl when present', () => {
    const result = parsePersonSocialsFromRaw({ twitterUrl: 'https://x.com/janedoe' })
    expect(result).toEqual({ twitterUrl: 'https://x.com/janedoe' })
  })

  it('should return null when absent', () => {
    const result = parsePersonSocialsFromRaw({ firstName: 'Jane' })
    expect(result).toEqual({ twitterUrl: null })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/apollo/format-company-summary.test.ts -t "SocialsFromRaw"`
Expected: FAIL with "parseCompanySocialsFromRaw is not a function" (or import error).

- [ ] **Step 3: Implement the parsers**

Add to `src/lib/apollo/format-company-summary.ts`, after `parseCompanyFirmographicsFromRaw` (after line 43):

```ts
const rawCompanySocialsSchema = z.object({
  organizationLinkedinUrl: z.string().nullable().optional(),
  organizationTwitterUrl: z.string().nullable().optional(),
}).passthrough()

export function parseCompanySocialsFromRaw(raw: Json): { linkedinUrl: string | null; twitterUrl: string | null } {
  const parsed = rawCompanySocialsSchema.safeParse(raw)
  if (!parsed.success) return { linkedinUrl: null, twitterUrl: null }
  return { linkedinUrl: parsed.data.organizationLinkedinUrl ?? null, twitterUrl: parsed.data.organizationTwitterUrl ?? null }
}

const rawPersonSocialsSchema = z.object({
  twitterUrl: z.string().nullable().optional(),
}).passthrough()

export function parsePersonSocialsFromRaw(raw: Json): { twitterUrl: string | null } {
  const parsed = rawPersonSocialsSchema.safeParse(raw)
  if (!parsed.success) return { twitterUrl: null }
  return { twitterUrl: parsed.data.twitterUrl ?? null }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/apollo/format-company-summary.test.ts`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/format-company-summary.ts src/lib/apollo/format-company-summary.test.ts
git commit -m "feat(apollo): add raw-parsers for company and person social URLs"
```

---

## Task 5: Bright Data social-scrape client (new module)

**Files:**
- Create: `src/lib/research/social-scrape.ts`
- Test: `src/lib/research/social-scrape.test.ts`

**Interfaces:**
- Consumes: `env.BRIGHTDATA_API_KEY` (`@/lib/env`, already declared — no env changes needed), `fetchJson` (`@/lib/http/fetch-json`), `AppError` (`@/lib/errors/app-error`).
- Produces: `discoverLinkedInPersonPosts(linkedinUrl: string): Promise<ScrapedPost[]>`, `discoverLinkedInCompanyPosts(companyUrl: string): Promise<ScrapedPost[]>`, `discoverXPersonPosts(xUrl: string): Promise<ScrapedPost[]>`, `discoverXCompanyPosts(xUrl: string): Promise<ScrapedPost[]>`, and `interface ScrapedPost { url: string; text: string | null; datePosted: string | null }`. Task 6 imports all four functions and the type.

- [ ] **Step 1: Write the failing tests (core trigger→poll→download flow)**

Create `src/lib/research/social-scrape.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({ env: { BRIGHTDATA_API_KEY: 'test-brightdata-key' } }))

import { discoverLinkedInPersonPosts, discoverLinkedInCompanyPosts, discoverXPersonPosts, discoverXCompanyPosts } from './social-scrape'

beforeEach(() => { mockFetchJson.mockReset() })

describe('discoverLinkedInPersonPosts', () => {
  it('should trigger, poll until ready, and download mapped posts', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' }) // trigger
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap1' }) // progress
      .mockResolvedValueOnce([ // snapshot
        { url: 'https://linkedin.com/posts/1', post_text: 'Hiring engineers!', date_posted: '2026-08-10T00:00:00Z' },
      ])

    const posts = await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    expect(posts).toEqual([{ url: 'https://linkedin.com/posts/1', text: 'Hiring engineers!', datePosted: '2026-08-10T00:00:00Z' }])
  })

  it('should call trigger with only_authored_posts:true and the LinkedIn posts dataset_id', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap1' })
      .mockResolvedValueOnce([])

    await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('dataset_id=gd_lyy3tktm25m4avu764')
    expect(url).toContain('type=discover_new')
    expect(url).toContain('discover_by=profile_url')
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.input).toEqual([{ url: 'https://www.linkedin.com/in/janedoe/', only_authored_posts: true }])
  })

  it('should drop records that report an inline error without failing the whole call', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap1' })
      .mockResolvedValueOnce([
        { url: 'https://linkedin.com/posts/bad', error: 'There is a Signup blocking page' },
        { url: 'https://linkedin.com/posts/good', post_text: 'ok', date_posted: '2026-08-10T00:00:00Z' },
      ])

    const posts = await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    expect(posts).toEqual([{ url: 'https://linkedin.com/posts/good', text: 'ok', datePosted: '2026-08-10T00:00:00Z' }])
  })

  it('should throw AppError EXTERNAL_ERROR when the job status is failed', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap1' })
      .mockResolvedValueOnce({ status: 'failed', snapshot_id: 'snap1' })

    await expect(discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/'))
      .rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })
})

describe('discoverLinkedInCompanyPosts', () => {
  it('should call trigger with discover_by=company_url and the LinkedIn posts dataset_id', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap2' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap2' })
      .mockResolvedValueOnce([])

    await discoverLinkedInCompanyPosts('https://www.linkedin.com/company/acme/')

    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('dataset_id=gd_lyy3tktm25m4avu764')
    expect(url).toContain('discover_by=company_url')
    const body = JSON.parse((options as RequestInit).body as string)
    expect(body.input).toEqual([{ url: 'https://www.linkedin.com/company/acme/' }])
  })
})

describe('discoverXPersonPosts / discoverXCompanyPosts', () => {
  it('should call trigger with the X posts dataset_id and profile_url discovery for a person', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap3' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap3' })
      .mockResolvedValueOnce([{ url: 'https://x.com/janedoe/status/1', description: 'a tweet', date_posted: '2026-08-13T00:00:00Z' }])

    const posts = await discoverXPersonPosts('https://x.com/janedoe')

    const [url] = mockFetchJson.mock.calls[0]!
    expect(url).toContain('dataset_id=gd_lwxkxvnf1cynvib9co')
    expect(url).toContain('discover_by=profile_url')
    expect(posts).toEqual([{ url: 'https://x.com/janedoe/status/1', text: 'a tweet', datePosted: '2026-08-13T00:00:00Z' }])
  })

  it('should map the X `description` field to text (X uses a different field name than LinkedIn)', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap4' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap4' })
      .mockResolvedValueOnce([{ url: 'https://x.com/acme/status/2', description: 'company news', date_posted: '2026-08-12T00:00:00Z' }])

    const posts = await discoverXCompanyPosts('https://x.com/acme')

    expect(posts).toEqual([{ url: 'https://x.com/acme/status/2', text: 'company news', datePosted: '2026-08-12T00:00:00Z' }])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/research/social-scrape.test.ts`
Expected: FAIL — the module doesn't exist yet ("Cannot find module './social-scrape'").

- [ ] **Step 3: Implement the module**

Create `src/lib/research/social-scrape.ts`:

```ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'

const DATASETS_BASE_URL = 'https://api.brightdata.com/datasets/v3'

// dataset_ids confirmed live against our own account 2026-08-14 — see
// docs/superpowers/specs/2026-08-14-social-scraping-design.md.
const LINKEDIN_POSTS_DATASET_ID = 'gd_lyy3tktm25m4avu764'
const X_POSTS_DATASET_ID = 'gd_lwxkxvnf1cynvib9co'

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' }
}

// Live testing 2026-08-14: LinkedIn ~49s, X ~30s for a single-profile
// discovery job. 180s leaves real headroom while still failing loudly
// instead of tying up a research task indefinitely.
const POLL_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 5_000

const triggerResponseSchema = z.object({ snapshot_id: z.string() })

const progressResponseSchema = z.object({
  status: z.enum(['starting', 'running', 'ready', 'failed']),
  snapshot_id: z.string(),
})

export interface ScrapedPost {
  url: string
  text: string | null
  datePosted: string | null
}

// LinkedIn's text field is post_text; X's is description — accept either
// rather than guess, same pattern as apollo/client.ts's bulkMatchResponseSchema
// comment on matches-vs-people.
const postRecordSchema = z.object({
  url: z.string(),
  post_text: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  date_posted: z.string().nullable().optional(),
  error: z.string().optional(),
}).passthrough()

const snapshotResponseSchema = z.array(postRecordSchema)

async function triggerDiscovery(
  datasetId: string,
  discoverParams: Record<string, string>,
  profileUrl: string,
  extraInput: Record<string, unknown>,
): Promise<string> {
  const query = new URLSearchParams({ dataset_id: datasetId, ...discoverParams }).toString()
  const res = await fetchJson(
    `${DATASETS_BASE_URL}/trigger?${query}`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify({ input: [{ url: profileUrl, ...extraInput }] }) },
    triggerResponseSchema,
  )
  return res.snapshot_id
}

async function pollUntilReady(snapshotId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await fetchJson(
      `${DATASETS_BASE_URL}/progress/${snapshotId}`,
      { method: 'GET', headers: authHeaders() },
      progressResponseSchema,
    )
    if (res.status === 'ready') return
    if (res.status === 'failed') {
      throw new AppError('EXTERNAL_ERROR', 'Bright Data social scrape job failed', { snapshotId })
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new AppError('EXTERNAL_TIMEOUT', 'Bright Data social scrape job did not finish in time', {
    snapshotId, timeoutMs: POLL_TIMEOUT_MS,
  })
}

async function downloadSnapshot(snapshotId: string): Promise<ScrapedPost[]> {
  const records = await fetchJson(
    `${DATASETS_BASE_URL}/snapshot/${snapshotId}?format=json`,
    { method: 'GET', headers: authHeaders() },
    snapshotResponseSchema,
  )
  // Bright Data reports per-record failures (e.g. a "Signup blocking page"
  // wall on one post) inline inside an otherwise-successful batch rather than
  // failing the whole job — confirmed live 2026-08-14. Drop only those rows.
  return records
    .filter((r) => !r.error)
    .map((r) => ({ url: r.url, text: r.post_text ?? r.description ?? null, datePosted: r.date_posted ?? null }))
}

async function discoverPosts(
  datasetId: string,
  discoverParams: Record<string, string>,
  profileUrl: string,
  extraInput: Record<string, unknown> = {},
): Promise<ScrapedPost[]> {
  const snapshotId = await triggerDiscovery(datasetId, discoverParams, profileUrl, extraInput)
  await pollUntilReady(snapshotId)
  return downloadSnapshot(snapshotId)
}

/**
 * Posts authored by a specific person, via their Apollo-verified LinkedIn
 * URL. `only_authored_posts: true` is load-bearing — live testing 2026-08-14
 * found the default (false) surfaces other accounts' posts (reposts/related
 * content) mixed in with the target's own, which is exactly the cross-author
 * contamination this module exists to avoid.
 */
export async function discoverLinkedInPersonPosts(linkedinUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(
    LINKEDIN_POSTS_DATASET_ID,
    { type: 'discover_new', discover_by: 'profile_url' },
    linkedinUrl,
    { only_authored_posts: true },
  )
}

/**
 * Posts from a company's LinkedIn page.
 * NOTE: Bright Data's own docs assistant gave param names for this mode
 * (`discover_by=discover_new`+`discover_by_type=company_url`) inconsistent
 * with the profile_url pair confirmed live for discoverLinkedInPersonPosts —
 * confirm against the live Bright Data dashboard request-builder before
 * trusting this in production; this specific call was not independently
 * live-tested (see docs/superpowers/specs/2026-08-14-social-scraping-design.md).
 */
export async function discoverLinkedInCompanyPosts(companyUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(LINKEDIN_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'company_url' }, companyUrl)
}

/** Posts authored by a person's X/Twitter account, when Apollo has one on file. */
export async function discoverXPersonPosts(xUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(X_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'profile_url' }, xUrl)
}

/** Posts from a company's X/Twitter account — same discovery mode as a person's, X has no separate company dataset. */
export async function discoverXCompanyPosts(xUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(X_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'profile_url' }, xUrl)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/research/social-scrape.test.ts`
Expected: PASS (all tests from Step 1).

- [ ] **Step 5: Write and pass the remaining edge-case tests**

Add to `src/lib/research/social-scrape.test.ts`:

```ts
describe('polling behavior', () => {
  it('should poll again when status is running, then succeed once ready', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap5' })
      .mockResolvedValueOnce({ status: 'running', snapshot_id: 'snap5' })
      .mockResolvedValueOnce({ status: 'ready', snapshot_id: 'snap5' })
      .mockResolvedValueOnce([{ url: 'https://linkedin.com/posts/1', post_text: 'ok', date_posted: '2026-08-10T00:00:00Z' }])

    const posts = await discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')

    expect(posts).toHaveLength(1)
    expect(mockFetchJson).toHaveBeenCalledTimes(4) // trigger + 2 progress polls + snapshot
  })

  it('should throw AppError EXTERNAL_TIMEOUT when the job never reaches ready or failed', async () => {
    vi.useFakeTimers()
    mockFetchJson
      .mockResolvedValueOnce({ snapshot_id: 'snap6' })
      .mockResolvedValue({ status: 'running', snapshot_id: 'snap6' }) // every subsequent poll stays running

    const resultPromise = discoverLinkedInPersonPosts('https://www.linkedin.com/in/janedoe/')
    // Advance past POLL_TIMEOUT_MS (180_000ms) in POLL_INTERVAL_MS (5_000ms) steps.
    for (let elapsed = 0; elapsed <= 180_000; elapsed += 5_000) {
      await vi.advanceTimersByTimeAsync(5_000)
    }

    await expect(resultPromise).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
    vi.useRealTimers()
  })
})
```

- [ ] **Step 6: Run the full file to confirm everything passes**

Run: `pnpm test src/lib/research/social-scrape.test.ts`
Expected: PASS — all tests, including the fake-timer timeout test.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/research/social-scrape.ts src/lib/research/social-scrape.test.ts
git commit -m "feat(research): add Bright Data LinkedIn/X social-scrape client"
```

---

## Task 6: Social-knowledge orchestration (new module)

**Files:**
- Create: `src/lib/pipeline/social-knowledge.ts`
- Test: `src/lib/pipeline/social-knowledge.test.ts`

**Interfaces:**
- Consumes: `discoverLinkedInPersonPosts`, `discoverLinkedInCompanyPosts`, `discoverXPersonPosts`, `discoverXCompanyPosts`, `ScrapedPost` (Task 5, `@/lib/research/social-scrape`); `logEventSafe` (`@/lib/events/log-event`); `isAppError` (`@/lib/errors/app-error`).
- Produces: `collectSocialKnowledge(context: { clientId: string; caseId: string }, company: CompanySocialTarget, people: PersonSocialTarget[], now?: Date): Promise<SocialKnowledgeCandidate[]>`, `interface SocialKnowledgeCandidate { kind: 'news'; content: string; sourceUrl: string; citation: string; leadId: string | null; eventDate: string }`, `interface PersonSocialTarget { leadId: string; linkedinUrl: string | null; twitterUrl: string | null }`, `interface CompanySocialTarget { linkedinUrl: string | null; twitterUrl: string | null }`. Task 7's `research.ts` wiring imports all of these.

- [ ] **Step 1: Write the failing tests (core behavior)**

Create `src/lib/pipeline/social-knowledge.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const discoverLinkedInPersonPostsMock = vi.fn()
const discoverLinkedInCompanyPostsMock = vi.fn()
const discoverXPersonPostsMock = vi.fn()
const discoverXCompanyPostsMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/research/social-scrape', () => ({
  discoverLinkedInPersonPosts: (...a: unknown[]) => discoverLinkedInPersonPostsMock(...a),
  discoverLinkedInCompanyPosts: (...a: unknown[]) => discoverLinkedInCompanyPostsMock(...a),
  discoverXPersonPosts: (...a: unknown[]) => discoverXPersonPostsMock(...a),
  discoverXCompanyPosts: (...a: unknown[]) => discoverXCompanyPostsMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { collectSocialKnowledge } from './social-knowledge'

const NOW = new Date('2026-08-14T00:00:00Z')
const context = { clientId: 'c1', caseId: 'case1' }

beforeEach(() => {
  discoverLinkedInPersonPostsMock.mockReset()
  discoverLinkedInCompanyPostsMock.mockReset()
  discoverXPersonPostsMock.mockReset()
  discoverXCompanyPostsMock.mockReset()
  logEventMock.mockReset()
})

describe('collectSocialKnowledge', () => {
  it('should return an empty array and make zero calls when no social targets are given', async () => {
    const result = await collectSocialKnowledge(context, { linkedinUrl: null, twitterUrl: null }, [], NOW)
    expect(result).toEqual([])
    expect(discoverLinkedInPersonPostsMock).not.toHaveBeenCalled()
    expect(discoverLinkedInCompanyPostsMock).not.toHaveBeenCalled()
    expect(discoverXPersonPostsMock).not.toHaveBeenCalled()
    expect(discoverXCompanyPostsMock).not.toHaveBeenCalled()
  })

  it('should tag company posts with leadId: null', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/co1', text: 'We shipped a new feature', datePosted: '2026-08-10T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toEqual([{
      kind: 'news', content: 'We shipped a new feature', sourceUrl: 'https://linkedin.com/posts/co1',
      citation: 'LinkedIn post, 2026-08-10', leadId: null, eventDate: '2026-08-10T00:00:00Z',
    }])
  })

  it('should tag a person post with that person\'s leadId', async () => {
    discoverLinkedInPersonPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/p1', text: 'Excited to announce a promotion', datePosted: '2026-08-12T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(
      context,
      { linkedinUrl: null, twitterUrl: null },
      [{ leadId: 'lead-a', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: null }],
      NOW,
    )
    expect(result).toEqual([{
      kind: 'news', content: 'Excited to announce a promotion', sourceUrl: 'https://linkedin.com/posts/p1',
      citation: 'LinkedIn post, 2026-08-12', leadId: 'lead-a', eventDate: '2026-08-12T00:00:00Z',
    }])
  })

  it('should drop a post older than 90 days', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/old', text: 'old news', datePosted: '2026-01-01T00:00:00Z' }, // ~225 days before NOW
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toEqual([])
  })

  it('should keep a post exactly at the 90-day boundary and drop one just past it', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/boundary', text: 'right at 90 days', datePosted: '2026-05-16T00:00:00Z' }, // exactly 90 days before NOW
      { url: 'https://linkedin.com/posts/past', text: 'just past 90 days', datePosted: '2026-05-15T00:00:00Z' }, // 91 days before NOW
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toHaveLength(1)
    expect(result[0]!.sourceUrl).toBe('https://linkedin.com/posts/boundary')
  })

  it('should drop a post with no text or no datePosted', async () => {
    discoverLinkedInCompanyPostsMock.mockResolvedValue([
      { url: 'https://linkedin.com/posts/no-text', text: null, datePosted: '2026-08-10T00:00:00Z' },
      { url: 'https://linkedin.com/posts/no-date', text: 'has text', datePosted: null },
    ])
    const result = await collectSocialKnowledge(context, { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: null }, [], NOW)
    expect(result).toEqual([])
  })

  it('should query both LinkedIn and X for the same lead when both URLs are present', async () => {
    discoverLinkedInPersonPostsMock.mockResolvedValue([])
    discoverXPersonPostsMock.mockResolvedValue([
      { url: 'https://x.com/janedoe/status/1', text: 'a tweet', datePosted: '2026-08-13T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(
      context,
      { linkedinUrl: null, twitterUrl: null },
      [{ leadId: 'lead-a', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
      NOW,
    )
    expect(discoverLinkedInPersonPostsMock).toHaveBeenCalledWith('https://linkedin.com/in/janedoe')
    expect(discoverXPersonPostsMock).toHaveBeenCalledWith('https://x.com/janedoe')
    expect(result).toEqual([expect.objectContaining({ sourceUrl: 'https://x.com/janedoe/status/1', leadId: 'lead-a' })])
  })

  it('should log and continue (return empty for that source) when one source throws', async () => {
    discoverLinkedInCompanyPostsMock.mockRejectedValue(new Error('bright data down'))
    discoverXCompanyPostsMock.mockResolvedValue([
      { url: 'https://x.com/acme/status/1', text: 'still works', datePosted: '2026-08-10T00:00:00Z' },
    ])
    const result = await collectSocialKnowledge(
      context,
      { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
      [],
      NOW,
    )
    expect(result).toEqual([expect.objectContaining({ sourceUrl: 'https://x.com/acme/status/1' })])
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.social_scrape_failed',
      payload: expect.objectContaining({ source: 'linkedin_company' }),
    }))
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/pipeline/social-knowledge.test.ts`
Expected: FAIL — the module doesn't exist yet.

- [ ] **Step 3: Implement the module**

Create `src/lib/pipeline/social-knowledge.ts`:

```ts
import { discoverLinkedInPersonPosts, discoverLinkedInCompanyPosts, discoverXPersonPosts, discoverXCompanyPosts, type ScrapedPost } from '@/lib/research/social-scrape'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

// Posts older than this are dropped entirely, not deprioritized — an opener
// referencing a "recent" post that's actually 4 months old reads worse than
// no personalization at all. See docs/superpowers/specs/2026-08-14-social-scraping-design.md.
const MAX_POST_AGE_DAYS = 90
const MAX_CONTENT_CHARS = 600

export interface SocialKnowledgeCandidate {
  kind: 'news'
  content: string
  sourceUrl: string
  citation: string
  leadId: string | null
  eventDate: string
}

export interface PersonSocialTarget {
  leadId: string
  linkedinUrl: string | null
  twitterUrl: string | null
}

export interface CompanySocialTarget {
  linkedinUrl: string | null
  twitterUrl: string | null
}

function withinCutoff(datePosted: string, now: Date): boolean {
  const posted = new Date(datePosted)
  if (Number.isNaN(posted.getTime())) return false
  const ageDays = (now.getTime() - posted.getTime()) / (1000 * 60 * 60 * 24)
  // ageDays >= 0 rejects a future-dated post outright (clock skew or bad
  // upstream data) rather than silently treating it as maximally "fresh."
  return ageDays >= 0 && ageDays <= MAX_POST_AGE_DAYS
}

function toCandidates(posts: ScrapedPost[], leadId: string | null, platform: 'LinkedIn' | 'X', now: Date): SocialKnowledgeCandidate[] {
  const candidates: SocialKnowledgeCandidate[] = []
  for (const post of posts) {
    if (!post.text || !post.datePosted) continue
    if (!withinCutoff(post.datePosted, now)) continue
    candidates.push({
      kind: 'news',
      content: post.text.slice(0, MAX_CONTENT_CHARS),
      sourceUrl: post.url,
      citation: `${platform} post, ${post.datePosted.slice(0, 10)}`,
      leadId,
      eventDate: post.datePosted,
    })
  }
  return candidates
}

// One failed source (a LinkedIn timeout, an X job that errors) never fails
// the case — matches runResearchForCase's existing "one agent failure is
// logged and dropped, not fatal" stance.
async function safeDiscover(
  fn: () => Promise<ScrapedPost[]>,
  context: { clientId: string; caseId: string; source: string },
): Promise<ScrapedPost[]> {
  try {
    return await fn()
  } catch (error) {
    await logEventSafe({
      clientId: context.clientId,
      caseId: context.caseId,
      actor: 'social_scrape',
      type: 'pipeline.research.social_scrape_failed',
      payload: { source: context.source, errorCode: isAppError(error) ? error.code : 'EXTERNAL_ERROR' },
    })
    return []
  }
}

export async function collectSocialKnowledge(
  context: { clientId: string; caseId: string },
  company: CompanySocialTarget,
  people: PersonSocialTarget[],
  now: Date = new Date(),
): Promise<SocialKnowledgeCandidate[]> {
  const tasks: Promise<SocialKnowledgeCandidate[]>[] = []

  if (company.linkedinUrl) {
    const url = company.linkedinUrl
    tasks.push(
      safeDiscover(() => discoverLinkedInCompanyPosts(url), { ...context, source: 'linkedin_company' })
        .then((posts) => toCandidates(posts, null, 'LinkedIn', now)),
    )
  }
  if (company.twitterUrl) {
    const url = company.twitterUrl
    tasks.push(
      safeDiscover(() => discoverXCompanyPosts(url), { ...context, source: 'x_company' })
        .then((posts) => toCandidates(posts, null, 'X', now)),
    )
  }
  for (const person of people) {
    if (person.linkedinUrl) {
      const url = person.linkedinUrl
      tasks.push(
        safeDiscover(() => discoverLinkedInPersonPosts(url), { ...context, source: 'linkedin_person' })
          .then((posts) => toCandidates(posts, person.leadId, 'LinkedIn', now)),
      )
    }
    if (person.twitterUrl) {
      const url = person.twitterUrl
      tasks.push(
        safeDiscover(() => discoverXPersonPosts(url), { ...context, source: 'x_person' })
          .then((posts) => toCandidates(posts, person.leadId, 'X', now)),
      )
    }
  }

  const results = await Promise.all(tasks)
  return results.flat()
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/pipeline/social-knowledge.test.ts`
Expected: PASS — all tests from Step 1.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/social-knowledge.ts src/lib/pipeline/social-knowledge.test.ts
git commit -m "feat(pipeline): add social-knowledge orchestration (90-day cutoff, deterministic mapping)"
```

---

## Task 7: Wire into `research.ts` (and widen `ResearchLead`)

**Files:**
- Modify: `src/lib/research/provider.ts` (`ResearchLead` interface)
- Modify: `src/lib/pipeline/research.ts`
- Modify: `src/lib/research/agent.test.ts` (fixture updates for the widened `ResearchLead`)
- Test: `src/lib/pipeline/research.test.ts`

**Interfaces:**
- Consumes: `collectSocialKnowledge`, `SocialKnowledgeCandidate`, `PersonSocialTarget`, `CompanySocialTarget` (Task 6, `@/lib/pipeline/social-knowledge`); `KnowledgeInsert.lead_id`/`.event_date` (Task 1).
- Produces: `RunResearchInput.companySocials: CompanySocialTarget`; `ResearchLead.id: string`, `ResearchLead.twitterUrl: string | null` — Task 8's route wiring constructs both of these.

- [ ] **Step 1: Widen `ResearchLead` in `provider.ts`**

Edit `src/lib/research/provider.ts`:

```ts
export interface ResearchLead {
  id: string
  fullName: string
  title: string | null
  // Apollo's own profile match for this person — a known, precise scrape
  // target, not a claim to trust. See agent.ts's gather prompt: the agent is
  // told to confirm this is the right person before treating it as a source.
  linkedinUrl: string | null
  twitterUrl: string | null
}
```

- [ ] **Step 2: Fix the two `agent.test.ts` fixtures broken by the now-required `id`/`twitterUrl` fields**

Edit `src/lib/research/agent.test.ts:57` (inside the first `it('should include the person name...')` block):

```ts
        lead: { id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: null, twitterUrl: null },
```

Edit `src/lib/research/agent.test.ts:128` (inside the second person-role test):

```ts
        lead: { id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: null },
```

- [ ] **Step 3: Run the existing agent tests to confirm they still pass after the fixture fix**

Run: `pnpm test src/lib/research/agent.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing test for `research.ts`'s new behavior**

First, update the shared fixtures near the top of `src/lib/pipeline/research.test.ts`. Add this mock alongside the file's existing `vi.mock` calls:

```ts
const collectSocialKnowledgeMock = vi.fn()
vi.mock('@/lib/pipeline/social-knowledge', () => ({ collectSocialKnowledge: (...a: unknown[]) => collectSocialKnowledgeMock(...a) }))
```

Then replace the existing `input` fixture with:

```ts
const input = {
  clientId: 'c1', caseId: 'case1', companyName: 'Acme', companyDomain: 'acme.com',
  companyFirmographics: null,
  companySocials: { linkedinUrl: null, twitterUrl: null },
  leads: [{ id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: null, twitterUrl: null }],
  seller: { name: 'Seller Co', companyInfo: 'Makes widgets.', valueProp: 'Custom widgets' },
}
```

Add `collectSocialKnowledgeMock.mockReset().mockResolvedValue([])` to the `beforeEach` block (default: no social candidates, so every pre-existing test in the file keeps passing unmodified).

Add new tests inside `describe('runResearchForCase', ...)`:

```ts
  it('should insert social candidates with lead_id and event_date alongside agent entries', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
    collectSocialKnowledgeMock.mockResolvedValueOnce([{
      kind: 'news', content: 'Jane posted about hiring', sourceUrl: 'https://linkedin.com/posts/1',
      citation: 'LinkedIn post, 2026-08-10', leadId: 'lead1', eventDate: '2026-08-10T00:00:00Z',
    }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(insertKnowledgeMock).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([
      expect.objectContaining({ kind: 'company', lead_id: null, event_date: null }),
      expect.objectContaining({
        kind: 'news', content: 'Jane posted about hiring', lead_id: 'lead1', event_date: '2026-08-10T00:00:00Z',
      }),
    ]))
    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 2 })
  })

  it('should still mark the case ready and insert when every agent fails but social scraping finds something', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('agent down'))
    collectSocialKnowledgeMock.mockResolvedValueOnce([{
      kind: 'news', content: 'Company posted news', sourceUrl: 'https://linkedin.com/posts/co',
      citation: 'LinkedIn post, 2026-08-10', leadId: null, eventDate: '2026-08-10T00:00:00Z',
    }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 1 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should NOT mark ready when every agent fails and social scraping also finds nothing', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('agent down'))
    collectSocialKnowledgeMock.mockResolvedValueOnce([])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should pass company socials and per-lead id/linkedinUrl/twitterUrl through to collectSocialKnowledge', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'x', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])
    const leadInput = {
      ...input,
      companySocials: { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
      leads: [{ id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
    }

    await runResearchForCase({} as never, { research }, leadInput)

    expect(collectSocialKnowledgeMock).toHaveBeenCalledWith(
      { clientId: 'c1', caseId: 'case1' },
      { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
      [{ leadId: 'lead1', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
    )
  })
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `pnpm test src/lib/pipeline/research.test.ts`
Expected: FAIL — `RunResearchInput` has no `companySocials` field yet, `toRows` doesn't emit `lead_id`/`event_date`, and `runResearchForCase` never calls `collectSocialKnowledge`.

- [ ] **Step 6: Implement the wiring**

Edit `src/lib/pipeline/research.ts` — add the import and widen `RunResearchInput` (near the top, alongside the existing imports and interface):

```ts
import { collectSocialKnowledge, type CompanySocialTarget } from '@/lib/pipeline/social-knowledge'
```

```ts
export interface RunResearchInput {
  clientId: string
  caseId: string
  companyName: string
  companyDomain: string | null
  companyFirmographics: CompanyFirmographics | null
  companySocials: CompanySocialTarget
  leads: ResearchLead[]
  seller: SellerContext
}
```

Add the internal candidate type right after `ResearchSummary`:

```ts
type KnowledgeCandidate = AgentDossierEntry & { leadId: string | null; eventDate: string | null }
```

Edit `toRows` (previously lines 64-74):

```ts
function toRows(input: RunResearchInput, entries: KnowledgeCandidate[]): KnowledgeInsert[] {
  return entries.map((entry) => ({
    client_id: input.clientId,
    case_id: input.caseId,
    kind: entry.kind,
    content: entry.content,
    source_url: entry.sourceUrl,
    citation: entry.citation,
    created_by: 'agent',
    lead_id: entry.leadId,
    event_date: entry.eventDate,
  }))
}
```

Edit `runResearchForCase` (previously lines 100-135) — replace the `Promise.allSettled` + entry-collection block:

```ts
  const roles = buildRoles(input)
  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }

  const agentResults = await Promise.allSettled(
    roles.map((role) => runResearchAgent(context, deps, { role, seller: input.seller })),
  )
  const socialCandidates = await collectSocialKnowledge(
    { clientId: input.clientId, caseId: input.caseId },
    input.companySocials,
    input.leads.map((l) => ({ leadId: l.id, linkedinUrl: l.linkedinUrl, twitterUrl: l.twitterUrl })),
  )

  const entries: KnowledgeCandidate[] = socialCandidates.map((c) => ({ ...c }))
  let failed = 0
  for (let i = 0; i < agentResults.length; i += 1) {
    const result = agentResults[i]
    if (result && result.status === 'fulfilled') {
      entries.push(...result.value.map((e) => ({ ...e, leadId: null, eventDate: null })))
    } else if (result) {
      failed += 1
      await logAgentFailure(input, roles[i]!, result.reason)
    }
  }

  // failed === roles.length alone would discard real social-only results —
  // the guard's actual intent is "don't mark ready with an empty/misleading
  // dossier," which social-only success doesn't violate.
  const allFailed = failed === roles.length && socialCandidates.length === 0
  if (allFailed) {
    await logEventSafe({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: ACTOR,
      type: 'pipeline.research.completed',
      payload: { caseId: input.caseId, knowledgeCount: 0, agentsFailed: failed },
    })
    return { caseId: input.caseId, knowledgeCount: 0 }
  }
```

(everything from `const inserted = await insertKnowledge(...)` onward, previously lines 137-168, is unchanged — it already reads `entries`/`failed`, both of which keep the same names).

- [ ] **Step 7: Run the tests to verify they pass**

Run: `pnpm test src/lib/pipeline/research.test.ts`
Expected: PASS — every test, new and pre-existing (pre-existing tests pass because `collectSocialKnowledgeMock` defaults to `[]` in `beforeEach`, matching today's "no social data" behavior exactly).

- [ ] **Step 8: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/lib/research/provider.ts src/lib/research/agent.test.ts src/lib/pipeline/research.ts src/lib/pipeline/research.test.ts
git commit -m "feat(research): wire social-knowledge collection into runResearchForCase"
```

---

## Task 8: Wire into `route.ts`

**Files:**
- Modify: `src/app/api/pipeline/research/route.ts`
- Test: `src/app/api/pipeline/research/route.test.ts`

**Interfaces:**
- Consumes: `parseCompanySocialsFromRaw`, `parsePersonSocialsFromRaw` (Task 4, `@/lib/apollo/format-company-summary`); `RunResearchInput.companySocials`, `ResearchLead.id`/`.twitterUrl` (Task 7).

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/pipeline/research/route.test.ts`:

```ts
  it('should derive companySocials and per-lead id/twitterUrl from leads[0].raw and each lead\'s raw', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com' })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'active' })
    listActiveLeadsMock.mockResolvedValue([
      {
        id: 'lead1', full_name: 'Jane', title: 'CTO', linkedin_url: 'https://linkedin.com/in/janedoe',
        raw: { organizationLinkedinUrl: 'https://linkedin.com/company/acme', organizationTwitterUrl: 'https://x.com/acme', twitterUrl: 'https://x.com/janedoe' },
      },
    ])
    runResearchMock.mockResolvedValue({ caseId: CASE_ID, knowledgeCount: 0 })

    await POST(req({ caseId: CASE_ID }))

    expect(runResearchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({
        companySocials: { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
        leads: [{ id: 'lead1', fullName: 'Jane', title: 'CTO', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
      }),
    )
  })

  it('should default companySocials to all-null when there are no leads on the case', async () => {
    getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com' })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: null, status: 'active' })
    listActiveLeadsMock.mockResolvedValue([])
    runResearchMock.mockResolvedValue({ caseId: CASE_ID, knowledgeCount: 0 })

    await POST(req({ caseId: CASE_ID }))

    expect(runResearchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ companySocials: { linkedinUrl: null, twitterUrl: null }, leads: [] }),
    )
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/app/api/pipeline/research/route.test.ts`
Expected: FAIL — `runResearchMock` is currently called without `companySocials`, and `leads` mapping omits `id`/`twitterUrl`.

- [ ] **Step 3: Implement the wiring**

Edit `src/app/api/pipeline/research/route.ts` — add the import:

```ts
import { parseCompanyFirmographicsFromRaw, parseCompanySocialsFromRaw, parsePersonSocialsFromRaw } from '@/lib/apollo/format-company-summary'
```

Edit the body (previously lines 52-78):

```ts
    const leads = await listActiveLeadsForCase(admin, caseId)
    // Every active lead on a case shares one company, so any lead's `raw`
    // carries the same Apollo org match — the first lead is enough.
    const companyFirmographics = leads[0] ? parseCompanyFirmographicsFromRaw(leads[0].raw) : null
    const companySocials = leads[0] ? parseCompanySocialsFromRaw(leads[0].raw) : { linkedinUrl: null, twitterUrl: null }
    // Missing client row never blocks research — same "degrade, don't
    // fail" stance write.ts takes for the same lookup — the agent just gets
    // less to filter against (sellerContextLine omits itself when every
    // field is null).
    const client = await getClientById(admin, kase.client_id)

    try {
      const summary = await runResearchForCase(
        admin,
        { research: brightdataResearch },
        {
          clientId: kase.client_id,
          caseId: parsedBody.caseId,
          companyName: kase.company_name,
          companyDomain: kase.company_domain,
          companyFirmographics,
          companySocials,
          leads: leads.map((l) => {
            const { twitterUrl } = parsePersonSocialsFromRaw(l.raw)
            return { id: l.id, fullName: l.full_name, title: l.title, linkedinUrl: l.linkedin_url, twitterUrl }
          }),
          seller: {
            name: client?.name ?? null,
            companyInfo: client?.company_info ?? null,
            valueProp: campaign.value_prop,
          },
        },
      )
```

(everything else in the route — the outer try/catch, overload handling, error responses — is unchanged).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/app/api/pipeline/research/route.test.ts`
Expected: PASS — including every pre-existing test in the file.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/research/route.ts src/app/api/pipeline/research/route.test.ts
git commit -m "feat(research-route): pass companySocials and per-lead id/twitterUrl through to runResearchForCase"
```

---

## Task 9: Full-suite verification

**Files:** none (verification only — fixes go back into whichever task's files if something turns up).

**Interfaces:** none — this task produces no new interfaces, only confidence that every prior task's pieces work together.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: PASS — every test file in the project, not just the ones touched by this plan.

- [ ] **Step 2: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Run lint**

Run: `pnpm lint`
Expected: PASS.

- [ ] **Step 4: If any of the above fail, fix in place**

Trace the failure back to the task whose files it touches, fix it there (don't invent a new file for a fix that belongs to an earlier task), and re-run Steps 1-3 until all three are clean.

- [ ] **Step 5: Manually confirm the migration is applied on whatever environment this will run against next**

Run: `pnpm supabase db reset` (or the project's real deploy-migration command, if this is going to staging/production rather than staying local)
Expected: `case_knowledge.lead_id` and `case_knowledge.event_date` exist and match Task 1's migration.

No commit for this task unless Step 4 required one — in that case, the fix was already committed as part of re-doing the relevant earlier task's Step 5/6.
