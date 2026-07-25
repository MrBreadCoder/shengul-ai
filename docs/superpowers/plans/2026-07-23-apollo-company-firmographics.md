# Apollo Company Firmographics on Cases Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Capture the company industry, employee count, founded year, description, and location that Apollo's People Enrichment call already returns (and today discards), and write them into `case_knowledge` so they show up in the Case page's Knowledge tab and automatically flow into the AI email writer's prompt — at zero extra API cost, with no DB migration.

**Architecture:** Widen the existing Apollo response schema/types to capture the fields, thread the enriched person's `raw` blob through the existing `groupVerifiedLead` case-creation hook, format it into one plain-text sentence with a new pure function, and insert it as a single `kind: 'company'` `case_knowledge` row (check-before-insert, so it's written once per case).

**Tech Stack:** TypeScript, Zod, Vitest, Supabase (`@supabase/supabase-js`), Next.js (no UI changes in this plan — the feature rides the existing Knowledge tab).

**Spec:** `docs/superpowers/specs/2026-07-23-apollo-company-firmographics-design.md` — read it in full before starting; this plan does not repeat its rationale, only its execution.

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (`QUALITY.md`).
- Zod for all runtime validation of external/stored data, including this feature's `case_knowledge.raw` boundary parse (`QUALITY.md`).
- Named exports only; default exports are reserved for Next.js pages/layouts (`BEHAVIORS.md`) — none of this plan's files are pages.
- Data access (Supabase queries) lives exclusively in `src/lib/db/` — never inline queries in pipeline/component code (`QUALITY.md`).
- Every thrown error carries `code`, `message`, `context` via `AppError` — never a bare `Error` (`QUALITY.md`).
- Every catch block handles, rethrows, or escalates to logging — never swallows silently (`QUALITY.md`).
- No function longer than ~40 lines; single responsibility (`QUALITY.md`).
- Test files colocated (`feature.test.ts` next to `feature.ts`), Vitest, Arrange-Act-Assert, `it('should ... when ...')` naming (`QUALITY.md`).
- No `console.log` in any code path (`BEHAVIORS.md`).
- `UPDATE THE .claude/roadmap.md EVERY TIME YOU MAKE PROGRESS` (`CLAUDE.md`) — Task 7 does this.

---

### Task 1: Widen the Apollo client to capture firmographics

**Files:**
- Modify: `src/lib/apollo/client.ts:26-30` (`organizationSchema`), `src/lib/apollo/client.ts:141-152` (`bulkMatchPeople` return mapping)
- Modify: `src/lib/apollo/types.ts:48-58` (`ApolloEnrichedPerson`)
- Test: `src/lib/apollo/client.test.ts` (extend)

**Interfaces:**
- Consumes: nothing new — extends the existing `organizationSchema`/`enrichedPersonSchema`/`bulkMatchPeople` already in this file.
- Produces: `ApolloEnrichedPerson` now carries `organizationIndustry: string | null`, `organizationEmployeeCount: number | null`, `organizationFoundedYear: number | null`, `organizationDescription: string | null`, `organizationCity: string | null`, `organizationState: string | null`, `organizationCountry: string | null`. Task 4 (`group-lead.ts`) reads these off `leads.raw` by exactly these field names.

- [ ] **Step 1: Write the failing tests**

Open `src/lib/apollo/client.test.ts`. First, fix the existing exact-object test so it doesn't break once the mapping grows — replace the `'matches'` wrapper test:

```ts
  it('should read email + email_status from the "matches" wrapper key', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{ id: 'p1', first_name: 'Jo', last_name: 'Doe', email: 'jo@acme.com', email_status: 'Verified', organization: { primary_domain: 'acme.com', name: 'Acme' } }],
    })
    const result = await bulkMatchPeople([{ id: 'p1' }])
    expect(result).toEqual([{
      apolloId: 'p1', firstName: 'Jo', lastName: 'Doe', title: null, email: 'jo@acme.com',
      emailStatus: 'Verified', linkedinUrl: null, organizationName: 'Acme', organizationDomain: 'acme.com',
    }])
  })
```

with:

```ts
  it('should read email + email_status from the "matches" wrapper key', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{ id: 'p1', first_name: 'Jo', last_name: 'Doe', email: 'jo@acme.com', email_status: 'Verified', organization: { primary_domain: 'acme.com', name: 'Acme' } }],
    })
    const result = await bulkMatchPeople([{ id: 'p1' }])
    expect(result).toEqual([{
      apolloId: 'p1', firstName: 'Jo', lastName: 'Doe', title: null, email: 'jo@acme.com',
      emailStatus: 'Verified', linkedinUrl: null, organizationName: 'Acme', organizationDomain: 'acme.com',
      organizationIndustry: null, organizationEmployeeCount: null, organizationFoundedYear: null,
      organizationDescription: null, organizationCity: null, organizationState: null, organizationCountry: null,
    }])
  })
```

