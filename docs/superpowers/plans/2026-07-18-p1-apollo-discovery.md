# P1 — Apollo Discovery + Verify + CRM View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every active campaign pulls up to `daily_target` (default 30) new ICP-matching people a day from **Apollo.io**, gets each email revealed *and* verified by Apollo in the same call, groups Apollo-verified people into cases by company, and surfaces them in a read-mostly `/crm` board. An operator-only `/campaigns` page creates campaigns with Apollo-shaped ICP filters.

**Architecture:** This plan **replaces** the original P1 design's Brightdata+Gemini "Lead-Gen Agent" and Emailable-based "Email Acquisition + Verify" system with a single deterministic, LLM-free Apollo pipeline (`src/lib/apollo/`). Apollo's `POST /mixed_people/api_search` finds candidates (no cost, no email/phone); `POST /people/bulk_match?reveal_personal_emails=true` reveals each candidate's email plus Apollo's own `email_status` (≤10 people/call, 1 credit per net-new verified email). Grouping (deterministic company-key → case) is unchanged in spirit from the original design but gets a real `cases.company_key` column instead of fuzzy name matching. Full narrative and rationale: `.claude/architecture.md §6 Stage 1, §12`. Roadmap entry: `.claude/roadmap.md` P1 (already updated as part of this planning pass — do not re-edit its structure, only tick checkboxes as tasks complete).

**Tech Stack:** Next.js 16 (App Router, React 19) · TypeScript 5 (strict) · `@supabase/supabase-js` + `@supabase/ssr` · Zod 4 · Vitest · `@upstash/qstash` · raw `fetch` + Zod for the Apollo REST API · pnpm.

## External Prerequisite (not code — flag to the user, do not attempt to work around)

Apollo's `POST /mixed_people/api_search` and `POST /people/bulk_match` both require an Apollo plan with **API access and a master API key** (`x-api-key` header). This must be provisioned by the user before Task 11/12's routes can be exercised against live data. Every task below is independently unit-testable with mocked HTTP calls and does **not** require a real key; only a live end-to-end run does.

## Global Constraints

Carried over from `.claude/architecture.md`, `.claude/roadmap.md`, and the conventions already established in `src/lib/mailbox/`, `src/lib/qstash/`, `src/lib/db/`. **Every task's requirements implicitly include this section.**

