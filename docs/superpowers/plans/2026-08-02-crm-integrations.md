# CRM Integrations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Push a qualified case into the client's own CRM (HubSpot or Pipedrive) as a Contact + Company + Deal, then keep that Deal's notes and won/lost outcome in step with the case as it progresses.

**Architecture:** Two new tables (`crm_connections`, `case_crm_links`). Both CRMs sit behind one `CrmProvider` interface mirroring the existing `MailboxProvider` pattern. Syncs never run inline — each case status transition calls `enqueueCrmSync`, which publishes to QStash; a signed worker route does the provider work, claims the case to stay single-flight, and persists external ids incrementally so a retry resumes rather than restarts.

**Tech Stack:** Next.js 16 (App Router), TypeScript strict, Supabase (Postgres + RLS), Zod 4, Upstash QStash, Vitest. Package manager is **pnpm** — `npm install` corrupts this repo's tree.

**Spec:** `docs/superpowers/specs/2026-08-02-crm-integrations-design.md`

## Global Constraints

- Every task ends green: `pnpm test`, `pnpm typecheck`, `pnpm lint`. Never commit red.
- No `any`. No `!` non-null assertion without a comment proving it safe. Explicit return types on every exported function.
- All data access lives in `src/lib/db/`. Never inline a `supabase.from(...)` call in a route, action, component, or pipeline module.
- Every Supabase call destructures `{ data, error }` and maps `error` to `AppError('DB_ERROR', ...)`.
- Every external HTTP call goes through `fetchJson` (`src/lib/http/fetch-json.ts`) with a Zod schema. It supplies the AbortController timeout and validates the response shape.
- DB columns are `snake_case`; TypeScript is `camelCase`. Map explicitly at the boundary.
- Test naming: `it('should [behavior] when [condition]')`. Arrange-Act-Assert.
- No `console.log`. No `TODO`/`FIXME` comments. No commented-out code.
- Encryption key is the existing `MAILBOX_ENCRYPTION_KEY`. Do not add a new one.
- Branch: work on `master`. Do not create feature branches.

---

### Task 1: Migration and generated types

Creates both tables, their enums, indexes, and RLS policies. Nothing else can be typed until `src/types/database.ts` knows about them.

**Files:**
- Create: `supabase/migrations/0022_crm_integrations.sql`
- Modify: `src/types/database.ts` (regenerated)

**Interfaces:**
- Consumes: nothing.
- Produces: `Database['public']['Tables']['crm_connections']`, `Database['public']['Tables']['case_crm_links']`, and enums `crm_provider` (`'hubspot' | 'pipedrive'`), `crm_connection_status` (`'connected' | 'error'`), `crm_sync_status` (`'ok' | 'error'`).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0022_crm_integrations.sql`:

```sql
-- Outbound CRM integrations. We PUSH qualified cases into a client's own CRM
-- (HubSpot / Pipedrive) as Contact + Company + Deal, then keep the Deal's notes
-- and won/lost outcome in step with the case. One-way: we never read the
-- client's CRM as a lead source.
-- See docs/superpowers/specs/2026-08-02-crm-integrations-design.md.

create type crm_provider          as enum ('hubspot', 'pipedrive');
create type crm_connection_status as enum ('connected', 'error');
create type crm_sync_status       as enum ('ok', 'error');

-- New vendor for the Logs tab's source filter. Permitted inside a transaction
-- on PG12+ because nothing in this migration *uses* the new value.
alter type log_source add value if not exists 'crm';

create table crm_connections (
  id             uuid primary key default gen_random_uuid(),
  -- UNIQUE: one CRM per client. Connecting a second one is not supported, and
  -- the constraint is what makes getCrmConnectionForClient a single-row read.
  client_id      uuid not null unique references clients(id) on delete cascade,
  provider       crm_provider not null,
  -- Provider-side portal/company name, shown in Settings so the client can
  -- confirm WHICH account is linked. Nullable: not every provider returns one.
  account_label  text,
  -- Provider-side account identifier needed to build record deep links:
  -- HubSpot portal (hub) id, Pipedrive api_domain. Captured at code exchange so
  -- createDeal can return a URL without a second round trip.
  account_ref    text,
  -- AES-256-GCM envelope, identical shape to mailboxes.oauth. Encrypted because
  -- the SELECT policy below lets a client-role session read its own row via
  -- PostgREST — plaintext here would hand out a live refresh token.
  oauth          jsonb not null default '{}'::jsonb,
  -- Null until the client finishes the pipeline-selection step. A connection
  -- with a null pipeline_id is NOT usable; the sync worker skips it.
  pipeline_id      text,
  pipeline_label   text,
  initial_stage_id text,
  -- HubSpot models closure as pipeline stages, so these carry stage ids there.
  -- Pipedrive models it as a separate deal status field, so they stay null.
  won_stage_id   text,
  lost_stage_id  text,
  status         crm_connection_status not null default 'connected',
  -- e.g. 'token_revoked'. Drives the reconnect banner in /settings/crm.
  status_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table case_crm_links (
  id                   uuid primary key default gen_random_uuid(),
  -- Denormalized so this table fits the flat RLS shape every other table in
  -- 0002_rls_policies.sql uses, exactly as email_attachments.client_id does.
  client_id            uuid not null references clients(id) on delete cascade,
  -- UNIQUE: one external Deal per case. This constraint plus the claim below is
  -- what makes a retried or concurrent sync unable to create a second Deal.
  case_id              uuid not null unique references cases(id) on delete cascade,
  -- CASCADE: an external id is only meaningful relative to one connected
  -- account, so disconnecting must not leave links pointing at ids that do not
  -- exist in whatever CRM is connected next.
  crm_connection_id    uuid not null references crm_connections(id) on delete cascade,
  external_contact_ids text[] not null default '{}',
  external_company_id  text,
  external_deal_id     text,
  external_deal_url    text,
  -- Single-flight claim. Set when a worker starts, cleared when it finishes;
  -- a stale value past the cutoff is reclaimable so a crashed worker cannot
  -- deadlock the case permanently.
  sync_started_at      timestamptz,
  last_synced_at       timestamptz,
  last_sync_status     crm_sync_status,
  last_sync_error      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index case_crm_links_connection_idx on case_crm_links (crm_connection_id);

alter table crm_connections enable row level security;
alter table case_crm_links  enable row level security;

-- Flat per-client isolation, same shape as the loop in 0002_rls_policies.sql.
-- SELECT only: every write goes through createAdminClient() from a route or
-- Server Action that has already checked session, role, and ownership.
create policy crm_connections_select on crm_connections for select
  using (is_operator() or client_id = current_client_id());
create policy crm_connections_write on crm_connections for all
  using (is_operator()) with check (is_operator());

create policy case_crm_links_select on case_crm_links for select
  using (is_operator() or client_id = current_client_id());
create policy case_crm_links_write on case_crm_links for all
  using (is_operator()) with check (is_operator());
```

- [ ] **Step 2: Apply the migration locally**

Run: `pnpm supabase db reset` (or `pnpm supabase migration up` against the local stack).
Expected: applies cleanly through `0022`, no errors.

- [ ] **Step 3: Regenerate database types**

Run: `pnpm supabase gen types typescript --local > src/types/database.ts`

Verify by grepping — `grep -n "crm_connections\|crm_provider" src/types/database.ts` must return hits.

If the local stack is unavailable, hand-write the two `Tables` entries and three `Enums` entries into `src/types/database.ts` matching the SQL above exactly (`Row`, `Insert`, `Update` shapes; nullable columns as `| null`; `external_contact_ids` as `string[]`).

- [ ] **Step 4: Verify the codebase still compiles**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. No existing code references these tables yet, so this is a regression check only.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0022_crm_integrations.sql src/types/database.ts
git commit -m "feat: add crm_connections and case_crm_links schema"
```

---

### Task 2: Token encryption and environment variables

Ports the mailbox AES-256-GCM envelope to CRM credentials. Unlike `mailbox/tokens.ts` there is **no legacy plaintext shape to accept** — these tables are new, so only the encrypted envelope is valid input.

**Files:**
- Create: `src/lib/crm/tokens.ts`
- Create: `src/lib/crm/tokens.test.ts`
- Modify: `src/lib/env.ts`

**Interfaces:**
- Consumes: `env.MAILBOX_ENCRYPTION_KEY`, `AppError`.
- Produces:
  - `interface CrmOAuthCredentials { kind: 'oauth'; accessToken: string; refreshToken: string; expiresAt: string }`
  - `encryptCrmTokens(tokens: CrmOAuthCredentials): Record<string, Json>`
  - `parseCrmTokens(oauth: Json, connectionId: string): CrmOAuthCredentials`

- [ ] **Step 1: Add the four OAuth env vars**

In `src/lib/env.ts`, inside `envSchema.extend({ ... })`, after the `MAILREACH_API_KEY: nonEmpty,` line:

```ts
  HUBSPOT_OAUTH_CLIENT_ID: nonEmpty,
  HUBSPOT_OAUTH_CLIENT_SECRET: nonEmpty,
  PIPEDRIVE_OAUTH_CLIENT_ID: nonEmpty,
  PIPEDRIVE_OAUTH_CLIENT_SECRET: nonEmpty,
```

Add the same four keys to `.env.example` if that file exists, with empty values.

- [ ] **Step 2: Write the failing test**

Create `src/lib/crm/tokens.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { encryptCrmTokens, parseCrmTokens, type CrmOAuthCredentials } from './tokens'
import { AppError } from '@/lib/errors/app-error'

// Long, distinctive values so a substring check against the ciphertext cannot
// coincidentally pass.
const tokens: CrmOAuthCredentials = {
  kind: 'oauth',
  accessToken: 'hubspot-access-token-fixture-qzptv',
  refreshToken: 'hubspot-refresh-token-fixture-mwbkr',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

describe('encryptCrmTokens', () => {
  it('should produce a versioned ciphertext blob rather than the plaintext tokens', () => {
    const encrypted = encryptCrmTokens(tokens)

    expect(encrypted).toMatchObject({ v: 1 })
    expect(JSON.stringify(encrypted)).not.toContain('access-token-fixture')
    expect(JSON.stringify(encrypted)).not.toContain('refresh-token-fixture')
  })

  it('should produce a different ciphertext each call when given identical input', () => {
    const a = encryptCrmTokens(tokens)
    const b = encryptCrmTokens(tokens)

    expect(a.data).not.toEqual(b.data)
    expect(a.iv).not.toEqual(b.iv)
  })
})

describe('parseCrmTokens', () => {
  it('should round-trip the credentials when given its own ciphertext', () => {
    const parsed = parseCrmTokens(encryptCrmTokens(tokens), 'conn-1')

    expect(parsed).toEqual(tokens)
  })

  it('should throw INVARIANT_VIOLATION when the ciphertext was tampered with', () => {
    const encrypted = encryptCrmTokens(tokens)
    const tampered = { ...encrypted, data: Buffer.from('not-the-real-ciphertext').toString('base64') }

    expect(() => parseCrmTokens(tampered, 'conn-1')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION when the auth tag was tampered with', () => {
    const encrypted = encryptCrmTokens(tokens)
    const tampered = { ...encrypted, tag: Buffer.alloc(16).toString('base64') }

    expect(() => parseCrmTokens(tampered, 'conn-1')).toThrow(AppError)
  })

  it('should reject plaintext credentials, which must never be stored', () => {
    expect(() => parseCrmTokens(tokens as never, 'conn-1')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION when the column is the empty default', () => {
    expect(() => parseCrmTokens({}, 'conn-1')).toThrow(AppError)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/crm/tokens.test.ts`
Expected: FAIL — cannot resolve `./tokens`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/crm/tokens.ts`:

```ts
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'

export interface CrmOAuthCredentials {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
}

const credentialsSchema = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

const ALGORITHM = 'aes-256-gcm'
const IV_BYTES = 12

const encryptedTokensSchema = z.object({
  v: z.literal(1),
  iv: z.string(),
  tag: z.string(),
  data: z.string(),
})

function encryptionKey(): Buffer {
  return Buffer.from(env.MAILBOX_ENCRYPTION_KEY, 'hex')
}

/**
 * Encrypts CRM OAuth tokens for storage in `crm_connections.oauth`. RLS grants
 * a client-role session SELECT on its own connection row, so plaintext here
 * would hand a live refresh token to anyone who can query PostgREST directly.
 * Reuses MAILBOX_ENCRYPTION_KEY — one key, one rotation story.
 */
export function encryptCrmTokens(tokens: CrmOAuthCredentials): Record<string, Json> {
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv)
  const plaintext = Buffer.from(JSON.stringify(tokens), 'utf-8')
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  return {
    v: 1,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: ciphertext.toString('base64'),
  }
}

/**
 * Validates the stored jsonb into typed credentials. Accepts ONLY the encrypted
 * envelope — unlike mailbox tokens there is no legacy plaintext shape, because
 * these tables were created after encryption existed. Throws on anything else:
 * a connection with unusable credentials is a programming/config error.
 */
export function parseCrmTokens(oauth: Json, connectionId: string): CrmOAuthCredentials {
  const encrypted = encryptedTokensSchema.safeParse(oauth)
  if (!encrypted.success) {
    throw new AppError('INVARIANT_VIOLATION', 'CRM connection oauth is not an encrypted envelope', {
      connectionId,
    })
  }
  // `encrypted.data` is the Zod-parsed envelope; its own ciphertext field is
  // also called `data`, hence `encrypted.data.data` below.
  const envelope = encrypted.data
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(envelope.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.data, 'base64')),
      decipher.final(),
    ])
    const parsed = credentialsSchema.safeParse(JSON.parse(plaintext.toString('utf-8')))
    if (!parsed.success) throw new Error('decrypted payload failed schema validation')
    return parsed.data
  } catch (cause) {
    throw new AppError('INVARIANT_VIOLATION', 'Failed to decrypt CRM connection oauth tokens', {
      connectionId,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/crm/tokens.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 6: Verify the whole suite is still green**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all pass. If `pnpm test` now fails on missing env vars, add the four new keys to the test env setup the same way existing secrets are provided there.

- [ ] **Step 7: Commit**

```bash
git add src/lib/crm/tokens.ts src/lib/crm/tokens.test.ts src/lib/env.ts
git commit -m "feat: add encrypted CRM credential storage and OAuth env vars"
```

---

### Task 3: Provider interface and field mapping

The interface every CRM implements, plus the pure functions that turn a case and its leads into provider-shaped input. No I/O in this task — `mapping.ts` is 100%-testable pure code.

**Files:**
- Create: `src/lib/crm/provider.ts`
- Create: `src/lib/crm/mapping.ts`
- Create: `src/lib/crm/mapping.test.ts`

**Interfaces:**
- Consumes: `CrmOAuthCredentials` from Task 2; `CaseRow` from `@/lib/db/cases`; `LeadRow` from `@/lib/db/leads`.
- Produces: `CrmProvider`, `CrmPipeline`, `CrmPipelineStage`, `CrmContactInput`, `CrmCompanyInput`, `CrmDealInput`, `CrmDealTarget`, and from `mapping.ts`: `splitFullName`, `toCompanyInput`, `toContactInput`, `toDealTitle`, `toCreationNote`, `isSyncableLead`.

- [ ] **Step 1: Write `provider.ts`**

Create `src/lib/crm/provider.ts`:

```ts
import type { Database } from '@/types/database'
import type { CrmOAuthCredentials } from './tokens'

/** Derived from the DB enum so the schema and the code cannot drift apart. */
export type CrmProviderName = Database['public']['Enums']['crm_provider']

export interface CrmPipelineStage {
  id: string
  label: string
  /** Providers that model closure as a stage flag it here; null when unknown. */
  closedOutcome: 'won' | 'lost' | null
}

export interface CrmPipeline {
  id: string
  label: string
  stages: CrmPipelineStage[]
}

export interface CrmContactInput {
  email: string
  firstName: string | null
  lastName: string | null
  title: string | null
  linkedinUrl: string | null
  companyName: string | null
}

export interface CrmCompanyInput {
  name: string
  domain: string | null
}

export interface CrmDealInput {
  title: string
  pipelineId: string
  stageId: string
  companyExternalId: string | null
  contactExternalIds: readonly string[]
  /** crm_connections.account_ref — HubSpot hub id / Pipedrive api_domain. */
  accountRef: string | null
}

/**
 * Where a Deal should end up. A discriminated union rather than a boolean: the
 * two providers model closure differently (HubSpot moves to a closed stage,
 * Pipedrive sets a separate status field) and callers must not have to know.
 */
export type CrmDealTarget =
  | { kind: 'stage'; stageId: string }
  | { kind: 'closed'; outcome: 'won' | 'lost' }

export interface CrmExchangeResult {
  tokens: CrmOAuthCredentials
  /** Human-readable account name for Settings. Null when the provider has none. */
  accountLabel: string | null
  /** Stored as crm_connections.account_ref; feeds CrmDealInput.accountRef. */
  accountRef: string | null
}

/**
 * Every method returns possibly-refreshed credentials alongside its result,
 * the same contract as MailboxProvider.sendEmail. The caller persists them
 * when accessToken changed, so a refresh is never silently dropped.
 */
export interface CrmProvider {
  readonly provider: CrmProviderName

  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<CrmExchangeResult>

  listPipelines(
    credentials: CrmOAuthCredentials,
  ): Promise<{ pipelines: CrmPipeline[]; tokens: CrmOAuthCredentials }>

  upsertCompany(
    credentials: CrmOAuthCredentials,
    input: CrmCompanyInput,
  ): Promise<{ externalId: string; tokens: CrmOAuthCredentials }>

  upsertContact(
    credentials: CrmOAuthCredentials,
    input: CrmContactInput,
  ): Promise<{ externalId: string; tokens: CrmOAuthCredentials }>

  createDeal(
    credentials: CrmOAuthCredentials,
    input: CrmDealInput,
  ): Promise<{ externalId: string; url: string; tokens: CrmOAuthCredentials }>

  moveDeal(
    credentials: CrmOAuthCredentials,
    dealId: string,
    target: CrmDealTarget,
  ): Promise<{ tokens: CrmOAuthCredentials }>

  addDealNote(
    credentials: CrmOAuthCredentials,
    dealId: string,
    note: string,
  ): Promise<{ tokens: CrmOAuthCredentials }>
}
```

- [ ] **Step 2: Write the failing mapping test**

Create `src/lib/crm/mapping.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  splitFullName,
  toCompanyInput,
  toContactInput,
  toDealTitle,
  toCreationNote,
  isSyncableLead,
  type SyncableLead,
} from './mapping'

function lead(overrides: Partial<SyncableLead> = {}): SyncableLead {
  return {
    email: 'ada@example.com',
    full_name: 'Ada Lovelace',
    title: 'CTO',
    linkedin_url: 'https://linkedin.com/in/ada',
    company_name: 'Analytical Engines',
    email_status: 'verified',
    status: 'active',
    ...overrides,
  }
}

describe('splitFullName', () => {
  it('should split first and last when given two names', () => {
    expect(splitFullName('Ada Lovelace')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
  })

  it('should keep everything after the first space as the last name', () => {
    expect(splitFullName('Ada King Lovelace')).toEqual({ firstName: 'Ada', lastName: 'King Lovelace' })
  })

  it('should return a null last name when given a single word', () => {
    expect(splitFullName('Ada')).toEqual({ firstName: 'Ada', lastName: null })
  })

  it('should return nulls when given an empty or whitespace-only name', () => {
    expect(splitFullName('   ')).toEqual({ firstName: null, lastName: null })
  })

  it('should ignore repeated and surrounding whitespace', () => {
    expect(splitFullName('  Ada   Lovelace  ')).toEqual({ firstName: 'Ada', lastName: 'Lovelace' })
  })
})

describe('toCompanyInput', () => {
  it('should carry the case company name and domain through', () => {
    expect(toCompanyInput({ company_name: 'Acme', company_domain: 'acme.com' })).toEqual({
      name: 'Acme',
      domain: 'acme.com',
    })
  })

  it('should preserve a null domain rather than inventing one', () => {
    expect(toCompanyInput({ company_name: 'Acme', company_domain: null })).toEqual({
      name: 'Acme',
      domain: null,
    })
  })
})

describe('toContactInput', () => {
  it('should map a fully populated lead', () => {
    expect(toContactInput(lead())).toEqual({
      email: 'ada@example.com',
      firstName: 'Ada',
      lastName: 'Lovelace',
      title: 'CTO',
      linkedinUrl: 'https://linkedin.com/in/ada',
      companyName: 'Analytical Engines',
    })
  })

  it('should preserve nulls for the optional fields', () => {
    expect(toContactInput(lead({ title: null, linkedin_url: null, company_name: null }))).toMatchObject({
      title: null,
      linkedinUrl: null,
      companyName: null,
    })
  })
})

describe('toDealTitle', () => {
  it('should combine the company name and the campaign name', () => {
    expect(toDealTitle('Acme', 'Q3 Outbound')).toBe('Acme — Q3 Outbound')
  })

  it('should fall back to the company name alone when there is no campaign name', () => {
    expect(toDealTitle('Acme', null)).toBe('Acme')
  })
})

describe('toCreationNote', () => {
  it('should include the dossier summary, the case link, and each contact line', () => {
    const note = toCreationNote({
      summary: 'Scaling their support team.',
      caseUrl: 'https://app.example.com/cases/abc',
      companyDomain: 'acme.com',
      leads: [lead()],
    })

    expect(note).toContain('Scaling their support team.')
    expect(note).toContain('https://app.example.com/cases/abc')
    expect(note).toContain('acme.com')
    expect(note).toContain('Ada Lovelace')
    expect(note).toContain('CTO')
    expect(note).toContain('https://linkedin.com/in/ada')
  })

  it('should omit the summary line when the case has no dossier summary', () => {
    const note = toCreationNote({
      summary: null,
      caseUrl: 'https://app.example.com/cases/abc',
      companyDomain: null,
      leads: [lead({ title: null, linkedin_url: null })],
    })

    expect(note).toContain('https://app.example.com/cases/abc')
    expect(note).toContain('Ada Lovelace')
    expect(note).not.toContain('Summary:')
  })
})

describe('isSyncableLead', () => {
  it('should accept an active, verified lead with an email', () => {
    expect(isSyncableLead(lead())).toBe(true)
  })

  it('should reject a lead whose email is not verified', () => {
    expect(isSyncableLead(lead({ email_status: 'risky' }))).toBe(false)
  })

  it('should reject a lead that is no longer active', () => {
    expect(isSyncableLead(lead({ status: 'stopped' }))).toBe(false)
  })

  it('should reject a lead with no email address', () => {
    expect(isSyncableLead(lead({ email: null }))).toBe(false)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/crm/mapping.test.ts`
Expected: FAIL — cannot resolve `./mapping`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/crm/mapping.ts`. Check `src/types/database.ts` for the exact `lead_email_status` and `lead_status` enum members before writing, and match them:

```ts
import type { Database } from '@/types/database'
import type { CrmCompanyInput, CrmContactInput } from './provider'

type LeadEmailStatus = Database['public']['Enums']['lead_email_status']
type LeadStatus = Database['public']['Enums']['lead_status']

/** The lead fields the CRM mapping reads. Narrower than LeadRow on purpose. */
export interface SyncableLead {
  email: string | null
  full_name: string
  title: string | null
  linkedin_url: string | null
  company_name: string | null
  email_status: LeadEmailStatus
  status: LeadStatus
}

/** The case fields the company mapping reads. */
export interface MappableCase {
  company_name: string
  company_domain: string | null
}

export interface SplitName {
  firstName: string | null
  lastName: string | null
}

/**
 * First token is the given name, everything after it is the family name. Naive
 * on purpose: the alternative is guessing at particles and multi-part surnames,
 * and a wrong guess is worse in a client's CRM than an unsplit surname.
 */
export function splitFullName(fullName: string): SplitName {
  const parts = fullName.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length === 0) return { firstName: null, lastName: null }
  // length check above guarantees index 0 exists
  const [firstName, ...rest] = parts as [string, ...string[]]
  return { firstName, lastName: rest.length > 0 ? rest.join(' ') : null }
}

export function toCompanyInput(kase: MappableCase): CrmCompanyInput {
  return { name: kase.company_name, domain: kase.company_domain }
}

/**
 * Callers must have filtered with isSyncableLead first, which is what proves
 * `email` is non-null here.
 */
export function toContactInput(lead: SyncableLead): CrmContactInput {
  const { firstName, lastName } = splitFullName(lead.full_name)
  return {
    email: lead.email ?? '',
    firstName,
    lastName,
    title: lead.title,
    linkedinUrl: lead.linkedin_url,
    companyName: lead.company_name,
  }
}

export function toDealTitle(companyName: string, campaignName: string | null): string {
  return campaignName ? `${companyName} — ${campaignName}` : companyName
}

export interface CreationNoteInput {
  summary: string | null
  caseUrl: string
  companyDomain: string | null
  leads: readonly SyncableLead[]
}

/**
 * The note carries every field the providers cannot store natively. Pipedrive
 * has no standard field for job title, LinkedIn URL, or organization domain,
 * and its custom fields must be created by the account owner first — we do not
 * mutate a client's CRM schema, so those values live here instead.
 */
export function toCreationNote({ summary, caseUrl, companyDomain, leads }: CreationNoteInput): string {
  const lines: string[] = ['Sourced and qualified by the outreach agent.']
  if (summary) lines.push('', `Summary: ${summary}`)
  if (companyDomain) lines.push('', `Domain: ${companyDomain}`)
  if (leads.length > 0) {
    lines.push('', 'Contacts:')
    for (const lead of leads) {
      const detail = [lead.title, lead.linkedin_url].filter((part) => part !== null)
      const suffix = detail.length > 0 ? ` — ${detail.join(' — ')}` : ''
      lines.push(`- ${lead.full_name} <${lead.email ?? 'no email'}>${suffix}`)
    }
  }
  lines.push('', `Full case: ${caseUrl}`)
  return lines.join('\n')
}

/**
 * Only active, email-verified leads reach a client's CRM. An unverified or
 * stopped lead is not something their sales team should be calling.
 */
export function isSyncableLead(lead: SyncableLead): boolean {
  return lead.status === 'active' && lead.email_status === 'verified' && lead.email !== null
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/crm/mapping.test.ts`
Expected: PASS, 18 tests.

If `lead.status === 'active'` fails to typecheck, the `lead_status` enum uses different member names — read them from `src/types/database.ts` and update both the implementation and the test fixture.

- [ ] **Step 6: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/lib/crm/provider.ts src/lib/crm/mapping.ts src/lib/crm/mapping.test.ts
git commit -m "feat: add CRM provider interface and case-to-CRM field mapping"
```

---

### Task 4: `crm_connections` data access

One function per DB operation, per `QUALITY.md`. Every write here is called only from a route or Server Action that has already checked session, role, and ownership.

**Files:**
- Create: `src/lib/db/crm-connections.ts`
- Create: `src/lib/db/crm-connections.test.ts`

**Interfaces:**
- Consumes: `Database` types from Task 1; `CrmProviderName` from `@/lib/crm/provider` (Task 3); `AppError`.
- Produces:
  - `type CrmConnectionRow = Database['public']['Tables']['crm_connections']['Row']`
  - `getCrmConnectionForClient(supabase, clientId): Promise<CrmConnectionRow | null>`
  - `getCrmConnectionById(supabase, id): Promise<CrmConnectionRow | null>`
  - `upsertCrmConnection(supabase, input: UpsertCrmConnectionInput): Promise<CrmConnectionRow>`
  - `updateCrmConnectionPipeline(supabase, id, input: CrmPipelineSelection): Promise<void>`
  - `updateCrmConnectionTokens(supabase, id, oauth: Record<string, Json>): Promise<void>`
  - `markCrmConnectionError(supabase, id, reason: string): Promise<void>`
  - `deleteCrmConnection(supabase, id): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/crm-connections.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  getCrmConnectionForClient,
  upsertCrmConnection,
  updateCrmConnectionPipeline,
  updateCrmConnectionTokens,
  markCrmConnectionError,
  deleteCrmConnection,
} from './crm-connections'
import { AppError } from '@/lib/errors/app-error'

function mockMaybeSingle(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}

function mockUpsert(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ upsert: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }),
  } as never
}

function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}

function mockDelete(result: { error: unknown }) {
  return { from: () => ({ delete: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}

describe('getCrmConnectionForClient', () => {
  it('should return the connection when the client has one', async () => {
    const row = { id: 'conn-1', client_id: 'c1', provider: 'hubspot' }

    const found = await getCrmConnectionForClient(mockMaybeSingle({ data: row, error: null }), 'c1')

    expect(found).toEqual(row)
  })

  it('should return null when the client has not connected a CRM', async () => {
    const found = await getCrmConnectionForClient(mockMaybeSingle({ data: null, error: null }), 'c1')

    expect(found).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getCrmConnectionForClient(mockMaybeSingle({ data: null, error: { message: 'boom' } }), 'c1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('upsertCrmConnection', () => {
  const input = {
    clientId: 'c1',
    provider: 'hubspot' as const,
    accountLabel: 'Acme Portal',
    accountRef: '12345678',
    oauth: { v: 1, iv: 'i', tag: 't', data: 'd' },
  }

  it('should return the stored row when the upsert succeeds', async () => {
    const row = { id: 'conn-1', client_id: 'c1' }

    const saved = await upsertCrmConnection(mockUpsert({ data: row, error: null }), input)

    expect(saved).toEqual(row)
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    await expect(
      upsertCrmConnection(mockUpsert({ data: null, error: { message: 'boom' } }), input),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the upsert returns no row', async () => {
    await expect(
      upsertCrmConnection(mockUpsert({ data: null, error: null }), input),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCrmConnectionPipeline', () => {
  const selection = {
    pipelineId: 'p1',
    pipelineLabel: 'Sales',
    initialStageId: 's1',
    wonStageId: 's9',
    lostStageId: 's10',
  }

  it('should resolve when the update succeeds', async () => {
    await expect(
      updateCrmConnectionPipeline(mockUpdate({ error: null }), 'conn-1', selection),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateCrmConnectionPipeline(mockUpdate({ error: { message: 'boom' } }), 'conn-1', selection),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCrmConnectionTokens', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      updateCrmConnectionTokens(mockUpdate({ error: null }), 'conn-1', { v: 1 }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateCrmConnectionTokens(mockUpdate({ error: { message: 'boom' } }), 'conn-1', { v: 1 }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markCrmConnectionError', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      markCrmConnectionError(mockUpdate({ error: null }), 'conn-1', 'token_revoked'),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      markCrmConnectionError(mockUpdate({ error: { message: 'boom' } }), 'conn-1', 'token_revoked'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteCrmConnection', () => {
  it('should resolve when the delete succeeds', async () => {
    await expect(deleteCrmConnection(mockDelete({ error: null }), 'conn-1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    await expect(
      deleteCrmConnection(mockDelete({ error: { message: 'boom' } }), 'conn-1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/db/crm-connections.test.ts`
Expected: FAIL — cannot resolve `./crm-connections`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/crm-connections.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { CrmProviderName } from '@/lib/crm/provider'

export type CrmConnectionRow = Database['public']['Tables']['crm_connections']['Row']

export interface UpsertCrmConnectionInput {
  clientId: string
  // Imported from the provider module rather than re-derived here, so there is
  // exactly one CrmProviderName in the codebase.
  provider: CrmProviderName
  accountLabel: string | null
  accountRef: string | null
  oauth: Record<string, Json>
}

export interface CrmPipelineSelection {
  pipelineId: string
  pipelineLabel: string
  initialStageId: string
  wonStageId: string | null
  lostStageId: string | null
}

export async function getCrmConnectionForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<CrmConnectionRow | null> {
  const { data, error } = await supabase
    .from('crm_connections')
    .select('*')
    .eq('client_id', clientId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load CRM connection for client', {
      clientId, cause: error.message,
    })
  }
  return data
}

export async function getCrmConnectionById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<CrmConnectionRow | null> {
  const { data, error } = await supabase
    .from('crm_connections')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load CRM connection', { id, cause: error.message })
  }
  return data
}