Then add two new tests at the end of the `describe('bulkMatchPeople', ...)` block, right before its closing `})`:

```ts

  it('should map organization firmographics from the enriched response', async () => {
    mockFetchJson.mockResolvedValueOnce({
      matches: [{
        id: 'p4',
        organization: {
          name: 'Acme', primary_domain: 'acme.com',
          industry: 'Software', estimated_num_employees: 120, founded_year: 2016,
          short_description: 'Acme builds workflow automation.',
          city: 'Austin', state: 'TX', country: 'United States',
        },
      }],
    })
    const result = await bulkMatchPeople([{ id: 'p4' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      organizationIndustry: 'Software',
      organizationEmployeeCount: 120,
      organizationFoundedYear: 2016,
      organizationDescription: 'Acme builds workflow automation.',
      organizationCity: 'Austin',
      organizationState: 'TX',
      organizationCountry: 'United States',
    })
  })

  it('should return null firmographic fields when organization is absent', async () => {
    mockFetchJson.mockResolvedValueOnce({ matches: [{ id: 'p5' }] })
    const result = await bulkMatchPeople([{ id: 'p5' }])
    // the mocked response above contains exactly one person
    expect(result[0]).toMatchObject({
      organizationIndustry: null,
      organizationEmployeeCount: null,
      organizationFoundedYear: null,
      organizationDescription: null,
      organizationCity: null,
      organizationState: null,
      organizationCountry: null,
    })
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/apollo/client.test.ts`
Expected: FAIL — the updated `'matches'` wrapper test fails because the mapper doesn't yet emit the seven new null fields; the two new tests fail with `undefined` firmographic fields (`toMatchObject` reports missing/mismatched keys).

- [ ] **Step 3: Implement — widen `organizationSchema` and `ApolloEnrichedPerson`**

In `src/lib/apollo/types.ts`, replace the `ApolloEnrichedPerson` interface (lines 48-58):

```ts
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
  organizationIndustry: string | null
  organizationEmployeeCount: number | null
  organizationFoundedYear: number | null
  organizationDescription: string | null
  organizationCity: string | null
  organizationState: string | null
  organizationCountry: string | null
}
```

In `src/lib/apollo/client.ts`, replace `organizationSchema` (lines 26-30):

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
}).nullable().optional()
```

Then, in the same file, replace the `bulkMatchPeople` return-mapping object (inside the `.map((p) => { ... })` at the end of `bulkMatchPeople`, lines ~141-152):

```ts
    return {
      apolloId: p.id,
      firstName: p.first_name ?? null,
      lastName: p.last_name ?? null,
      title: p.title ?? null,
      email,
      emailStatus,
      linkedinUrl: p.linkedin_url ?? null,
      organizationName: p.organization?.name ?? null,
      organizationDomain: domainFromOrg(p.organization),
      organizationIndustry: p.organization?.industry ?? null,
      organizationEmployeeCount: p.organization?.estimated_num_employees ?? null,
      organizationFoundedYear: p.organization?.founded_year ?? null,
      organizationDescription: p.organization?.short_description ?? null,
      organizationCity: p.organization?.city ?? null,
      organizationState: p.organization?.state ?? null,
      organizationCountry: p.organization?.country ?? null,
    }