- **Package manager:** `pnpm` for all commands.
- **TypeScript:** `strict: true`. No `any` (use `unknown` + narrow/Zod). No `!` non-null assertions without a proof comment. Named exports only, except Next.js pages/layouts/components (default export).
- **Runtime validation:** Zod for **all** external boundaries — route inputs, the Apollo HTTP responses, campaign `icp` jsonb read back out of Postgres. Never trust an external shape; use `.passthrough()` + defensive optional chaining where a third-party API's docs are ambiguous (see the Apollo client task) rather than guessing a rigid shape.
- **Errors:** Never throw bare `Error`. Always `throw new AppError(code, message, context)` (`src/lib/errors/app-error.ts`). No empty catch blocks.
- **External calls:** Every external HTTP call goes through `fetchJson` (`src/lib/http/fetch-json.ts`), which already enforces an `AbortController` timeout — do not call `fetch` directly.
- **Naming:** Files `kebab-case.ts`. DB tables/columns `snake_case`; TypeScript `camelCase`. Zod schemas suffixed `Schema`.
- **DB access:** lives only in `src/lib/db/*.ts`. One function per DB operation, taking a `SupabaseClient<Database>` as the first argument (never construct a client inside a db-access function). Map raw Supabase errors to `AppError` at the DB layer.
- **Testing:** Vitest, colocated `*.test.ts`. Arrange-Act-Assert. Test naming `it('should [behavior] when [condition]')`. Mock at the boundary (`fetchJson`, `@/lib/env`, or a hand-rolled Supabase mock matching the exact chain used, per `src/lib/db/app-users.test.ts`) — never mock our own business-logic modules from within their own test file, only from *callers'* tests.
- **Observability:** Every pipeline state change writes to `events` via `logEvent` (`src/lib/events/log-event.ts`).
- **Completeness (ANTI_LAZY):** No stubs, no TODOs, no truncation, no hardcoded mock returns in shipped code. Every function fully implemented.
- **RLS:** Any new table/column keeps existing RLS coverage (0002_rls_policies.sql's generic per-`client_id` loop already covers `leads` and `cases`; adding columns to them needs no new policy).
- **Idempotency:** `/api/pipeline/discover` must be safe to retry (QStash at-least-once delivery) — achieved via the `(campaign_id, source_id)` unique index + upsert-ignore-duplicates, not a separate idempotency table.
- **Year is 2026.** After completing each task, tick its corresponding checkbox in `.claude/roadmap.md` under the P1 section.

---

## File Structure

```
supabase/migrations/
  0003_leads_source_id.sql          # leads.source_id + unique(campaign_id, source_id)
  0004_cases_company_key.sql        # cases.company_key + unique(campaign_id, company_key)

src/types/database.ts               # add source_id (leads), company_key (cases)

src/lib/env.ts                      # drop EMAILABLE_API_KEY, add APOLLO_API_KEY
src/lib/env.test.ts
.env.example

src/lib/apollo/
  types.ts                          # ApolloIcpFilters + apolloIcpSchema, ApolloSearchCandidate, ApolloEnrichedPerson
  build-search-params.ts            # ICP -> Apollo query params
  build-search-params.test.ts
  map-email-status.ts               # Apollo email_status -> lead_email_status
  map-email-status.test.ts
  client.ts                         # searchPeople(), bulkMatchPeople()
  client.test.ts

src/lib/db/
  leads.ts                          # getKnownSourceIds, insertLeads, updateLeadCase
  leads.test.ts
  cases.ts                          # findOrCreateCase
  cases.test.ts
  campaigns.ts                      # insertCampaign, getCampaignById, listActiveCampaigns, listCampaignsForClient
  campaigns.test.ts
  crm.ts                            # listCasesWithLeads (RLS-scoped read)
  crm.test.ts

src/lib/pipeline/
  company-key.ts                    # normalizeCompanyName
  company-key.test.ts
  group-lead.ts                     # computeCompanyKey, groupVerifiedLead
  group-lead.test.ts
  discover.ts                       # runDiscoveryForCampaign (orchestrates the above)
  discover.test.ts

src/app/api/pipeline/
  discover/route.ts                 # QStash-triggered, one campaign
  discover-fanout/route.ts          # QStash daily cron, fans out to all active campaigns

src/app/api/campaigns/route.ts      # POST create campaign (operator only)

src/app/campaigns/
  page.tsx
  new-campaign-form.tsx

src/app/crm/
  page.tsx

scripts/
  schedule-discover-cron.ts         # one-time: registers the QStash daily schedule
```

---

### Task 1: Schema migrations — Apollo dedup key + deterministic case key

**Files:**
- Create: `supabase/migrations/0003_leads_source_id.sql`
- Create: `supabase/migrations/0004_cases_company_key.sql`
- Modify: `src/types/database.ts` (leads and cases table types)

**Interfaces:**
- Produces: `leads.source_id: string | null` (unique per `(campaign_id, source_id)` — NULL values never conflict with each other under Postgres unique-constraint semantics, so non-Apollo leads with no `source_id` are unaffected).
- Produces: `cases.company_key: string` (not null, unique per `(campaign_id, company_key)`).
- These are plain (non-partial) unique indexes deliberately — a partial index (`WHERE source_id IS NOT NULL`) cannot be targeted by a Postgres `ON CONFLICT (col) DO NOTHING` clause without repeating the same `WHERE` in the conflict target, which Supabase-js's `upsert({ onConflict })` has no way to express. A plain unique index avoids that trap entirely.

- [ ] **Step 1: Write the migration for `leads.source_id`**

```sql
-- supabase/migrations/0003_leads_source_id.sql
-- Apollo person id for a discovered lead. Used to dedupe against Apollo re-fetches
-- and to skip credit-costing re-enrichment of people we've already seen for a
-- campaign. NULL is fine for any future non-Apollo source: Postgres unique
-- constraints never consider two NULLs equal, so multiple NULL source_ids per
-- campaign do not conflict.
alter table leads add column source_id text;
create unique index idx_leads_campaign_source_id on leads(campaign_id, source_id);
```

- [ ] **Step 2: Write the migration for `cases.company_key`**

```sql
-- supabase/migrations/0004_cases_company_key.sql
-- Deterministic dedup key for Stage 2 grouping (architecture.md §6): the
-- company_domain (lowercased) when known, else the normalized company_name.
-- Always populated by the grouping code path (src/lib/pipeline/group-lead.ts),
-- so NOT NULL with no default is safe — there are no pre-existing case rows yet.
alter table cases add column company_key text not null;
create unique index idx_cases_campaign_company_key on cases(campaign_id, company_key);
```

- [ ] **Step 3: Update `src/types/database.ts` for `leads`**

In the `leads` table's `Row` type, add after `source: string | null`:

```ts
          source: string | null
          source_id: string | null
```

In the `leads` table's `Insert` type, add after `source?: string | null`:

```ts
          source?: string | null
          source_id?: string | null
```

- [ ] **Step 4: Update `src/types/database.ts` for `cases`**

In the `cases` table's `Row` type, add after `company_domain: string | null`:

```ts
          company_domain: string | null
          company_key: string
```

In the `cases` table's `Insert` type, add after `company_domain?: string | null`:

```ts
          company_domain?: string | null
          company_key: string
```

(`company_key` is required on insert — no `?` — since the column is `not null` with no default.)

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: passes with no errors (these are additive, optional-where-needed fields).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0003_leads_source_id.sql supabase/migrations/0004_cases_company_key.sql src/types/database.ts
git commit -m "feat: add leads.source_id and cases.company_key for Apollo-based dedup"
```

---

### Task 2: Swap `EMAILABLE_API_KEY` for `APOLLO_API_KEY`

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `src/lib/env.test.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `env.APOLLO_API_KEY: string` (non-empty, required), consumed by `src/lib/apollo/client.ts` in Task 5.
- Removes: `env.EMAILABLE_API_KEY` (no remaining call site references it after this task — confirmed by the earlier repo grep showing only `env.ts`/`env.test.ts`/`log-event.test.ts` mention it, and `log-event.test.ts` doesn't actually reference the key, only the word "email").

- [ ] **Step 1: Write the failing test**

Edit `src/lib/env.test.ts`, replace the `complete` fixture's `EMAILABLE_API_KEY` line and add a new assertion:

```ts
const complete: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  APP_URL: 'http://localhost:3000',
  GOOGLE_OAUTH_CLIENT_ID: 'gid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  MICROSOFT_OAUTH_CLIENT_ID: 'mid',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
  QSTASH_TOKEN: 'qtoken',
  QSTASH_CURRENT_SIGNING_KEY: 'sig1',
  QSTASH_NEXT_SIGNING_KEY: 'sig2',
  BRIGHTDATA_API_KEY: 'bd',
  GEMINI_API_KEY: 'gem',
  APOLLO_API_KEY: 'apollo-key',
}

describe('loadEnv', () => {
  it('should return a typed env object when all vars are present', () => {
    const env = loadEnv(complete)
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co')
    expect(env.APP_URL).toBe('http://localhost:3000')
    expect(env.APOLLO_API_KEY).toBe('apollo-key')
  })

  it('should throw CONFIG_ERROR when a required var is missing', () => {
    const { QSTASH_TOKEN: _omit, ...partial } = complete
    expect(() => loadEnv(partial)).toThrowError(/QSTASH_TOKEN/)
  })

  it('should throw CONFIG_ERROR when APP_URL is not a valid url', () => {
    expect(() => loadEnv({ ...complete, APP_URL: 'not-a-url' })).toThrowError(/APP_URL/)
  })

  it('should reject blank strings for required vars', () => {
    expect(() => loadEnv({ ...complete, APOLLO_API_KEY: '' })).toThrowError(/APOLLO_API_KEY/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/env.test.ts`
Expected: FAIL — `env.APOLLO_API_KEY` is `undefined` (schema doesn't know the key yet) and the blank-string test fails because `EMAILABLE_API_KEY` (still required by the schema) is untouched while `APOLLO_API_KEY` isn't validated at all.

- [ ] **Step 3: Update the env schema**

Edit `src/lib/env.ts`, replace:

```ts
  EMAILABLE_API_KEY: nonEmpty,
```

with:

```ts
  APOLLO_API_KEY: nonEmpty,
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/env.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Update `.env.example`**

Edit `.env.example`, replace:

```
EMAILABLE_API_KEY=
```

with:

```
APOLLO_API_KEY=
```

- [ ] **Step 6: Commit**

```bash
git add src/lib/env.ts src/lib/env.test.ts .env.example
git commit -m "feat: replace EMAILABLE_API_KEY with APOLLO_API_KEY"
```

---

### Task 3: Apollo ICP schema + search-param builder

**Files:**
- Create: `src/lib/apollo/types.ts`
- Create: `src/lib/apollo/build-search-params.ts`
- Test: `src/lib/apollo/build-search-params.test.ts`

**Interfaces:**
- Produces: `apolloIcpSchema: ZodType<ApolloIcpFilters>`, `type ApolloIcpFilters = { personTitles: string[]; organizationLocations: string[]; employeeRangeMin: number | null; employeeRangeMax: number | null; keywords: string[] }`. This is the shape stored in `campaigns.icp` jsonb going forward (Task 10/13 write it; Task 11/12 read it back through this schema).
- Produces: `type ApolloSearchCandidate = { apolloId: string; firstName: string; lastNamePreview: string | null; title: string | null; organizationName: string | null; organizationDomain: string | null; linkedinUrl: string | null }` (used by Task 5's `client.ts`).
- Produces: `type ApolloEnrichedPerson = { apolloId: string; firstName: string | null; lastName: string | null; title: string | null; email: string | null; emailStatus: string | null; linkedinUrl: string | null; organizationName: string | null; organizationDomain: string | null }` (used by Task 5's `client.ts` and Task 4's mapper).
- Produces: `buildPeopleSearchParams(icp: ApolloIcpFilters, page: number, perPage: number): Record<string, string | string[]>` (consumed by Task 11's `discover.ts`, passed straight into Task 5's `searchPeople`).

- [ ] **Step 1: Write `types.ts`**

```ts
// src/lib/apollo/types.ts
import { z } from 'zod'

// Maps directly to Apollo's documented People Search filters
// (POST /mixed_people/api_search). Apollo's public API has no separate
// "industries" filter, so any industry terms an operator wants to target
// go into `keywords` (sent as the free-text `q_keywords` param).
export const apolloIcpSchema = z.object({
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nonnegative().nullable().default(null),
  employeeRangeMax: z.number().int().nonnegative().nullable().default(null),
  keywords: z.array(z.string()).default([]),
})

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

- [ ] **Step 2: Write the failing test for `build-search-params.ts`**

```ts
// src/lib/apollo/build-search-params.test.ts
import { describe, it, expect } from 'vitest'
import { buildPeopleSearchParams } from './build-search-params'
import type { ApolloIcpFilters } from './types'

const emptyIcp: ApolloIcpFilters = {
  personTitles: [],
  organizationLocations: [],
  employeeRangeMin: null,
  employeeRangeMax: null,
  keywords: [],
}

describe('buildPeopleSearchParams', () => {
  it('should always include page and per_page', () => {
    const params = buildPeopleSearchParams(emptyIcp, 2, 25)
    expect(params.page).toBe('2')
    expect(params.per_page).toBe('25')
  })

  it('should omit empty filters', () => {
    const params = buildPeopleSearchParams(emptyIcp, 1, 25)
    expect(params['person_titles[]']).toBeUndefined()
    expect(params['organization_locations[]']).toBeUndefined()
    expect(params['organization_num_employees_ranges[]']).toBeUndefined()
    expect(params.q_keywords).toBeUndefined()
  })

  it('should pass person titles and organization locations through as arrays', () => {
    const icp: ApolloIcpFilters = {
      ...emptyIcp,
      personTitles: ['vp sales', 'founder'],
      organizationLocations: ['united states'],
    }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['person_titles[]']).toEqual(['vp sales', 'founder'])
    expect(params['organization_locations[]']).toEqual(['united states'])
  })

  it('should format the employee range as a single "min,max" string when both bounds are set', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, employeeRangeMin: 50, employeeRangeMax: 200 }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['organization_num_employees_ranges[]']).toEqual(['50,200'])
  })

  it('should omit the employee range when only one bound is set', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, employeeRangeMin: 50, employeeRangeMax: null }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params['organization_num_employees_ranges[]']).toBeUndefined()
  })

  it('should join keywords into a single space-separated q_keywords string', () => {
    const icp: ApolloIcpFilters = { ...emptyIcp, keywords: ['fintech', 'payments'] }
    const params = buildPeopleSearchParams(icp, 1, 25)
    expect(params.q_keywords).toBe('fintech payments')
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: FAIL — `Cannot find module './build-search-params'`

- [ ] **Step 4: Write `build-search-params.ts`**

```ts
// src/lib/apollo/build-search-params.ts
import type { ApolloIcpFilters } from './types'

export function buildPeopleSearchParams(
  icp: ApolloIcpFilters,
  page: number,
  perPage: number,
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
  return params
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/build-search-params.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 6: Commit**

```bash
git add src/lib/apollo/types.ts src/lib/apollo/build-search-params.ts src/lib/apollo/build-search-params.test.ts
git commit -m "feat: add Apollo ICP schema and people-search param builder"
```

---

### Task 4: Apollo email-status mapping

**Files:**
- Create: `src/lib/apollo/map-email-status.ts`
- Test: `src/lib/apollo/map-email-status.test.ts`

**Interfaces:**
- Consumes: `Database['public']['Enums']['lead_email_status']` from `@/types/database` (`'unverified' | 'verified' | 'invalid' | 'risky' | 'not_found'`).
- Produces: `mapApolloEmailStatus(status: string | null | undefined): LeadEmailStatus`, consumed by Task 11's `discover.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/apollo/map-email-status.test.ts
import { describe, it, expect } from 'vitest'
import { mapApolloEmailStatus } from './map-email-status'

describe('mapApolloEmailStatus', () => {
  it('should map "verified" to verified', () => {
    expect(mapApolloEmailStatus('verified')).toBe('verified')
  })

  it('should be case-insensitive', () => {
    expect(mapApolloEmailStatus('Verified')).toBe('verified')
  })

  it('should map "catch_all" (and "Catch-all" spelling) to risky', () => {
    expect(mapApolloEmailStatus('catch_all')).toBe('risky')
    expect(mapApolloEmailStatus('Catch-all')).toBe('risky')
  })

  it('should map "unverified" to unverified', () => {
    expect(mapApolloEmailStatus('unverified')).toBe('unverified')
  })

  it('should map "update_required" (and "Update required" spelling) to unverified', () => {
    expect(mapApolloEmailStatus('update_required')).toBe('unverified')
    expect(mapApolloEmailStatus('Update required')).toBe('unverified')
  })

  it('should map "unavailable" to not_found', () => {
    expect(mapApolloEmailStatus('unavailable')).toBe('not_found')
  })

  it('should map null or undefined to not_found', () => {
    expect(mapApolloEmailStatus(null)).toBe('not_found')
    expect(mapApolloEmailStatus(undefined)).toBe('not_found')
  })

  it('should default any unrecognized status to unverified (never guess verified)', () => {
    expect(mapApolloEmailStatus('some_new_apollo_status')).toBe('unverified')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/apollo/map-email-status.test.ts`
Expected: FAIL — `Cannot find module './map-email-status'`

- [ ] **Step 3: Write `map-email-status.ts`**

```ts
// src/lib/apollo/map-email-status.ts
import type { Database } from '@/types/database'

type LeadEmailStatus = Database['public']['Enums']['lead_email_status']

const STATUS_MAP: Record<string, LeadEmailStatus> = {
  verified: 'verified',
  unverified: 'unverified',
  update_required: 'unverified',
  catch_all: 'risky',
  unavailable: 'not_found',
}

function normalize(status: string): string {
  return status.toLowerCase().trim().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '')
}

// Apollo's email_status vocabulary (Verified / Unverified / Update required /
// Unavailable / Catch-all) mapped onto our own lead_email_status enum.
// Anything Apollo returns that we don't recognize defaults to 'unverified',
// never 'verified' — per architecture.md's "no guessing" principle, only a
// status we can positively identify as Apollo's own "Verified" activates a lead.
export function mapApolloEmailStatus(status: string | null | undefined): LeadEmailStatus {
  if (!status) return 'not_found'
  const key = normalize(status)
  return STATUS_MAP[key] ?? 'unverified'
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/map-email-status.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/map-email-status.ts src/lib/apollo/map-email-status.test.ts
git commit -m "feat: map Apollo email_status onto lead_email_status enum"
```

---

### Task 5: Apollo API client (search + bulk enrich)

**Files:**
- Create: `src/lib/apollo/client.ts`
- Test: `src/lib/apollo/client.test.ts`

**Interfaces:**
- Consumes: `env.APOLLO_API_KEY` (Task 2), `fetchJson` (`@/lib/http/fetch-json`), `ApolloSearchCandidate`/`ApolloEnrichedPerson` (Task 3).
- Produces: `searchPeople(params: Record<string, string | string[]>): Promise<{ totalEntries: number; candidates: ApolloSearchCandidate[] }>`, consumed by Task 11's `discover.ts`.
- Produces: `interface BulkMatchDetail { id?: string; firstName?: string; lastName?: string; organizationName?: string; domain?: string; linkedinUrl?: string }` and `bulkMatchPeople(details: BulkMatchDetail[]): Promise<ApolloEnrichedPerson[]>`, consumed by Task 11's `discover.ts`.
- Base URL and endpoints are taken from Apollo's own OpenAPI spec (confirmed via Context7 docs, `docs.apollo.io/reference`): base `https://api.apollo.io/api/v1`; search path `/mixed_people/api_search` (POST, requires master API key, no credits, no email/phone in the response); enrich path `/people/bulk_match` (POST, query params `reveal_personal_emails`/`reveal_phone_number`, body `{ details: [...] }`, ≤10 entries).
- Apollo's public docs are inconsistent about the exact response wrapper key for `bulk_match` (`matches` vs `people` appear in different doc pages) and about where `email_status` nests (top-level `email_status` vs `contact_emails[0].email_status`). The client is written defensively — it accepts either wrapper key and checks both field paths — rather than guessing one. See `architecture.md §12`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/apollo/client.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({ env: { APOLLO_API_KEY: 'test-apollo-key' } }))

import { searchPeople, bulkMatchPeople } from './client'
import { AppError } from '@/lib/errors/app-error'

describe('searchPeople', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should call the mixed_people/api_search endpoint with the API key header', async () => {
    mockFetchJson.mockResolvedValueOnce({ total_entries: 0, people: [] })
    await searchPeople({ page: '1', per_page: '25' })
    const [url, options] = mockFetchJson.mock.calls[0]
    expect(url).toContain('https://api.apollo.io/api/v1/mixed_people/api_search')
    expect(url).toContain('page=1')
    expect(url).toContain('per_page=25')
    expect(options.method).toBe('POST')
    expect(options.headers['x-api-key']).toBe('test-apollo-key')
  })

  it('should serialize array params as repeated query keys', async () => {
    mockFetchJson.mockResolvedValueOnce({ total_entries: 0, people: [] })
    await searchPeople({ 'person_titles[]': ['vp sales', 'founder'] })
    const [url] = mockFetchJson.mock.calls[0]
    const parsed = new URL(url as string)
    expect(parsed.searchParams.getAll('person_titles[]')).toEqual(['vp sales', 'founder'])
  })

  it('should map candidates and resolve the organization domain from primary_domain', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_entries: 1,
      people: [{
        id: 'p1', first_name: 'Jo', last_name_obfuscated: 'Do***e', title: 'VP Sales',
        linkedin_url: 'https://linkedin.com/in/jo', organization: { name: 'Acme', primary_domain: 'acme.com' },
      }],
    })
    const { totalEntries, candidates } = await searchPeople({})
    expect(totalEntries).toBe(1)
    expect(candidates).toEqual([{
      apolloId: 'p1', firstName: 'Jo', lastNamePreview: 'Do***e', title: 'VP Sales',
      organizationName: 'Acme', organizationDomain: 'acme.com', linkedinUrl: 'https://linkedin.com/in/jo',
    }])
  })

  it('should derive the organization domain from website_url when primary_domain is missing', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_entries: 1,
      people: [{ id: 'p2', first_name: 'Al', organization: { name: 'Beta', website_url: 'https://www.beta.io/home' } }],
    })
    const { candidates } = await searchPeople({})
    expect(candidates[0].organizationDomain).toBe('beta.io')
  })

  it('should return an empty candidate list when the response has no people', async () => {
    mockFetchJson.mockResolvedValueOnce({ total_entries: 0 })
    const { candidates } = await searchPeople({})
    expect(candidates).toEqual([])
  })
})