/**
 * Upsert on the client_id unique constraint: reconnecting (same or different
 * provider) replaces the stored grant in place rather than failing. Pipeline
 * selection is deliberately reset to null so a provider switch cannot leave a
 * stage id from the previous CRM behind — the client re-picks after connecting.
 */
export async function upsertCrmConnection(
  supabase: SupabaseClient<Database>,
  input: UpsertCrmConnectionInput,
): Promise<CrmConnectionRow> {
  const { data, error } = await supabase
    .from('crm_connections')
    .upsert(
      {
        client_id: input.clientId,
        provider: input.provider,
        account_label: input.accountLabel,
        account_ref: input.accountRef,
        oauth: input.oauth,
        pipeline_id: null,
        pipeline_label: null,
        initial_stage_id: null,
        won_stage_id: null,
        lost_stage_id: null,
        status: 'connected',
        status_reason: null,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'client_id' },
    )
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to upsert CRM connection', {
      clientId: input.clientId, provider: input.provider, cause: error?.message,
    })
  }
  return data
}

export async function updateCrmConnectionPipeline(
  supabase: SupabaseClient<Database>,
  id: string,
  selection: CrmPipelineSelection,
): Promise<void> {
  const { error } = await supabase
    .from('crm_connections')
    .update({
      pipeline_id: selection.pipelineId,
      pipeline_label: selection.pipelineLabel,
      initial_stage_id: selection.initialStageId,
      won_stage_id: selection.wonStageId,
      lost_stage_id: selection.lostStageId,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update CRM connection pipeline', { id, cause: error.message })
  }
}

export async function updateCrmConnectionTokens(
  supabase: SupabaseClient<Database>,
  id: string,
  oauth: Record<string, Json>,
): Promise<void> {
  const { error } = await supabase
    .from('crm_connections')
    .update({ oauth, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update CRM connection tokens', { id, cause: error.message })
  }
}

/**
 * Parks the connection. enqueueCrmSync short-circuits on status 'error', so
 * this both stops the retry loop and lights the reconnect banner in Settings.
 */
export async function markCrmConnectionError(
  supabase: SupabaseClient<Database>,
  id: string,
  reason: string,
): Promise<void> {
  const { error } = await supabase
    .from('crm_connections')
    .update({ status: 'error', status_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark CRM connection errored', { id, cause: error.message })
  }
}

/** Cascades to case_crm_links — see the FK comment in migration 0022. */
export async function deleteCrmConnection(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('crm_connections').delete().eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete CRM connection', { id, cause: error.message })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/db/crm-connections.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/lib/db/crm-connections.ts src/lib/db/crm-connections.test.ts
git commit -m "feat: add crm_connections data access layer"
```

---

### Task 5: `case_crm_links` data access and the single-flight claim

`claimCrmSync` is the concurrency guard for the whole feature: an atomic conditional update, the same shape as `claimCollisionNotice` in `src/lib/db/cases.ts`.

**Files:**
- Create: `src/lib/db/case-crm-links.ts`
- Create: `src/lib/db/case-crm-links.test.ts`

**Interfaces:**
- Consumes: `Database` types from Task 1; `AppError`.
- Produces:
  - `type CaseCrmLinkRow = Database['public']['Tables']['case_crm_links']['Row']`
  - `getCaseCrmLink(supabase, caseId): Promise<CaseCrmLinkRow | null>`
  - `ensureCaseCrmLink(supabase, input: EnsureCaseCrmLinkInput): Promise<CaseCrmLinkRow>`
  - `claimCrmSync(supabase, caseId, now: Date): Promise<boolean>`
  - `updateCaseCrmLinkIds(supabase, caseId, ids: CaseCrmLinkIds): Promise<void>`
  - `markCrmSyncResult(supabase, caseId, result: CrmSyncResult): Promise<void>`
  - `const CRM_SYNC_CLAIM_STALE_MS = 300_000`

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/case-crm-links.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  getCaseCrmLink,
  ensureCaseCrmLink,
  claimCrmSync,
  updateCaseCrmLinkIds,
  markCrmSyncResult,
} from './case-crm-links'
import { AppError } from '@/lib/errors/app-error'

function mockMaybeSingle(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}

function mockUpsert(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ upsert: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }),
  } as never
}

function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}

/**
 * claimCrmSync chains .update().eq().or().select(). `capture` records the `or`
 * filter string so the test can assert the staleness predicate is present.
 */
function mockClaim(result: { data: unknown; error: unknown }, capture?: (filter: string) => void) {
  return {
    from: () => ({
      update: () => ({
        eq: () => ({
          or: (filter: string) => {
            capture?.(filter)
            return { select: () => Promise.resolve(result) }
          },
        }),
      }),
    }),
  } as never
}

describe('getCaseCrmLink', () => {
  it('should return the link when the case has been synced before', async () => {
    const row = { id: 'link-1', case_id: 'case-1', external_deal_id: 'deal-9' }

    expect(await getCaseCrmLink(mockMaybeSingle({ data: row, error: null }), 'case-1')).toEqual(row)
  })

  it('should return null when the case has never been synced', async () => {
    expect(await getCaseCrmLink(mockMaybeSingle({ data: null, error: null }), 'case-1')).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getCaseCrmLink(mockMaybeSingle({ data: null, error: { message: 'boom' } }), 'case-1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('ensureCaseCrmLink', () => {
  const input = { clientId: 'c1', caseId: 'case-1', crmConnectionId: 'conn-1' }

  it('should return the row when the upsert succeeds', async () => {
    const row = { id: 'link-1', case_id: 'case-1' }

    expect(await ensureCaseCrmLink(mockUpsert({ data: row, error: null }), input)).toEqual(row)
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    await expect(
      ensureCaseCrmLink(mockUpsert({ data: null, error: { message: 'boom' } }), input),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the upsert returns no row', async () => {
    await expect(
      ensureCaseCrmLink(mockUpsert({ data: null, error: null }), input),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimCrmSync', () => {
  const now = new Date('2026-08-02T12:00:00.000Z')

  it('should return true when the claim updated a row', async () => {
    expect(await claimCrmSync(mockClaim({ data: [{ id: 'link-1' }], error: null }), 'case-1', now)).toBe(true)
  })

  it('should return false when another worker already holds a fresh claim', async () => {
    expect(await claimCrmSync(mockClaim({ data: [], error: null }), 'case-1', now)).toBe(false)
  })

  it('should allow reclaiming a claim older than the staleness cutoff', async () => {
    const capture = vi.fn()

    await claimCrmSync(mockClaim({ data: [{ id: 'link-1' }], error: null }, capture), 'case-1', now)

    // 5 minutes before `now`, so a crashed worker cannot deadlock the case.
    expect(capture).toHaveBeenCalledWith(
      'sync_started_at.is.null,sync_started_at.lt.2026-08-02T11:55:00.000Z',
    )
  })

  it('should throw DB_ERROR when the claim query fails', async () => {
    await expect(
      claimCrmSync(mockClaim({ data: null, error: { message: 'boom' } }), 'case-1', now),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCaseCrmLinkIds', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(
      updateCaseCrmLinkIds(mockUpdate({ error: null }), 'case-1', { externalCompanyId: 'co-1' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateCaseCrmLinkIds(mockUpdate({ error: { message: 'boom' } }), 'case-1', { externalCompanyId: 'co-1' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markCrmSyncResult', () => {
  it('should resolve when recording a successful sync', async () => {
    await expect(
      markCrmSyncResult(mockUpdate({ error: null }), 'case-1', { status: 'ok' }),
    ).resolves.toBeUndefined()
  })

  it('should resolve when recording a failed sync with its message', async () => {
    await expect(
      markCrmSyncResult(mockUpdate({ error: null }), 'case-1', { status: 'error', message: 'bad field' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      markCrmSyncResult(mockUpdate({ error: { message: 'boom' } }), 'case-1', { status: 'ok' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/db/case-crm-links.test.ts`
Expected: FAIL — cannot resolve `./case-crm-links`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/case-crm-links.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseCrmLinkRow = Database['public']['Tables']['case_crm_links']['Row']

/**
 * How long a sync claim stays valid. A worker that crashes mid-sync leaves
 * sync_started_at set; past this cutoff another worker may reclaim it, so a
 * crash cannot strand a case permanently. Longer than any realistic sync
 * (a handful of sequential HTTP calls), short enough to self-heal quickly.
 */
export const CRM_SYNC_CLAIM_STALE_MS = 300_000

export interface EnsureCaseCrmLinkInput {
  clientId: string
  caseId: string
  crmConnectionId: string
}

export interface CaseCrmLinkIds {
  externalCompanyId?: string
  externalContactIds?: string[]
  externalDealId?: string
  externalDealUrl?: string
}

export type CrmSyncResult =
  | { status: 'ok' }
  | { status: 'error'; message: string }

/** Truncated so a verbose provider error cannot bloat the row or the UI. */
const MAX_SYNC_ERROR_CHARS = 500

export async function getCaseCrmLink(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CaseCrmLinkRow | null> {
  const { data, error } = await supabase
    .from('case_crm_links')
    .select('*')
    .eq('case_id', caseId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load case CRM link', { caseId, cause: error.message })
  }
  return data
}

/**
 * Race-safe find-or-create on the case_id unique index, the same shape as
 * findOrCreateCase. ignoreDuplicates is deliberately NOT set: the merge-on-
 * conflict returns the existing row, which is what a second sync for an
 * already-linked case needs.
 */
export async function ensureCaseCrmLink(
  supabase: SupabaseClient<Database>,
  input: EnsureCaseCrmLinkInput,
): Promise<CaseCrmLinkRow> {
  const { data, error } = await supabase
    .from('case_crm_links')
    .upsert(
      {
        client_id: input.clientId,
        case_id: input.caseId,
        crm_connection_id: input.crmConnectionId,
        updated_at: new Date().toISOString(),
      },
      { onConflict: 'case_id' },
    )
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to ensure case CRM link', {
      caseId: input.caseId, cause: error?.message,
    })
  }
  return data
}

/**
 * Atomic single-flight claim: only the caller that actually updates a row gets
 * true and may talk to the CRM. A loser must not proceed — two concurrent
 * status transitions on one case would otherwise create two Deals.
 */
export async function claimCrmSync(
  supabase: SupabaseClient<Database>,
  caseId: string,
  now: Date,
): Promise<boolean> {
  const staleBefore = new Date(now.getTime() - CRM_SYNC_CLAIM_STALE_MS).toISOString()
  const { data, error } = await supabase
    .from('case_crm_links')
    .update({ sync_started_at: now.toISOString() })
    .eq('case_id', caseId)
    .or(`sync_started_at.is.null,sync_started_at.lt.${staleBefore}`)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim CRM sync', { caseId, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}

/**
 * Persists external ids as soon as each is obtained, so a retry after a partial
 * failure resumes instead of restarting — which is what stops an orphaned
 * Company or Contact from being created twice.
 */
export async function updateCaseCrmLinkIds(
  supabase: SupabaseClient<Database>,
  caseId: string,
  ids: CaseCrmLinkIds,
): Promise<void> {
  const patch: Record<string, string | string[]> = { updated_at: new Date().toISOString() }
  if (ids.externalCompanyId !== undefined) patch.external_company_id = ids.externalCompanyId
  if (ids.externalContactIds !== undefined) patch.external_contact_ids = ids.externalContactIds
  if (ids.externalDealId !== undefined) patch.external_deal_id = ids.externalDealId
  if (ids.externalDealUrl !== undefined) patch.external_deal_url = ids.externalDealUrl

  const { error } = await supabase.from('case_crm_links').update(patch).eq('case_id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case CRM link ids', { caseId, cause: error.message })
  }
}

/** Records the outcome and releases the claim in one write. */
export async function markCrmSyncResult(
  supabase: SupabaseClient<Database>,
  caseId: string,
  result: CrmSyncResult,
): Promise<void> {
  const { error } = await supabase
    .from('case_crm_links')
    .update({
      sync_started_at: null,
      last_synced_at: new Date().toISOString(),
      last_sync_status: result.status,
      last_sync_error: result.status === 'error' ? result.message.slice(0, MAX_SYNC_ERROR_CHARS) : null,
      updated_at: new Date().toISOString(),
    })
    .eq('case_id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to record CRM sync result', { caseId, cause: error.message })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/db/case-crm-links.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/lib/db/case-crm-links.ts src/lib/db/case-crm-links.test.ts
git commit -m "feat: add case_crm_links data access with single-flight sync claim"
```

---

### Task 6: HubSpot provider

Implements `CrmProvider` against the HubSpot CRM v3 API. Uses **search-then-create-or-patch** rather than HubSpot's batch-upsert endpoint: upsert-by-`idProperty` depends on a property being configured unique in the customer's portal, which we cannot guarantee, while search works on every portal.

**Files:**
- Create: `src/lib/crm/hubspot-provider.ts`
- Create: `src/lib/crm/hubspot-provider.test.ts`

**Interfaces:**
- Consumes: `CrmProvider` and its input types (Task 3); `CrmOAuthCredentials` (Task 2); `fetchJson`; `env.HUBSPOT_OAUTH_CLIENT_ID` / `env.HUBSPOT_OAUTH_CLIENT_SECRET`.
- Produces: `export const hubspotProvider: CrmProvider`.

**Reference:** HubSpot association type ids used below are HubSpot-defined constants — deal→contact `3`, deal→company `341`, note→deal `214`. Deal-stage closure is read from `stage.metadata.probability`: `"1.0"` is closed-won, `"0.0"` is closed-lost.

- [x] **Step 1: Write the failing test**

Create `src/lib/crm/hubspot-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { hubspotProvider } from './hubspot-provider'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'

const credentials: CrmOAuthCredentials = {
  kind: 'oauth',
  accessToken: 'hs-access',
  refreshToken: 'hs-refresh',
  // Far future so no test accidentally triggers the refresh path.
  expiresAt: '2099-01-01T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockFetch(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>
}

describe('hubspotProvider.buildAuthUrl', () => {
  it('should target the HubSpot consent screen carrying the state nonce', () => {
    const url = new URL(hubspotProvider.buildAuthUrl('nonce-123'))

    expect(url.origin + url.pathname).toBe('https://app.hubspot.com/oauth/authorize')
    expect(url.searchParams.get('state')).toBe('nonce-123')
    expect(url.searchParams.get('response_type')).toBe('code')
    expect(url.searchParams.get('scope')).toContain('crm.objects.deals.write')
  })
})

describe('hubspotProvider.exchangeCode', () => {
  it('should return credentials plus the portal label and hub id', async () => {
    mockFetch()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 1800 }),
      )
      .mockResolvedValueOnce(jsonResponse({ hub_id: 12345678, hub_domain: 'acme.hubspot.com' }))

    const result = await hubspotProvider.exchangeCode('the-code')

    expect(result.tokens.accessToken).toBe('at')
    expect(result.tokens.refreshToken).toBe('rt')
    expect(Date.parse(result.tokens.expiresAt)).toBeGreaterThan(Date.now())
    expect(result.accountLabel).toBe('acme.hubspot.com')
    expect(result.accountRef).toBe('12345678')
  })

  it('should throw EXTERNAL_ERROR when HubSpot rejects the code', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'invalid code' }, 400))

    await expect(hubspotProvider.exchangeCode('bad')).rejects.toBeInstanceOf(AppError)
  })

  it('should throw EXTERNAL_ERROR when the token response omits a refresh token', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ access_token: 'at', expires_in: 1800 }))

    await expect(hubspotProvider.exchangeCode('the-code')).rejects.toBeInstanceOf(AppError)
  })
})