```

Nothing else in `client.ts` changes — `searchPeople`'s mapping doesn't read these fields, and `organizationSchema` being shared is fine since all seven new fields are `.nullable().optional()`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/apollo/client.test.ts`
Expected: PASS — all tests in the file green, including the two new ones.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/apollo/client.ts src/lib/apollo/types.ts src/lib/apollo/client.test.ts
git commit -m "feat: capture Apollo company firmographics from people enrichment"
```

---

### Task 2: Pure company-summary formatter

**Files:**
- Create: `src/lib/apollo/format-company-summary.ts`
- Test: `src/lib/apollo/format-company-summary.test.ts`

**Interfaces:**
- Consumes: nothing (pure function, no I/O).
- Produces: `export interface CompanyFirmographics { industry: string | null; employeeCount: number | null; foundedYear: number | null; description: string | null; city: string | null; state: string | null; country: string | null }` and `export function formatCompanySummary(companyName: string, firmographics: CompanyFirmographics): string | null`. Task 4 (`group-lead.ts`) imports both.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/apollo/format-company-summary.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatCompanySummary, type CompanyFirmographics } from './format-company-summary'

const empty: CompanyFirmographics = {
  industry: null, employeeCount: null, foundedYear: null, description: null,
  city: null, state: null, country: null,
}

describe('formatCompanySummary', () => {
  it('should return null when every field is null', () => {
    const result = formatCompanySummary('Acme Corp', empty)

    expect(result).toBeNull()
  })

  it('should render one sentence per section when every field is present', () => {
    const firmographics: CompanyFirmographics = {
      industry: 'Software', employeeCount: 120, foundedYear: 2016,
      description: 'Acme builds workflow automation for logistics teams.',
      city: 'Austin', state: 'TX', country: 'United States',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe(
      'Acme Corp — Software industry, ~120 employees, founded 2016. ' +
      'Acme builds workflow automation for logistics teams. ' +
      'Based in Austin, TX, United States.',
    )
  })

  it('should omit the description and founded year sections when they are null', () => {
    const firmographics: CompanyFirmographics = {
      industry: 'Software', employeeCount: 120, foundedYear: null, description: null,
      city: 'Austin', state: 'TX', country: 'United States',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Software industry, ~120 employees. Based in Austin, TX, United States.')
  })

  it('should prefix the company name onto a location-only summary', () => {
    const firmographics: CompanyFirmographics = {
      ...empty, city: 'Austin', state: 'TX', country: 'United States',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Based in Austin, TX, United States.')
  })

  it('should treat an employee count of zero as a real value, not a missing one', () => {
    const firmographics: CompanyFirmographics = { ...empty, employeeCount: 0 }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — ~0 employees.')
  })

  it('should omit missing location parts without leaving stray punctuation', () => {
    const firmographics: CompanyFirmographics = { ...empty, state: 'TX' }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Based in TX.')
  })

  it('should render a description-only summary ending with proper punctuation', () => {
    const firmographics: CompanyFirmographics = {
      ...empty, description: 'Acme builds workflow automation',
    }

    const result = formatCompanySummary('Acme Corp', firmographics)

    expect(result).toBe('Acme Corp — Acme builds workflow automation.')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/apollo/format-company-summary.test.ts`
Expected: FAIL with "Cannot find module './format-company-summary'".

- [ ] **Step 3: Implement**

Create `src/lib/apollo/format-company-summary.ts`:

```ts
export interface CompanyFirmographics {
  industry: string | null
  employeeCount: number | null
  foundedYear: number | null
  description: string | null
  city: string | null
  state: string | null
  country: string | null
}

function ensureSentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`
}

function buildFirmographicClause(firmographics: CompanyFirmographics): string | null {
  const clauses: string[] = []
  if (firmographics.industry) clauses.push(`${firmographics.industry} industry`)
  if (firmographics.employeeCount !== null) clauses.push(`~${firmographics.employeeCount} employees`)
  if (firmographics.foundedYear !== null) clauses.push(`founded ${firmographics.foundedYear}`)
  if (clauses.length === 0) return null
  return ensureSentence(clauses.join(', '))
}

function buildLocationClause(firmographics: CompanyFirmographics): string | null {
  const parts = [firmographics.city, firmographics.state, firmographics.country]
    .filter((part): part is string => part !== null && part.length > 0)
  if (parts.length === 0) return null
  return `Based in ${parts.join(', ')}.`
}

/**
 * One plain-text sentence summarizing a company's Apollo firmographics, or
 * `null` if every field is null — a case with no captured data gets no row.
 * The company name is prefixed only once, onto the first non-empty section,
 * whichever section that turns out to be.
 */