describe('bulkMatchPeople', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return an empty array without calling fetchJson when details is empty', async () => {
    const result = await bulkMatchPeople([])
    expect(result).toEqual([])
    expect(mockFetchJson).not.toHaveBeenCalled()
  })

  it('should throw VALIDATION_ERROR when more than 10 details are given', async () => {
    const details = Array.from({ length: 11 }, (_, i) => ({ id: `p${i}` }))
    await expect(bulkMatchPeople(details)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should call bulk_match with reveal_personal_emails=true and the details body', async () => {
    mockFetchJson.mockResolvedValueOnce({ matches: [] })
    await bulkMatchPeople([{ id: 'p1', firstName: 'Jo', domain: 'acme.com' }])
    const [url, options] = mockFetchJson.mock.calls[0]
    expect(url).toContain('/people/bulk_match')
    expect(url).toContain('reveal_personal_emails=true')
    const body = JSON.parse(options.body as string)
    expect(body.details).toEqual([{
      id: 'p1', first_name: 'Jo', last_name: undefined, organization_name: undefined,
      domain: 'acme.com', linkedin_url: undefined,
    }])
  })

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

  it('should fall back to the "people" wrapper key and contact_emails[0] when top-level email fields are absent', async () => {
    mockFetchJson.mockResolvedValueOnce({
      people: [{ id: 'p2', contact_emails: [{ email: 'al@beta.io', email_status: 'unverified' }] }],
    })
    const result = await bulkMatchPeople([{ id: 'p2' }])
    expect(result[0].email).toBe('al@beta.io')
    expect(result[0].emailStatus).toBe('unverified')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/apollo/client.test.ts`
Expected: FAIL — `Cannot find module './client'`

- [ ] **Step 3: Write `client.ts`**

```ts
// src/lib/apollo/client.ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { ApolloEnrichedPerson, ApolloSearchCandidate } from './types'

const BASE_URL = 'https://api.apollo.io/api/v1'
const MAX_BULK_MATCH_DETAILS = 10

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'x-api-key': env.APOLLO_API_KEY }
}

function toURLSearchParams(params: Record<string, string | string[]>): URLSearchParams {
  const usp = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (Array.isArray(value)) {
      for (const v of value) usp.append(key, v)
    } else {
      usp.append(key, value)
    }
  }
  return usp
}