describe('hubspotProvider.listPipelines', () => {
  it('should map stages and flag the closed-won and closed-lost ones', async () => {
    mockFetch().mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            id: 'default',
            label: 'Sales Pipeline',
            stages: [
              { id: 's1', label: 'New', metadata: { probability: '0.2' } },
              { id: 's9', label: 'Closed Won', metadata: { probability: '1.0' } },
              { id: 's10', label: 'Closed Lost', metadata: { probability: '0.0' } },
            ],
          },
        ],
      }),
    )

    const { pipelines } = await hubspotProvider.listPipelines(credentials)

    expect(pipelines).toEqual([
      {
        id: 'default',
        label: 'Sales Pipeline',
        stages: [
          { id: 's1', label: 'New', closedOutcome: null },
          { id: 's9', label: 'Closed Won', closedOutcome: 'won' },
          { id: 's10', label: 'Closed Lost', closedOutcome: 'lost' },
        ],
      },
    ])
  })

  it('should throw EXTERNAL_ERROR carrying the status when HubSpot rate limits', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'rate limited' }, 429))

    await expect(hubspotProvider.listPipelines(credentials)).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
      context: { status: 429 },
    })
  })

  it('should throw EXTERNAL_ERROR when the response shape is unexpected', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ nope: true }))

    await expect(hubspotProvider.listPipelines(credentials)).rejects.toBeInstanceOf(AppError)
  })
})

describe('hubspotProvider.upsertCompany', () => {
  it('should patch the existing company when the domain already matches one', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'co-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'co-1' }))

    const { externalId } = await hubspotProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: 'acme.com',
    })

    expect(externalId).toBe('co-1')
    expect(mockFetch().mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' })
  })

  it('should create the company when no domain match exists', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'co-2' }))

    const { externalId } = await hubspotProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: 'acme.com',
    })

    expect(externalId).toBe('co-2')
    expect(mockFetch().mock.calls[1]?.[1]).toMatchObject({ method: 'POST' })
  })

  it('should create without searching when the case has no domain to match on', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'co-3' }))

    const { externalId } = await hubspotProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: null,
    })

    expect(externalId).toBe('co-3')
    expect(mockFetch()).toHaveBeenCalledTimes(1)
  })
})

describe('hubspotProvider.upsertContact', () => {
  const contact = {
    email: 'ada@acme.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    title: 'CTO',
    linkedinUrl: 'https://linkedin.com/in/ada',
    companyName: 'Acme',
  }

  it('should patch the existing contact when the email already matches one', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [{ id: 'ct-1' }] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'ct-1' }))

    const { externalId } = await hubspotProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('ct-1')
    expect(mockFetch().mock.calls[1]?.[1]).toMatchObject({ method: 'PATCH' })
  })

  it('should create the contact when the email is new to the portal', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ id: 'ct-2' }))

    const { externalId } = await hubspotProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('ct-2')
  })

  it('should throw EXTERNAL_ERROR when HubSpot rejects the credentials', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'expired' }, 401))

    await expect(hubspotProvider.upsertContact(credentials, contact)).rejects.toMatchObject({
      context: { status: 401 },
    })
  })
})

describe('hubspotProvider.createDeal', () => {
  it('should create the deal with company and contact associations and a portal URL', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-1' }))

    const { externalId, url } = await hubspotProvider.createDeal(credentials, {
      title: 'Acme — Q3',
      pipelineId: 'default',
      stageId: 's1',
      companyExternalId: 'co-1',
      contactExternalIds: ['ct-1', 'ct-2'],
      accountRef: '12345678',
    })

    expect(externalId).toBe('deal-1')
    expect(url).toBe('https://app.hubspot.com/contacts/12345678/record/0-3/deal-1')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.properties).toMatchObject({ dealname: 'Acme — Q3', pipeline: 'default', dealstage: 's1' })
    expect(body.associations).toHaveLength(3)
  })

  it('should omit the company association when the case had no company id', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-2' }))

    await hubspotProvider.createDeal(credentials, {
      title: 'Acme',
      pipelineId: 'default',
      stageId: 's1',
      companyExternalId: null,
      contactExternalIds: [],
      accountRef: '12345678',
    })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.associations).toEqual([])
  })

  it('should fall back to an empty URL when the connection has no portal id', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-3' }))

    const { url } = await hubspotProvider.createDeal(credentials, {
      title: 'Acme',
      pipelineId: 'default',
      stageId: 's1',
      companyExternalId: null,
      contactExternalIds: [],
      accountRef: null,
    })

    expect(url).toBe('')
  })
})

describe('hubspotProvider.moveDeal', () => {
  it('should patch the deal stage when given a stage target', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'deal-1' }))

    await hubspotProvider.moveDeal(credentials, 'deal-1', { kind: 'stage', stageId: 's5' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.properties.dealstage).toBe('s5')
  })

  it('should resolve the closed-won stage from the pipeline when closing as won', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ properties: { pipeline: 'default' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            {
              id: 'default',
              label: 'Sales',
              stages: [
                { id: 's1', label: 'New', metadata: { probability: '0.2' } },
                { id: 's9', label: 'Closed Won', metadata: { probability: '1.0' } },
              ],
            },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'deal-1' }))

    await hubspotProvider.moveDeal(credentials, 'deal-1', { kind: 'closed', outcome: 'won' })

    const body = JSON.parse(String(mockFetch().mock.calls[2]?.[1]?.body))
    expect(body.properties.dealstage).toBe('s9')
  })

  it('should record a note instead of moving when the pipeline has no closed stage', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ properties: { pipeline: 'default' } }))
      .mockResolvedValueOnce(
        jsonResponse({
          results: [
            { id: 'default', label: 'Sales', stages: [{ id: 's1', label: 'New', metadata: { probability: '0.2' } }] },
          ],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: 'note-1' }))

    await hubspotProvider.moveDeal(credentials, 'deal-1', { kind: 'closed', outcome: 'lost' })

    const lastCall = mockFetch().mock.calls[2]?.[0]
    expect(String(lastCall)).toContain('/crm/v3/objects/notes')
  })
})

describe('hubspotProvider.addDealNote', () => {
  it('should create a note associated with the deal', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ id: 'note-1' }))

    await hubspotProvider.addDealNote(credentials, 'deal-1', 'First outreach sent')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.properties.hs_note_body).toBe('First outreach sent')
    expect(body.associations[0].to.id).toBe('deal-1')
  })

  it('should throw EXTERNAL_ERROR when HubSpot returns a server error', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ message: 'boom' }, 503))

    await expect(hubspotProvider.addDealNote(credentials, 'deal-1', 'note')).rejects.toMatchObject({
      context: { status: 503 },
    })
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/crm/hubspot-provider.test.ts`
Expected: FAIL — cannot resolve `./hubspot-provider`.

- [x] **Step 3: Write the implementation**

Create `src/lib/crm/hubspot-provider.ts`:

```ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'
import type {
  CrmCompanyInput, CrmContactInput, CrmDealInput, CrmDealTarget, CrmExchangeResult,
  CrmPipeline, CrmProvider,
} from './provider'

const API_BASE = 'https://api.hubapi.com'
const APP_BASE = 'https://app.hubspot.com'
const REDIRECT_PATH = '/api/crm/hubspot/callback'

const SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
].join(' ')

// HubSpot-defined association type ids. These are platform constants, not
// portal-specific: a portal cannot renumber them.
const ASSOCIATION_DEAL_TO_CONTACT = 3
const ASSOCIATION_DEAL_TO_COMPANY = 341
const ASSOCIATION_NOTE_TO_DEAL = 214

// HubSpot's object type id for deals, used in record deep links.
const DEAL_OBJECT_TYPE_ID = '0-3'

/** Refresh this far before actual expiry so a slow request cannot straddle it. */
const REFRESH_SKEW_MS = 30_000

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
})

const tokenInfoSchema = z.object({
  hub_id: z.number(),
  hub_domain: z.string().optional(),
})

const stageSchema = z.object({
  id: z.string(),
  label: z.string(),
  metadata: z.object({ probability: z.string().optional() }).optional(),
})

const pipelinesSchema = z.object({
  results: z.array(z.object({ id: z.string(), label: z.string(), stages: z.array(stageSchema) })),
})

const searchSchema = z.object({ results: z.array(z.object({ id: z.string() })) })
const objectSchema = z.object({ id: z.string() })
const dealReadSchema = z.object({ properties: z.object({ pipeline: z.string().optional() }) })