export function formatCompanySummary(
  companyName: string,
  firmographics: CompanyFirmographics,
): string | null {
  const sections = [
    buildFirmographicClause(firmographics),
    firmographics.description ? ensureSentence(firmographics.description.trim()) : null,
    buildLocationClause(firmographics),
  ].filter((section): section is string => section !== null && section.length > 0)

  if (sections.length === 0) return null

  const [first, ...rest] = sections
  return [`${companyName} — ${first}`, ...rest].join(' ')
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/apollo/format-company-summary.test.ts`
Expected: PASS — all 7 tests green.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/apollo/format-company-summary.ts src/lib/apollo/format-company-summary.test.ts
git commit -m "feat: add pure formatter for Apollo company firmographic summaries"
```

---

### Task 3: `insertCompanyKnowledgeIfMissing` DB helper

**Files:**
- Modify: `src/lib/db/case-knowledge.ts`
- Test: `src/lib/db/case-knowledge.test.ts` (extend)

**Interfaces:**
- Consumes: `SupabaseClient<Database>`, and `{ clientId: string; caseId: string; content: string; sourceUrl: string | null }`.
- Produces: `export async function insertCompanyKnowledgeIfMissing(supabase, input): Promise<KnowledgeRow | null>` — returns `null` when a `kind: 'company'` row already exists for `input.caseId` (skip, no insert), otherwise inserts and returns the new row. Task 4 (`group-lead.ts`) calls this.

- [ ] **Step 1: Write the failing tests**

Open `src/lib/db/case-knowledge.test.ts` and add, after the existing `describe('listKnowledgeForCase', ...)` block:

```ts

function mockCheckThenInsert(existing: { data: unknown; error: unknown }, insert?: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({
        eq: () => ({
          eq: () => ({
            limit: () => Promise.resolve(existing),
          }),
        }),
      }),
      insert: () => ({
        select: () => Promise.resolve(insert),
      }),
    }),
  } as never
}

describe('insertCompanyKnowledgeIfMissing', () => {
  const input = { clientId: 'c1', caseId: 'case1', content: 'Acme Corp — Software industry.', sourceUrl: 'https://acme.com' }

  it('should skip the insert and return null when a company row already exists for the case', async () => {
    const supabase = mockCheckThenInsert({ data: [{ id: 'existing' }], error: null })

    const result = await insertCompanyKnowledgeIfMissing(supabase, input)

    expect(result).toBeNull()
  })

  it('should insert and return the new row when no company row exists for the case', async () => {
    const insertedRow = { id: 'k1', kind: 'company' }
    const supabase = mockCheckThenInsert({ data: [], error: null }, { data: [insertedRow], error: null })

    const result = await insertCompanyKnowledgeIfMissing(supabase, input)

    expect(result).toEqual(insertedRow)
  })

  it('should throw DB_ERROR when the existence check errors', async () => {
    const supabase = mockCheckThenInsert({ data: null, error: { message: 'boom' } })

    await expect(insertCompanyKnowledgeIfMissing(supabase, input)).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the insert errors', async () => {
    const supabase = mockCheckThenInsert({ data: [], error: null }, { data: null, error: { message: 'boom' } })

    await expect(insertCompanyKnowledgeIfMissing(supabase, input)).rejects.toBeInstanceOf(AppError)
  })
})
```

Update the file's import line at the top from:

```ts
import { insertKnowledge, listKnowledgeForCase } from './case-knowledge'
```

to:

```ts
import { insertKnowledge, listKnowledgeForCase, insertCompanyKnowledgeIfMissing } from './case-knowledge'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db/case-knowledge.test.ts`
Expected: FAIL — `insertCompanyKnowledgeIfMissing` is not exported yet.

- [ ] **Step 3: Implement**

In `src/lib/db/case-knowledge.ts`, add after `insertKnowledge` (after its closing `}` around line 20):

```ts

export interface InsertCompanyKnowledgeInput {
  clientId: string
  caseId: string
  content: string
  sourceUrl: string | null
}

// Check-before-insert: a case gets at most one kind:'company' row. Two
// groupVerifiedLead calls for the same brand-new case within one discovery
// run can't race here — discover.ts calls it sequentially — but concurrent
// discovery runs across campaigns could theoretically both pass this check;
// accepted per the design doc (no DB-level constraint for this row).
export async function insertCompanyKnowledgeIfMissing(
  supabase: SupabaseClient<Database>,
  input: InsertCompanyKnowledgeInput,
): Promise<KnowledgeRow | null> {
  const { data: existing, error: selectError } = await supabase
    .from('case_knowledge')
    .select('id')
    .eq('case_id', input.caseId)
    .eq('kind', 'company')
    .limit(1)
  if (selectError) {
    throw new AppError('DB_ERROR', 'Failed to check for existing company knowledge', {
      caseId: input.caseId, cause: selectError.message,
    })
  }
  if (existing && existing.length > 0) return null

  const { data: inserted, error: insertError } = await supabase
    .from('case_knowledge')
    .insert({
      client_id: input.clientId,
      case_id: input.caseId,
      kind: 'company',
      content: input.content,
      source_url: input.sourceUrl,
      citation: 'Apollo',
      created_by: 'agent',
    })
    .select('*')
  if (insertError) {
    throw new AppError('DB_ERROR', 'Failed to insert company knowledge', {
      caseId: input.caseId, cause: insertError.message,
    })
  }
  return inserted && inserted.length > 0 ? inserted[0]! : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/case-knowledge.test.ts`
Expected: PASS — all tests in the file green (existing `insertKnowledge`/`listKnowledgeForCase` tests plus the 4 new ones).

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/case-knowledge.ts src/lib/db/case-knowledge.test.ts
git commit -m "feat: add insertCompanyKnowledgeIfMissing DB helper"
```

---

### Task 4: Wire firmographics into `groupVerifiedLead`

**Files:**
- Modify: `src/lib/pipeline/group-lead.ts`
- Test: `src/lib/pipeline/group-lead.test.ts` (extend)

**Interfaces:**
- Consumes: `formatCompanySummary`/`CompanyFirmographics` from `src/lib/apollo/format-company-summary` (Task 2), `insertCompanyKnowledgeIfMissing` from `src/lib/db/case-knowledge` (Task 3), `logWarn` from `src/lib/events/log-event` (existing export).
- Produces: `LeadToGroup` gains a required `raw: Json` field — Task 5 (`discover.ts`) must pass it at the call site or this won't type-check.

- [ ] **Step 1: Write the failing tests**

Replace the full contents of `src/lib/pipeline/group-lead.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindOrCreateCase = vi.hoisted(() => vi.fn())
const mockUpdateLeadCase = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())
const mockLogWarn = vi.hoisted(() => vi.fn())
const mockInsertCompanyKnowledgeIfMissing = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/cases', () => ({ findOrCreateCase: mockFindOrCreateCase }))
vi.mock('@/lib/db/leads', () => ({ updateLeadCase: mockUpdateLeadCase }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent, logWarn: mockLogWarn }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertCompanyKnowledgeIfMissing: mockInsertCompanyKnowledgeIfMissing }))