const organizationSchema = z.object({
  name: z.string().nullable().optional(),
  primary_domain: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
}).nullable().optional()

function domainFromOrg(org: z.infer<typeof organizationSchema>): string | null {
  if (!org) return null
  if (org.primary_domain) return org.primary_domain
  if (org.website_url) {
    try {
      return new URL(org.website_url).hostname.replace(/^www\./, '')
    } catch {
      return null
    }
  }
  return null
}

const searchPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  last_name_obfuscated: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  organization: organizationSchema,
}).passthrough()

const searchResponseSchema = z.object({
  total_entries: z.number().optional(),
  people: z.array(searchPersonSchema).optional(),
}).passthrough()

export async function searchPeople(
  params: Record<string, string | string[]>,
): Promise<{ totalEntries: number; candidates: ApolloSearchCandidate[] }> {
  const query = toURLSearchParams(params)
  const res = await fetchJson(
    `${BASE_URL}/mixed_people/api_search?${query.toString()}`,
    { method: 'POST', headers: authHeaders() },
    searchResponseSchema,
  )
  const candidates: ApolloSearchCandidate[] = (res.people ?? []).map((p) => ({
    apolloId: p.id,
    firstName: p.first_name ?? '',
    lastNamePreview: p.last_name ?? p.last_name_obfuscated ?? null,
    title: p.title ?? null,
    organizationName: p.organization?.name ?? null,
    organizationDomain: domainFromOrg(p.organization),
    linkedinUrl: p.linkedin_url ?? null,
  }))
  return { totalEntries: res.total_entries ?? candidates.length, candidates }
}

const enrichedPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  email_status: z.string().nullable().optional(),
  contact_emails: z.array(z.object({
    email: z.string().nullable().optional(),
    email_status: z.string().nullable().optional(),
  })).optional(),
  organization: organizationSchema,
}).passthrough()

// Apollo's docs use "matches" on some pages and "people" on others for the
// same bulk_match response — accept either rather than guess.
const bulkMatchResponseSchema = z.object({
  matches: z.array(enrichedPersonSchema).optional(),
  people: z.array(enrichedPersonSchema).optional(),
}).passthrough()

export interface BulkMatchDetail {
  id?: string
  firstName?: string
  lastName?: string
  organizationName?: string
  domain?: string
  linkedinUrl?: string
}

export async function bulkMatchPeople(details: BulkMatchDetail[]): Promise<ApolloEnrichedPerson[]> {
  if (details.length === 0) return []
  if (details.length > MAX_BULK_MATCH_DETAILS) {
    throw new AppError('VALIDATION_ERROR', 'Apollo bulk_match accepts at most 10 people per call', {
      count: details.length,
    })
  }
  const body = {
    details: details.map((d) => ({
      id: d.id,
      first_name: d.firstName,
      last_name: d.lastName,
      organization_name: d.organizationName,
      domain: d.domain,
      linkedin_url: d.linkedinUrl,
    })),
  }
  const res = await fetchJson(
    `${BASE_URL}/people/bulk_match?reveal_personal_emails=true`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify(body) },
    bulkMatchResponseSchema,
  )
  const people = res.matches ?? res.people ?? []
  return people.map((p) => {
    const emailStatus = p.email_status ?? p.contact_emails?.[0]?.email_status ?? null
    const email = p.email ?? p.contact_emails?.[0]?.email ?? null
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
    }
  })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/client.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/client.ts src/lib/apollo/client.test.ts
git commit -m "feat: add Apollo API client (people search + bulk enrich)"
```

---

### Task 6: Leads DB access for Apollo dedup

**Files:**
- Create: `src/lib/db/leads.ts`
- Test: `src/lib/db/leads.test.ts`

**Interfaces:**
- Consumes: `leads.source_id` column (Task 1).
- Produces: `getKnownSourceIds(supabase, campaignId): Promise<Set<string>>`, `insertLeads(supabase, rows: LeadInsert[]): Promise<LeadRow[]>`, `updateLeadCase(supabase, leadId, caseId): Promise<void>` — all consumed by Task 9's `group-lead.ts` and Task 11's `discover.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/db/leads.test.ts
import { describe, it, expect, vi } from 'vitest'
import { getKnownSourceIds, insertLeads, updateLeadCase } from './leads'
import { AppError } from '@/lib/errors/app-error'

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