function redirectUri(): string {
  return new URL(REDIRECT_PATH, env.APP_URL).toString()
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

async function refreshAccessToken(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const refreshed = await fetchJson(
    `${API_BASE}/oauth/v1/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.HUBSPOT_OAUTH_CLIENT_ID,
        client_secret: env.HUBSPOT_OAUTH_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
      }),
    },
    tokenResponseSchema,
  )
  return {
    kind: 'oauth',
    accessToken: refreshed.access_token,
    // HubSpot returns a rotated refresh token on some plans and omits it on
    // others; keeping the old one when absent is what the docs prescribe.
    refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    expiresAt: expiresAtFrom(refreshed.expires_in),
  }
}

async function ensureFresh(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + REFRESH_SKEW_MS
  return isExpired ? refreshAccessToken(tokens) : tokens
}

function closedOutcomeFor(probability: string | undefined): 'won' | 'lost' | null {
  if (probability === '1.0') return 'won'
  if (probability === '0.0') return 'lost'
  return null
}

async function fetchPipelines(accessToken: string): Promise<CrmPipeline[]> {
  const response = await fetchJson(
    `${API_BASE}/crm/v3/pipelines/deals`,
    { method: 'GET', headers: authHeaders(accessToken) },
    pipelinesSchema,
  )
  return response.results.map((pipeline) => ({
    id: pipeline.id,
    label: pipeline.label,
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      closedOutcome: closedOutcomeFor(stage.metadata?.probability),
    })),
  }))
}

/** Search by an exact property match, returning the first id or null. */
async function findObjectId(
  accessToken: string,
  objectType: 'contacts' | 'companies',
  propertyName: string,
  value: string,
): Promise<string | null> {
  const found = await fetchJson(
    `${API_BASE}/crm/v3/objects/${objectType}/search`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
        limit: 1,
      }),
    },
    searchSchema,
  )
  return found.results[0]?.id ?? null
}

async function createOrPatch(
  accessToken: string,
  objectType: 'contacts' | 'companies',
  existingId: string | null,
  properties: Record<string, string>,
): Promise<string> {
  const url = existingId
    ? `${API_BASE}/crm/v3/objects/${objectType}/${existingId}`
    : `${API_BASE}/crm/v3/objects/${objectType}`
  const saved = await fetchJson(
    url,
    {
      method: existingId ? 'PATCH' : 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({ properties }),
    },
    objectSchema,
  )
  return saved.id
}

/** Drops null/empty values — HubSpot rejects a property set to `null`. */
function definedProperties(entries: Record<string, string | null>): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== '') properties[key] = value
  }
  return properties
}

async function postNote(accessToken: string, dealId: string, note: string): Promise<void> {
  await fetchJson(
    `${API_BASE}/crm/v3/objects/notes`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        properties: { hs_note_body: note, hs_timestamp: new Date().toISOString() },
        associations: [
          {
            to: { id: dealId },
            types: [
              { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_NOTE_TO_DEAL },
            ],
          },
        ],
      }),
    },
    objectSchema,
  )
}

export const hubspotProvider: CrmProvider = {
  provider: 'hubspot',

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.HUBSPOT_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      state,
    })
    return `${APP_BASE}/oauth/authorize?${params.toString()}`
  },

  async exchangeCode(code: string): Promise<CrmExchangeResult> {
    const token = await fetchJson(
      `${API_BASE}/oauth/v1/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.HUBSPOT_OAUTH_CLIENT_ID,
          client_secret: env.HUBSPOT_OAUTH_CLIENT_SECRET,
          redirect_uri: redirectUri(),
          code,
        }),
      },
      tokenResponseSchema,
    )
    if (!token.refresh_token) {
      throw new AppError('EXTERNAL_ERROR', 'HubSpot did not return a refresh token', {})
    }
    const info = await fetchJson(
      `${API_BASE}/oauth/v1/access-tokens/${token.access_token}`,
      { method: 'GET' },
      tokenInfoSchema,
      // Redacted: the real URL embeds the access token, and AppError context is
      // written to the events table and rendered on the operator Logs tab.
      8000,
      `${API_BASE}/oauth/v1/access-tokens/[redacted]`,
    )
    return {
      tokens: {
        kind: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
      accountLabel: info.hub_domain ?? null,
      accountRef: String(info.hub_id),
    }
  },

  async listPipelines(credentials: CrmOAuthCredentials) {
    const fresh = await ensureFresh(credentials)
    return { pipelines: await fetchPipelines(fresh.accessToken), tokens: fresh }
  },

  async upsertCompany(credentials: CrmOAuthCredentials, input: CrmCompanyInput) {
    const fresh = await ensureFresh(credentials)
    // Domain is the only reliable company identity in HubSpot. Without one we
    // create rather than risk merging two unrelated same-named companies.
    const existingId = input.domain
      ? await findObjectId(fresh.accessToken, 'companies', 'domain', input.domain)
      : null
    const externalId = await createOrPatch(
      fresh.accessToken,
      'companies',
      existingId,
      definedProperties({ name: input.name, domain: input.domain }),
    )
    return { externalId, tokens: fresh }
  },

  async upsertContact(credentials: CrmOAuthCredentials, input: CrmContactInput) {
    const fresh = await ensureFresh(credentials)
    const existingId = await findObjectId(fresh.accessToken, 'contacts', 'email', input.email)
    const externalId = await createOrPatch(
      fresh.accessToken,
      'contacts',
      existingId,
      definedProperties({
        email: input.email,
        firstname: input.firstName,
        lastname: input.lastName,
        jobtitle: input.title,
        linkedin_bio: input.linkedinUrl,
        company: input.companyName,
      }),
    )
    return { externalId, tokens: fresh }
  },

  async createDeal(credentials: CrmOAuthCredentials, input: CrmDealInput) {
    const fresh = await ensureFresh(credentials)
    const associations = [
      ...(input.companyExternalId
        ? [{
            to: { id: input.companyExternalId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_DEAL_TO_COMPANY }],
          }]
        : []),
      ...input.contactExternalIds.map((contactId) => ({
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_DEAL_TO_CONTACT }],
      })),
    ]
    const deal = await fetchJson(
      `${API_BASE}/crm/v3/objects/deals`,
      {
        method: 'POST',
        headers: authHeaders(fresh.accessToken),
        body: JSON.stringify({
          properties: { dealname: input.title, pipeline: input.pipelineId, dealstage: input.stageId },
          associations,
        }),
      },
      objectSchema,
    )
    // Empty rather than a broken link when the portal id is unknown; the UI
    // renders the indicator without an anchor in that case.
    const url = input.accountRef
      ? `${APP_BASE}/contacts/${input.accountRef}/record/${DEAL_OBJECT_TYPE_ID}/${deal.id}`
      : ''
    return { externalId: deal.id, url, tokens: fresh }
  },

  async moveDeal(credentials: CrmOAuthCredentials, dealId: string, target: CrmDealTarget) {
    const fresh = await ensureFresh(credentials)
    let stageId: string | null = null

    if (target.kind === 'stage') {
      stageId = target.stageId
    } else {
      // Read the deal's own pipeline rather than trusting the stored stage ids:
      // a client can move a deal to another pipeline in HubSpot after we
      // created it, which would make our stored closed-stage id invalid.
      const deal = await fetchJson(
        `${API_BASE}/crm/v3/objects/deals/${dealId}?properties=pipeline`,
        { method: 'GET', headers: authHeaders(fresh.accessToken) },
        dealReadSchema,
      )
      const pipelines = await fetchPipelines(fresh.accessToken)
      const pipeline = pipelines.find((candidate) => candidate.id === deal.properties.pipeline)
      stageId = pipeline?.stages.find((stage) => stage.closedOutcome === target.outcome)?.id ?? null
    }

    if (stageId === null) {
      // Losing a stage move is not worth failing a sync over — record the
      // outcome as a note so the information still reaches the client.
      await postNote(fresh.accessToken, dealId, `Case marked ${target.kind === 'closed' ? target.outcome : 'updated'}`)
      return { tokens: fresh }
    }

    await fetchJson(
      `${API_BASE}/crm/v3/objects/deals/${dealId}`,
      {
        method: 'PATCH',
        headers: authHeaders(fresh.accessToken),
        body: JSON.stringify({ properties: { dealstage: stageId } }),
      },
      objectSchema,
    )
    return { tokens: fresh }
  },

  async addDealNote(credentials: CrmOAuthCredentials, dealId: string, note: string) {
    const fresh = await ensureFresh(credentials)
    await postNote(fresh.accessToken, dealId, note)
    return { tokens: fresh }
  },
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/crm/hubspot-provider.test.ts`
Expected: PASS, 20 tests.

- [x] **Step 5: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/lib/crm/hubspot-provider.ts src/lib/crm/hubspot-provider.test.ts
git commit -m "feat: add HubSpot CRM provider"
```

---

### Task 7: Pipedrive provider and the registry

Pipedrive differs from HubSpot in three ways that shape this implementation: the token endpoint uses HTTP Basic auth, the API base URL is per-account (`api_domain`, returned with the token), and deal closure is a `status` field independent of stage — so `won_stage_id` / `lost_stage_id` stay null for Pipedrive connections.

**Files:**
- Create: `src/lib/crm/pipedrive-provider.ts`
- Create: `src/lib/crm/pipedrive-provider.test.ts`
- Create: `src/lib/crm/registry.ts`
- Create: `src/lib/crm/registry.test.ts`

**Interfaces:**
- Consumes: `CrmProvider` and its input types (Task 3); `hubspotProvider` (Task 6).
- Produces: `export const pipedriveProvider: CrmProvider`, `getCrmProvider(provider: CrmProviderName): CrmProvider`.

- [x] **Step 1: Write the failing Pipedrive test**

Create `src/lib/crm/pipedrive-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { pipedriveProvider } from './pipedrive-provider'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'

// accessToken carries the api_domain suffix the provider parses out; see the
// implementation note on why the domain rides along with the token.
const credentials: CrmOAuthCredentials = {
  kind: 'oauth',
  accessToken: 'pd-access|https://acme.pipedrive.com',
  refreshToken: 'pd-refresh',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn())
})

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

function mockFetch(): ReturnType<typeof vi.fn> {
  return globalThis.fetch as unknown as ReturnType<typeof vi.fn>
}

describe('pipedriveProvider.buildAuthUrl', () => {
  it('should target the Pipedrive consent screen carrying the state nonce', () => {
    const url = new URL(pipedriveProvider.buildAuthUrl('nonce-123'))

    expect(url.origin + url.pathname).toBe('https://oauth.pipedrive.com/oauth/authorize')
    expect(url.searchParams.get('state')).toBe('nonce-123')
    expect(url.searchParams.get('response_type')).toBe('code')
  })
})

describe('pipedriveProvider.exchangeCode', () => {
  it('should return credentials carrying the api domain plus the account label', async () => {
    mockFetch()
      .mockResolvedValueOnce(
        jsonResponse({
          access_token: 'at',
          refresh_token: 'rt',
          expires_in: 3600,
          api_domain: 'https://acme.pipedrive.com',
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { company_name: 'Acme Ltd' } }))

    const result = await pipedriveProvider.exchangeCode('the-code')

    expect(result.tokens.accessToken).toBe('at|https://acme.pipedrive.com')
    expect(result.tokens.refreshToken).toBe('rt')
    expect(result.accountLabel).toBe('Acme Ltd')
    expect(result.accountRef).toBe('https://acme.pipedrive.com')
  })

  it('should authenticate the token request with HTTP Basic credentials', async () => {
    mockFetch()
      .mockResolvedValueOnce(
        jsonResponse({ access_token: 'at', refresh_token: 'rt', expires_in: 3600, api_domain: 'https://a.pipedrive.com' }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { company_name: 'A' } }))

    await pipedriveProvider.exchangeCode('the-code')

    const headers = mockFetch().mock.calls[0]?.[1]?.headers as Record<string, string>
    expect(headers.Authorization).toMatch(/^Basic /)
  })

  it('should throw EXTERNAL_ERROR when Pipedrive rejects the code', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'invalid_grant' }, 400))

    await expect(pipedriveProvider.exchangeCode('bad')).rejects.toBeInstanceOf(AppError)
  })
})

describe('pipedriveProvider.listPipelines', () => {
  it('should attach each pipeline its own stages with no closed outcome flagged', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: [{ id: 1, name: 'Sales' }] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: [{ id: 10, name: 'Lead In', pipeline_id: 1 }, { id: 11, name: 'Demo', pipeline_id: 1 }] }),
      )

    const { pipelines } = await pipedriveProvider.listPipelines(credentials)

    expect(pipelines).toEqual([
      {
        id: '1',
        label: 'Sales',
        stages: [
          { id: '10', label: 'Lead In', closedOutcome: null },
          { id: '11', label: 'Demo', closedOutcome: null },
        ],
      },
    ])
  })

  it('should return an empty list when the account has no pipelines', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: null }))
      .mockResolvedValueOnce(jsonResponse({ data: null }))

    const { pipelines } = await pipedriveProvider.listPipelines(credentials)

    expect(pipelines).toEqual([])
  })

  it('should throw EXTERNAL_ERROR carrying the status when Pipedrive rate limits', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'rate limited' }, 429))

    await expect(pipedriveProvider.listPipelines(credentials)).rejects.toMatchObject({
      context: { status: 429 },
    })
  })
})

describe('pipedriveProvider.upsertCompany', () => {
  it('should reuse the existing organization when the name already matches one', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { items: [{ item: { id: 7 } }] } }))

    const { externalId } = await pipedriveProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: 'acme.com',
    })

    expect(externalId).toBe('7')
    expect(mockFetch()).toHaveBeenCalledTimes(1)
  })

  it('should create the organization when the search finds nothing', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 8 } }))

    const { externalId } = await pipedriveProvider.upsertCompany(credentials, {
      name: 'Acme',
      domain: null,
    })

    expect(externalId).toBe('8')
  })
})

describe('pipedriveProvider.upsertContact', () => {
  const contact = {
    email: 'ada@acme.com',
    firstName: 'Ada',
    lastName: 'Lovelace',
    title: 'CTO',
    linkedinUrl: 'https://linkedin.com/in/ada',
    companyName: 'Acme',
  }

  it('should reuse the existing person when the email already matches one', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { items: [{ item: { id: 3 } }] } }))

    const { externalId } = await pipedriveProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('3')
  })

  it('should create the person with the email marked primary when none matches', async () => {
    mockFetch()
      .mockResolvedValueOnce(jsonResponse({ data: { items: [] } }))
      .mockResolvedValueOnce(jsonResponse({ data: { id: 4 } }))

    const { externalId } = await pipedriveProvider.upsertContact(credentials, contact)

    expect(externalId).toBe('4')
    const body = JSON.parse(String(mockFetch().mock.calls[1]?.[1]?.body))
    expect(body.name).toBe('Ada Lovelace')
    expect(body.email).toEqual([{ value: 'ada@acme.com', primary: true }])
  })

  it('should throw EXTERNAL_ERROR when Pipedrive rejects the credentials', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401))

    await expect(pipedriveProvider.upsertContact(credentials, contact)).rejects.toMatchObject({
      context: { status: 401 },
    })
  })
})

describe('pipedriveProvider.createDeal', () => {
  it('should create the deal linked to the organization and first person', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    const { externalId, url } = await pipedriveProvider.createDeal(credentials, {
      title: 'Acme — Q3',
      pipelineId: '1',
      stageId: '10',
      companyExternalId: '7',
      contactExternalIds: ['3', '4'],
      accountRef: 'https://acme.pipedrive.com',
    })

    expect(externalId).toBe('55')
    expect(url).toBe('https://acme.pipedrive.com/deal/55')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toMatchObject({ title: 'Acme — Q3', org_id: 7, person_id: 3, pipeline_id: 1, stage_id: 10 })
  })

  it('should omit the person link when the case has no synced contacts', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 56 } }))

    await pipedriveProvider.createDeal(credentials, {
      title: 'Acme',
      pipelineId: '1',
      stageId: '10',
      companyExternalId: null,
      contactExternalIds: [],
      accountRef: 'https://acme.pipedrive.com',
    })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body.person_id).toBeUndefined()
    expect(body.org_id).toBeUndefined()
  })
})

describe('pipedriveProvider.moveDeal', () => {
  it('should set the stage when given a stage target', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    await pipedriveProvider.moveDeal(credentials, '55', { kind: 'stage', stageId: '11' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ stage_id: 11 })
  })

  it('should set the deal status rather than a stage when closing as won', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    await pipedriveProvider.moveDeal(credentials, '55', { kind: 'closed', outcome: 'won' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ status: 'won' })
  })

  it('should set the deal status to lost when closing as lost', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 55 } }))

    await pipedriveProvider.moveDeal(credentials, '55', { kind: 'closed', outcome: 'lost' })

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ status: 'lost' })
  })
})

describe('pipedriveProvider.addDealNote', () => {
  it('should create a note attached to the deal', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ data: { id: 90 } }))

    await pipedriveProvider.addDealNote(credentials, '55', 'First outreach sent')

    const body = JSON.parse(String(mockFetch().mock.calls[0]?.[1]?.body))
    expect(body).toEqual({ content: 'First outreach sent', deal_id: 55 })
  })

  it('should throw EXTERNAL_ERROR when Pipedrive returns a server error', async () => {
    mockFetch().mockResolvedValueOnce(jsonResponse({ error: 'boom' }, 503))

    await expect(pipedriveProvider.addDealNote(credentials, '55', 'note')).rejects.toMatchObject({
      context: { status: 503 },
    })
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/crm/pipedrive-provider.test.ts`
Expected: FAIL — cannot resolve `./pipedrive-provider`.

- [x] **Step 3: Write the Pipedrive implementation**

Create `src/lib/crm/pipedrive-provider.ts`:

```ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'
import type {
  CrmCompanyInput, CrmContactInput, CrmDealInput, CrmDealTarget, CrmExchangeResult,
  CrmPipeline, CrmProvider,
} from './provider'

const OAUTH_BASE = 'https://oauth.pipedrive.com'
const REDIRECT_PATH = '/api/crm/pipedrive/callback'
const SCOPES = 'deals:full contacts:full'
const REFRESH_SKEW_MS = 30_000

/**
 * Pipedrive's API base URL is per-account (`api_domain`), returned only with
 * the token response — every later call needs it. Rather than widen
 * CrmOAuthCredentials (which mailbox tokens share the shape of) we pack it into
 * accessToken after a separator that cannot occur in a bearer token, and split
 * it back out at every use site.
 */
const DOMAIN_SEPARATOR = '|'

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  api_domain: z.string(),
})

const meSchema = z.object({ data: z.object({ company_name: z.string().optional() }).nullable() })
const pipelinesSchema = z.object({
  data: z.array(z.object({ id: z.number(), name: z.string() })).nullable(),
})
const stagesSchema = z.object({
  data: z.array(z.object({ id: z.number(), name: z.string(), pipeline_id: z.number() })).nullable(),
})
const searchSchema = z.object({
  data: z.object({ items: z.array(z.object({ item: z.object({ id: z.number() }) })) }).nullable(),
})
const createdSchema = z.object({ data: z.object({ id: z.number() }).nullable() })

interface PackedCredentials {
  accessToken: string
  apiDomain: string
}

function unpack(tokens: CrmOAuthCredentials): PackedCredentials {
  const separatorIndex = tokens.accessToken.indexOf(DOMAIN_SEPARATOR)
  if (separatorIndex === -1) {
    throw new AppError('INVARIANT_VIOLATION', 'Pipedrive credentials are missing their api domain', {})
  }
  return {
    accessToken: tokens.accessToken.slice(0, separatorIndex),
    apiDomain: tokens.accessToken.slice(separatorIndex + 1),
  }
}

function pack(accessToken: string, apiDomain: string): string {
  return `${accessToken}${DOMAIN_SEPARATOR}${apiDomain}`
}

function redirectUri(): string {
  return new URL(REDIRECT_PATH, env.APP_URL).toString()
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

function basicAuthHeader(): string {
  const raw = `${env.PIPEDRIVE_OAUTH_CLIENT_ID}:${env.PIPEDRIVE_OAUTH_CLIENT_SECRET}`
  return `Basic ${Buffer.from(raw, 'utf-8').toString('base64')}`
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

async function refreshAccessToken(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const { apiDomain } = unpack(tokens)
  const refreshed = await fetchJson(
    `${OAUTH_BASE}/oauth/token`,
    {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
    },
    tokenResponseSchema,
  )
  return {
    kind: 'oauth',
    // The refresh response repeats api_domain; prefer it over the stored one so
    // an account migrated to a new domain keeps working.
    accessToken: pack(refreshed.access_token, refreshed.api_domain || apiDomain),
    refreshToken: refreshed.refresh_token,
    expiresAt: expiresAtFrom(refreshed.expires_in),
  }
}

async function ensureFresh(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + REFRESH_SKEW_MS
  return isExpired ? refreshAccessToken(tokens) : tokens
}

/** Pipedrive ids are numeric; our interface carries strings. One place to convert. */
function toNumericId(id: string, field: string): number {
  const parsed = Number(id)
  if (!Number.isInteger(parsed)) {
    throw new AppError('INVARIANT_VIOLATION', 'Pipedrive id is not numeric', { field, id })
  }
  return parsed
}

async function searchFirstId(
  packed: PackedCredentials,
  resource: 'persons' | 'organizations',
  term: string,
  fields: string,
): Promise<string | null> {
  const params = new URLSearchParams({ term, fields, exact_match: 'true', limit: '1' })
  const found = await fetchJson(
    `${packed.apiDomain}/api/v1/${resource}/search?${params.toString()}`,
    { method: 'GET', headers: authHeaders(packed.accessToken) },
    searchSchema,
  )
  const first = found.data?.items[0]
  return first ? String(first.item.id) : null
}

async function createResource(
  packed: PackedCredentials,
  resource: 'persons' | 'organizations' | 'deals' | 'notes',
  body: Record<string, unknown>,
): Promise<string> {
  const created = await fetchJson(
    `${packed.apiDomain}/api/v1/${resource}`,
    { method: 'POST', headers: authHeaders(packed.accessToken), body: JSON.stringify(body) },
    createdSchema,
  )
  if (!created.data) {
    throw new AppError('EXTERNAL_ERROR', 'Pipedrive create returned no record', { resource })
  }
  return String(created.data.id)
}

export const pipedriveProvider: CrmProvider = {
  provider: 'pipedrive',

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.PIPEDRIVE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      state,
    })
    return `${OAUTH_BASE}/oauth/authorize?${params.toString()}`
  },

  async exchangeCode(code: string): Promise<CrmExchangeResult> {
    const token = await fetchJson(
      `${OAUTH_BASE}/oauth/token`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }),
      },
      tokenResponseSchema,
    )
    const me = await fetchJson(
      `${token.api_domain}/api/v1/users/me`,
      { method: 'GET', headers: authHeaders(token.access_token) },
      meSchema,
    )
    return {
      tokens: {
        kind: 'oauth',
        accessToken: pack(token.access_token, token.api_domain),
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
      accountLabel: me.data?.company_name ?? null,
      accountRef: token.api_domain,
    }
  },

  async listPipelines(credentials: CrmOAuthCredentials) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const pipelinesResponse = await fetchJson(
      `${packed.apiDomain}/api/v1/pipelines`,
      { method: 'GET', headers: authHeaders(packed.accessToken) },
      pipelinesSchema,
    )
    const stagesResponse = await fetchJson(
      `${packed.apiDomain}/api/v1/stages`,
      { method: 'GET', headers: authHeaders(packed.accessToken) },
      stagesSchema,
    )
    const stages = stagesResponse.data ?? []
    // Pipedrive models closure as a deal status field, not a stage, so no stage
    // ever carries a closed outcome here. moveDeal handles closure instead.
    const pipelines: CrmPipeline[] = (pipelinesResponse.data ?? []).map((pipeline) => ({
      id: String(pipeline.id),
      label: pipeline.name,
      stages: stages
        .filter((stage) => stage.pipeline_id === pipeline.id)
        .map((stage) => ({ id: String(stage.id), label: stage.name, closedOutcome: null })),
    }))
    return { pipelines, tokens: fresh }
  },

  async upsertCompany(credentials: CrmOAuthCredentials, input: CrmCompanyInput) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const existingId = await searchFirstId(packed, 'organizations', input.name, 'name')
    if (existingId) return { externalId: existingId, tokens: fresh }
    const externalId = await createResource(packed, 'organizations', { name: input.name })
    return { externalId, tokens: fresh }
  },

  async upsertContact(credentials: CrmOAuthCredentials, input: CrmContactInput) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const existingId = await searchFirstId(packed, 'persons', input.email, 'email')
    if (existingId) return { externalId: existingId, tokens: fresh }
    const name = [input.firstName, input.lastName].filter((part) => part !== null).join(' ') || input.email
    const externalId = await createResource(packed, 'persons', {
      name,
      email: [{ value: input.email, primary: true }],
    })
    return { externalId, tokens: fresh }
  },

  async createDeal(credentials: CrmOAuthCredentials, input: CrmDealInput) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const body: Record<string, unknown> = {
      title: input.title,
      pipeline_id: toNumericId(input.pipelineId, 'pipelineId'),
      stage_id: toNumericId(input.stageId, 'stageId'),
    }
    if (input.companyExternalId) body.org_id = toNumericId(input.companyExternalId, 'companyExternalId')
    // A Pipedrive deal links to exactly one person. The rest of the case's
    // contacts are already Persons on the organization and appear there.
    const primaryContactId = input.contactExternalIds[0]
    if (primaryContactId) body.person_id = toNumericId(primaryContactId, 'contactExternalIds[0]')

    const externalId = await createResource(packed, 'deals', body)
    const url = input.accountRef ? `${input.accountRef}/deal/${externalId}` : ''
    return { externalId, url, tokens: fresh }
  },

  async moveDeal(credentials: CrmOAuthCredentials, dealId: string, target: CrmDealTarget) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const body =
      target.kind === 'stage'
        ? { stage_id: toNumericId(target.stageId, 'stageId') }
        : { status: target.outcome }
    await fetchJson(
      `${packed.apiDomain}/api/v1/deals/${toNumericId(dealId, 'dealId')}`,
      { method: 'PUT', headers: authHeaders(packed.accessToken), body: JSON.stringify(body) },
      createdSchema,
    )
    return { tokens: fresh }
  },

  async addDealNote(credentials: CrmOAuthCredentials, dealId: string, note: string) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    await createResource(packed, 'notes', { content: note, deal_id: toNumericId(dealId, 'dealId') })
    return { tokens: fresh }
  },
}
```

- [x] **Step 4: Run the Pipedrive test to verify it passes**

Run: `pnpm vitest run src/lib/crm/pipedrive-provider.test.ts`
Expected: PASS, 17 tests.

- [x] **Step 5: Write the failing registry test**

Create `src/lib/crm/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getCrmProvider } from './registry'

describe('getCrmProvider', () => {
  it('should return the HubSpot implementation when asked for hubspot', () => {
    expect(getCrmProvider('hubspot').provider).toBe('hubspot')
  })

  it('should return the Pipedrive implementation when asked for pipedrive', () => {
    expect(getCrmProvider('pipedrive').provider).toBe('pipedrive')
  })

  it('should throw when given a provider outside the enum', () => {
    expect(() => getCrmProvider('salesforce' as never)).toThrow()
  })
})
```

- [x] **Step 6: Write the registry**

Create `src/lib/crm/registry.ts`:

```ts
import type { CrmProvider, CrmProviderName } from './provider'
import { hubspotProvider } from './hubspot-provider'
import { pipedriveProvider } from './pipedrive-provider'

export function getCrmProvider(provider: CrmProviderName): CrmProvider {
  switch (provider) {
    case 'hubspot':
      return hubspotProvider
    case 'pipedrive':
      return pipedriveProvider
    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown CRM provider: ${String(exhaustive)}`)
    }
  }
}
```

- [x] **Step 7: Run the registry test to verify it passes**

Run: `pnpm vitest run src/lib/crm/registry.test.ts`
Expected: PASS, 3 tests.

- [x] **Step 8: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/lib/crm/pipedrive-provider.ts src/lib/crm/pipedrive-provider.test.ts \
        src/lib/crm/registry.ts src/lib/crm/registry.test.ts
git commit -m "feat: add Pipedrive CRM provider and provider registry"
```

---

### Task 8: Sync orchestration

`enqueueCrmSync` is the one-line hook the pipeline calls; `runCrmSync` is the worker body. Splitting them keeps the QStash publish (fire-and-forget, never throws) apart from the provider work (fully testable with a fake provider).

**Files:**
- Create: `src/lib/crm/sync.ts`
- Create: `src/lib/crm/sync.test.ts`
- Modify: `src/types/logs.ts` (add `'crm'` to `LOG_SOURCES`)

**Interfaces:**
- Consumes: `getCrmProvider` (Task 7); `parseCrmTokens` / `encryptCrmTokens` (Task 2); mapping helpers (Task 3); both DB modules (Tasks 4–5); `getCaseById`, `listActiveLeadsForCase`, `getCampaignForCase`; `publishJson`; `logEventSafe` / `logError`.
- Produces:
  - `type CrmSyncReason = 'qualified' | 'contacted' | 'in_conversation' | 'hot_handoff' | 'won' | 'lost' | 'dead'`
  - `enqueueCrmSync(caseId: string, reason: CrmSyncReason): Promise<void>`
  - `runCrmSync(supabase, input: RunCrmSyncInput): Promise<CrmSyncOutcome>`
  - `type CrmSyncOutcome = { kind: 'synced' } | { kind: 'skipped'; reason: string } | { kind: 'busy' } | { kind: 'permanent_failure'; message: string }`
  - `CRM_SYNC_PATH = '/api/crm/sync'`

**Contract:** retryable failures (429, 5xx, timeout) are **thrown** so the route returns 500 and QStash retries. Terminal outcomes are **returned** so the route returns 200.

- [x] **Step 1: Write the failing test**

Create `src/lib/crm/sync.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runCrmSync } from './sync'
import { AppError } from '@/lib/errors/app-error'
import type { CrmProvider } from './provider'

const hoisted = vi.hoisted(() => ({
  getCrmConnectionForClient: vi.fn(),
  markCrmConnectionError: vi.fn(),
  updateCrmConnectionTokens: vi.fn(),
  getCaseCrmLink: vi.fn(),
  ensureCaseCrmLink: vi.fn(),
  claimCrmSync: vi.fn(),
  updateCaseCrmLinkIds: vi.fn(),
  markCrmSyncResult: vi.fn(),
  getCaseById: vi.fn(),
  listActiveLeadsForCase: vi.fn(),
  getCampaignForCase: vi.fn(),
  getCrmProvider: vi.fn(),
  parseCrmTokens: vi.fn(),
  encryptCrmTokens: vi.fn(),
}))

vi.mock('@/lib/db/crm-connections', () => ({
  getCrmConnectionForClient: hoisted.getCrmConnectionForClient,
  markCrmConnectionError: hoisted.markCrmConnectionError,
  updateCrmConnectionTokens: hoisted.updateCrmConnectionTokens,
}))
vi.mock('@/lib/db/case-crm-links', () => ({
  getCaseCrmLink: hoisted.getCaseCrmLink,
  ensureCaseCrmLink: hoisted.ensureCaseCrmLink,
  claimCrmSync: hoisted.claimCrmSync,
  updateCaseCrmLinkIds: hoisted.updateCaseCrmLinkIds,
  markCrmSyncResult: hoisted.markCrmSyncResult,
}))
vi.mock('@/lib/db/cases', () => ({ getCaseById: hoisted.getCaseById }))
vi.mock('@/lib/db/leads', () => ({ listActiveLeadsForCase: hoisted.listActiveLeadsForCase }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: hoisted.getCampaignForCase }))
vi.mock('./registry', () => ({ getCrmProvider: hoisted.getCrmProvider }))
vi.mock('./tokens', () => ({
  parseCrmTokens: hoisted.parseCrmTokens,
  encryptCrmTokens: hoisted.encryptCrmTokens,
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: vi.fn(), logError: vi.fn() }))

const supabase = {} as never
const now = new Date('2026-08-02T12:00:00.000Z')

const credentials = { kind: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00.000Z' }

function connection(overrides: Record<string, unknown> = {}) {
  return {
    id: 'conn-1',
    client_id: 'c1',
    provider: 'hubspot',
    account_ref: '123',
    oauth: { v: 1 },
    pipeline_id: 'p1',
    initial_stage_id: 's1',
    won_stage_id: 's9',
    lost_stage_id: 's10',
    status: 'connected',
    ...overrides,
  }
}

function link(overrides: Record<string, unknown> = {}) {
  return {
    id: 'link-1',
    case_id: 'case-1',
    external_company_id: null,
    external_contact_ids: [],
    external_deal_id: null,
    external_deal_url: null,
    ...overrides,
  }
}

function fakeProvider(): CrmProvider {
  return {
    provider: 'hubspot',
    buildAuthUrl: vi.fn(),
    exchangeCode: vi.fn(),
    listPipelines: vi.fn(),
    upsertCompany: vi.fn().mockResolvedValue({ externalId: 'co-1', tokens: credentials }),
    upsertContact: vi.fn().mockResolvedValue({ externalId: 'ct-1', tokens: credentials }),
    createDeal: vi.fn().mockResolvedValue({ externalId: 'deal-1', url: 'https://crm/deal/1', tokens: credentials }),
    moveDeal: vi.fn().mockResolvedValue({ tokens: credentials }),
    addDealNote: vi.fn().mockResolvedValue({ tokens: credentials }),
  } as unknown as CrmProvider
}

let provider: CrmProvider

beforeEach(() => {
  vi.clearAllMocks()
  provider = fakeProvider()
  hoisted.getCrmProvider.mockReturnValue(provider)
  hoisted.parseCrmTokens.mockReturnValue(credentials)
  hoisted.encryptCrmTokens.mockReturnValue({ v: 1 })
  hoisted.getCaseById.mockResolvedValue({
    id: 'case-1', client_id: 'c1', company_name: 'Acme', company_domain: 'acme.com', summary: 'Growing fast.',
  })
  hoisted.getCampaignForCase.mockResolvedValue({ id: 'camp-1', name: 'Q3 Outbound' })
  hoisted.listActiveLeadsForCase.mockResolvedValue([
    { email: 'ada@acme.com', full_name: 'Ada Lovelace', title: 'CTO', linkedin_url: null,
      company_name: 'Acme', email_status: 'verified', status: 'active' },
  ])
  hoisted.getCrmConnectionForClient.mockResolvedValue(connection())
  hoisted.ensureCaseCrmLink.mockResolvedValue(link())
  hoisted.claimCrmSync.mockResolvedValue(true)
  hoisted.getCaseCrmLink.mockResolvedValue(link())
})

describe('runCrmSync — preconditions', () => {
  it('should skip when the case does not exist', async () => {
    hoisted.getCaseById.mockResolvedValue(null)

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'case_not_found' })
  })

  it('should skip when the client has not connected a CRM', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(null)

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'no_connection' })
  })

  it('should skip when the connection has not finished pipeline selection', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(connection({ pipeline_id: null }))

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'setup_incomplete' })
  })

  it('should skip when the connection is parked in the error state', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(connection({ status: 'error' }))

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'skipped', reason: 'connection_errored' })
  })

  it('should report busy without touching the CRM when another worker holds the claim', async () => {
    hoisted.claimCrmSync.mockResolvedValue(false)

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'busy' })
    expect(provider.createDeal).not.toHaveBeenCalled()
  })
})

describe('runCrmSync — create path', () => {
  it('should create company, contact, and deal then record success', async () => {
    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome).toEqual({ kind: 'synced' })
    expect(provider.upsertCompany).toHaveBeenCalledWith(credentials, { name: 'Acme', domain: 'acme.com' })
    expect(provider.upsertContact).toHaveBeenCalledTimes(1)
    expect(provider.createDeal).toHaveBeenCalledWith(
      credentials,
      expect.objectContaining({
        title: 'Acme — Q3 Outbound',
        pipelineId: 'p1',
        stageId: 's1',
        companyExternalId: 'co-1',
        contactExternalIds: ['ct-1'],
        accountRef: '123',
      }),
    )
    expect(hoisted.markCrmSyncResult).toHaveBeenCalledWith(supabase, 'case-1', { status: 'ok' })
  })

  it('should persist each external id as it is obtained so a retry can resume', async () => {
    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(hoisted.updateCaseCrmLinkIds).toHaveBeenCalledWith(supabase, 'case-1', { externalCompanyId: 'co-1' })
    expect(hoisted.updateCaseCrmLinkIds).toHaveBeenCalledWith(supabase, 'case-1', { externalContactIds: ['ct-1'] })
    expect(hoisted.updateCaseCrmLinkIds).toHaveBeenCalledWith(supabase, 'case-1', {
      externalDealId: 'deal-1',
      externalDealUrl: 'https://crm/deal/1',
    })
  })

  it('should attach the dossier summary and case link as the creation note', async () => {
    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    const note = vi.mocked(provider.addDealNote).mock.calls[0]?.[2] ?? ''
    expect(note).toContain('Growing fast.')
    expect(note).toContain('/cases/case-1')
  })

  it('should skip the company step when it was already created by an earlier attempt', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_company_id: 'co-existing' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(provider.upsertCompany).not.toHaveBeenCalled()
    expect(provider.createDeal).toHaveBeenCalledWith(
      credentials,
      expect.objectContaining({ companyExternalId: 'co-existing' }),
    )
  })

  it('should never create a second deal once one is linked', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-existing' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'contacted', now })

    expect(provider.createDeal).not.toHaveBeenCalled()
    expect(provider.upsertCompany).not.toHaveBeenCalled()
  })

  it('should sync only leads that are verified, active, and have an email', async () => {
    hoisted.listActiveLeadsForCase.mockResolvedValue([
      { email: 'ada@acme.com', full_name: 'Ada', title: null, linkedin_url: null,
        company_name: 'Acme', email_status: 'verified', status: 'active' },
      { email: null, full_name: 'No Email', title: null, linkedin_url: null,
        company_name: 'Acme', email_status: 'verified', status: 'active' },
      { email: 'risky@acme.com', full_name: 'Risky', title: null, linkedin_url: null,
        company_name: 'Acme', email_status: 'risky', status: 'active' },
    ])

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(provider.upsertContact).toHaveBeenCalledTimes(1)
  })
})

describe('runCrmSync — reason handling', () => {
  it('should add a note without moving the deal for an intermediate reason', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'contacted', now })

    expect(provider.moveDeal).not.toHaveBeenCalled()
    expect(provider.addDealNote).toHaveBeenCalledWith(credentials, 'deal-1', expect.stringContaining('First outreach'))
  })

  it('should close the deal as won when the case is won', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'won', now })

    expect(provider.moveDeal).toHaveBeenCalledWith(credentials, 'deal-1', { kind: 'closed', outcome: 'won' })
  })

  it('should close the deal as lost when the case is lost', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'lost', now })

    expect(provider.moveDeal).toHaveBeenCalledWith(credentials, 'deal-1', { kind: 'closed', outcome: 'lost' })
  })

  it('should close the deal as lost when the follow-up sequence exhausts', async () => {
    hoisted.ensureCaseCrmLink.mockResolvedValue(link({ external_deal_id: 'deal-1' }))

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'dead', now })

    expect(provider.moveDeal).toHaveBeenCalledWith(credentials, 'deal-1', { kind: 'closed', outcome: 'lost' })
    expect(provider.addDealNote).toHaveBeenCalledWith(credentials, 'deal-1', expect.stringContaining('No reply'))
  })
})

describe('runCrmSync — error handling', () => {
  it('should park the connection and stop retrying when the token was revoked', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 401', { status: 401 }),
    )

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome.kind).toBe('permanent_failure')
    expect(hoisted.markCrmConnectionError).toHaveBeenCalledWith(supabase, 'conn-1', 'token_revoked')
  })

  it('should rethrow so QStash retries when the CRM rate limits', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 429', { status: 429 }),
    )

    await expect(
      runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should rethrow so QStash retries when the CRM returns a server error', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }),
    )

    await expect(
      runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should rethrow so QStash retries when the CRM call times out', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'timed out', {}))

    await expect(
      runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should record a permanent failure and release the claim on a validation error', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 400', { status: 400 }),
    )

    const outcome = await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(outcome.kind).toBe('permanent_failure')
    expect(hoisted.markCrmSyncResult).toHaveBeenCalledWith(
      supabase, 'case-1', expect.objectContaining({ status: 'error' }),
    )
  })

  it('should release the claim even when the failure is retryable', async () => {
    vi.mocked(provider.upsertCompany).mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }),
    )

    await expect(runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })).rejects.toThrow()

    expect(hoisted.markCrmSyncResult).toHaveBeenCalled()
  })
})

describe('runCrmSync — token persistence', () => {
  it('should persist refreshed credentials as soon as a call rotates them', async () => {
    const rotated = { ...credentials, accessToken: 'at-2', refreshToken: 'rt-2' }
    vi.mocked(provider.upsertCompany).mockResolvedValue({ externalId: 'co-1', tokens: rotated })

    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(hoisted.encryptCrmTokens).toHaveBeenCalledWith(rotated)
    expect(hoisted.updateCrmConnectionTokens).toHaveBeenCalledWith(supabase, 'conn-1', { v: 1 })
  })

  it('should not write credentials back when nothing was refreshed', async () => {
    await runCrmSync(supabase, { caseId: 'case-1', reason: 'qualified', now })

    expect(hoisted.updateCrmConnectionTokens).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/crm/sync.test.ts`