import { computeCompanyKey, groupVerifiedLead } from './group-lead'

describe('computeCompanyKey', () => {
  it('should use the lowercased domain when present', () => {
    expect(computeCompanyKey('Acme.COM', 'Acme Inc')).toBe('acme.com')
  })

  it('should fall back to the normalized company name when domain is null', () => {
    expect(computeCompanyKey(null, 'Acme Inc.')).toBe('acme')
  })
})

describe('groupVerifiedLead', () => {
  beforeEach(() => {
    mockFindOrCreateCase.mockReset()
    mockUpdateLeadCase.mockReset()
    mockLogEvent.mockReset()
    mockLogWarn.mockReset()
    mockInsertCompanyKnowledgeIfMissing.mockReset()
  })

  it('should find-or-create a case keyed by domain, attach the lead, log the event, and return the case id', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case1' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead1', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(caseId).toBe('case1')
    expect(mockFindOrCreateCase).toHaveBeenCalledWith({}, {
      clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', companyKey: 'acme.com',
    })
    expect(mockUpdateLeadCase).toHaveBeenCalledWith({}, 'lead1', 'case1')
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case1', type: 'pipeline.lead_grouped',
    }))
  })

  it('should still return the case id when the audit logEvent call fails', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case3' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockRejectedValue(new Error('audit write failed'))

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead3', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(caseId).toBe('case3')
    expect(mockUpdateLeadCase).toHaveBeenCalledWith({}, 'lead3', 'case3')
  })

  it('should use the domain as the display company name when companyName is blank', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case2' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    await groupVerifiedLead({} as never, {
      id: 'lead2', clientId: 'client1', campaignId: 'camp1', companyName: null, companyDomain: 'beta.io', raw: null,
    })

    expect(mockFindOrCreateCase).toHaveBeenCalledWith({}, expect.objectContaining({ companyName: 'beta.io' }))
  })

  it('should write a company-knowledge row when raw carries firmographics', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case4' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockInsertCompanyKnowledgeIfMissing.mockResolvedValue({ id: 'k1' })

    await groupVerifiedLead({} as never, {
      id: 'lead4', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com',
      raw: { organizationIndustry: 'Software', organizationEmployeeCount: 120 },
    })

    expect(mockInsertCompanyKnowledgeIfMissing).toHaveBeenCalledWith({}, {
      clientId: 'client1',
      caseId: 'case4',
      content: 'Acme Inc. — Software industry, ~120 employees.',
      sourceUrl: 'https://acme.com',
    })
  })

  it('should not write a company-knowledge row when raw carries no firmographic fields', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case5' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    await groupVerifiedLead({} as never, {
      id: 'lead5', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(mockInsertCompanyKnowledgeIfMissing).not.toHaveBeenCalled()
  })

  it('should not write a company-knowledge row when the lead has no company domain', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case7' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockInsertCompanyKnowledgeIfMissing.mockResolvedValue({ id: 'k2' })

    await groupVerifiedLead({} as never, {
      id: 'lead7', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: null,
      raw: { organizationIndustry: 'Software' },
    })

    expect(mockInsertCompanyKnowledgeIfMissing).toHaveBeenCalledWith({}, expect.objectContaining({ sourceUrl: null }))
  })

  it('should still return the case id when insertCompanyKnowledgeIfMissing rejects', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case6' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockInsertCompanyKnowledgeIfMissing.mockRejectedValue(new Error('db write failed'))

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead6', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com',
      raw: { organizationIndustry: 'Software' },
    })

    expect(caseId).toBe('case6')
    expect(mockLogWarn).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case6', type: 'pipeline.company_knowledge_failed',
    }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/group-lead.test.ts`
Expected: FAIL — `raw` is missing from `LeadToGroup` (type error at every call), `mockInsertCompanyKnowledgeIfMissing` is never called, `mockLogWarn` never called.

- [ ] **Step 3: Implement**

Replace the full contents of `src/lib/pipeline/group-lead.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database, Json } from '@/types/database'
import { normalizeCompanyName } from './company-key'
import { findOrCreateCase } from '@/lib/db/cases'
import { updateLeadCase } from '@/lib/db/leads'
import { insertCompanyKnowledgeIfMissing } from '@/lib/db/case-knowledge'
import { formatCompanySummary, type CompanyFirmographics } from '@/lib/apollo/format-company-summary'
import { logEvent, logWarn } from '@/lib/events/log-event'