describe('getKnownSourceIds', () => {
  it('should return a set of non-null source ids', async () => {
    const supabase = mockSupabase({ selectResult: { data: [{ source_id: 'a' }, { source_id: 'b' }], error: null } })
    const result = await getKnownSourceIds(supabase, 'camp1')
    expect(result).toEqual(new Set(['a', 'b']))
  })

  it('should filter out null source ids', async () => {
    const supabase = mockSupabase({ selectResult: { data: [{ source_id: 'a' }, { source_id: null }], error: null } })
    const result = await getKnownSourceIds(supabase, 'camp1')
    expect(result).toEqual(new Set(['a']))
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = mockSupabase({ selectResult: { data: null, error: { message: 'boom' } } })
    await expect(getKnownSourceIds(supabase, 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertLeads', () => {
  it('should return an empty array without calling supabase when rows is empty', async () => {
    const fromSpy = vi.fn()
    const supabase = { from: fromSpy } as never
    const result = await insertLeads(supabase, [])
    expect(result).toEqual([])
    expect(fromSpy).not.toHaveBeenCalled()
  })

  it('should return only the newly inserted rows (duplicates silently skipped)', async () => {
    const inserted = [{ id: 'l1', campaign_id: 'camp1', source_id: 'a' }]
    const supabase = mockSupabase({ upsertResult: { data: inserted, error: null } })
    const result = await insertLeads(supabase, [{ client_id: 'c1', campaign_id: 'camp1', full_name: 'A', source_id: 'a' }] as never)
    expect(result).toEqual(inserted)
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    const supabase = mockSupabase({ upsertResult: { data: null, error: { message: 'boom' } } })
    await expect(
      insertLeads(supabase, [{ client_id: 'c1', campaign_id: 'camp1', full_name: 'A' }] as never),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateLeadCase', () => {
  it('should resolve when the update succeeds', async () => {
    const supabase = mockSupabase({})
    await expect(updateLeadCase(supabase, 'lead1', 'case1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = mockSupabase({ updateResult: { data: null, error: { message: 'boom' } } })
    await expect(updateLeadCase(supabase, 'lead1', 'case1')).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: FAIL — `Cannot find module './leads'`

- [ ] **Step 3: Write `leads.ts`**

```ts
// src/lib/db/leads.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type LeadRow = Database['public']['Tables']['leads']['Row']
export type LeadInsert = Database['public']['Tables']['leads']['Insert']

export async function getKnownSourceIds(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('leads')
    .select('source_id')
    .eq('campaign_id', campaignId)
    .not('source_id', 'is', null)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load known lead source ids', { campaignId, cause: error.message })
  }
  return new Set((data ?? []).map((r) => r.source_id).filter((v): v is string => v !== null))
}

// Upsert with ignoreDuplicates so a QStash retry of /api/pipeline/discover is
// idempotent: rows already present for (campaign_id, source_id) are silently
// skipped and never appear in the returned array (Postgres INSERT ... ON
// CONFLICT DO NOTHING RETURNING * semantics).
export async function insertLeads(
  supabase: SupabaseClient<Database>,
  rows: LeadInsert[],
): Promise<LeadRow[]> {
  if (rows.length === 0) return []
  const { data, error } = await supabase
    .from('leads')
    .upsert(rows, { onConflict: 'campaign_id,source_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert leads', { count: rows.length, cause: error.message })
  }
  return data ?? []
}

export async function updateLeadCase(
  supabase: SupabaseClient<Database>,
  leadId: string,
  caseId: string,
): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ case_id: caseId, status: 'active' })
    .eq('id', leadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to attach lead to case', { leadId, caseId, cause: error.message })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat: add leads DB access for Apollo dedup and case attachment"
```

---

### Task 7: Company-key normalization

**Files:**
- Create: `src/lib/pipeline/company-key.ts`
- Test: `src/lib/pipeline/company-key.test.ts`

**Interfaces:**
- Produces: `normalizeCompanyName(name: string): string`, consumed by Task 9's `group-lead.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/pipeline/company-key.test.ts
import { describe, it, expect } from 'vitest'
import { normalizeCompanyName } from './company-key'

describe('normalizeCompanyName', () => {
  it('should lowercase the name', () => {
    expect(normalizeCompanyName('ACME')).toBe('acme')
  })

  it('should strip a trailing legal suffix', () => {
    expect(normalizeCompanyName('Acme Inc.')).toBe('acme')
    expect(normalizeCompanyName('Acme, LLC')).toBe('acme')
    expect(normalizeCompanyName('Acme GmbH')).toBe('acme')
  })

  it('should collapse repeated whitespace', () => {
    expect(normalizeCompanyName('  Multi   Space   Co  ')).toBe('multi space')
  })

  it('should preserve multi-word names with no legal suffix', () => {
    expect(normalizeCompanyName('Foo Bar Studios')).toBe('foo bar studios')
  })

  it('should return an empty string for a name that is only a legal suffix', () => {
    expect(normalizeCompanyName('Inc')).toBe('')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/company-key.test.ts`
Expected: FAIL — `Cannot find module './company-key'`

- [ ] **Step 3: Write `company-key.ts`**

```ts
// src/lib/pipeline/company-key.ts
const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'sa', 'srl', 'bv', 'plc', 'llp', 'pty',
])

// Deterministic company-key fallback (architecture.md §6 Stage 2) used when
// Apollo doesn't return a company_domain: lowercase, strip punctuation, drop
// trailing legal-entity suffix words, collapse whitespace.
export function normalizeCompanyName(name: string): string {
  const words = name
    .toLowerCase()
    .trim()
    .replace(/[.,]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 0 && !LEGAL_SUFFIXES.has(word))
  return words.join(' ')
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/company-key.test.ts`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/company-key.ts src/lib/pipeline/company-key.test.ts
git commit -m "feat: add deterministic company-name normalization"
```

---

### Task 8: Cases DB access — `findOrCreateCase`

**Files:**
- Create: `src/lib/db/cases.ts`
- Test: `src/lib/db/cases.test.ts`

**Interfaces:**
- Consumes: `cases.company_key` column (Task 1).
- Produces: `findOrCreateCase(supabase, input: { clientId: string; campaignId: string; companyName: string; companyDomain: string | null; companyKey: string }): Promise<CaseRow>`, consumed by Task 9's `group-lead.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/db/cases.test.ts
import { describe, it, expect } from 'vitest'
import { findOrCreateCase } from './cases'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(steps: {
  upsertResult: { data: unknown; error: unknown }
  selectResult?: { data: unknown; error: unknown }
}) {
  return {
    from: () => ({
      upsert: () => ({ select: () => Promise.resolve(steps.upsertResult) }),
      select: () => ({
        eq: () => ({
          eq: () => ({ single: () => Promise.resolve(steps.selectResult ?? { data: null, error: null }) }),
        }),
      }),
    }),
  } as never
}

const input = {
  clientId: 'client1', campaignId: 'camp1', companyName: 'Acme', companyDomain: 'acme.com', companyKey: 'acme.com',
}

describe('findOrCreateCase', () => {
  it('should return the newly created case when the upsert inserts a fresh row', async () => {
    const row = { id: 'case1', company_key: 'acme.com' }
    const supabase = mockSupabase({ upsertResult: { data: [row], error: null } })
    const result = await findOrCreateCase(supabase, input)
    expect(result).toEqual(row)
  })

  it('should look up and return the existing case when the upsert hits a conflict (ignoreDuplicates returns no row)', async () => {
    const existing = { id: 'case1', company_key: 'acme.com' }
    const supabase = mockSupabase({
      upsertResult: { data: [], error: null },
      selectResult: { data: existing, error: null },
    })
    const result = await findOrCreateCase(supabase, input)
    expect(result).toEqual(existing)
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    const supabase = mockSupabase({ upsertResult: { data: null, error: { message: 'boom' } } })
    await expect(findOrCreateCase(supabase, input)).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the conflict fallback lookup finds nothing', async () => {
    const supabase = mockSupabase({
      upsertResult: { data: [], error: null },
      selectResult: { data: null, error: null },
    })
    await expect(findOrCreateCase(supabase, input)).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/cases.test.ts`
Expected: FAIL — `Cannot find module './cases'`

- [ ] **Step 3: Write `cases.ts`**

```ts
// src/lib/db/cases.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseRow = Database['public']['Tables']['cases']['Row']

export interface FindOrCreateCaseInput {
  clientId: string
  campaignId: string
  companyName: string
  companyDomain: string | null
  companyKey: string
}

// Race-safe find-or-create on the (campaign_id, company_key) unique index
// (Task 1 migration): the upsert wins the race for a brand-new key; a loser
// (two verified leads for the same company arriving in the same discovery
// batch) gets ignoreDuplicates' empty result and falls back to a plain read
// of the row the winner just created.
export async function findOrCreateCase(
  supabase: SupabaseClient<Database>,
  input: FindOrCreateCaseInput,
): Promise<CaseRow> {
  const { data: upserted, error: upsertErr } = await supabase
    .from('cases')
    .upsert(
      {
        client_id: input.clientId,
        campaign_id: input.campaignId,
        company_name: input.companyName,
        company_domain: input.companyDomain,
        company_key: input.companyKey,
      },
      { onConflict: 'campaign_id,company_key', ignoreDuplicates: true },
    )
    .select('*')
  if (upsertErr) {
    throw new AppError('DB_ERROR', 'Failed to upsert case', {
      campaignId: input.campaignId, companyKey: input.companyKey, cause: upsertErr.message,
    })
  }
  if (upserted && upserted.length > 0) return upserted[0]

  const { data: existing, error: selErr } = await supabase
    .from('cases')
    .select('*')
    .eq('campaign_id', input.campaignId)
    .eq('company_key', input.companyKey)
    .single()
  if (selErr || !existing) {
    throw new AppError('DB_ERROR', 'Case upsert produced no row and none found on fallback lookup', {
      campaignId: input.campaignId, companyKey: input.companyKey, cause: selErr?.message,
    })
  }
  return existing
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/cases.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/cases.ts src/lib/db/cases.test.ts
git commit -m "feat: add race-safe findOrCreateCase keyed on company_key"
```

---

### Task 9: Grouping — attach a verified lead to its case

**Files:**
- Create: `src/lib/pipeline/group-lead.ts`
- Test: `src/lib/pipeline/group-lead.test.ts`

**Interfaces:**
- Consumes: `normalizeCompanyName` (Task 7), `findOrCreateCase` (Task 8), `updateLeadCase` (Task 6), `logEvent` (`@/lib/events/log-event`).
- Produces: `computeCompanyKey(domain: string | null, companyName: string | null): string`, `groupVerifiedLead(supabase, lead: LeadToGroup): Promise<string>` (returns the case id), consumed by Task 11's `discover.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/pipeline/group-lead.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindOrCreateCase = vi.hoisted(() => vi.fn())
const mockUpdateLeadCase = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/cases', () => ({ findOrCreateCase: mockFindOrCreateCase }))
vi.mock('@/lib/db/leads', () => ({ updateLeadCase: mockUpdateLeadCase }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent }))

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
  })

  it('should find-or-create a case keyed by domain, attach the lead, log the event, and return the case id', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case1' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead1', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com',
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

  it('should use the domain as the display company name when companyName is blank', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case2' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    await groupVerifiedLead({} as never, {
      id: 'lead2', clientId: 'client1', campaignId: 'camp1', companyName: null, companyDomain: 'beta.io',
    })

    expect(mockFindOrCreateCase).toHaveBeenCalledWith({}, expect.objectContaining({ companyName: 'beta.io' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/group-lead.test.ts`
Expected: FAIL — `Cannot find module './group-lead'`

- [ ] **Step 3: Write `group-lead.ts`**

```ts
// src/lib/pipeline/group-lead.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { normalizeCompanyName } from './company-key'
import { findOrCreateCase } from '@/lib/db/cases'
import { updateLeadCase } from '@/lib/db/leads'
import { logEvent } from '@/lib/events/log-event'

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
}

// Stage 2 (architecture.md §6): a verified lead activates a case for its
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
  await logEvent({
    clientId: lead.clientId,
    caseId: kase.id,
    actor: 'system',
    type: 'pipeline.lead_grouped',
    payload: { leadId: lead.id, caseId: kase.id, companyKey },
  })
  return kase.id
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/group-lead.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/group-lead.ts src/lib/pipeline/group-lead.test.ts
git commit -m "feat: group verified leads into cases by deterministic company key"
```

---

### Task 10: Campaigns DB access

**Files:**
- Create: `src/lib/db/campaigns.ts`
- Test: `src/lib/db/campaigns.test.ts`

**Interfaces:**
- Produces: `insertCampaign(supabase, row: CampaignInsert): Promise<CampaignRow>`, `getCampaignById(supabase, id): Promise<CampaignRow | null>`, `listActiveCampaigns(supabase): Promise<CampaignRow[]>`, `listCampaignsForClient(supabase, clientId: string | null): Promise<CampaignRow[]>` — consumed by Task 12's routes and Task 13's `/campaigns` page.

- [ ] **Step 1: Write the failing test**

Each function uses a different Supabase query-builder chain shape, so each `describe` block gets its own tailored mock (matching the precedent in `src/lib/db/app-users.test.ts`) rather than one shared generic mock:

```ts
// src/lib/db/campaigns.test.ts
import { describe, it, expect } from 'vitest'
import { insertCampaign, getCampaignById, listActiveCampaigns, listCampaignsForClient } from './campaigns'
import { AppError } from '@/lib/errors/app-error'

describe('insertCampaign', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return the created campaign row', async () => {
    const row = { id: 'camp1', name: 'Test' }
    const result = await insertCampaign(mockSupabase({ data: row, error: null }), { client_id: 'c1', name: 'Test' } as never)
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on insert failure', async () => {
    await expect(
      insertCampaign(mockSupabase({ data: null, error: { message: 'boom' } }), { client_id: 'c1', name: 'Test' } as never),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getCampaignById', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return the campaign row when found', async () => {
    const row = { id: 'camp1' }
    const result = await getCampaignById(mockSupabase({ data: row, error: null }), 'camp1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const result = await getCampaignById(mockSupabase({ data: null, error: null }), 'camp1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      getCampaignById(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listActiveCampaigns', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should return the list of active campaigns', async () => {
    const rows = [{ id: 'camp1', status: 'active' }]
    const result = await listActiveCampaigns(mockSupabase({ data: rows, error: null }))
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(listActiveCampaigns(mockSupabase({ data: null, error: { message: 'boom' } }))).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCampaignsForClient', () => {
  it('should return all campaigns when clientId is null', async () => {
    const rows = [{ id: 'camp1' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listCampaignsForClient(supabase, null)
    expect(result).toEqual(rows)
  })

  it('should filter by client_id when a clientId is given', async () => {
    const rows = [{ id: 'camp1', client_id: 'c1' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as never
    const result = await listCampaignsForClient(supabase, 'c1')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listCampaignsForClient(supabase, null)).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: FAIL — `Cannot find module './campaigns'`

- [ ] **Step 3: Write `campaigns.ts`**

```ts
// src/lib/db/campaigns.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CampaignRow = Database['public']['Tables']['campaigns']['Row']
export type CampaignInsert = Database['public']['Tables']['campaigns']['Insert']

export async function insertCampaign(
  supabase: SupabaseClient<Database>,
  row: CampaignInsert,
): Promise<CampaignRow> {
  const { data, error } = await supabase.from('campaigns').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert campaign', { cause: error?.message })
  }
  return data
}

export async function getCampaignById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<CampaignRow | null> {
  const { data, error } = await supabase.from('campaigns').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load campaign', { id, cause: error.message })
  return data
}

export async function listActiveCampaigns(
  supabase: SupabaseClient<Database>,
): Promise<CampaignRow[]> {
  const { data, error } = await supabase.from('campaigns').select('*').eq('status', 'active')
  if (error) throw new AppError('DB_ERROR', 'Failed to list active campaigns', { cause: error.message })
  return data ?? []
}

export async function listCampaignsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string | null,
): Promise<CampaignRow[]> {
  const base = supabase.from('campaigns').select('*').order('created_at', { ascending: false })
  const { data, error } = clientId ? await base.eq('client_id', clientId) : await base
  if (error) throw new AppError('DB_ERROR', 'Failed to list campaigns', { cause: error.message })
  return data ?? []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat: add campaigns DB access"
```

---

### Task 11: Discovery orchestration

**Files:**
- Create: `src/lib/pipeline/discover.ts`
- Test: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `searchPeople`/`bulkMatchPeople` (Task 5), `buildPeopleSearchParams` (Task 3), `mapApolloEmailStatus` (Task 4), `getKnownSourceIds`/`insertLeads` (Task 6), `groupVerifiedLead` (Task 9), `logEvent`.
- Produces: `interface CampaignForDiscovery { id: string; clientId: string; dailyTarget: number; icp: ApolloIcpFilters }`, `interface DiscoverySummary { campaignId: string; candidatesSeen: number; newCandidates: number; enriched: number; verified: number; inserted: number }`, `runDiscoveryForCampaign(supabase, campaign: CampaignForDiscovery): Promise<DiscoverySummary>` — consumed by Task 12's `/api/pipeline/discover` route.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/pipeline/discover.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSearchPeople = vi.hoisted(() => vi.fn())
const mockBulkMatchPeople = vi.hoisted(() => vi.fn())
const mockGetKnownSourceIds = vi.hoisted(() => vi.fn())
const mockInsertLeads = vi.hoisted(() => vi.fn())
const mockGroupVerifiedLead = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apollo/client', () => ({ searchPeople: mockSearchPeople, bulkMatchPeople: mockBulkMatchPeople }))
vi.mock('@/lib/db/leads', () => ({ getKnownSourceIds: mockGetKnownSourceIds, insertLeads: mockInsertLeads }))
vi.mock('./group-lead', () => ({ groupVerifiedLead: mockGroupVerifiedLead }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent }))

import { runDiscoveryForCampaign } from './discover'
import type { ApolloIcpFilters } from '@/lib/apollo/types'

const icp: ApolloIcpFilters = {
  personTitles: ['vp sales'], organizationLocations: [], employeeRangeMin: null, employeeRangeMax: null, keywords: [],
}

function candidate(apolloId: string) {
  return {
    apolloId, firstName: 'Jo', lastNamePreview: 'D***e', title: 'VP Sales',
    organizationName: 'Acme', organizationDomain: 'acme.com', linkedinUrl: null,
  }
}

function enriched(apolloId: string, emailStatus: string) {
  return {
    apolloId, firstName: 'Jo', lastName: 'Doe', title: 'VP Sales', email: `${apolloId}@acme.com`,
    emailStatus, linkedinUrl: null, organizationName: 'Acme', organizationDomain: 'acme.com',
  }
}

describe('runDiscoveryForCampaign', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
  })

  it('should stop searching once the daily quota of fresh candidates is reached', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 2, candidates: [candidate('p1'), candidate('p2')] })
    mockBulkMatchPeople.mockResolvedValueOnce([enriched('p1', 'verified'), enriched('p2', 'unverified')])
    mockInsertLeads.mockResolvedValueOnce([
      { id: 'l1', client_id: 'client1', campaign_id: 'camp1', company_name: 'Acme', company_domain: 'acme.com', email_status: 'verified' },
      { id: 'l2', client_id: 'client1', campaign_id: 'camp1', company_name: 'Acme', company_domain: 'acme.com', email_status: 'unverified' },
    ])
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary).toEqual({ campaignId: 'camp1', candidatesSeen: 2, newCandidates: 2, enriched: 2, verified: 1, inserted: 2 })
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledWith({}, expect.objectContaining({ id: 'l1' }))
  })

  it('should skip candidates whose apolloId is already known for the campaign', async () => {
    mockGetKnownSourceIds.mockResolvedValue(new Set(['p1']))
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1')] }).mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp })

    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
    expect(summary.newCandidates).toBe(0)
  })

  it('should default the quota to 30 when dailyTarget is 0', async () => {
    // 25 fresh candidates per page (SEARCH_PER_PAGE) is not enough to hit the
    // default quota of 30 in one page, so this only passes if the code really
    // defaults to 30 (and not, say, some other fallback): it must fetch a
    // second page and stop after collecting exactly 5 more from it.
    const page1 = Array.from({ length: 25 }, (_, i) => candidate(`page1-${i}`))
    const page2 = Array.from({ length: 25 }, (_, i) => candidate(`page2-${i}`))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 50, candidates: page1 })
      .mockResolvedValueOnce({ totalEntries: 50, candidates: page2 })
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
    expect(summary.newCandidates).toBe(30)
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

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — `Cannot find module './discover'`

- [ ] **Step 3: Write `discover.ts`**

```ts
// src/lib/pipeline/discover.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { searchPeople, bulkMatchPeople } from '@/lib/apollo/client'
import { buildPeopleSearchParams } from '@/lib/apollo/build-search-params'
import { mapApolloEmailStatus } from '@/lib/apollo/map-email-status'
import type { ApolloIcpFilters } from '@/lib/apollo/types'
import { getKnownSourceIds, insertLeads, type LeadInsert } from '@/lib/db/leads'
import { groupVerifiedLead } from './group-lead'
import { logEvent } from '@/lib/events/log-event'

const MAX_SEARCH_PAGES = 20
const SEARCH_PER_PAGE = 25
const ENRICH_BATCH_SIZE = 10
const DEFAULT_DAILY_QUOTA = 30

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

export async function runDiscoveryForCampaign(
  supabase: SupabaseClient<Database>,
  campaign: CampaignForDiscovery,
): Promise<DiscoverySummary> {
  const quota = campaign.dailyTarget > 0 ? campaign.dailyTarget : DEFAULT_DAILY_QUOTA
  const known = await getKnownSourceIds(supabase, campaign.id)

  const fresh: FreshCandidate[] = []
  let candidatesSeen = 0
  for (let page = 1; page <= MAX_SEARCH_PAGES && fresh.length < quota; page++) {
    const params = buildPeopleSearchParams(campaign.icp, page, SEARCH_PER_PAGE)
    const { candidates } = await searchPeople(params)
    candidatesSeen += candidates.length
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      if (fresh.length >= quota) break
      if (known.has(candidate.apolloId)) continue
      if (fresh.some((f) => f.apolloId === candidate.apolloId)) continue
      fresh.push({
        apolloId: candidate.apolloId,
        firstName: candidate.firstName,
        title: candidate.title,
        organizationName: candidate.organizationName,
        organizationDomain: candidate.organizationDomain,
        linkedinUrl: candidate.linkedinUrl,
      })
    }
  }

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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Tick the roadmap**

In `.claude/roadmap.md` P1 section, tick the checkboxes for "Apollo client", "ICP → Apollo filter mapping", and "Discovery pipeline" now that Tasks 3–11 collectively deliver them.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts .claude/roadmap.md
git commit -m "feat: orchestrate Apollo discovery, enrichment, and grouping per campaign"
```

---

### Task 12: Pipeline routes + daily cron schedule script

**Files:**
- Create: `src/app/api/pipeline/discover/route.ts`
- Create: `src/app/api/pipeline/discover-fanout/route.ts`
- Create: `scripts/schedule-discover-cron.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature` (`@/lib/qstash/verify`), `createAdminClient` (`@/lib/supabase/admin`), `getCampaignById`/`listActiveCampaigns` (Task 10), `apolloIcpSchema` (Task 3), `runDiscoveryForCampaign` (Task 11), `publishJson`/`scheduleCron` (`@/lib/qstash/client`), `logEvent`.
- No new exported interfaces beyond the two route handlers and the script's `main()` — these are the outermost layer.

- [ ] **Step 1: Write `discover/route.ts`**

There is no route-handler test convention in this codebase yet (`src/app/api/cron/hello/route.ts` has none); this task is validated by Task 12 Step 4's manual curl check instead of a Vitest file, matching the existing precedent.

```ts
// src/app/api/pipeline/discover/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById } from '@/lib/db/campaigns'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { runDiscoveryForCampaign } from '@/lib/pipeline/discover'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ campaignId: z.string().uuid() })

export async function POST(request: Request) {
  try {
    const rawBody = await verifyQstashSignature(request)
    const { campaignId } = bodySchema.parse(JSON.parse(rawBody))

    const admin = createAdminClient()
    const campaign = await getCampaignById(admin, campaignId)
    if (!campaign) {
      return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 })
    }
    if (campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    const icp = apolloIcpSchema.parse(campaign.icp)
    const summary = await runDiscoveryForCampaign(admin, {
      id: campaign.id,
      clientId: campaign.client_id,
      dailyTarget: campaign.daily_target,
      icp,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write `discover-fanout/route.ts`**

```ts
// src/app/api/pipeline/discover-fanout/route.ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listActiveCampaigns } from '@/lib/db/campaigns'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const campaigns = await listActiveCampaigns(admin)
    for (const campaign of campaigns) {
      await publishJson('/api/pipeline/discover', { campaignId: campaign.id })
    }
    await logEvent({
      clientId: null,
      actor: 'system',
      type: 'pipeline.discover_fanout.completed',
      payload: { campaignCount: campaigns.length },
    })
    return NextResponse.json({ ok: true, campaignCount: campaigns.length })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 3: Write the one-time schedule script**

```ts
// scripts/schedule-discover-cron.ts
// One-time setup: registers the QStash daily schedule that fans discovery out
// to every active campaign. Run manually once per environment after deploy:
//   Usage: tsx scripts/schedule-discover-cron.ts [cron-expression]
// Default cron: "0 6 * * *" (06:00 UTC daily).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 6 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/discover-fanout', cron)
  process.stdout.write(`Scheduled discover-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 4: Typecheck and manual smoke test**

Run: `pnpm typecheck`
Expected: passes.

Manual verification (mirrors how `/api/cron/hello` was proven in P0 — no live Apollo key needed to prove routing/signature-verification wiring): with `pnpm dev` running and real `QSTASH_*` env vars set, send an unsigned request and confirm it's rejected:

Run: `curl -s -o /dev/null -w '%{http_code}\n' -X POST http://localhost:3000/api/pipeline/discover-fanout`
Expected: `401`

- [ ] **Step 5: Tick the roadmap**

Tick the "Discovery pipeline" checkbox in `.claude/roadmap.md` P1 (if not already ticked in Task 11) to reflect the routes now existing end-to-end.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/discover/route.ts src/app/api/pipeline/discover-fanout/route.ts scripts/schedule-discover-cron.ts
git commit -m "feat: add discover and discover-fanout pipeline routes + cron schedule script"
```

---

### Task 13: Campaigns UI (operator-only setup page)

**Files:**
- Create: `src/app/api/campaigns/route.ts`
- Create: `src/app/campaigns/page.tsx`
- Create: `src/app/campaigns/new-campaign-form.tsx`

**Interfaces:**
- Consumes: `requireUser` (`@/lib/auth/require-user`), `createAdminClient`, `insertCampaign`/`listCampaignsForClient` (Task 10), `apolloIcpSchema` (Task 3), `logEvent`.

- [ ] **Step 1: Write `src/app/api/campaigns/route.ts`**

```ts
// src/app/api/campaigns/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createCampaignSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1),
  valueProp: z.string().min(1),
  bookingLink: z.string().url().nullable().default(null),
  dailyTarget: z.number().int().min(1).max(100).default(30),
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nullable().default(null),
  employeeRangeMax: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
})

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const body = createCampaignSchema.parse(await request.json())
    const icp = apolloIcpSchema.parse({
      personTitles: body.personTitles,
      organizationLocations: body.organizationLocations,
      employeeRangeMin: body.employeeRangeMin,
      employeeRangeMax: body.employeeRangeMax,
      keywords: body.keywords,
    })
    const admin = createAdminClient()
    const campaign = await insertCampaign(admin, {
      client_id: body.clientId,
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      icp,
    })
    await logEvent({
      clientId: body.clientId,
      actor: `human:${appUser.id}`,
      type: 'campaign.created',
      payload: { campaignId: campaign.id, name: campaign.name },
    })
    return NextResponse.json({ ok: true, campaign })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write `src/app/campaigns/new-campaign-form.tsx`**

```tsx
// src/app/campaigns/new-campaign-form.tsx
'use client'

import { useState } from 'react'

interface ClientOption {
  id: string
  name: string
}

type SubmitState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'done' }
  | { status: 'error'; message: string }

function splitCsv(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
}

export function NewCampaignForm({ clients }: { clients: ClientOption[] }) {
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onSubmit(formData: FormData) {
    setState({ status: 'submitting' })
    const employeeMinRaw = formData.get('employeeMin')
    const employeeMaxRaw = formData.get('employeeMax')
    const bookingLinkRaw = formData.get('bookingLink')
    const body = {
      clientId: String(formData.get('clientId') ?? ''),
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 30),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
    }
    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message = typeof json === 'object' && json !== null && 'error' in json
          ? String((json as { error: unknown }).error) : 'failed'
        setState({ status: 'error', message })
        return
      }
      setState({ status: 'done' })
      window.location.reload()
    } catch {
      setState({ status: 'error', message: 'network' })
    }
  }

  return (
    <form action={onSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 8, maxWidth: 480 }}>
      <select name="clientId" required defaultValue="">
        <option value="" disabled>Select client</option>
        {clients.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <input name="name" placeholder="Campaign name" required />
      <textarea name="valueProp" placeholder="Value proposition" required />
      <input name="bookingLink" placeholder="Booking link (optional)" />
      <input name="dailyTarget" type="number" placeholder="Daily Apollo target" defaultValue={30} min={1} max={100} />
      <input name="personTitles" placeholder="Target titles, comma-separated (e.g. vp sales, founder)" />
      <input name="organizationLocations" placeholder="Company locations, comma-separated (e.g. united states)" />
      <input name="employeeMin" type="number" placeholder="Min employees" />
      <input name="employeeMax" type="number" placeholder="Max employees" />
      <input name="keywords" placeholder="Keywords, comma-separated" />
      <button type="submit" disabled={state.status === 'submitting'}>
        {state.status === 'submitting' ? 'Creating…' : 'Create campaign'}
      </button>
      {state.status === 'error' && <span role="alert" style={{ color: 'crimson' }}>Error: {state.message}</span>}
    </form>
  )
}
```

- [ ] **Step 3: Write `src/app/campaigns/page.tsx`**

```tsx
// src/app/campaigns/page.tsx
import { redirect } from 'next/navigation'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { NewCampaignForm } from './new-campaign-form'

export const dynamic = 'force-dynamic'

export default async function CampaignsPage() {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') redirect('/crm')

  const admin = createAdminClient()
  const campaigns = await listCampaignsForClient(admin, null)
  const { data: clients } = await admin.from('clients').select('id, name').order('name')

  return (
    <main style={{ maxWidth: 720, margin: '48px auto', fontFamily: 'system-ui' }}>
      <h1>Campaigns</h1>

      <section>
        <h2>New campaign</h2>
        <NewCampaignForm clients={clients ?? []} />
      </section>

      <section>
        <h2>All campaigns</h2>
        {campaigns.length === 0 && <p>No campaigns yet.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {campaigns.map((c) => (
            <li key={c.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <strong>{c.name}</strong> — {c.status} · daily target: {c.daily_target}
              <div style={{ fontSize: 13, color: '#666' }}>{c.value_prop}</div>
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
```

- [ ] **Step 4: Typecheck**

Run: `pnpm typecheck`
Expected: passes.

- [ ] **Step 5: Manual browser check**

Run: `pnpm dev`, sign in as the seeded operator (`pnpm seed:operator <email> <password>` if not already seeded), visit `http://localhost:3000/campaigns`, create a campaign, and confirm it appears in the list without a page reload failure. Then sign in as a client-role user and confirm visiting `/campaigns` redirects to `/crm`.

- [ ] **Step 6: Tick the roadmap**

Tick the "Campaign setup UI (`/campaigns`)" checkbox in `.claude/roadmap.md` P1.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/campaigns/route.ts src/app/campaigns/page.tsx src/app/campaigns/new-campaign-form.tsx .claude/roadmap.md
git commit -m "feat: add operator-only /campaigns setup page"
```

---

### Task 14: CRM page (read-mostly pipeline board)

**Files:**
- Create: `src/lib/db/crm.ts`
- Test: `src/lib/db/crm.test.ts`
- Create: `src/app/crm/page.tsx`

**Interfaces:**
- Consumes: `createServerClient` (`@/lib/supabase/server`) — RLS-scoped, **not** the admin client, since this is the client-facing read-mostly view (architecture.md §11).
- Produces: `listCasesWithLeads(supabase): Promise<CaseWithLeads[]>`.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/db/crm.test.ts
import { describe, it, expect } from 'vitest'
import { listCasesWithLeads } from './crm'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ order: () => Promise.resolve(result) }) }),
  } as never
}

describe('listCasesWithLeads', () => {
  it('should return cases with their embedded leads', async () => {
    const rows = [{ id: 'case1', status: 'new', leads: [{ id: 'lead1', full_name: 'Jo Doe' }] }]
    const result = await listCasesWithLeads(mockSupabase({ data: rows, error: null }))
    expect(result).toEqual(rows)
  })

  it('should return an empty array when there are no cases', async () => {
    const result = await listCasesWithLeads(mockSupabase({ data: null, error: null }))
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(listCasesWithLeads(mockSupabase({ data: null, error: { message: 'boom' } }))).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/crm.test.ts`
Expected: FAIL — `Cannot find module './crm'`

- [ ] **Step 3: Write `crm.ts`**

```ts
// src/lib/db/crm.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseWithLeads = Database['public']['Tables']['cases']['Row'] & {
  leads: Database['public']['Tables']['leads']['Row'][]
}

// RLS-scoped read: the caller must pass a session-bound client
// (createServerClient), never the admin client, so a client role only ever
// sees their own client_id's rows (architecture.md §11).
export async function listCasesWithLeads(
  supabase: SupabaseClient<Database>,
): Promise<CaseWithLeads[]> {
  const { data, error } = await supabase
    .from('cases')
    .select('*, leads(*)')
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list cases with leads', { cause: error.message })
  }
  return (data ?? []) as CaseWithLeads[]
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/crm.test.ts`
Expected: PASS (3 tests)

- [ ] **Step 5: Write `src/app/crm/page.tsx`**

```tsx
// src/app/crm/page.tsx
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listCasesWithLeads } from '@/lib/db/crm'

export const dynamic = 'force-dynamic'

const STATUS_COLUMNS = [
  'new', 'researching', 'ready', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead',
] as const

export default async function CrmPage() {
  await requireUser()
  const supabase = await createServerClient()
  const cases = await listCasesWithLeads(supabase)

  return (
    <main style={{ maxWidth: 1100, margin: '48px auto', fontFamily: 'system-ui' }}>
      <h1>CRM</h1>
      <div style={{ display: 'flex', gap: 16, overflowX: 'auto' }}>
        {STATUS_COLUMNS.map((status) => {
          const columnCases = cases.filter((c) => c.status === status)
          return (
            <div key={status} style={{ minWidth: 240 }}>
              <h3 style={{ textTransform: 'capitalize' }}>{status.replace(/_/g, ' ')} ({columnCases.length})</h3>
              {columnCases.map((kase) => (
                <div key={kase.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 10, marginBottom: 8 }}>
                  <strong>{kase.company_name}</strong>
                  {kase.company_domain && <div style={{ fontSize: 12, color: '#666' }}>{kase.company_domain}</div>}
                  <ul style={{ paddingLeft: 16, margin: '6px 0 0', fontSize: 13 }}>
                    {kase.leads.map((lead) => (
                      <li key={lead.id}>
                        {lead.full_name} — {lead.title ?? 'n/a'} ({lead.email_status})
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          )
        })}
      </div>
    </main>
  )
}
```

- [ ] **Step 6: Typecheck and manual browser check**

Run: `pnpm typecheck`
Expected: passes.

Run: `pnpm dev`, visit `http://localhost:3000/crm` signed in as either role, and confirm the pipeline board renders (empty columns are fine with no data yet) and that a client-role user sees only their own client's cases (verify by comparing against an operator session, which sees all).

- [ ] **Step 7: Tick the roadmap**

Tick the "`/crm` page" checkbox in `.claude/roadmap.md` P1.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/crm.ts src/lib/db/crm.test.ts src/app/crm/page.tsx .claude/roadmap.md
git commit -m "feat: add read-mostly /crm pipeline board"
```

---

## Post-Plan Follow-Up (not a task — flag to the user)

Once a real `APOLLO_API_KEY` is available, run a single live `bulkMatchPeople`/`searchPeople` call against a disposable test campaign and diff the actual JSON against the `enrichedPersonSchema`/`searchPersonSchema` shapes in `src/lib/apollo/client.ts` (Task 5). Apollo's public docs disagree with themselves on a few field paths (see `architecture.md §12`); this is the one place in the plan where documentation gaps mean the schema might need a small adjustment (e.g. an extra fallback field path) before Task 12's routes are exercised for real.