Expected: FAIL — cannot resolve `./sync`.

- [x] **Step 3: Write the implementation**

Create `src/lib/crm/sync.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById } from '@/lib/db/cases'
import { listActiveLeadsForCase } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import {
  getCrmConnectionForClient, markCrmConnectionError, updateCrmConnectionTokens,
  type CrmConnectionRow,
} from '@/lib/db/crm-connections'
import {
  claimCrmSync, ensureCaseCrmLink, markCrmSyncResult, updateCaseCrmLinkIds,
} from '@/lib/db/case-crm-links'
import { getCrmProvider } from './registry'
import { encryptCrmTokens, parseCrmTokens, type CrmOAuthCredentials } from './tokens'
import { isSyncableLead, toCompanyInput, toContactInput, toCreationNote, toDealTitle } from './mapping'
import type { CrmDealTarget } from './provider'

export const CRM_SYNC_PATH = '/api/crm/sync'

export type CrmSyncReason =
  | 'qualified'
  | 'contacted'
  | 'in_conversation'
  | 'hot_handoff'
  | 'won'
  | 'lost'
  | 'dead'

export type CrmSyncOutcome =
  | { kind: 'synced' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'busy' }
  | { kind: 'permanent_failure'; message: string }

export interface RunCrmSyncInput {
  caseId: string
  reason: CrmSyncReason
  now: Date
}

function assertNever(value: never): never {
  throw new AppError('INVARIANT_VIOLATION', 'Unhandled CRM sync reason', { value: String(value) })
}

/** What gets written on the Deal for each reason, beyond creation. */
function noteForReason(reason: CrmSyncReason): string {
  switch (reason) {
    case 'qualified':      return 'Qualified by the outreach agent.'
    case 'contacted':      return 'First outreach sent.'
    case 'in_conversation':return 'Prospect replied — conversation in progress.'
    case 'hot_handoff':    return 'Hot handoff — ready for your team to take over.'
    case 'won':            return 'Marked won.'
    case 'lost':           return 'Marked lost.'
    case 'dead':           return 'No reply after the full follow-up sequence.'
    default:               return assertNever(reason)
  }
}

/**
 * Stage moves only for outcomes we can identify unambiguously. We know the
 * client's initial, won, and lost stages because they told us or the provider
 * flagged them; we do not know what their intermediate stages mean, and
 * guessing would corrupt their forecast.
 */
function dealTargetForReason(reason: CrmSyncReason): CrmDealTarget | null {
  switch (reason) {
    case 'qualified':
    case 'contacted':
    case 'in_conversation':
    case 'hot_handoff':
      return null
    case 'won':
      return { kind: 'closed', outcome: 'won' }
    case 'lost':
    case 'dead':
      return { kind: 'closed', outcome: 'lost' }
    default:
      return assertNever(reason)
  }
}

type FailureClass = 'auth' | 'retryable' | 'permanent'

function classifyFailure(error: unknown): FailureClass {
  if (!isAppError(error)) return 'permanent'
  if (error.code === 'EXTERNAL_TIMEOUT') return 'retryable'
  if (error.code !== 'EXTERNAL_ERROR') return 'permanent'

  const status = error.context.status
  if (typeof status !== 'number') return 'permanent'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status >= 500) return 'retryable'
  return 'permanent'
}

/**
 * Fire-and-forget entry point for the pipeline. Never throws: a CRM sync must
 * not be able to fail a case status transition that already succeeded.
 * Short-circuits before publishing for clients with no usable connection, so
 * the common case costs one indexed read.
 */
export async function enqueueCrmSync(caseId: string, reason: CrmSyncReason): Promise<void> {
  try {
    const supabase = createAdminClient()
    const kase = await getCaseById(supabase, caseId)
    if (!kase) return
    const connection = await getCrmConnectionForClient(supabase, kase.client_id)
    if (!connection || !connection.pipeline_id || connection.status !== 'connected') return
    await publishJson(CRM_SYNC_PATH, { caseId, reason })
  } catch (error) {
    await logError({
      clientId: null,
      caseId,
      actor: 'system:crm',
      type: 'crm.enqueue_failed',
      source: 'crm',
      error,
      payload: { reason },
    })
  }
}

/** Guards the pipeline-selection columns so the sync body can treat them as set. */
interface ReadyConnection extends CrmConnectionRow {
  pipeline_id: string
  initial_stage_id: string
}

function isReady(connection: CrmConnectionRow): connection is ReadyConnection {
  return connection.pipeline_id !== null && connection.initial_stage_id !== null
}

export async function runCrmSync(
  supabase: SupabaseClient<Database>,
  { caseId, reason, now }: RunCrmSyncInput,
): Promise<CrmSyncOutcome> {
  const kase = await getCaseById(supabase, caseId)
  if (!kase) return { kind: 'skipped', reason: 'case_not_found' }

  const connection = await getCrmConnectionForClient(supabase, kase.client_id)
  if (!connection) return { kind: 'skipped', reason: 'no_connection' }
  if (connection.status !== 'connected') return { kind: 'skipped', reason: 'connection_errored' }
  if (!isReady(connection)) return { kind: 'skipped', reason: 'setup_incomplete' }

  const link = await ensureCaseCrmLink(supabase, {
    clientId: kase.client_id,
    caseId,
    crmConnectionId: connection.id,
  })

  // Single-flight: a loser must not proceed, or two concurrent transitions on
  // one case would create two Deals.
  const claimed = await claimCrmSync(supabase, caseId, now)
  if (!claimed) return { kind: 'busy' }

  const provider = getCrmProvider(connection.provider)
  let credentials: CrmOAuthCredentials = parseCrmTokens(connection.oauth, connection.id)

  /**
   * Runs one provider call and persists rotated credentials immediately.
   * Immediately, not at the end: Pipedrive rotates the refresh token on every
   * refresh, so crashing before the write would leave the stored token dead.
   */
  async function call<T>(
    invoke: (creds: CrmOAuthCredentials) => Promise<T & { tokens: CrmOAuthCredentials }>,
  ): Promise<T> {
    const result = await invoke(credentials)
    if (result.tokens.accessToken !== credentials.accessToken) {
      credentials = result.tokens
      await updateCrmConnectionTokens(supabase, connection.id, encryptCrmTokens(result.tokens))
    }
    return result
  }

  try {
    let companyId = link.external_company_id
    let contactIds = link.external_contact_ids
    let dealId = link.external_deal_id

    // Create-or-update runs on ANY reason, which is what lets a client who
    // connects mid-campaign pick up existing cases at their next transition.
    if (dealId === null) {
      const leads = (await listActiveLeadsForCase(supabase, caseId)).filter(isSyncableLead)

      if (companyId === null) {
        const company = await call((creds) => provider.upsertCompany(creds, toCompanyInput(kase)))
        companyId = company.externalId
        await updateCaseCrmLinkIds(supabase, caseId, { externalCompanyId: companyId })
      }

      if (contactIds.length === 0 && leads.length > 0) {
        const created: string[] = []
        for (const lead of leads) {
          const contact = await call((creds) => provider.upsertContact(creds, toContactInput(lead)))
          created.push(contact.externalId)
        }
        contactIds = created
        await updateCaseCrmLinkIds(supabase, caseId, { externalContactIds: contactIds })
      }

      const campaign = await getCampaignForCase(supabase, caseId)
      const deal = await call((creds) =>
        provider.createDeal(creds, {
          title: toDealTitle(kase.company_name, campaign?.name ?? null),
          pipelineId: connection.pipeline_id,
          stageId: connection.initial_stage_id,
          companyExternalId: companyId,
          contactExternalIds: contactIds,
          accountRef: connection.account_ref,
        }),
      )
      dealId = deal.externalId
      await updateCaseCrmLinkIds(supabase, caseId, {
        externalDealId: deal.externalId,
        externalDealUrl: deal.url,
      })

      const createdDealId = deal.externalId
      await call((creds) =>
        provider.addDealNote(
          creds,
          createdDealId,
          toCreationNote({
            summary: kase.summary,
            caseUrl: new URL(`/cases/${caseId}`, env.APP_URL).toString(),
            companyDomain: kase.company_domain,
            leads,
          }),
        ),
      )
    }

    const target = dealTargetForReason(reason)
    // `dealId` is non-null here: either it was already linked, or the create
    // branch above assigned it. The narrowing is re-stated for the compiler.
    const activeDealId = dealId
    if (activeDealId !== null) {
      if (target !== null) {
        await call((creds) => provider.moveDeal(creds, activeDealId, target))
      }
      if (reason !== 'qualified') {
        await call((creds) => provider.addDealNote(creds, activeDealId, noteForReason(reason)))
      }
    }

    await markCrmSyncResult(supabase, caseId, { status: 'ok' })
    await logEventSafe({
      clientId: kase.client_id,
      caseId,
      actor: 'system:crm',
      type: 'crm.synced',
      source: 'crm',
      payload: { provider: connection.provider, reason, dealId: activeDealId },
    })
    return { kind: 'synced' }
  } catch (error) {
    const failure = classifyFailure(error)
    const message = error instanceof Error ? error.message : String(error)

    // Always release the claim, whatever the outcome — a held claim would block
    // the retry we are about to ask QStash for.
    await markCrmSyncResult(supabase, caseId, { status: 'error', message })

    if (failure === 'auth') {
      await markCrmConnectionError(supabase, connection.id, 'token_revoked')
    }
    await logError({
      clientId: kase.client_id,
      caseId,
      actor: 'system:crm',
      type: 'crm.sync_failed',
      source: 'crm',
      error,
      payload: { reason, failure },
    })

    // Retryable failures propagate so the route returns 500 and QStash retries.
    // Auth and validation failures are terminal — retrying cannot help.
    if (failure === 'retryable') throw error
    return { kind: 'permanent_failure', message }
  }
}
```

`logError` takes `{ clientId, caseId, actor, type, source, error, payload }` — `source` is required and `payload` (not `context`) carries the extra fields. `source: 'crm'` is the enum value added by the Task 1 migration; if `pnpm typecheck` rejects it, `src/types/database.ts` was not regenerated after that migration. Also add `'crm'` to the `LOG_SOURCES` array in `src/types/logs.ts` so it appears in the Logs tab source filter.

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/crm/sync.test.ts`
Expected: PASS, 22 tests.

- [x] **Step 5: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/lib/crm/sync.ts src/lib/crm/sync.test.ts
git commit -m "feat: add CRM sync orchestration with single-flight claim and resumable creates"
```

---

### Task 9: Sync worker route

A thin adapter, per `QUALITY.md`: verify signature → validate body → delegate → map the outcome union to a status code. All logic lives in `runCrmSync`.

**Files:**
- Create: `src/app/api/crm/sync/route.ts`
- Create: `src/app/api/crm/sync/route.test.ts`

**Interfaces:**
- Consumes: `runCrmSync`, `CrmSyncReason` (Task 8); `verifyQstashSignature`; `createAdminClient`.
- Produces: `POST /api/crm/sync`.

**Status-code contract:** `busy` and retryable throws → **500** (QStash retries). `synced`, `skipped`, `permanent_failure` → **200**. Signature failure → **401**. Bad body → **400**.

- [x] **Step 1: Write the failing test**

Create `src/app/api/crm/sync/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

const hoisted = vi.hoisted(() => ({
  verifyQstashSignature: vi.fn(),
  runCrmSync: vi.fn(),
}))

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: hoisted.verifyQstashSignature }))
vi.mock('@/lib/crm/sync', () => ({ runCrmSync: hoisted.runCrmSync }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logError: vi.fn() }))

const caseId = '11111111-2222-3333-4444-555555555555'

function request(): Request {
  return new Request('https://app.test/api/crm/sync', { method: 'POST' })
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.verifyQstashSignature.mockResolvedValue(JSON.stringify({ caseId, reason: 'qualified' }))
  hoisted.runCrmSync.mockResolvedValue({ kind: 'synced' })
})

describe('POST /api/crm/sync', () => {
  it('should return 401 when the QStash signature is missing or invalid', async () => {
    hoisted.verifyQstashSignature.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))

    expect((await POST(request())).status).toBe(401)
  })

  it('should return 400 when the body is not valid JSON', async () => {
    hoisted.verifyQstashSignature.mockResolvedValue('not json')

    expect((await POST(request())).status).toBe(400)
  })

  it('should return 400 when the case id is not a uuid', async () => {
    hoisted.verifyQstashSignature.mockResolvedValue(JSON.stringify({ caseId: 'nope', reason: 'qualified' }))

    expect((await POST(request())).status).toBe(400)
  })

  it('should return 400 when the reason is outside the allowed set', async () => {
    hoisted.verifyQstashSignature.mockResolvedValue(JSON.stringify({ caseId, reason: 'invented' }))

    expect((await POST(request())).status).toBe(400)
  })

  it('should return 200 when the sync succeeds', async () => {
    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true })
    expect(hoisted.runCrmSync).toHaveBeenCalledWith({}, expect.objectContaining({ caseId, reason: 'qualified' }))
  })

  it('should return 200 with the reason when the sync is skipped', async () => {
    hoisted.runCrmSync.mockResolvedValue({ kind: 'skipped', reason: 'no_connection' })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: true, skipped: 'no_connection' })
  })

  it('should return 500 so QStash retries when another worker holds the claim', async () => {
    hoisted.runCrmSync.mockResolvedValue({ kind: 'busy' })

    expect((await POST(request())).status).toBe(500)
  })

  it('should return 200 when the failure is permanent and retrying cannot help', async () => {
    hoisted.runCrmSync.mockResolvedValue({ kind: 'permanent_failure', message: 'bad field' })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({ ok: false, error: 'bad field' })
  })

  it('should return 500 so QStash retries when the sync throws a retryable error', async () => {
    hoisted.runCrmSync.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'HTTP 503', { status: 503 }))

    expect((await POST(request())).status).toBe(500)
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/api/crm/sync/route.test.ts`
Expected: FAIL — cannot resolve `./route`.

- [x] **Step 3: Write the route**

Create `src/app/api/crm/sync/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCrmSync } from '@/lib/crm/sync'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({
  caseId: z.string().uuid(),
  reason: z.enum(['qualified', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead']),
})

export async function POST(request: Request): Promise<NextResponse> {
  let caseId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsed = bodySchema.safeParse(JSON.parse(rawBody))
    if (!parsed.success) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    caseId = parsed.data.caseId

    const outcome = await runCrmSync(createAdminClient(), {
      caseId: parsed.data.caseId,
      reason: parsed.data.reason,
      now: new Date(),
    })

    switch (outcome.kind) {
      case 'synced':
        return NextResponse.json({ ok: true })
      case 'skipped':
        return NextResponse.json({ ok: true, skipped: outcome.reason })
      case 'permanent_failure':
        // 200 on purpose: retrying an invalid payload or a revoked grant just
        // burns quota. The failure is already recorded on the link row.
        return NextResponse.json({ ok: false, error: outcome.message })
      case 'busy':
        // 500 on purpose: another worker holds the claim, so this delivery must
        // come back rather than be dropped.
        return NextResponse.json({ error: 'sync_in_progress' }, { status: 500 })
      default: {
        const exhaustive: never = outcome
        throw new AppError('INVARIANT_VIOLATION', 'Unhandled CRM sync outcome', {
          outcome: String(exhaustive),
        })
      }
    }
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    if (error instanceof SyntaxError) {
      return NextResponse.json({ error: 'invalid_body' }, { status: 400 })
    }
    await logError({
      clientId: null,
      caseId,
      actor: 'system:crm',
      type: 'crm.sync_route_failed',
      source: 'crm',
      error,
    })
    return NextResponse.json({ error: 'sync_failed' }, { status: 500 })
  }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/app/api/crm/sync/route.test.ts`
Expected: PASS, 9 tests.

- [x] **Step 5: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/app/api/crm/sync/route.ts src/app/api/crm/sync/route.test.ts
git commit -m "feat: add QStash-signed CRM sync worker route"
```

---

### Task 10: OAuth connect and callback routes

Mirrors `/api/mailboxes/google/{connect,callback}` with one deliberate inversion: these require `appUser.role === 'client'`, not operator. A mailbox is agency infrastructure; a CRM account is the client's own property.

**Files:**
- Create: `src/app/api/crm/[provider]/state-cookie.ts`
- Create: `src/app/api/crm/[provider]/connect/route.ts`
- Create: `src/app/api/crm/[provider]/callback/route.ts`
- Create: `src/app/api/crm/[provider]/connect/route.test.ts`
- Create: `src/app/api/crm/[provider]/callback/route.test.ts`

**Interfaces:**
- Consumes: `getCrmProvider` (Task 7); `encryptCrmTokens` (Task 2); `upsertCrmConnection` (Task 4); `requireUser`; `timingSafeEqualString`; `createAdminClient`; `logEvent`.
- Produces: `GET /api/crm/hubspot/connect`, `GET /api/crm/hubspot/callback`, and the same pair for `pipedrive`.

- [x] **Step 1: Write the shared state-cookie module**

Create `src/app/api/crm/[provider]/state-cookie.ts`:

```ts
export const CRM_OAUTH_STATE_COOKIE = 'crm_oauth_state'
export const CRM_OAUTH_STATE_COOKIE_PATH = '/api/crm'
/** Long enough to complete a consent screen, short enough to limit replay. */
export const CRM_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600
```

- [x] **Step 2: Write the failing connect-route test**

Create `src/app/api/crm/[provider]/connect/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { CRM_OAUTH_STATE_COOKIE } from '../state-cookie'