export function computeCompanyKey(domain: string | null, companyName: string | null): string {
  if (domain) return domain.toLowerCase().trim()
  return normalizeCompanyName(companyName ?? '')
}

export interface LeadToGroup {
  id: string
  clientId: string
  campaignId: string
  companyName: string | null
  companyDomain: string | null
  raw: Json
}

// discover.ts spreads the already-mapped ApolloEnrichedPerson (camelCase)
// onto `leads.raw`, not raw Apollo API JSON — despite the column's name — so
// this schema mirrors ApolloEnrichedPerson's field names, not Apollo's
// snake_case wire format.
const rawOrgFieldsSchema = z.object({
  organizationIndustry: z.string().nullable().optional(),
  organizationEmployeeCount: z.number().nullable().optional(),
  organizationFoundedYear: z.number().nullable().optional(),
  organizationDescription: z.string().nullable().optional(),
  organizationCity: z.string().nullable().optional(),
  organizationState: z.string().nullable().optional(),
  organizationCountry: z.string().nullable().optional(),
}).passthrough()

// Returns null (not a throw) for a lead inserted before this feature shipped,
// or any other shape `raw` doesn't carry firmographics in — missing data is
// not an error condition here.
function parseCompanyFirmographicsFromRaw(raw: Json): CompanyFirmographics | null {
  const parsed = rawOrgFieldsSchema.safeParse(raw)
  if (!parsed.success) return null
  return {
    industry: parsed.data.organizationIndustry ?? null,
    employeeCount: parsed.data.organizationEmployeeCount ?? null,
    foundedYear: parsed.data.organizationFoundedYear ?? null,
    description: parsed.data.organizationDescription ?? null,
    city: parsed.data.organizationCity ?? null,
    state: parsed.data.organizationState ?? null,
    country: parsed.data.organizationCountry ?? null,
  }
}