const hoisted = vi.hoisted(() => ({ requireUser: vi.fn() }))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/crm/registry', () => ({
  getCrmProvider: () => ({ buildAuthUrl: (state: string) => `https://crm.test/auth?state=${state}` }),
}))

function params(provider: string) {
  return { params: Promise.resolve({ provider }) }
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
})

describe('GET /api/crm/[provider]/connect', () => {
  it('should redirect to the provider consent screen and set the state cookie', async () => {
    const response = await GET(new Request('https://app.test/api/crm/hubspot/connect'), params('hubspot'))

    expect(response.status).toBe(307)
    const location = response.headers.get('location') ?? ''
    expect(location).toContain('https://crm.test/auth?state=')

    const cookie = response.headers.get('set-cookie') ?? ''
    expect(cookie).toContain(CRM_OAUTH_STATE_COOKIE)
    expect(cookie).toContain('HttpOnly')
    // The nonce in the cookie must be the same one sent to the provider.
    const state = new URL(location).searchParams.get('state') ?? ''
    expect(state.length).toBeGreaterThan(0)
    expect(cookie).toContain(state)
  })

  it('should reject an operator, because a CRM grant belongs to the client', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    expect((await GET(new Request('https://app.test/x'), params('hubspot'))).status).toBe(403)
  })

  it('should return 404 for a provider outside the supported set', async () => {
    expect((await GET(new Request('https://app.test/x'), params('salesforce'))).status).toBe(404)
  })
})
```

- [x] **Step 3: Write the connect route**

Create `src/app/api/crm/[provider]/connect/route.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { getCrmProvider } from '@/lib/crm/registry'
import { env } from '@/lib/env'
import {
  CRM_OAUTH_STATE_COOKIE,
  CRM_OAUTH_STATE_COOKIE_PATH,
  CRM_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from '../state-cookie'

export const runtime = 'nodejs'

const providerSchema = z.enum(['hubspot', 'pipedrive'])

interface RouteContext {
  params: Promise<{ provider: string }>
}

export async function GET(_request: Request, context: RouteContext): Promise<NextResponse> {
  const { appUser } = await requireUser()
  // Inverted vs. the mailbox flow on purpose: the CRM account belongs to the
  // client, so only a client-role session may authorize it.
  if (appUser.role !== 'client') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsedProvider = providerSchema.safeParse((await context.params).provider)
  if (!parsedProvider.success) {
    return NextResponse.json({ error: 'unknown_provider' }, { status: 404 })
  }

  // A random single-use nonce (not the user id) — the callback compares it to
  // this httpOnly cookie, which is what proves the callback came from the
  // browser that started the flow.
  const state = randomUUID()
  const response = NextResponse.redirect(getCrmProvider(parsedProvider.data).buildAuthUrl(state))
  response.cookies.set(CRM_OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    secure: env.APP_URL.startsWith('https://'),
    sameSite: 'lax',
    maxAge: CRM_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
    path: CRM_OAUTH_STATE_COOKIE_PATH,
  })
  return response
}
```

- [x] **Step 4: Write the failing callback-route test**

Create `src/app/api/crm/[provider]/callback/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { GET } from './route'
import { CRM_OAUTH_STATE_COOKIE } from '../state-cookie'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  exchangeCode: vi.fn(),
  upsertCrmConnection: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/crm/registry', () => ({
  getCrmProvider: () => ({ exchangeCode: hoisted.exchangeCode }),
}))
vi.mock('@/lib/db/crm-connections', () => ({ upsertCrmConnection: hoisted.upsertCrmConnection }))
vi.mock('@/lib/crm/tokens', () => ({ encryptCrmTokens: () => ({ v: 1 }) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: vi.fn() }))

const STATE = 'nonce-abc'

function params(provider = 'hubspot') {
  return { params: Promise.resolve({ provider }) }
}

function request(search: string, cookieState: string | null = STATE): Request {
  const headers = new Headers()
  if (cookieState !== null) headers.set('cookie', `${CRM_OAUTH_STATE_COOKIE}=${cookieState}`)
  return new Request(`https://app.test/api/crm/hubspot/callback${search}`, { headers })
}

function locationOf(response: Response): string {
  return response.headers.get('location') ?? ''
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.exchangeCode.mockResolvedValue({
    tokens: { kind: 'oauth', accessToken: 'at', refreshToken: 'rt', expiresAt: '2099-01-01T00:00:00.000Z' },
    accountLabel: 'Acme Portal',
    accountRef: '123',
  })
  hoisted.upsertCrmConnection.mockResolvedValue({ id: 'conn-1' })
})

describe('GET /api/crm/[provider]/callback', () => {
  it('should store the connection and redirect to setup when the exchange succeeds', async () => {
    const response = await GET(request(`?code=the-code&state=${STATE}`), params())

    expect(hoisted.upsertCrmConnection).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ clientId: 'c1', provider: 'hubspot', accountLabel: 'Acme Portal', accountRef: '123' }),
    )
    expect(locationOf(response)).toContain('/settings/crm?connect=hubspot')
  })

  it('should reject the callback when the state does not match the cookie', async () => {
    const response = await GET(request('?code=the-code&state=forged'), params())

    expect(hoisted.upsertCrmConnection).not.toHaveBeenCalled()
    expect(locationOf(response)).toContain('error=oauth')
  })

  it('should reject the callback when no state cookie is present', async () => {
    const response = await GET(request(`?code=the-code&state=${STATE}`, null), params())

    expect(locationOf(response)).toContain('error=oauth')
  })

  it('should reject the callback when the provider returned no code', async () => {
    const response = await GET(request(`?state=${STATE}`), params())

    expect(locationOf(response)).toContain('error=oauth')
  })

  it('should redirect with the error code when the exchange fails', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    hoisted.exchangeCode.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'boom'))

    const response = await GET(request(`?code=the-code&state=${STATE}`), params())

    expect(locationOf(response)).toContain('error=EXTERNAL_ERROR')
  })

  it('should reject an operator, because a CRM grant belongs to the client', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    expect((await GET(request(`?code=c&state=${STATE}`), params())).status).toBe(403)
  })

  it('should return 404 for a provider outside the supported set', async () => {
    expect((await GET(request(`?code=c&state=${STATE}`), params('salesforce'))).status).toBe(404)
  })
})
```

- [x] **Step 5: Write the callback route**

Create `src/app/api/crm/[provider]/callback/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCrmProvider } from '@/lib/crm/registry'
import { encryptCrmTokens } from '@/lib/crm/tokens'
import { upsertCrmConnection } from '@/lib/db/crm-connections'
import { logEvent } from '@/lib/events/log-event'
import { timingSafeEqualString } from '@/lib/auth/timing-safe-equal'
import { isAppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'
import { CRM_OAUTH_STATE_COOKIE } from '../state-cookie'

export const runtime = 'nodejs'

const providerSchema = z.enum(['hubspot', 'pipedrive'])

interface RouteContext {
  params: Promise<{ provider: string }>
}

function redirectAndClearState(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, env.APP_URL))
  response.cookies.delete(CRM_OAUTH_STATE_COOKIE)
  return response
}

/**
 * NextRequest's typed cookie jar is not available on the plain Request this
 * handler receives, so the state cookie is read off the raw header.
 */
function readStateCookie(request: Request): string | undefined {
  return (request.headers.get('cookie') ?? '')
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${CRM_OAUTH_STATE_COOKIE}=`))
    ?.slice(CRM_OAUTH_STATE_COOKIE.length + 1)
}

export async function GET(request: Request, context: RouteContext): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const parsedProvider = providerSchema.safeParse((await context.params).provider)
  if (!parsedProvider.success) {
    return NextResponse.json({ error: 'unknown_provider' }, { status: 404 })
  }
  const provider = parsedProvider.data

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const expectedState = readStateCookie(request)

  // The single-use nonce comparison IS the CSRF check. Without a match this
  // callback either was not initiated by this browser or is a replay.
  if (!code || !state || !expectedState || !timingSafeEqualString(state, expectedState)) {
    return redirectAndClearState('/settings/crm?error=oauth')
  }

  try {
    const exchange = await getCrmProvider(provider).exchangeCode(code)
    const admin = createAdminClient()
    const connection = await upsertCrmConnection(admin, {
      clientId: appUser.client_id,
      provider,
      accountLabel: exchange.accountLabel,
      accountRef: exchange.accountRef,
      oauth: encryptCrmTokens(exchange.tokens),
    })
    await logEvent({
      clientId: appUser.client_id,
      actor: `human:${appUser.id}`,
      type: 'crm.connected',
      source: 'crm',
      payload: { connectionId: connection.id, provider, accountLabel: exchange.accountLabel },
    })
    return redirectAndClearState(`/settings/crm?connect=${provider}`)
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return redirectAndClearState(`/settings/crm?error=${reason}`)
  }
}
```

- [x] **Step 6: Run both route tests to verify they pass**

Run: `pnpm vitest run src/app/api/crm`
Expected: PASS — 3 connect tests, 7 callback tests, plus the 9 sync tests from Task 9.

- [x] **Step 7: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add src/app/api/crm/
git commit -m "feat: add client-initiated CRM OAuth connect and callback routes"
```

---

### Task 11: `/settings/crm` page and Server Actions

Four states, all handled: no connection, setup incomplete, connected, errored. Client-role users get the interactive version; operators get read-only visibility so the agency can see whether a client is set up.

**Files:**
- Create: `src/app/(app)/settings/crm/page.tsx`
- Create: `src/app/(app)/settings/crm/loading.tsx`
- Create: `src/app/(app)/settings/crm/error.tsx`
- Create: `src/app/(app)/settings/crm/connect-crm-buttons.tsx`
- Create: `src/app/(app)/settings/crm/pipeline-picker.tsx`
- Create: `src/app/(app)/settings/crm/connection-card.tsx`
- Create: `src/app/(app)/settings/crm/actions.ts`
- Create: `src/app/(app)/settings/crm/actions.test.ts`
- Modify: `src/lib/db/case-crm-links.ts` (add `getLatestCrmSyncAt`)
- Modify: `src/lib/db/case-crm-links.test.ts`

**Interfaces:**
- Consumes: `getCrmConnectionForClient`, `updateCrmConnectionPipeline`, `deleteCrmConnection` (Task 4); `getCrmProvider` (Task 7); `parseCrmTokens` (Task 2); `requireUser`; `createServerClient` / `createAdminClient`.
- Produces: Server Actions `selectCrmPipeline(formData: FormData): Promise<void>` and `disconnectCrm(): Promise<void>`.

- [x] **Step 1: Write the failing actions test**

Create `src/app/(app)/settings/crm/actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { selectCrmPipeline, disconnectCrm } from './actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  getCrmConnectionForClient: vi.fn(),
  updateCrmConnectionPipeline: vi.fn(),
  deleteCrmConnection: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/crm-connections', () => ({
  getCrmConnectionForClient: hoisted.getCrmConnectionForClient,
  updateCrmConnectionPipeline: hoisted.updateCrmConnectionPipeline,
  deleteCrmConnection: hoisted.deleteCrmConnection,
}))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: vi.fn() }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(entries: Record<string, string>): FormData {
  const data = new FormData()
  for (const [key, value] of Object.entries(entries)) data.append(key, value)
  return data
}

const validForm = {
  pipelineId: 'p1',
  pipelineLabel: 'Sales',
  initialStageId: 's1',
  wonStageId: 's9',
  lostStageId: 's10',
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.getCrmConnectionForClient.mockResolvedValue({ id: 'conn-1', client_id: 'c1' })
})

describe('selectCrmPipeline', () => {
  it('should persist the selection for the caller own connection', async () => {
    await selectCrmPipeline(form(validForm))

    expect(hoisted.updateCrmConnectionPipeline).toHaveBeenCalledWith({}, 'conn-1', {
      pipelineId: 'p1',
      pipelineLabel: 'Sales',
      initialStageId: 's1',
      wonStageId: 's9',
      lostStageId: 's10',
    })
  })

  it('should store nulls when the provider reported no closed stages', async () => {
    await selectCrmPipeline(form({ pipelineId: 'p1', pipelineLabel: 'Sales', initialStageId: 's1' }))

    expect(hoisted.updateCrmConnectionPipeline).toHaveBeenCalledWith(
      {}, 'conn-1', expect.objectContaining({ wonStageId: null, lostStageId: null }),
    )
  })

  it('should reject an operator, who does not own the CRM grant', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(selectCrmPipeline(form(validForm))).rejects.toThrow()
    expect(hoisted.updateCrmConnectionPipeline).not.toHaveBeenCalled()
  })

  it('should reject when the caller has no connection to configure', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(null)

    await expect(selectCrmPipeline(form(validForm))).rejects.toThrow()
  })

  it('should reject a submission missing the required pipeline fields', async () => {
    await expect(selectCrmPipeline(form({ pipelineId: 'p1' }))).rejects.toThrow()
    expect(hoisted.updateCrmConnectionPipeline).not.toHaveBeenCalled()
  })
})