// Stage 2 (.claude/architecture.md §6): a verified lead activates a case for its
// company. Unverified/not-found leads are inserted (Task 11) but stay
// unattached (case_id null) until a verified person for the same company
// arrives — this function is only ever called for verified leads.
export async function groupVerifiedLead(
  supabase: SupabaseClient<Database>,
  lead: LeadToGroup,
): Promise<string> {
  const companyName = lead.companyName?.trim() || lead.companyDomain || 'Unknown company'
  const companyKey = computeCompanyKey(lead.companyDomain, lead.companyName)

  const kase = await findOrCreateCase(supabase, {
    clientId: lead.clientId,
    campaignId: lead.campaignId,
    companyName,
    companyDomain: lead.companyDomain,
    companyKey,
  })
  await updateLeadCase(supabase, lead.id, kase.id)

  const firmographics = parseCompanyFirmographicsFromRaw(lead.raw)
  const summary = firmographics ? formatCompanySummary(companyName, firmographics) : null
  if (summary) {
    try {
      await insertCompanyKnowledgeIfMissing(supabase, {
        clientId: lead.clientId,
        caseId: kase.id,
        content: summary,
        sourceUrl: lead.companyDomain ? `https://${lead.companyDomain}` : null,
      })
    } catch (error) {
      // Isolated on purpose: a company-knowledge write failure must never
      // turn an already-successful case grouping into a failed pipeline run.
      await logWarn({
        clientId: lead.clientId,
        caseId: kase.id,
        actor: 'system',
        type: 'pipeline.company_knowledge_failed',
        source: 'pipeline',
        error,
        payload: { leadId: lead.id },
      })
    }
  }

  try {
    await logEvent({
      clientId: lead.clientId,
      caseId: kase.id,
      actor: 'system',
      type: 'pipeline.lead_grouped',
      payload: { leadId: lead.id, caseId: kase.id, companyKey },
    })
  } catch {
    // Audit logging is best-effort — it must not turn an already-completed
    // grouping (case created, lead attached) into a rejected operation.
  }
  return kase.id
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/group-lead.test.ts`
Expected: PASS — all 8 tests green.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: an error at `src/lib/pipeline/discover.ts` where `groupVerifiedLead` is called without `raw` — expected here, fixed in Task 5.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/group-lead.ts src/lib/pipeline/group-lead.test.ts
git commit -m "feat: write Apollo company firmographics to case_knowledge on lead grouping"
```

---

### Task 5: Pass `raw` through from `discover.ts`

**Files:**
- Modify: `src/lib/pipeline/discover.ts` (the `groupVerifiedLead` call site inside `runDiscoveryForCampaign`, around lines 436-443)
- Test: `src/lib/pipeline/discover.test.ts` (extend)

**Interfaces:**
- Consumes: `LeadToGroup.raw` from Task 4 — `lead.raw` already exists on `LeadRow` (Supabase-generated type), no new data fetched.
- Produces: nothing new for later tasks.

- [ ] **Step 1: Write the failing test**

Open `src/lib/pipeline/discover.test.ts` and add this test inside `describe('runDiscoveryForCampaign', ...)`, after the first existing test (`'should fill the daily quota across both search phases...'`):

```ts

  it("should pass each lead's raw Apollo data through to groupVerifiedLead", async () => {
    mockSearchPeople.mockResolvedValueOnce({
      totalEntries: 1,
      candidates: [candidate('p1', 'p1.com')],
    })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    const rawPayload = { organizationIndustry: 'Software', organizationEmployeeCount: 50 }
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
        email_status: 'verified', raw: rawPayload,
      })),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 1, icp })

    // firstPassQuota = ceil(1/2) = 1, so exactly one pick is enriched and
    // grouped, and secondPassQuota (1 - 1 = 0) means no second search call
    expect(mockGroupVerifiedLead).toHaveBeenCalledWith({}, expect.objectContaining({ raw: rawPayload }))
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts -t "raw Apollo data"`
Expected: FAIL — `mockGroupVerifiedLead` was called without a `raw` field (`objectContaining` assertion fails).

- [ ] **Step 3: Implement**

In `src/lib/pipeline/discover.ts`, inside the `for (const lead of inserted)` loop in `runDiscoveryForCampaign` (around line 434-443), change:

```ts
        await groupVerifiedLead(supabase, {
          id: lead.id,
          clientId: lead.client_id,
          campaignId: lead.campaign_id,
          companyName: lead.company_name,
          companyDomain: lead.company_domain,
        })
```

to:

```ts
        await groupVerifiedLead(supabase, {
          id: lead.id,
          clientId: lead.client_id,
          campaignId: lead.campaign_id,
          companyName: lead.company_name,
          companyDomain: lead.company_domain,
          raw: lead.raw,
        })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — the whole file green, including the new test and every pre-existing one (none of them assert the exact `groupVerifiedLead` call shape, so this is additive).

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: clean — the Task 4 error at this call site is now resolved.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "feat: pass lead.raw through to groupVerifiedLead for firmographic capture"
```

---

### Task 6: Logs-tab sentence for a company-knowledge write failure

**Files:**
- Modify: `src/lib/ui/log.ts`
- Test: `src/lib/ui/log.test.ts` (extend)

**Interfaces:**
- Consumes: the `pipeline.company_knowledge_failed` event type emitted by `logWarn` in Task 4 (payload: `{ leadId, errorCode, errorMessage }`, per `logWarn`'s existing behavior in `src/lib/events/log-event.ts`).
- Produces: nothing new for later tasks — this is the terminal display layer for that event type.

- [ ] **Step 1: Write the failing test**

Open `src/lib/ui/log.test.ts` and add, inside `describe('describeEvent', ...)`, after the `'should name the vendor and the domain when given a failed email verification'` test:

```ts

  it('should report a company-knowledge write failure with the error message', () => {
    const result = describeEvent('pipeline.company_knowledge_failed', {
      leadId: 'lead1',
      errorCode: 'DB_ERROR',
      errorMessage: 'insert failed',
    })

    expect(result).toBe('Could not save Apollo company info for a case: insert failed.')
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/ui/log.test.ts -t "company-knowledge write failure"`
Expected: FAIL — no `SENTENCE_BUILDERS` entry for `pipeline.company_knowledge_failed`, so `describeEvent` falls through to the humanized-type fallback (`'Pipeline company knowledge failed'`), not the expected sentence.

- [ ] **Step 3: Implement**

In `src/lib/ui/log.ts`, add an entry to `SENTENCE_BUILDERS` right after `'pipeline.discover.group_lead_failed'`:

```ts
  'pipeline.discover.group_lead_failed': (p) =>
    `Could not group a discovered lead into a company case: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.company_knowledge_failed': (p) =>
    `Could not save Apollo company info for a case: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/ui/log.test.ts`
Expected: PASS — all tests in the file green.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no new errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/log.ts src/lib/ui/log.test.ts
git commit -m "feat: add Logs tab sentence for company-knowledge write failures"
```

---

### Task 7: Full verification + roadmap update

**Files:**
- Modify: `.claude/roadmap.md` (append a new dated section, per `CLAUDE.md`'s standing instruction)
- No code files — this task is verification + documentation only.

**Interfaces:**
- Consumes: nothing new.
- Produces: nothing — terminal task.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: every test file green, including all files touched in Tasks 1-6. Note the total test count for the roadmap entry.

- [ ] **Step 2: Type-check the whole project**

Run: `pnpm tsc --noEmit`
Expected: clean (or only the same pre-existing unrelated warning(s) already noted elsewhere in `.claude/roadmap.md`, e.g. in `env.test.ts` — do not introduce any new error).

- [ ] **Step 3: Lint**

Run: `pnpm eslint .`
Expected: 0 errors (pre-existing unrelated warnings, if any, are fine — do not introduce new ones).

- [ ] **Step 4: Append a roadmap entry**

Open `.claude/roadmap.md` and add a new section at the end of the file (after the final `Client Detail Workspace — Group B` section), matching this project's established recap style:

```markdown

## Apollo company firmographics on cases (2026-07-23)

Apollo's People Enrichment call (`bulkMatchPeople`, already made during
discovery) returns a full `organization` object that the client discarded
down to `name`/`primary_domain`/`website_url`. Now captures core
firmographics — industry, employee count, founded year, description,
city/state/country — at zero extra API cost, and writes them into
`case_knowledge` (`kind: 'company'`) so they appear in the Case page's
existing Knowledge tab and automatically flow into the AI email writer's
dossier prompt. No migration, no new Apollo endpoint.

Spec: `docs/superpowers/specs/2026-07-23-apollo-company-firmographics-design.md`
Plan: `docs/superpowers/plans/2026-07-23-apollo-company-firmographics.md`

- [x] `src/lib/apollo/client.ts` / `types.ts` — `organizationSchema` and
  `ApolloEnrichedPerson` widened with the seven firmographic fields.
- [x] `src/lib/apollo/format-company-summary.ts` — pure formatter, one
  plain-text sentence, `null` when nothing was captured.
- [x] `src/lib/db/case-knowledge.ts` — `insertCompanyKnowledgeIfMissing`,
  check-before-insert so a case gets at most one company-knowledge row.
- [x] `src/lib/pipeline/group-lead.ts` — parses firmographics off
  `lead.raw` (Zod, safe against pre-feature/legacy leads), writes the
  summary, isolated in its own try/catch (`logWarn` →
  `pipeline.company_knowledge_failed`) so a write failure never fails an
  already-successful case grouping.
- [x] `src/lib/pipeline/discover.ts` — passes `lead.raw` through to
  `groupVerifiedLead`.
- [x] `src/lib/ui/log.ts` — Logs tab sentence for the new failure event type.

Full suite: <fill in the number from Step 1> tests green. `tsc --noEmit`
clean. `eslint .` 0 errors.
```

Fill in the actual test count from Step 1's output before saving — do not leave the placeholder in the committed file.

- [ ] **Step 5: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: update roadmap for Apollo company firmographics feature"
```