describe('disconnectCrm', () => {
  it('should delete the caller own connection', async () => {
    await disconnectCrm()

    expect(hoisted.deleteCrmConnection).toHaveBeenCalledWith({}, 'conn-1')
  })

  it('should reject an operator, who does not own the CRM grant', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(disconnectCrm()).rejects.toThrow()
    expect(hoisted.deleteCrmConnection).not.toHaveBeenCalled()
  })

  it('should no-op safely when there is nothing connected', async () => {
    hoisted.getCrmConnectionForClient.mockResolvedValue(null)

    await expect(disconnectCrm()).resolves.toBeUndefined()
    expect(hoisted.deleteCrmConnection).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Write the Server Actions**

Create `src/app/(app)/settings/crm/actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  deleteCrmConnection, getCrmConnectionForClient, updateCrmConnectionPipeline,
} from '@/lib/db/crm-connections'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings/crm'

const selectionSchema = z.object({
  pipelineId: z.string().min(1),
  pipelineLabel: z.string().min(1),
  initialStageId: z.string().min(1),
  // Absent whenever the provider does not model closure as a stage (Pipedrive).
  wonStageId: z.string().min(1).nullable().default(null),
  lostStageId: z.string().min(1).nullable().default(null),
})

export async function selectCrmPipeline(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may manage their CRM connection', { role: appUser.role })
  }

  const admin = createAdminClient()
  const connection = await getCrmConnectionForClient(admin, appUser.client_id)
  if (!connection) {
    throw new AppError('NOT_FOUND', 'No CRM connection to configure', { clientId: appUser.client_id })
  }

  const parsed = selectionSchema.safeParse({
    pipelineId: formData.get('pipelineId'),
    pipelineLabel: formData.get('pipelineLabel'),
    initialStageId: formData.get('initialStageId'),
    wonStageId: formData.get('wonStageId'),
    lostStageId: formData.get('lostStageId'),
  })
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Pipeline selection is incomplete', {
      issues: parsed.error.flatten(),
    })
  }

  await updateCrmConnectionPipeline(admin, connection.id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'crm.pipeline_selected',
    source: 'crm',
    payload: { connectionId: connection.id, pipelineId: parsed.data.pipelineId },
  })
  revalidatePath(SETTINGS_PATH)
}

export async function disconnectCrm(): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may manage their CRM connection', { role: appUser.role })
  }

  const admin = createAdminClient()
  const connection = await getCrmConnectionForClient(admin, appUser.client_id)
  // Already disconnected — nothing to do, and surfacing an error here would
  // just confuse someone who double-submitted.
  if (!connection) return

  await deleteCrmConnection(admin, connection.id)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'crm.disconnected',
    source: 'crm',
    payload: { connectionId: connection.id, provider: connection.provider },
  })
  revalidatePath(SETTINGS_PATH)
}
```

The session → role → ownership chain is deliberately inlined in both actions rather than extracted: `disconnectCrm` must tolerate a missing connection while `selectCrmPipeline` must reject one, so a shared helper would need a flag parameter — worse than the four duplicated lines.

Also change the two closed-stage reads to normalize the empty string the form submits when a provider reports no closed stages:

```ts
    wonStageId: formData.get('wonStageId') || null,
    lostStageId: formData.get('lostStageId') || null,
```

- [x] **Step 3: Run the actions test to verify it passes**

Run: `pnpm vitest run "src/app/(app)/settings/crm/actions.test.ts"`
Expected: PASS, 8 tests.

- [x] **Step 3b: Add the last-sync lookup the connection card needs**

The card shows when the connection last did anything, but `last_synced_at` lives per case link, not on the connection. Append to `src/lib/db/case-crm-links.ts`:

```ts
/** Most recent successful-or-failed sync across all of a connection's cases. */
export async function getLatestCrmSyncAt(
  supabase: SupabaseClient<Database>,
  crmConnectionId: string,
): Promise<string | null> {
  const { data, error } = await supabase
    .from('case_crm_links')
    .select('last_synced_at')
    .eq('crm_connection_id', crmConnectionId)
    .not('last_synced_at', 'is', null)
    .order('last_synced_at', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load latest CRM sync time', {
      crmConnectionId, cause: error.message,
    })
  }
  return data?.last_synced_at ?? null
}
```

Append to `src/lib/db/case-crm-links.test.ts`:

```ts
describe('getLatestCrmSyncAt', () => {
  function mockLatest(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({
        select: () => ({
          eq: () => ({
            not: () => ({
              order: () => ({ limit: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
            }),
          }),
        }),
      }),
    } as never
  }

  it('should return the timestamp when the connection has synced at least once', async () => {
    const at = '2026-08-02T10:00:00.000Z'

    expect(await getLatestCrmSyncAt(mockLatest({ data: { last_synced_at: at }, error: null }), 'conn-1')).toBe(at)
  })

  it('should return null when nothing has synced yet', async () => {
    expect(await getLatestCrmSyncAt(mockLatest({ data: null, error: null }), 'conn-1')).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getLatestCrmSyncAt(mockLatest({ data: null, error: { message: 'boom' } }), 'conn-1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `getLatestCrmSyncAt` to the test file's import list. Run: `pnpm vitest run src/lib/db/case-crm-links.test.ts` — expected PASS, 17 tests.

- [ ] **Step 4: Write the connect buttons**

Create `src/app/(app)/settings/crm/connect-crm-buttons.tsx`, following the existing `connect-buttons.tsx` markup exactly:

```tsx
import { Plus, Buildings, Kanban } from '@phosphor-icons/react/dist/ssr'

const CRM_PROVIDERS = [
  { href: '/api/crm/hubspot/connect', label: 'HubSpot', icon: Buildings },
  { href: '/api/crm/pipedrive/connect', label: 'Pipedrive', icon: Kanban },
] as const

export function ConnectCrmButtons(): React.ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      {CRM_PROVIDERS.map(({ href, label, icon: Icon }) => (
        // A full page navigation into the OAuth consent screen, so this is an
        // anchor rather than a button with a click handler.
        <a
          key={href}
          href={href}
          className="border-hairline bg-surface hover:border-hairline-strong group flex items-center gap-3 rounded-lg border p-4 transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.99]"
        >
          <span className="bg-accent text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
            <Icon size={18} weight="light" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Connect {label}</span>
            <span className="text-faint block text-[11px]">Qualified leads are pushed to your pipeline</span>
          </span>
          <Plus
            size={15}
            weight="light"
            className="text-faint group-hover:text-foreground shrink-0 transition-colors duration-200"
          />
        </a>
      ))}
    </div>
  )
}
```

- [x] **Step 5: Write the pipeline picker**

Create `src/app/(app)/settings/crm/pipeline-picker.tsx`. A Client Component so the pending state is visible; the pipeline data is fetched server-side and passed as props (never fetched in a Client Component):

```tsx
'use client'

import { useState, useTransition } from 'react'
import type { CrmPipeline } from '@/lib/crm/provider'
import { selectCrmPipeline } from './actions'

interface PipelinePickerProps {
  pipelines: readonly CrmPipeline[]
}

export function PipelinePicker({ pipelines }: PipelinePickerProps): React.ReactElement {
  const [pipelineId, setPipelineId] = useState(pipelines[0]?.id ?? '')
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const selected = pipelines.find((pipeline) => pipeline.id === pipelineId) ?? null
  const stages = selected?.stages ?? []

  if (pipelines.length === 0) {
    return (
      <p className="text-muted-foreground text-[13px]">
        This account has no deal pipelines. Create one in your CRM, then reload this page.
      </p>
    )
  }

  function onSubmit(formData: FormData): void {
    setError(null)
    startTransition(async () => {
      try {
        await selectCrmPipeline(formData)
      } catch {
        setError('Could not save that selection. Please try again.')
      }
    })
  }

  return (
    <form action={onSubmit} className="flex flex-col gap-4">
      <input type="hidden" name="pipelineLabel" value={selected?.label ?? ''} />
      <input
        type="hidden"
        name="wonStageId"
        value={stages.find((stage) => stage.closedOutcome === 'won')?.id ?? ''}
      />
      <input
        type="hidden"
        name="lostStageId"
        value={stages.find((stage) => stage.closedOutcome === 'lost')?.id ?? ''}
      />

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Pipeline</span>
        <select
          name="pipelineId"
          value={pipelineId}
          onChange={(event) => setPipelineId(event.target.value)}
          className="border-hairline bg-surface rounded-md border px-3 py-2 text-[13px]"
        >
          {pipelines.map((pipeline) => (
            <option key={pipeline.id} value={pipeline.id}>{pipeline.label}</option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1.5">
        <span className="text-[13px] font-medium">Stage for new deals</span>
        <select
          name="initialStageId"
          defaultValue={stages[0]?.id ?? ''}
          key={pipelineId}
          className="border-hairline bg-surface rounded-md border px-3 py-2 text-[13px]"
        >
          {stages.map((stage) => (
            <option key={stage.id} value={stage.id}>{stage.label}</option>
          ))}
        </select>
      </label>

      {error ? <p className="text-[12px] text-red-600">{error}</p> : null}

      <button
        type="submit"
        disabled={isPending || stages.length === 0}
        className="border-hairline bg-surface hover:border-hairline-strong self-start rounded-md border px-3 py-2 text-[13px] font-medium disabled:opacity-50"
      >
        {isPending ? 'Saving…' : 'Save and start syncing'}
      </button>
    </form>
  )
}
```

The empty `value=""` on the hidden won/lost inputs is what makes the action's `.nullable().default(null)` fire — normalize `''` to `null` in the action by reading `formData.get(...) || null` for those two fields.

- [x] **Step 6: Write the connection card**

Create `src/app/(app)/settings/crm/connection-card.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { disconnectCrm } from './actions'

interface ConnectionCardProps {
  provider: string
  accountLabel: string | null
  pipelineLabel: string | null
  lastSyncedAt: string | null
  canManage: boolean
}

function formatProvider(provider: string): string {
  return provider === 'hubspot' ? 'HubSpot' : 'Pipedrive'
}

export function ConnectionCard({
  provider, accountLabel, pipelineLabel, lastSyncedAt, canManage,
}: ConnectionCardProps): React.ReactElement {
  const [isConfirming, setIsConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()

  return (
    <div className="border-hairline bg-surface flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{formatProvider(provider)}</span>
        <span className="text-faint text-[11px]">{accountLabel ?? 'Connected account'}</span>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[12px]">
        <div>
          <dt className="text-faint">Pipeline</dt>
          <dd>{pipelineLabel ?? 'Not selected'}</dd>
        </div>
        <div>
          <dt className="text-faint">Last sync</dt>
          <dd>{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString('en-US') : 'Not yet'}</dd>
        </div>
      </dl>

      {canManage ? (
        isConfirming ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-[12px]">
              Syncing stops immediately. Records already created in {formatProvider(provider)} are left
              untouched, and reconnecting will not recreate them.
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(async () => { await disconnectCrm() })}
                className="rounded-md border border-red-600/40 px-3 py-1.5 text-[12px] font-medium text-red-600 disabled:opacity-50"
              >
                {isPending ? 'Disconnecting…' : 'Yes, disconnect'}
              </button>
              <button
                type="button"
                onClick={() => setIsConfirming(false)}
                className="border-hairline rounded-md border px-3 py-1.5 text-[12px]"
              >
                Cancel
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsConfirming(true)}
            className="border-hairline hover:border-hairline-strong self-start rounded-md border px-3 py-1.5 text-[12px]"
          >
            Disconnect
          </button>
        )
      ) : null}
    </div>
  )
}
```

- [x] **Step 7: Write the page plus its loading and error boundaries**

Create `src/app/(app)/settings/crm/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { Buildings } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getCrmConnectionForClient } from '@/lib/db/crm-connections'
import { getLatestCrmSyncAt } from '@/lib/db/case-crm-links'
import { getCrmProvider } from '@/lib/crm/registry'
import { parseCrmTokens } from '@/lib/crm/tokens'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import type { CrmPipeline } from '@/lib/crm/provider'
import { ConnectCrmButtons } from './connect-crm-buttons'
import { PipelinePicker } from './pipeline-picker'
import { ConnectionCard } from './connection-card'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'CRM' }

export default async function CrmSettingsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // RLS-scoped on purpose: the admin client would show a client-role user
  // another tenant's connection.
  const supabase = await createServerClient()
  const connection = appUser.client_id
    ? await getCrmConnectionForClient(supabase, appUser.client_id)
    : null
  const canManage = appUser.role === 'client'

  // Only fetched for the setup-incomplete state — a connected client does not
  // need a live pipeline list on every page load.
  let pipelines: CrmPipeline[] = []
  if (connection && connection.status === 'connected' && connection.pipeline_id === null) {
    const provider = getCrmProvider(connection.provider)
    const credentials = parseCrmTokens(connection.oauth, connection.id)
    pipelines = (await provider.listPipelines(credentials)).pipelines
  }

  const lastSyncedAt = connection ? await getLatestCrmSyncAt(supabase, connection.id) : null

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader
        title="CRM"
        description="Connect your CRM and qualified companies are pushed to it as deals, with notes as each one progresses."
      />

      {connection === null ? (
        <Section title="Connect a CRM">
          <EmptyState
            icon={Buildings}
            title="No CRM connected"
            description="Qualified companies stay in this app until you connect a CRM."
          />
          {canManage ? <div className="mt-4"><ConnectCrmButtons /></div> : null}
        </Section>
      ) : connection.status === 'error' ? (
        <Section title="Reconnect required">
          <div className="border-hairline rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <p className="text-[13px] font-medium">Syncing is paused</p>
            <p className="text-muted-foreground mt-1 text-[12px]">
              Your CRM rejected our access ({connection.status_reason ?? 'unknown reason'}). Reconnect to
              resume pushing qualified companies.
            </p>
          </div>
          {canManage ? <div className="mt-4"><ConnectCrmButtons /></div> : null}
        </Section>
      ) : connection.pipeline_id === null ? (
        <Section title="Choose where deals land">
          {canManage ? (
            <PipelinePicker pipelines={pipelines} />
          ) : (
            <p className="text-muted-foreground text-[13px]">
              This client has connected {connection.provider} but has not chosen a pipeline yet.
            </p>
          )}
        </Section>
      ) : (
        <Section title="Connected CRM">
          <ConnectionCard
            provider={connection.provider}
            accountLabel={connection.account_label}
            pipelineLabel={connection.pipeline_label}
            lastSyncedAt={lastSyncedAt}
            canManage={canManage}
          />
        </Section>
      )}
    </div>
  )
}
```

Create `src/app/(app)/settings/crm/loading.tsx` and `error.tsx` by copying the shape of the existing `src/app/(app)/inbox/loading.tsx` and `error.tsx` — same components, title "CRM".

- [x] **Step 8: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

Then check the page renders in all four states by temporarily forcing each branch, or trust the branch coverage and verify after Task 13 with a real connection.

```bash
git add "src/app/(app)/settings/crm/"
git commit -m "feat: add CRM settings page with connect, pipeline picker, and disconnect"
```

---

### Task 12: Case-detail sync indicator

One read, one line of UI. Shows where the case landed in the client's CRM, or why it did not.

**Files:**
- Modify: `src/app/(app)/cases/[id]/page.tsx`
- Create: `src/app/(app)/cases/[id]/crm-link-badge.tsx`

**Interfaces:**
- Consumes: `getCaseCrmLink` (Task 5).
- Produces: `CrmLinkBadge` component.

- [x] **Step 1: Write the badge component**

Create `src/app/(app)/cases/[id]/crm-link-badge.tsx`:

```tsx
import { ArrowSquareOut, WarningCircle } from '@phosphor-icons/react/dist/ssr'

interface CrmLinkBadgeProps {
  provider: string
  dealUrl: string | null
  syncError: string | null
}

function formatProvider(provider: string): string {
  return provider === 'hubspot' ? 'HubSpot' : 'Pipedrive'
}

export function CrmLinkBadge({ provider, dealUrl, syncError }: CrmLinkBadgeProps): React.ReactElement | null {
  if (syncError) {
    return (
      <span className="text-faint inline-flex items-center gap-1.5 text-[12px]">
        <WarningCircle size={13} weight="light" />
        {formatProvider(provider)} sync failed: {syncError}
      </span>
    )
  }
  // A deal exists but the provider gave us no portal id to link to. Say so
  // rather than rendering a dead anchor.
  if (!dealUrl) return null

  return (
    <a
      href={dealUrl}
      target="_blank"
      rel="noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[12px] transition-colors"
    >
      Synced to {formatProvider(provider)}
      <ArrowSquareOut size={13} weight="light" />
    </a>
  )
}
```

- [x] **Step 2: Wire it into the case page**

In `src/app/(app)/cases/[id]/page.tsx`:

1. Add the imports:
```ts
import { getCaseCrmLink } from '@/lib/db/case-crm-links'
import { getCrmConnectionForClient } from '@/lib/db/crm-connections'
import { CrmLinkBadge } from './crm-link-badge'
```

2. Alongside the page's existing case load, add:
```ts
const crmLink = await getCaseCrmLink(supabase, caseId)
const crmConnection = crmLink ? await getCrmConnectionForClient(supabase, kase.client_id) : null
```
Use whatever the page already names its case id and case row variables.

3. Render inside the page header's metadata row (next to the status/updated-at line), so the badge sits with the other case-level facts:
```tsx
{crmLink && crmConnection ? (
  <CrmLinkBadge
    provider={crmConnection.provider}
    dealUrl={crmLink.external_deal_url}
    syncError={crmLink.last_sync_status === 'error' ? crmLink.last_sync_error : null}
  />
) : null}
```

- [x] **Step 3: Verify (commit skipped per user request)**

Run: `pnpm test && pnpm typecheck && pnpm lint`

```bash
git add "src/app/(app)/cases/[id]/"
git commit -m "feat: show CRM sync status on the case detail page"
```

---

### Task 13: Wire the pipeline call sites

Last on purpose: nothing fires until the worker and both providers are proven. Six one-line additions, each immediately after an existing `updateCaseStatus`.

**Files:**
- Modify: `src/lib/pipeline/research.ts:111`
- Modify: `src/lib/pipeline/write.ts:175`
- Modify: `src/lib/pipeline/reply.ts:273,286,297`
- Modify: `src/lib/pipeline/followup.ts:285`
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: `enqueueCrmSync`, `CrmSyncReason` (Task 8).
- Produces: nothing new.

- [x] **Step 1: Add the call sites**

In each file, add `import { enqueueCrmSync } from '@/lib/crm/sync'` to the internal-absolute import group, then insert the matching line **immediately after** the existing `updateCaseStatus` call:

| File | After the transition to | Line to add |
|---|---|---|
| `research.ts` | `'ready'` | `await enqueueCrmSync(input.caseId, 'qualified')` |
| `write.ts` | `'contacted'` | `await enqueueCrmSync(input.caseId, 'contacted')` |
| `reply.ts` | `'in_conversation'` | `await enqueueCrmSync(inbound.case_id, 'in_conversation')` |
| `reply.ts` | `'hot_handoff'` | `await enqueueCrmSync(inbound.case_id, 'hot_handoff')` |
| `reply.ts` | `'lost'` | `await enqueueCrmSync(inbound.case_id, 'lost')` |
| `followup.ts` | `'dead'` | `await enqueueCrmSync(sequence.case_id, 'dead')` |

`enqueueCrmSync` never throws, so no call site needs a try/catch. Match each file's existing variable name for the case id — the table above uses the names visible at those line numbers today; verify before editing, since earlier tasks may have shifted them.

- [x] **Step 2: Add a regression test for one call site**

`src/lib/pipeline/research.test.ts` declares its mocks as plain `vi.fn()` consts (not `vi.hoisted`), so follow that. Add next to the existing mock consts at the top:

```ts
const enqueueCrmSyncMock = vi.fn()
```

Add alongside the existing `vi.mock` calls:

```ts
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))
```

Add to the existing `beforeEach` reset line:

```ts
  enqueueCrmSyncMock.mockReset()
```

Then add these two tests inside the `describe('runResearchForCase', ...)` block:

```ts
  it('should enqueue a CRM sync once the case is marked ready', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
      .mockResolvedValueOnce([])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, input)

    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'qualified')
  })

  it('should not enqueue a CRM sync when the case never reaches ready', async () => {
    runResearchAgentMock
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))

    await runResearchForCase({} as never, { research }, input)

    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })
```

- [x] **Step 3: Run the pipeline tests**

Run: `pnpm vitest run src/lib/pipeline`
Expected: PASS. If a test fails on an unmocked `@/lib/crm/sync`, add the mock above to that file too — `enqueueCrmSync` reaches for `createAdminClient` and QStash, neither of which belongs in a pipeline unit test.

- [x] **Step 4: Update the roadmap**

Append to `.claude/roadmap.md`, after the P2 section:

```markdown
## CRM Integrations — DONE

**Goal:** push qualified cases into the client's own CRM (HubSpot, Pipedrive) as Contact + Company + Deal, then keep the Deal's notes and won/lost outcome in step with the case. One-way, outbound only.
**Design:** `docs/superpowers/specs/2026-08-02-crm-integrations-design.md` · **Plan:** `docs/superpowers/plans/2026-08-02-crm-integrations.md`

- [x] Migration `0022_crm_integrations.sql` — `crm_connections` (one per client, encrypted OAuth, selected pipeline/stages) + `case_crm_links` (one Deal per case, external ids, single-flight `sync_started_at` claim); flat per-client RLS on both; `log_source` gains `'crm'`.
- [x] `src/lib/crm/` — `CrmProvider` interface, `hubspot-provider.ts`, `pipedrive-provider.ts`, `registry.ts`, AES-256-GCM `tokens.ts` (reuses `MAILBOX_ENCRYPTION_KEY`), pure `mapping.ts`.
- [x] `sync.ts` — `enqueueCrmSync` (best-effort QStash publish, short-circuits when no usable connection) + `runCrmSync` (single-flight claim, create-or-update on any reason, external ids persisted incrementally so a retry resumes, retryable vs. terminal error classification).
- [x] Routes — `POST /api/crm/sync` (QStash-signed worker), `GET /api/crm/[provider]/{connect,callback}` (client-role only: the CRM account is the client's property, unlike operator-owned mailboxes).
- [x] UI — `/settings/crm` (four states: none, setup incomplete, connected, errored; read-only for operators), case-detail sync badge.
- [x] Six pipeline call sites wired: `ready`→qualified, `contacted`→contacted, `in_conversation`, `hot_handoff`, `lost`, `dead`→closed-lost.

**Known dormant path:** nothing sets `case_status = 'won'` yet, so the `'won'` reason and its closed-won mapping are implemented and tested but unreachable until a "mark won" action exists.
**Out of scope:** pulling from the CRM, two-way sync, backfilling pre-connection cases, custom field mapping, Salesforce, CRM-side webhooks.
```

- [x] **Step 5: Full verification**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all green. Record the actual test-file and test counts in the commit message rather than guessing.

- [ ] **Step 6: Commit (skipped per user request)**

```bash
git add src/lib/pipeline/ .claude/roadmap.md
git commit -m "feat: enqueue CRM syncs from every case status transition"
```

---

## Verification Checklist

Run after Task 13, before calling the feature done:

- [x] `pnpm test` — full suite green, with new tests for tokens, mapping, both providers, registry, both DB modules, sync, all three routes, and the Server Actions.
- [x] `pnpm typecheck` — clean.
- [x] `pnpm lint` — no new warnings.
- [x] `grep -rn "TODO\|FIXME\|console\.log" src/lib/crm src/app/api/crm "src/app/(app)/settings/crm"` returns nothing.
- [x] `grep -rn "supabase.from(" src/lib/crm src/app/api/crm "src/app/(app)/settings/crm"` returns nothing — all data access is in `src/lib/db/`.
- [ ] Manual: connect a HubSpot sandbox as a client-role user, pick a pipeline, force a case to `ready`, confirm one Contact, one Company, one Deal with a note appear, and that re-running the sync creates no duplicates.
- [ ] Manual: revoke the app in HubSpot, trigger a sync, confirm `/settings/crm` shows the reconnect banner and no further syncs are published.

## Spec Coverage

| Spec section | Task |
|---|---|
| §3.1–3.3 tables and enums | 1 |
| §3.4 RLS | 1 |
| §4.1 interface | 3 |
| §4.2 implementations + registry | 6, 7 |
| §4.3 token encryption | 2 |
| §4.4 env vars | 2 |
| §5.1–5.2 who connects, routes | 9, 10 |
| §5.3 pipeline selection | 11 |
| §5.4 provider closure differences | 6, 7 |
| §5.5 trigger points and worker | 8, 9, 13 |
| §5.6 concurrency | 5, 8 |
| §5.7 reason → action | 8 |
| §5.8 field mapping | 3 |
| §6 error handling | 8, 9 |
| §7.1 settings page | 11 |
| §7.2 case detail | 12 |
| §7.3 data access | 4, 5 |
| §9 testing | every task |
