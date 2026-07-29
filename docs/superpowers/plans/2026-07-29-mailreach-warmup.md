# Mailreach Warmup Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** enroll every mailbox in continuous Mailreach warmup, gate campaign (cold outreach) sending behind 14 days of enrollment, and let an operator enable/disable it per client and per mailbox — independently of the existing daily-cap ramp.

**Architecture:** A new `src/lib/mailreach/` module (external API client + connect/disconnect orchestration) sits alongside the existing `src/lib/mailbox/` warmup ramp without touching it. A pure gate function decides campaign-send eligibility from `mailreach_started_at`; it's wired into the one chokepoint every send already flows through (`sendViaMailbox`'s `rotationOrder`). SMTP mailboxes connect to Mailreach directly (we hold real IMAP/SMTP credentials); Gmail/Outlook mailboxes need an interactive OAuth redirect through Mailreach's own consent screen, mirroring the existing Gmail/Outlook connect flow's CSRF cookie pattern.

**Tech Stack:** Next.js 15 App Router (Server Components + Server Actions/Route Handlers), Supabase Postgres (RLS), supabase-js v2, Zod, Vitest, QStash cron.

**Spec:** `docs/superpowers/specs/2026-07-29-mailreach-warmup-design.md`

## Global Constraints

- Package manager is **pnpm**. `npm install` corrupts this repo's tree.
- No `console.log`, no `any`, no non-null assertion without a comment proving it's safe, explicit return types on every function.
- Test names read `it('should [behavior] when [condition]')`, Arrange-Act-Assert.
- Data access lives exclusively in `src/lib/db/`. Route handlers validate input → check auth → call lib functions → return result, in that order.
- Every external call (Mailreach) is wrapped in `fetchJson` (timeout + `AppError` mapping is automatic there) and every response is Zod-validated.
- Every state change writes an `events` row via `logEvent`/`logEventSafe`.
- `MAILREACH_CAMPAIGN_GATE_DAYS = 14`. Mailreach base URL: `https://api.mailreach.co/api/v1`. Auth header: `X-Api-Key: <MAILREACH_API_KEY>`. **These field names for `connect-account`/`account-stats`/OAuth endpoints are Mailreach's documented conventions but were not verified against a live account during design — Task 3, Step 1 is to confirm them with a real API key before the rest of that task is trusted.**
- Update `.claude/roadmap.md` as each task completes (Task 13 does the final consolidated pass, but don't wait until then if a natural checkpoint arrives earlier).

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `supabase/migrations/0021_mailreach_warmup.sql` | `mailreach_status` enum, `clients.mailreach_enabled`, 6 new `mailboxes` columns |
| `src/lib/mailbox/mailreach-gate.ts` + `.test.ts` | Pure: campaign-send eligibility, elapsed-day math |
| `src/lib/mailreach/client.ts` + `.test.ts` | Mailreach REST API wrapper (connect, OAuth, disconnect, stats) |
| `src/lib/mailreach/enrollment.ts` + `.test.ts` | Orchestrates client calls + DB writes: connect/disconnect/bulk |
| `src/app/api/mailboxes/[id]/mailreach/connect/route.ts` + `.test.ts` | Operator: enable Mailreach for one mailbox |
| `src/app/api/mailboxes/[id]/mailreach/disconnect/route.ts` + `.test.ts` | Operator: disable Mailreach for one mailbox |
| `src/app/api/mailboxes/mailreach/state-cookie.ts` | OAuth CSRF cookie constants (mirrors `google/state-cookie.ts`) |
| `src/app/api/mailboxes/mailreach/callback/route.ts` + `.test.ts` | OAuth callback for gmail/outlook mailboxes |
| `src/app/(app)/clients/[id]/mailreach-toggle.tsx` | Client-level master switch checkbox |
| `src/app/(app)/settings/mailreach-controls.tsx` | Per-mailbox checkbox (SMTP async, OAuth redirect) |
| `src/lib/pipeline/mailreach-sync.ts` + `.test.ts` | Stats sync sweep |
| `src/app/api/pipeline/mailreach-sync/route.ts` + `.test.ts` | QStash cron entry for the sweep |
| `scripts/schedule-mailreach-sync-cron.ts` | Registers the 6-hourly sync schedule |

**Modified files**

| File | Change |
|---|---|
| `src/types/database.ts` | `mailreach_status` enum, `clients` + `mailboxes` Row/Insert/Update |
| `src/lib/env.ts`, `src/lib/env.test.ts` | `MAILREACH_API_KEY` |
| `src/lib/db/mailboxes.ts` | New mailreach columns/helpers, `MailboxSummary` extended |
| `src/lib/db/clients.ts` | `updateClientMailreachEnabled` |
| `src/lib/mailbox/sender.ts` | `rotationOrder` gains the gate filter |
| `src/app/api/clients/[clientId]/route.ts` | PATCH accepts `mailreachEnabled`, triggers bulk connect/disconnect |
| `src/app/(app)/clients/[id]/page.tsx` | Renders `MailreachToggle` |
| `src/app/(app)/settings/page.tsx`, `mailbox-row.tsx` | Pass new fields, render day-count/status, mount `MailreachControls` |
| `.claude/roadmap.md` | Progress |

---

## Task 1: Migration + generated types + env var

**Files:**
- Create: `supabase/migrations/0021_mailreach_warmup.sql`
- Modify: `src/types/database.ts:12-37` (clients), `src/types/database.ts:660-705` (mailboxes), `src/types/database.ts:900-930` (Enums)
- Modify: `src/lib/env.ts`, `src/lib/env.test.ts`

**Interfaces:**
- Produces: enum `mailreach_status` (`'disconnected' | 'pending' | 'connected' | 'error'`); `clients.mailreach_enabled: boolean`; `mailboxes.mailreach_enabled: boolean`, `mailreach_started_at: string | null`, `mailreach_account_id: string | null`, `mailreach_status: mailreach_status`, `mailreach_reputation_score: number | null`, `mailreach_stats_synced_at: string | null`; `env.MAILREACH_API_KEY: string`.

- [x] **Step 1: Write the migration**

Create `supabase/migrations/0021_mailreach_warmup.sql`:

```sql
-- Mailreach warmup integration: continuous inbox-reputation warmup via the
-- Mailreach API, independent of the existing daily-cap ramp (warmup_profile).
-- A mailbox becomes eligible for campaign sends 14 days after
-- mailreach_started_at, which is stamped once on first enrollment and never
-- cleared by a later disconnect/reconnect cycle (see mailreach-gate.ts).

create type mailreach_status as enum ('disconnected', 'pending', 'connected', 'error');

alter table clients add column mailreach_enabled boolean not null default false;

alter table mailboxes add column mailreach_enabled          boolean not null default false;
alter table mailboxes add column mailreach_started_at       timestamptz;
alter table mailboxes add column mailreach_account_id       text;
alter table mailboxes add column mailreach_status           mailreach_status not null default 'disconnected';
alter table mailboxes add column mailreach_reputation_score numeric;
alter table mailboxes add column mailreach_stats_synced_at  timestamptz;
```

- [x] **Step 2: Add the enum and columns to `src/types/database.ts`**

In the `clients` table block (currently lines 12-37), add `mailreach_enabled: boolean` to `Row` (after `warmup_profile`) and `mailreach_enabled?: boolean` to `Insert`:

```ts
      clients: {
        Row: {
          id: string
          name: string
          status: Database['public']['Enums']['client_status']
          settings: Json
          warmup_profile: Database['public']['Enums']['warmup_profile']
          mailreach_enabled: boolean
          domain: string | null
          logo_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          status?: Database['public']['Enums']['client_status']
          settings?: Json
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          mailreach_enabled?: boolean
          domain?: string | null
          logo_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
```

In the `mailboxes` table block (currently lines 660-705), add the six new fields to both `Row` and `Insert` (after `health_changed_at`):

```ts
      mailboxes: {
        Row: {
          id: string
          client_id: string
          provider: Database['public']['Enums']['mailbox_provider']
          email_address: string
          display_name: string | null
          oauth: Json
          daily_cap: number
          sent_today: number
          warmup_profile: Database['public']['Enums']['warmup_profile']
          warmup_started_at: string | null
          health: Database['public']['Enums']['mailbox_health']
          health_reason: string | null
          health_changed_at: string | null
          mailreach_enabled: boolean
          mailreach_started_at: string | null
          mailreach_account_id: string | null
          mailreach_status: Database['public']['Enums']['mailreach_status']
          mailreach_reputation_score: number | null
          mailreach_stats_synced_at: string | null
          inbound_cursor: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          provider: Database['public']['Enums']['mailbox_provider']
          email_address: string
          display_name?: string | null
          oauth?: Json
          daily_cap?: number
          sent_today?: number
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          warmup_started_at?: string | null
          health?: Database['public']['Enums']['mailbox_health']
          health_reason?: string | null
          health_changed_at?: string | null
          mailreach_enabled?: boolean
          mailreach_started_at?: string | null
          mailreach_account_id?: string | null
          mailreach_status?: Database['public']['Enums']['mailreach_status']
          mailreach_reputation_score?: number | null
          mailreach_stats_synced_at?: string | null
          inbound_cursor?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['mailboxes']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'mailboxes_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
```

(The `Relationships` array is shown for anchoring only — leave its actual contents as they already are; only the `Row`/`Insert` blocks above it change.)

In the `Enums` block (currently around line 900), add the new enum next to `warmup_profile`:

```ts
      warmup_profile: 'standard' | 'slow' | 'none'
      mailreach_status: 'disconnected' | 'pending' | 'connected' | 'error'
```

- [x] **Step 3: Add `MAILREACH_API_KEY` to the env schema**

In `src/lib/env.ts`, add to `envSchema`:

```ts
  MAILREACH_API_KEY: nonEmpty,
```

In `src/lib/env.test.ts`, add to the `complete` fixture object:

```ts
  MAILREACH_API_KEY: 'mailreach-key',
```

- [x] **Step 4: Run the env test**

Run: `pnpm vitest run src/lib/env.test.ts`
Expected: PASS (the existing "missing var" test uses `QSTASH_TOKEN`, unaffected; the fixture now includes the new key so the happy-path test still passes).

- [x] **Step 5: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS — no other file references the new columns yet, so this only validates the `database.ts` edit itself is syntactically consistent.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0021_mailreach_warmup.sql src/types/database.ts src/lib/env.ts src/lib/env.test.ts
git commit -m "feat: add mailreach warmup schema and env var"
```

---

## Task 2: Pure campaign-send gate

**Files:**
- Create: `src/lib/mailbox/mailreach-gate.ts`
- Test: `src/lib/mailbox/mailreach-gate.test.ts`

**Interfaces:**
- Consumes: nothing (pure).
- Produces: `MAILREACH_CAMPAIGN_GATE_DAYS: number`; `mailreachElapsedDays(startedAt: string, now: Date): number`; `isEligibleForCampaignSend(input: { mailreachEnabled: boolean; mailreachStartedAt: string | null; now: Date }): boolean`. Consumed by Task 8 (`sender.ts`) and Task 10 (UI day-count display).

- [x] **Step 1: Write the failing tests**

Create `src/lib/mailbox/mailreach-gate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { MAILREACH_CAMPAIGN_GATE_DAYS, mailreachElapsedDays, isEligibleForCampaignSend } from './mailreach-gate'

const DAY_MS = 86_400_000

describe('mailreachElapsedDays', () => {
  it('should return 0 when startedAt is now', () => {
    const now = new Date('2026-07-29T00:00:00Z')
    expect(mailreachElapsedDays(now.toISOString(), now)).toBe(0)
  })

  it('should return the number of whole days elapsed', () => {
    const startedAt = new Date('2026-07-01T00:00:00Z').toISOString()
    const now = new Date('2026-07-15T12:00:00Z')
    expect(mailreachElapsedDays(startedAt, now)).toBe(14)
  })

  it('should clamp to 0 when startedAt is in the future', () => {
    const now = new Date('2026-07-01T00:00:00Z')
    const startedAt = new Date('2026-07-05T00:00:00Z').toISOString()
    expect(mailreachElapsedDays(startedAt, now)).toBe(0)
  })

  it('should throw AppError when startedAt is not a valid timestamp', () => {
    expect(() => mailreachElapsedDays('not-a-date', new Date())).toThrow(AppError)
  })
})

describe('isEligibleForCampaignSend', () => {
  const now = new Date('2026-07-29T00:00:00Z')

  it('should be eligible when mailreach is not enabled', () => {
    expect(isEligibleForCampaignSend({ mailreachEnabled: false, mailreachStartedAt: null, now })).toBe(true)
  })

  it('should be eligible when enabled but never started', () => {
    expect(isEligibleForCampaignSend({ mailreachEnabled: true, mailreachStartedAt: null, now })).toBe(true)
  })

  it('should be ineligible before day 14', () => {
    const startedAt = new Date(now.getTime() - 13 * DAY_MS).toISOString()
    expect(isEligibleForCampaignSend({ mailreachEnabled: true, mailreachStartedAt: startedAt, now })).toBe(false)
  })

  it('should be eligible exactly at day 14', () => {
    const startedAt = new Date(now.getTime() - MAILREACH_CAMPAIGN_GATE_DAYS * DAY_MS).toISOString()
    expect(isEligibleForCampaignSend({ mailreachEnabled: true, mailreachStartedAt: startedAt, now })).toBe(true)
  })

  it('should stay eligible well past day 14', () => {
    const startedAt = new Date(now.getTime() - 90 * DAY_MS).toISOString()
    expect(isEligibleForCampaignSend({ mailreachEnabled: true, mailreachStartedAt: startedAt, now })).toBe(true)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/mailreach-gate.test.ts`
Expected: FAIL — `./mailreach-gate` does not exist yet.

- [x] **Step 3: Implement**

Create `src/lib/mailbox/mailreach-gate.ts`:

```ts
import { AppError } from '@/lib/errors/app-error'

/** Days of continuous Mailreach warmup before a mailbox may send campaign mail. */
export const MAILREACH_CAMPAIGN_GATE_DAYS = 14

const MS_PER_DAY = 86_400_000

/**
 * Whole days elapsed since `startedAt`. Clamped at 0 so clock skew (or a start
 * date stamped slightly in the future) never produces a negative count.
 */
export function mailreachElapsedDays(startedAt: string, now: Date): number {
  const startedAtMs = Date.parse(startedAt)
  if (Number.isNaN(startedAtMs)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox mailreach_started_at is not a valid timestamp', {
      startedAt,
    })
  }
  return Math.max(0, Math.floor((now.getTime() - startedAtMs) / MS_PER_DAY))
}

export interface CampaignSendEligibilityInput {
  mailreachEnabled: boolean
  mailreachStartedAt: string | null
  now: Date
}

/**
 * Whether a mailbox may send campaign (outreach) mail right now. A mailbox
 * never enrolled in Mailreach is ungated — this only restricts mailboxes
 * actively warming. Independent of the daily_cap ramp: this is permission to
 * send at all, not how many.
 */
export function isEligibleForCampaignSend(input: CampaignSendEligibilityInput): boolean {
  if (!input.mailreachEnabled || input.mailreachStartedAt === null) return true
  return mailreachElapsedDays(input.mailreachStartedAt, input.now) >= MAILREACH_CAMPAIGN_GATE_DAYS
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/mailreach-gate.test.ts`
Expected: PASS, all 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/mailreach-gate.ts src/lib/mailbox/mailreach-gate.test.ts
git commit -m "feat: add the mailreach campaign-send eligibility gate"
```

---

## Task 3: Mailreach API client

**Files:**
- Create: `src/lib/mailreach/client.ts`
- Test: `src/lib/mailreach/client.test.ts`

**Interfaces:**
- Consumes: `fetchJson` (`src/lib/http/fetch-json.ts`), `env.MAILREACH_API_KEY`.
- Produces: `connectSmtpAccount(input: SmtpConnectInput): Promise<{ accountId: string }>`; `buildOAuthAuthorizeUrl(params: { provider: 'gmail' | 'outlook'; redirectUri: string; state: string }): string`; `completeOAuthConnect(params: { code: string; provider: 'gmail' | 'outlook' }): Promise<{ accountId: string }>`; `disconnectAccount(accountId: string): Promise<void>`; `getAccountStats(accountId: string): Promise<{ reputationScore: number | null }>`. Consumed by Task 4 (`enrollment.ts`) and Task 11 (`mailreach-sync.ts`).

- [ ] **Step 1: Confirm the live API contract** (not done — no live `MAILREACH_API_KEY`/account was available; client.ts was implemented against the plan's documented-but-unverified field names only)

Before writing tests, confirm against `docs.mailreach.co` (with a real `MAILREACH_API_KEY` if available) that: the connect-account request/response field names below match, the OAuth authorize/callback mechanic is a redirect URL + code exchange as assumed, and the disconnect/stats endpoints exist at the paths below. If anything differs, adjust the schemas and paths in Step 3 before proceeding — the rest of this task assumes they're correct.

- [x] **Step 2: Write the failing tests**

Create `src/lib/mailreach/client.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFetchJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: mockFetchJson }))
vi.mock('@/lib/env', () => ({ env: { MAILREACH_API_KEY: 'test-mailreach-key' } }))

import { connectSmtpAccount, buildOAuthAuthorizeUrl, completeOAuthConnect, disconnectAccount, getAccountStats } from './client'

const smtpInput = {
  emailAddress: 'sales@acme.com',
  username: 'sales@acme.com',
  password: 'app-password',
  smtpHost: 'smtp.acme.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.acme.com',
  imapPort: 993,
  imapSecure: true,
}

describe('connectSmtpAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should POST the credentials with the API key header and return the account id', async () => {
    mockFetchJson.mockResolvedValueOnce({ account_id: 'acc_123' })
    const result = await connectSmtpAccount(smtpInput)
    expect(result).toEqual({ accountId: 'acc_123' })
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/connect-account')
    expect(options.method).toBe('POST')
    expect(options.headers['X-Api-Key']).toBe('test-mailreach-key')
    const body = JSON.parse(options.body as string)
    expect(body.email).toBe('sales@acme.com')
    expect(body.smtp_host).toBe('smtp.acme.com')
    expect(body.imap_host).toBe('imap.acme.com')
  })
})

describe('buildOAuthAuthorizeUrl', () => {
  it('should build a redirect url carrying the provider, redirect_uri, and state', () => {
    const url = buildOAuthAuthorizeUrl({ provider: 'gmail', redirectUri: 'https://app.example.com/cb', state: 'nonce123' })
    const parsed = new URL(url)
    expect(parsed.origin + parsed.pathname).toBe('https://api.mailreach.co/api/v1/connect-account/oauth')
    expect(parsed.searchParams.get('provider')).toBe('google')
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://app.example.com/cb')
    expect(parsed.searchParams.get('state')).toBe('nonce123')
  })
})

describe('completeOAuthConnect', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should exchange the code and return the account id', async () => {
    mockFetchJson.mockResolvedValueOnce({ account_id: 'acc_456' })
    const result = await completeOAuthConnect({ code: 'auth-code', provider: 'outlook' })
    expect(result).toEqual({ accountId: 'acc_456' })
    const [, options] = mockFetchJson.mock.calls[0]!
    const body = JSON.parse(options.body as string)
    expect(body.code).toBe('auth-code')
    expect(body.provider).toBe('outlook')
  })
})

describe('disconnectAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should DELETE the account by id', async () => {
    mockFetchJson.mockResolvedValueOnce(undefined)
    await disconnectAccount('acc_123')
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/accounts/acc_123')
    expect(options.method).toBe('DELETE')
  })
})

describe('getAccountStats', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return the reputation score', async () => {
    mockFetchJson.mockResolvedValueOnce({ reputation_score: 94 })
    const result = await getAccountStats('acc_123')
    expect(result).toEqual({ reputationScore: 94 })
  })

  it('should return null when the score is absent', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const result = await getAccountStats('acc_123')
    expect(result).toEqual({ reputationScore: null })
  })
})
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailreach/client.test.ts`
Expected: FAIL — `./client` does not exist yet.

- [x] **Step 4: Implement**

Create `src/lib/mailreach/client.ts`:

```ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'

const BASE_URL = 'https://api.mailreach.co/api/v1'

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Api-Key': env.MAILREACH_API_KEY }
}

function toMailreachProvider(provider: 'gmail' | 'outlook'): 'google' | 'outlook' {
  return provider === 'gmail' ? 'google' : 'outlook'
}

export interface SmtpConnectInput {
  emailAddress: string
  username: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  imapHost: string
  imapPort: number
  imapSecure: boolean
}

const connectAccountResponseSchema = z.object({ account_id: z.string() }).passthrough()

export async function connectSmtpAccount(input: SmtpConnectInput): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/connect-account`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'smtp',
        email: input.emailAddress,
        smtp_username: input.username,
        smtp_password: input.password,
        smtp_host: input.smtpHost,
        smtp_port: input.smtpPort,
        smtp_secure: input.smtpSecure,
        imap_host: input.imapHost,
        imap_port: input.imapPort,
        imap_secure: input.imapSecure,
      }),
    },
    connectAccountResponseSchema,
  )
  return { accountId: res.account_id }
}

export function buildOAuthAuthorizeUrl(params: { provider: 'gmail' | 'outlook'; redirectUri: string; state: string }): string {
  const usp = new URLSearchParams({
    provider: toMailreachProvider(params.provider),
    redirect_uri: params.redirectUri,
    state: params.state,
  })
  return `${BASE_URL}/connect-account/oauth?${usp.toString()}`
}

const oauthCompleteResponseSchema = z.object({ account_id: z.string() }).passthrough()

export async function completeOAuthConnect(params: { code: string; provider: 'gmail' | 'outlook' }): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/connect-account/oauth/callback`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ code: params.code, provider: toMailreachProvider(params.provider) }),
    },
    oauthCompleteResponseSchema,
  )
  return { accountId: res.account_id }
}

export async function disconnectAccount(accountId: string): Promise<void> {
  await fetchJson(`${BASE_URL}/accounts/${accountId}`, { method: 'DELETE', headers: authHeaders() }, z.unknown())
}

const accountStatsResponseSchema = z.object({ reputation_score: z.number().nullable().optional() }).passthrough()

export async function getAccountStats(accountId: string): Promise<{ reputationScore: number | null }> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}/stats`,
    { method: 'GET', headers: authHeaders() },
    accountStatsResponseSchema,
  )
  return { reputationScore: res.reputation_score ?? null }
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailreach/client.test.ts`
Expected: PASS, all 6 tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailreach/client.ts src/lib/mailreach/client.test.ts
git commit -m "feat: add the mailreach API client"
```

---

## Task 4: DB layer additions

**Files:**
- Modify: `src/lib/db/mailboxes.ts`
- Modify: `src/lib/db/clients.ts`
- Test: `src/lib/db/mailboxes.test.ts`, `src/lib/db/clients.test.ts`

**Interfaces:**
- Consumes: `MailboxRow`, `ClientRow` (existing).
- Produces: `updateMailboxMailreachPending`, `updateMailboxMailreachConnected`, `updateMailboxMailreachDisconnected`, `clearMailboxMailreachConnection`, `updateMailboxMailreachEnabled`, `updateMailboxMailreachStats`, `listMailboxesForClient`, `listMailreachConnectedMailboxes` (all `src/lib/db/mailboxes.ts`); `updateClientMailreachEnabled` (`src/lib/db/clients.ts`); `MailboxSummary` gains the 6 mailreach fields. Consumed by Task 5 (`enrollment.ts`), Task 6-7 (routes), Task 9 (client PATCH), Task 11 (sync).

- [x] **Step 1: Write the failing tests**

Add to `src/lib/db/mailboxes.test.ts` (same file, new `describe` blocks — reuse the existing `mockUpdate`/`mockUpdateChain`/`mockIn` helpers already defined at the top of the file):

```ts
import {
  updateMailboxMailreachPending,
  updateMailboxMailreachConnected,
  updateMailboxMailreachDisconnected,
  clearMailboxMailreachConnection,
  updateMailboxMailreachEnabled,
  updateMailboxMailreachStats,
  listMailboxesForClient,
  listMailreachConnectedMailboxes,
} from './mailboxes'

describe('updateMailboxMailreachPending', () => {
  it('should set status to pending', async () => {
    await expect(updateMailboxMailreachPending(mockUpdate({ error: null }), 'm1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(updateMailboxMailreachPending(mockUpdate({ error: { message: 'boom' } }), 'm1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateMailboxMailreachConnected', () => {
  it('should persist the account id, status, and started-at', async () => {
    await expect(
      updateMailboxMailreachConnected(mockUpdate({ error: null }), 'm1', {
        mailreach_account_id: 'acc_1',
        mailreach_status: 'connected',
        mailreach_started_at: '2026-07-29T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateMailboxMailreachConnected(mockUpdate({ error: { message: 'boom' } }), 'm1', {
        mailreach_account_id: 'acc_1',
        mailreach_status: 'connected',
        mailreach_started_at: '2026-07-29T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateMailboxMailreachDisconnected', () => {
  it('should clear the connection and the enrollment intent', async () => {
    await expect(updateMailboxMailreachDisconnected(mockUpdate({ error: null }), 'm1')).resolves.toBeUndefined()
  })
})

describe('clearMailboxMailreachConnection', () => {
  it('should clear the connection but leave enrollment intent untouched', async () => {
    await expect(clearMailboxMailreachConnection(mockUpdate({ error: null }), 'm1')).resolves.toBeUndefined()
  })
})

describe('updateMailboxMailreachEnabled', () => {
  it('should persist the enrollment flag', async () => {
    await expect(updateMailboxMailreachEnabled(mockUpdate({ error: null }), 'm1', true)).resolves.toBeUndefined()
  })
})

describe('updateMailboxMailreachStats', () => {
  it('should persist the reputation score and sync timestamp', async () => {
    await expect(
      updateMailboxMailreachStats(mockUpdate({ error: null }), 'm1', {
        reputationScore: 94,
        syncedAt: '2026-07-29T00:00:00.000Z',
      }),
    ).resolves.toBeUndefined()
  })
})

describe('listMailboxesForClient', () => {
  it('should return every mailbox for the client', async () => {
    const rows = [{ id: 'm1' }, { id: 'm2' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    await expect(listMailboxesForClient(supabase, 'c1')).resolves.toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listMailboxesForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listMailreachConnectedMailboxes', () => {
  it('should return every connected mailbox', async () => {
    const rows = [{ id: 'm1', mailreach_status: 'connected' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    await expect(listMailreachConnectedMailboxes(supabase)).resolves.toEqual(rows)
  })
})
```

Add to `src/lib/db/clients.test.ts` (mirror the existing `updateClientWarmupProfile` test block's mock shape):

```ts
describe('updateClientMailreachEnabled', () => {
  it('should persist the flag and return the updated row', async () => {
    const row = { id: 'c1', mailreach_enabled: true }
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }) }),
    } as never
    await expect(updateClientMailreachEnabled(supabase, 'c1', true)).resolves.toEqual(row)
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
    } as never
    await expect(updateClientMailreachEnabled(supabase, 'c1', true)).rejects.toBeInstanceOf(AppError)
  })
})
```

(Add the matching `import { updateClientMailreachEnabled } from './clients'` to that test file's import block.)

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/mailboxes.test.ts src/lib/db/clients.test.ts`
Expected: FAIL — the new exports don't exist yet.

- [x] **Step 3: Implement — `src/lib/db/mailboxes.ts`**

Add near `updateMailboxWarmup`:

```ts
export async function updateMailboxMailreachPending(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ mailreach_status: 'pending' }).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to set mailbox mailreach status pending', { id, cause: error.message })
}

export async function updateMailboxMailreachConnected(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: {
    mailreach_account_id: string
    mailreach_status: Database['public']['Enums']['mailreach_status']
    mailreach_started_at: string
  },
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update(fields).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to persist mailbox mailreach connection', { id, cause: error.message })
}

// Operator-initiated disconnect: clears the live connection AND the
// enrollment intent. mailreach_started_at is left untouched — a later
// re-enable resumes the day count instead of restarting it.
export async function updateMailboxMailreachDisconnected(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ mailreach_account_id: null, mailreach_status: 'disconnected', mailreach_enabled: false })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to disconnect mailbox from mailreach', { id, cause: error.message })
}

// Client-master-switch-initiated pause: clears the live connection but
// preserves the mailbox's own mailreach_enabled intent, so turning the client
// switch back on knows which mailboxes to reconnect.
export async function clearMailboxMailreachConnection(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ mailreach_account_id: null, mailreach_status: 'disconnected' })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to clear mailbox mailreach connection', { id, cause: error.message })
}

export async function updateMailboxMailreachEnabled(
  supabase: SupabaseClient<Database>,
  id: string,
  enabled: boolean,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ mailreach_enabled: enabled }).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox mailreach_enabled', { id, cause: error.message })
}

export async function updateMailboxMailreachStats(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: { reputationScore: number | null; syncedAt: string },
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ mailreach_reputation_score: fields.reputationScore, mailreach_stats_synced_at: fields.syncedAt })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox mailreach stats', { id, cause: error.message })
}

export async function listMailboxesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('client_id', clientId)
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailboxes for client', { clientId, cause: error.message })
  return data ?? []
}

// The stats-sync sweep's candidate set — every mailbox currently live on
// Mailreach's side, across every client.
export async function listMailreachConnectedMailboxes(
  supabase: SupabaseClient<Database>,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('mailreach_status', 'connected')
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailreach-connected mailboxes', { cause: error.message })
  return data ?? []
}
```

Extend `MailboxSummary` and `listMailboxesForViewer`'s select list so `/settings` can render the mailreach fields for both roles:

```ts
export type MailboxSummary = Pick<
  MailboxRow,
  | 'id' | 'provider' | 'email_address' | 'display_name' | 'health' | 'created_at'
  | 'health_reason' | 'warmup_profile' | 'warmup_started_at' | 'daily_cap' | 'sent_today'
  | 'mailreach_enabled' | 'mailreach_started_at' | 'mailreach_status' | 'mailreach_reputation_score'
>
```

```ts
export async function listMailboxesForViewer(
  supabase: SupabaseClient<Database>,
): Promise<MailboxSummary[]> {
  const { data, error } = await supabase
    .from('mailboxes')
    .select(
      'id, provider, email_address, display_name, health, created_at, health_reason, warmup_profile, warmup_started_at, daily_cap, sent_today, mailreach_enabled, mailreach_started_at, mailreach_status, mailreach_reputation_score',
    )
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list mailboxes', { cause: error.message })
  }
  return data ?? []
}
```

- [x] **Step 4: Implement — `src/lib/db/clients.ts`**

Add near `updateClientWarmupProfile`:

```ts
export async function updateClientMailreachEnabled(
  supabase: SupabaseClient<Database>,
  id: string,
  enabled: boolean,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ mailreach_enabled: enabled })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client mailreach_enabled', { id, cause: error?.message })
  }
  return data
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/mailboxes.test.ts src/lib/db/clients.test.ts`
Expected: PASS.

- [x] **Step 6: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts src/lib/db/clients.ts src/lib/db/clients.test.ts
git commit -m "feat: add mailreach db helpers"
```

---

## Task 5: Enrollment orchestration

**Files:**
- Create: `src/lib/mailreach/enrollment.ts`
- Test: `src/lib/mailreach/enrollment.test.ts`

**Interfaces:**
- Consumes: `MailboxRow` (`@/lib/db/mailboxes`), `parseMailboxTokens` (`@/lib/mailbox/tokens`), everything from Task 3's `client.ts`, everything from Task 4's new `mailboxes.ts`/`clients.ts` helpers.
- Produces: `connectSmtpMailbox(supabase, mailbox, now): Promise<void>`; `oauthAuthorizeUrl(params): string`; `completeOAuthConnectForMailbox(supabase, mailbox, code, now): Promise<void>`; `disconnectMailbox(supabase, mailbox): Promise<void>`; `bulkDisconnectForClient(supabase, clientId): Promise<BulkResult>`; `bulkReconnectSmtpForClient(supabase, clientId, now): Promise<BulkResult>`; `interface BulkResult { attempted: number; succeeded: number; failed: number }`. Consumed by Task 6-7 (routes) and Task 9 (client PATCH bulk toggle).

- [x] **Step 1: Write the failing tests**

Create `src/lib/mailreach/enrollment.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const connectSmtpAccount = vi.fn()
const disconnectAccount = vi.fn()
const completeOAuthConnect = vi.fn()
const updateMailboxMailreachConnected = vi.fn()
const updateMailboxMailreachDisconnected = vi.fn()
const clearMailboxMailreachConnection = vi.fn()
const updateMailboxMailreachEnabled = vi.fn()
const listMailboxesForClient = vi.fn()

vi.mock('./client', () => ({
  connectSmtpAccount: (...args: unknown[]) => connectSmtpAccount(...args),
  disconnectAccount: (...args: unknown[]) => disconnectAccount(...args),
  completeOAuthConnect: (...args: unknown[]) => completeOAuthConnect(...args),
  buildOAuthAuthorizeUrl: (params: unknown) => `https://api.mailreach.co/api/v1/connect-account/oauth?stub=${JSON.stringify(params)}`,
}))
vi.mock('@/lib/db/mailboxes', () => ({
  updateMailboxMailreachConnected: (...args: unknown[]) => updateMailboxMailreachConnected(...args),
  updateMailboxMailreachDisconnected: (...args: unknown[]) => updateMailboxMailreachDisconnected(...args),
  clearMailboxMailreachConnection: (...args: unknown[]) => clearMailboxMailreachConnection(...args),
  updateMailboxMailreachEnabled: (...args: unknown[]) => updateMailboxMailreachEnabled(...args),
  listMailboxesForClient: (...args: unknown[]) => listMailboxesForClient(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

import { AppError } from '@/lib/errors/app-error'
import {
  connectSmtpMailbox,
  completeOAuthConnectForMailbox,
  disconnectMailbox,
  bulkDisconnectForClient,
  bulkReconnectSmtpForClient,
} from './enrollment'

const now = new Date('2026-07-29T00:00:00.000Z')

function smtpMailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    client_id: 'c1',
    provider: 'smtp',
    mailreach_account_id: null,
    mailreach_status: 'disconnected',
    mailreach_enabled: false,
    mailreach_started_at: null,
    oauth: {
      kind: 'smtp',
      emailAddress: 'sales@acme.com',
      username: 'sales@acme.com',
      password: 'pw',
      smtpHost: 'smtp.acme.com',
      smtpPort: 587,
      smtpSecure: false,
      imapHost: 'imap.acme.com',
      imapPort: 993,
      imapSecure: true,
    },
    ...overrides,
  } as never
}

beforeEach(() => vi.clearAllMocks())

describe('connectSmtpMailbox', () => {
  it('should connect via the API and stamp mailreach_started_at for a never-enrolled mailbox', async () => {
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_1' })
    await connectSmtpMailbox({} as never, smtpMailbox(), now)
    expect(updateMailboxMailreachConnected).toHaveBeenCalledWith({}, 'm1', {
      mailreach_account_id: 'acc_1',
      mailreach_status: 'connected',
      mailreach_started_at: now.toISOString(),
    })
    expect(updateMailboxMailreachEnabled).toHaveBeenCalledWith({}, 'm1', true)
  })

  it('should preserve the original mailreach_started_at on reconnect', async () => {
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_2' })
    const original = '2026-07-01T00:00:00.000Z'
    await connectSmtpMailbox({} as never, smtpMailbox({ mailreach_started_at: original }), now)
    expect(updateMailboxMailreachConnected).toHaveBeenCalledWith(
      {},
      'm1',
      expect.objectContaining({ mailreach_started_at: original }),
    )
  })

  it('should throw VALIDATION_ERROR for a non-smtp mailbox', async () => {
    await expect(connectSmtpMailbox({} as never, smtpMailbox({ provider: 'gmail' }), now)).rejects.toBeInstanceOf(AppError)
    expect(connectSmtpAccount).not.toHaveBeenCalled()
  })
})

describe('completeOAuthConnectForMailbox', () => {
  it('should exchange the code and persist the connection', async () => {
    completeOAuthConnect.mockResolvedValue({ accountId: 'acc_3' })
    const mailbox = smtpMailbox({ provider: 'gmail' })
    await completeOAuthConnectForMailbox({} as never, mailbox, 'auth-code', now)
    expect(completeOAuthConnect).toHaveBeenCalledWith({ code: 'auth-code', provider: 'gmail' })
    expect(updateMailboxMailreachEnabled).toHaveBeenCalledWith({}, 'm1', true)
  })

  it('should throw VALIDATION_ERROR for an smtp mailbox', async () => {
    await expect(completeOAuthConnectForMailbox({} as never, smtpMailbox(), 'auth-code', now)).rejects.toBeInstanceOf(AppError)
  })
})

describe('disconnectMailbox', () => {
  it('should disconnect the remote account when one is set', async () => {
    await disconnectMailbox({} as never, smtpMailbox({ mailreach_account_id: 'acc_1' }))
    expect(disconnectAccount).toHaveBeenCalledWith('acc_1')
    expect(updateMailboxMailreachDisconnected).toHaveBeenCalledWith({}, 'm1')
  })

  it('should skip the remote call when no account id is set', async () => {
    await disconnectMailbox({} as never, smtpMailbox({ mailreach_account_id: null }))
    expect(disconnectAccount).not.toHaveBeenCalled()
    expect(updateMailboxMailreachDisconnected).toHaveBeenCalledWith({}, 'm1')
  })
})

describe('bulkDisconnectForClient', () => {
  it('should disconnect every currently-connected mailbox and count failures separately', async () => {
    listMailboxesForClient.mockResolvedValue([
      smtpMailbox({ id: 'm1', mailreach_status: 'connected', mailreach_account_id: 'acc_1' }),
      smtpMailbox({ id: 'm2', mailreach_status: 'connected', mailreach_account_id: 'acc_2' }),
      smtpMailbox({ id: 'm3', mailreach_status: 'disconnected' }),
    ])
    disconnectAccount.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('vendor down'))
    const result = await bulkDisconnectForClient({} as never, 'c1')
    expect(result).toEqual({ attempted: 2, succeeded: 1, failed: 1 })
  })
})

describe('bulkReconnectSmtpForClient', () => {
  it('should reconnect every enabled, disconnected smtp mailbox', async () => {
    listMailboxesForClient.mockResolvedValue([
      smtpMailbox({ id: 'm1', mailreach_enabled: true, mailreach_status: 'disconnected' }),
      smtpMailbox({ id: 'm2', provider: 'gmail', mailreach_enabled: true, mailreach_status: 'disconnected' }),
      smtpMailbox({ id: 'm3', mailreach_enabled: false }),
    ])
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_new' })
    const result = await bulkReconnectSmtpForClient({} as never, 'c1', now)
    // Only m1 qualifies: m2 is oauth (needs interactive consent, skipped), m3 isn't enabled.
    expect(result).toEqual({ attempted: 1, succeeded: 1, failed: 0 })
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailreach/enrollment.test.ts`
Expected: FAIL — `./enrollment` does not exist yet.

- [x] **Step 3: Implement**

Create `src/lib/mailreach/enrollment.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { MailboxRow } from '@/lib/db/mailboxes'
import {
  listMailboxesForClient,
  updateMailboxMailreachConnected,
  updateMailboxMailreachDisconnected,
  clearMailboxMailreachConnection,
  updateMailboxMailreachEnabled,
} from '@/lib/db/mailboxes'
import { parseMailboxTokens } from '@/lib/mailbox/tokens'
import { logEventSafe } from '@/lib/events/log-event'
import {
  connectSmtpAccount,
  disconnectAccount,
  completeOAuthConnect,
  buildOAuthAuthorizeUrl,
} from './client'

// First-ever enrollment stamps mailreach_started_at; every later
// reconnect (individual or bulk) reuses whatever was already stored, so the
// 14-day gate always resumes from the original date instead of restarting.
function startedAtFor(mailbox: Pick<MailboxRow, 'mailreach_started_at'>, now: Date): string {
  return mailbox.mailreach_started_at ?? now.toISOString()
}

export async function connectSmtpMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
  now: Date,
): Promise<void> {
  if (mailbox.provider !== 'smtp') {
    throw new AppError('VALIDATION_ERROR', 'Mailreach direct connect requires an SMTP mailbox', {
      mailboxId: mailbox.id, provider: mailbox.provider,
    })
  }
  const credentials = parseMailboxTokens(mailbox.oauth, mailbox.id)
  if (credentials.kind !== 'smtp') {
    throw new AppError('INVARIANT_VIOLATION', 'SMTP mailbox has non-smtp credentials', { mailboxId: mailbox.id })
  }
  const { accountId } = await connectSmtpAccount({
    emailAddress: credentials.emailAddress,
    username: credentials.username,
    password: credentials.password,
    smtpHost: credentials.smtpHost,
    smtpPort: credentials.smtpPort,
    smtpSecure: credentials.smtpSecure,
    imapHost: credentials.imapHost,
    imapPort: credentials.imapPort,
    imapSecure: credentials.imapSecure,
  })
  await updateMailboxMailreachConnected(supabase, mailbox.id, {
    mailreach_account_id: accountId,
    mailreach_status: 'connected',
    mailreach_started_at: startedAtFor(mailbox, now),
  })
  await updateMailboxMailreachEnabled(supabase, mailbox.id, true)
}

export function oauthAuthorizeUrl(params: { provider: 'gmail' | 'outlook'; redirectUri: string; state: string }): string {
  return buildOAuthAuthorizeUrl(params)
}

export async function completeOAuthConnectForMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
  code: string,
  now: Date,
): Promise<void> {
  if (mailbox.provider !== 'gmail' && mailbox.provider !== 'outlook') {
    throw new AppError('VALIDATION_ERROR', 'Mailreach OAuth connect requires a gmail or outlook mailbox', {
      mailboxId: mailbox.id, provider: mailbox.provider,
    })
  }
  const { accountId } = await completeOAuthConnect({ code, provider: mailbox.provider })
  await updateMailboxMailreachConnected(supabase, mailbox.id, {
    mailreach_account_id: accountId,
    mailreach_status: 'connected',
    mailreach_started_at: startedAtFor(mailbox, now),
  })
  await updateMailboxMailreachEnabled(supabase, mailbox.id, true)
}

export async function disconnectMailbox(supabase: SupabaseClient<Database>, mailbox: MailboxRow): Promise<void> {
  if (mailbox.mailreach_account_id) {
    await disconnectAccount(mailbox.mailreach_account_id)
  }
  await updateMailboxMailreachDisconnected(supabase, mailbox.id)
}

export interface BulkResult {
  attempted: number
  succeeded: number
  failed: number
}

// Client master switch OFF: disconnect every currently-connected mailbox.
// Best-effort per mailbox — one vendor failure doesn't strand the rest still
// billed. Each mailbox's own mailreach_enabled intent is left untouched (see
// clearMailboxMailreachConnection) so a later switch-on knows what to resume.
export async function bulkDisconnectForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<BulkResult> {
  const targets = (await listMailboxesForClient(supabase, clientId)).filter((m) => m.mailreach_status === 'connected')
  let succeeded = 0
  let failed = 0
  for (const mailbox of targets) {
    try {
      if (mailbox.mailreach_account_id) await disconnectAccount(mailbox.mailreach_account_id)
      await clearMailboxMailreachConnection(supabase, mailbox.id)
      succeeded += 1
    } catch (error) {
      failed += 1
      await logEventSafe({
        clientId, actor: 'mailreach_bulk_disconnect', type: 'mailbox.mailreach_disconnect_failed', source: 'mailbox',
        payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return { attempted: targets.length, succeeded, failed }
}

// Client master switch ON: silently reconnect every enabled SMTP mailbox (we
// hold the credentials). Gmail/Outlook mailboxes need interactive OAuth
// consent and are deliberately excluded here — they surface a "needs
// reconnect" affordance in the UI instead (see mailreach-controls.tsx).
export async function bulkReconnectSmtpForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  now: Date,
): Promise<BulkResult> {
  const targets = (await listMailboxesForClient(supabase, clientId)).filter(
    (m) => m.mailreach_enabled && m.provider === 'smtp' && m.mailreach_status !== 'connected',
  )
  let succeeded = 0
  let failed = 0
  for (const mailbox of targets) {
    try {
      await connectSmtpMailbox(supabase, mailbox, now)
      succeeded += 1
    } catch (error) {
      failed += 1
      await logEventSafe({
        clientId, actor: 'mailreach_bulk_reconnect', type: 'mailbox.mailreach_reconnect_failed', source: 'mailbox',
        payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return { attempted: targets.length, succeeded, failed }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailreach/enrollment.test.ts`
Expected: PASS, all 10 tests.

- [x] **Step 5: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailreach/enrollment.ts src/lib/mailreach/enrollment.test.ts
git commit -m "feat: add mailreach connect/disconnect orchestration"
```

---

## Task 6: Per-mailbox connect/disconnect routes

**Files:**
- Create: `src/app/api/mailboxes/[id]/mailreach/connect/route.ts`
- Create: `src/app/api/mailboxes/[id]/mailreach/disconnect/route.ts`
- Create: `src/app/api/mailboxes/mailreach/state-cookie.ts`
- Test: `src/app/api/mailboxes/[id]/mailreach/connect/route.test.ts`, `src/app/api/mailboxes/[id]/mailreach/disconnect/route.test.ts`

**Interfaces:**
- Consumes: `connectSmtpMailbox`, `oauthAuthorizeUrl`, `disconnectMailbox` (Task 5); `getMailboxById`, `updateMailboxMailreachPending` (Task 4/existing).
- Produces: `POST /api/mailboxes/[id]/mailreach/connect` → `{ ok: true, redirect: false }` (smtp) or `{ ok: true, redirect: true, authorizeUrl }` (gmail/outlook, sets the state cookie); `POST /api/mailboxes/[id]/mailreach/disconnect` → `{ ok: true }`. Consumed by Task 10 (`mailreach-controls.tsx`).

- [x] **Step 1: Write the failing tests**

Create `src/app/api/mailboxes/[id]/mailreach/connect/route.test.ts` (mirrors `pause/route.test.ts`'s mocking style):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const updateMailboxMailreachPending = vi.fn()
const connectSmtpMailbox = vi.fn()
const oauthAuthorizeUrl = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  updateMailboxMailreachPending: (...args: unknown[]) => updateMailboxMailreachPending(...args),
}))
vi.mock('@/lib/mailreach/enrollment', () => ({
  connectSmtpMailbox: (...args: unknown[]) => connectSmtpMailbox(...args),
  oauthAuthorizeUrl: (...args: unknown[]) => oauthAuthorizeUrl(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'http://localhost:3000' } }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
})

describe('POST /api/mailboxes/[id]/mailreach/connect', () => {
  it('should connect an smtp mailbox synchronously', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    connectSmtpMailbox.mockResolvedValue(undefined)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, redirect: false })
    expect(connectSmtpMailbox).toHaveBeenCalled()
  })

  it('should return a redirect url for a gmail mailbox without connecting synchronously', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'gmail' })
    oauthAuthorizeUrl.mockReturnValue('https://api.mailreach.co/api/v1/connect-account/oauth?stub=1')
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body.redirect).toBe(true)
    expect(body.authorizeUrl).toBe('https://api.mailreach.co/api/v1/connect-account/oauth?stub=1')
    expect(updateMailboxMailreachPending).toHaveBeenCalledWith({}, 'm1')
    expect(response.headers.get('set-cookie')).toContain('mailreach_oauth_state=')
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(403)
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })

  it('should return 500 with the AppError code when the smtp connect fails', async () => {
    getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
    const { AppError } = await import('@/lib/errors/app-error')
    connectSmtpMailbox.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'boom'))
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(500)
    const body = await response.json()
    expect(body.error).toBe('EXTERNAL_ERROR')
  })
})
```

Create `src/app/api/mailboxes/[id]/mailreach/disconnect/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const disconnectMailbox = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ getMailboxById: (...args: unknown[]) => getMailboxById(...args) }))
vi.mock('@/lib/mailreach/enrollment', () => ({ disconnectMailbox: (...args: unknown[]) => disconnectMailbox(...args) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'smtp' })
})

describe('POST /api/mailboxes/[id]/mailreach/disconnect', () => {
  it('should disconnect the mailbox', async () => {
    disconnectMailbox.mockResolvedValue(undefined)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(disconnectMailbox).toHaveBeenCalled()
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(403)
    expect(disconnectMailbox).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/api/mailboxes/[id]/mailreach`
Expected: FAIL — routes don't exist yet.

- [x] **Step 3: Implement**

Create `src/app/api/mailboxes/mailreach/state-cookie.ts`:

```ts
// Shared between /[id]/mailreach/connect (sets it) and /mailreach/callback
// (validates it) — the OAuth2 CSRF state nonce for the Mailreach connect flow.
// Path is the common /api/mailboxes prefix so both routes' cookie jars overlap.
export const MAILREACH_OAUTH_STATE_COOKIE = 'mailreach_oauth_state'
export const MAILREACH_OAUTH_STATE_COOKIE_PATH = '/api/mailboxes'
export const MAILREACH_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600
```

Create `src/app/api/mailboxes/[id]/mailreach/connect/route.ts`:

```ts
import { randomUUID } from 'node:crypto'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxMailreachPending } from '@/lib/db/mailboxes'
import { connectSmtpMailbox, oauthAuthorizeUrl } from '@/lib/mailreach/enrollment'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { env } from '@/lib/env'
import {
  MAILREACH_OAUTH_STATE_COOKIE,
  MAILREACH_OAUTH_STATE_COOKIE_PATH,
  MAILREACH_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
} from '../../../mailreach/state-cookie'

export const runtime = 'nodejs'

// SMTP mailboxes connect synchronously — we already hold real IMAP/SMTP
// credentials. Gmail/Outlook mailboxes need Mailreach's own OAuth consent, so
// this hands the browser a redirect URL instead (checking the box for those
// providers navigates rather than firing an async toggle — see
// mailreach-controls.tsx).
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  const admin = createAdminClient()
  const mailbox = await getMailboxById(admin, id)
  if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  if (mailbox.provider === 'smtp') {
    try {
      await connectSmtpMailbox(admin, mailbox, new Date())
      await logEventSafe({
        clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_connected',
        source: 'mailbox', payload: { mailboxId: id, provider: 'smtp' },
      })
      return NextResponse.json({ ok: true, redirect: false })
    } catch (error) {
      return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
    }
  }

  const state = randomUUID()
  await updateMailboxMailreachPending(admin, id)
  const authorizeUrl = oauthAuthorizeUrl({
    provider: mailbox.provider as 'gmail' | 'outlook',
    redirectUri: new URL('/api/mailboxes/mailreach/callback', env.APP_URL).toString(),
    state,
  })
  const response = NextResponse.json({ ok: true, redirect: true, authorizeUrl })
  response.cookies.set(
    MAILREACH_OAUTH_STATE_COOKIE,
    JSON.stringify({ nonce: state, mailboxId: id }),
    {
      httpOnly: true,
      secure: env.APP_URL.startsWith('https://'),
      sameSite: 'lax',
      maxAge: MAILREACH_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS,
      path: MAILREACH_OAUTH_STATE_COOKIE_PATH,
    },
  )
  return response
}
```

Create `src/app/api/mailboxes/[id]/mailreach/disconnect/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById } from '@/lib/db/mailboxes'
import { disconnectMailbox } from '@/lib/mailreach/enrollment'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  const admin = createAdminClient()
  const mailbox = await getMailboxById(admin, id)
  if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    await disconnectMailbox(admin, mailbox)
    await logEventSafe({
      clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_disconnected',
      source: 'mailbox', payload: { mailboxId: id },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/mailboxes/\[id\]/mailreach`
Expected: PASS, all 8 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/mailboxes/[id]/mailreach" src/app/api/mailboxes/mailreach/state-cookie.ts
git commit -m "feat: add per-mailbox mailreach connect/disconnect routes"
```

---

## Task 7: OAuth callback route

**Files:**
- Create: `src/app/api/mailboxes/mailreach/callback/route.ts`
- Test: `src/app/api/mailboxes/mailreach/callback/route.test.ts`

**Interfaces:**
- Consumes: `completeOAuthConnectForMailbox` (Task 5), `getMailboxById` (existing), `timingSafeEqualString` (`@/lib/auth/timing-safe-equal`, existing), `MAILREACH_OAUTH_STATE_COOKIE` (Task 6).
- Produces: `GET /api/mailboxes/mailreach/callback` → redirect to `/settings?mailreach=connected` or `/settings?error=...`.

- [x] **Step 1: Write the failing tests**

Create `src/app/api/mailboxes/mailreach/callback/route.test.ts`. Neither `google/callback` nor `outlook/callback` has a test file today, so there's no prior art to match — the shape below (boundary-mocked, real `cookie` header string) is self-contained and consistent with the rest of this plan's route tests:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const completeOAuthConnectForMailbox = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ getMailboxById: (...args: unknown[]) => getMailboxById(...args) }))
vi.mock('@/lib/mailreach/enrollment', () => ({
  completeOAuthConnectForMailbox: (...args: unknown[]) => completeOAuthConnectForMailbox(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'http://localhost:3000' } }))

const { GET } = await import('./route')

function requestWithCookie(nonce: string, mailboxId: string, queryState: string, code = 'auth-code') {
  const cookieValue = encodeURIComponent(JSON.stringify({ nonce, mailboxId }))
  return new Request(`http://localhost:3000/api/mailboxes/mailreach/callback?code=${code}&state=${queryState}`, {
    headers: { cookie: `mailreach_oauth_state=${cookieValue}` },
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', provider: 'gmail' })
})

describe('GET /api/mailboxes/mailreach/callback', () => {
  it('should complete the connection when the state nonce matches', async () => {
    completeOAuthConnectForMailbox.mockResolvedValue(undefined)
    const response = await GET(requestWithCookie('nonce1', 'm1', 'nonce1'))
    expect(response.status).toBe(307)
    expect(response.headers.get('location')).toContain('/settings?mailreach=connected')
    expect(completeOAuthConnectForMailbox).toHaveBeenCalled()
  })

  it('should redirect with an oauth error when the state does not match the cookie', async () => {
    const response = await GET(requestWithCookie('nonce1', 'm1', 'wrong-nonce'))
    expect(response.headers.get('location')).toContain('/settings?error=oauth')
    expect(completeOAuthConnectForMailbox).not.toHaveBeenCalled()
  })

  it('should redirect with an oauth error when the cookie is missing', async () => {
    const response = await GET(
      new Request('http://localhost:3000/api/mailboxes/mailreach/callback?code=auth-code&state=nonce1'),
    )
    expect(response.headers.get('location')).toContain('/settings?error=oauth')
  })

  it('should redirect with not_found when the mailbox no longer exists', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await GET(requestWithCookie('nonce1', 'm1', 'nonce1'))
    expect(response.headers.get('location')).toContain('/settings?error=not_found')
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/api/mailboxes/mailreach/callback/route.test.ts`
Expected: FAIL — route doesn't exist yet.

- [x] **Step 3: Implement**

Create `src/app/api/mailboxes/mailreach/callback/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById } from '@/lib/db/mailboxes'
import { completeOAuthConnectForMailbox } from '@/lib/mailreach/enrollment'
import { logEventSafe } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'
import { timingSafeEqualString } from '@/lib/auth/timing-safe-equal'
import { MAILREACH_OAUTH_STATE_COOKIE } from '../state-cookie'

export const runtime = 'nodejs'

const cookieStateSchema = z.object({ nonce: z.string(), mailboxId: z.string() })

function redirectAndClearState(path: string): NextResponse {
  const response = NextResponse.redirect(new URL(path, env.APP_URL))
  response.cookies.delete(MAILREACH_OAUTH_STATE_COOKIE)
  return response
}

export async function GET(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  const cookieHeader = request.headers.get('cookie') ?? ''
  const rawCookie = cookieHeader
    .split(';')
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${MAILREACH_OAUTH_STATE_COOKIE}=`))
    ?.slice(MAILREACH_OAUTH_STATE_COOKIE.length + 1)

  if (!code || !state || !rawCookie) return redirectAndClearState('/settings?error=oauth')

  const cookieParse = (() => {
    try {
      return cookieStateSchema.safeParse(JSON.parse(decodeURIComponent(rawCookie)))
    } catch {
      return { success: false as const }
    }
  })()
  if (!cookieParse.success) return redirectAndClearState('/settings?error=oauth')

  // state is a single-use random nonce minted by /connect and stored in an
  // httpOnly cookie alongside the target mailbox id — this is the actual CSRF
  // check. Without a match, this callback either wasn't initiated by this
  // browser or is a replay.
  if (!timingSafeEqualString(state, cookieParse.data.nonce)) return redirectAndClearState('/settings?error=oauth')

  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, cookieParse.data.mailboxId)
    if (!mailbox) return redirectAndClearState('/settings?error=not_found')

    await completeOAuthConnectForMailbox(admin, mailbox, code, new Date())
    await logEventSafe({
      clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.mailreach_connected',
      source: 'mailbox', payload: { mailboxId: mailbox.id, provider: mailbox.provider },
    })
    return redirectAndClearState('/settings?mailreach=connected')
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return redirectAndClearState(`/settings?error=${reason}`)
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/mailboxes/mailreach/callback/route.test.ts`
Expected: PASS, all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mailboxes/mailreach/callback/route.ts src/app/api/mailboxes/mailreach/callback/route.test.ts
git commit -m "feat: add the mailreach oauth callback route"
```

---

## Task 8: Wire the gate into `sendViaMailbox`

**Files:**
- Modify: `src/lib/mailbox/sender.ts:63-70` (`rotationOrder`), `:101-119` (call site + `now` declaration)
- Modify: `src/lib/mailbox/sender.test.ts`

**Interfaces:**
- Consumes: `isEligibleForCampaignSend` (Task 2).
- Produces: `rotationOrder` now takes `(mailboxes, purpose, now)`; the existing `mailbox.none_healthy` warn log gains a `warmupGatedCount` field.

- [x] **Step 1: Write the failing tests**

Add to `src/lib/mailbox/sender.test.ts`, inside `describe('rotation and health', ...)`:

```ts
  it('should skip a mailbox gated by mailreach warmup for an outreach send but still use it for a reply', async () => {
    const now = new Date('2026-07-29T00:00:00Z')
    const gatedMailbox = mockMailbox({
      id: 'm-gated',
      sent_today: 0,
      mailreach_enabled: true,
      mailreach_started_at: new Date(now.getTime() - 3 * 86_400_000).toISOString(), // day 3, gate needs 14
    })
    const claimSpy = vi.fn().mockResolvedValue({ ...gatedMailbox, oauth: gatedMailbox.oauth })
    const supabase = buildSupabase({ mailboxes: [gatedMailbox], claim: claimSpy })

    await expect(
      sendViaMailbox(supabase, { ...baseInput, mailboxIds: ['m-gated'], purpose: 'outreach' }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(claimSpy).not.toHaveBeenCalled()

    const result = await sendViaMailbox(supabase, { ...baseInput, mailboxIds: ['m-gated'], purpose: 'reply' })
    expect(result.mailboxId).toBe('m-gated')
  })

  it('should still use a mailbox past day 14 of mailreach warmup for an outreach send', async () => {
    const now = new Date('2026-07-29T00:00:00Z')
    const warmMailbox = mockMailbox({
      id: 'm-warm',
      sent_today: 0,
      mailreach_enabled: true,
      mailreach_started_at: new Date(now.getTime() - 20 * 86_400_000).toISOString(),
    })
    const claimSpy = vi.fn().mockResolvedValue(warmMailbox)
    const supabase = buildSupabase({ mailboxes: [warmMailbox], claim: claimSpy })

    const result = await sendViaMailbox(supabase, { ...baseInput, mailboxIds: ['m-warm'], purpose: 'outreach' })
    expect(result.mailboxId).toBe('m-warm')
  })
```

Check the top of `sender.test.ts` for the existing `mockMailbox`/`buildSupabase` (or equivalently-named) test helpers already used by the neighboring `rotation and health` tests, and reuse them exactly rather than inventing new ones — match whatever fixture shape `'should skip a blocked mailbox entirely'` already uses, extended with the two new `mailreach_*` fields (defaulting every other existing fixture call to `mailreach_enabled: false, mailreach_started_at: null` implicitly, since those are the fixture's defaults once Task 1's migration fields exist).

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: FAIL — `rotationOrder` doesn't gate on mailreach yet.

- [x] **Step 3: Implement**

In `src/lib/mailbox/sender.ts`, add the import:

```ts
import { isEligibleForCampaignSend } from '@/lib/mailbox/mailreach-gate'
```

Replace `rotationOrder`:

```ts
// Rotation: least-used-first, so sends spread evenly across a campaign's
// mailboxes and warm them uniformly. 'warning' is a soft flag that still sends;
// only 'blocked' takes a mailbox out of rotation. The mailreach gate only
// applies to 'outreach' — a reply is allowed regardless of warmup state, same
// as it bypasses most suppression rules.
function rotationOrder(mailboxes: MailboxRow[], purpose: SendPurpose, now: Date): MailboxRow[] {
  return [...mailboxes]
    .filter((m) => m.health !== 'blocked')
    .filter(
      (m) =>
        purpose !== 'outreach' ||
        isEligibleForCampaignSend({
          mailreachEnabled: m.mailreach_enabled,
          mailreachStartedAt: m.mailreach_started_at,
          now,
        }),
    )
    .sort((a, b) => a.sent_today - b.sent_today)
}
```

In `sendViaMailbox`, move the `const now = new Date()` declaration up so it's available to `rotationOrder`, and update the call site and the `none_healthy` log payload:

```ts
  const mailboxes = await listMailboxesByIds(supabase, input.mailboxIds)
  const now = new Date()
  const ordered = rotationOrder(mailboxes, input.purpose, now)
  if (ordered.length === 0) {
    const warmupGatedCount =
      input.purpose === 'outreach'
        ? mailboxes.filter(
            (m) =>
              m.health !== 'blocked' &&
              !isEligibleForCampaignSend({
                mailreachEnabled: m.mailreach_enabled,
                mailreachStartedAt: m.mailreach_started_at,
                now,
              }),
          ).length
        : 0
    const error = new AppError('RATE_LIMITED', 'No healthy mailbox available', { clientId: input.clientId })
    await logWarn({
      clientId: input.clientId,
      actor: 'system',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      error,
      payload: { mailboxCount: mailboxes.length, warmupGatedCount },
    })
    throw error
  }
```

Remove the now-duplicate `const now = new Date()` further down (the one that previously preceded the `for (const candidate of ordered)` loop) — there is only one `now` declaration after this change, reused by both `rotationOrder` and the `effectiveDailyCap` call inside the loop.

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: PASS, full file (existing tests plus the two new ones).

- [x] **Step 5: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts
git commit -m "feat: gate outreach sends on mailreach warmup eligibility"
```

---

## Task 9: Client-level master switch (PATCH route)

**Files:**
- Modify: `src/app/api/clients/[clientId]/route.ts`
- Modify: `src/app/api/clients/[clientId]/route.test.ts` (create it if it doesn't already exist — check first)

**Interfaces:**
- Consumes: `updateClientMailreachEnabled` (Task 4), `bulkDisconnectForClient`, `bulkReconnectSmtpForClient` (Task 5).
- Produces: `PATCH /api/clients/[clientId]` accepts `{ mailreachEnabled: boolean }`.

- [x] **Step 1: Extend the existing test file**

`src/app/api/clients/[clientId]/route.test.ts` already exists (137 lines: `PATCH`/`DELETE` describe blocks, mock-function-per-import convention with `xxxMock` names reset in `beforeEach`). Add two new mocks to the top-of-file `vi.fn()` declarations and the `vi.mock('@/lib/db/clients', ...)` factory, add a new `vi.mock('@/lib/mailreach/enrollment', ...)` block, reset the two new mocks in the existing `beforeEach`, and add a new `describe` block. Diff against the current file:

```ts
const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientNameMock = vi.fn()
const updateClientDomainMock = vi.fn()
const updateClientMailreachEnabledMock = vi.fn()
const deleteClientCascadeMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const deleteAuthUsersMock = vi.fn()
const logEventMock = vi.fn()
const bulkDisconnectForClientMock = vi.fn()
const bulkReconnectSmtpForClientMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientName: (...a: unknown[]) => updateClientNameMock(...a),
  updateClientDomain: (...a: unknown[]) => updateClientDomainMock(...a),
  updateClientMailreachEnabled: (...a: unknown[]) => updateClientMailreachEnabledMock(...a),
  deleteClientCascade: (...a: unknown[]) => deleteClientCascadeMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/mailreach/enrollment', () => ({
  bulkDisconnectForClient: (...a: unknown[]) => bulkDisconnectForClientMock(...a),
  bulkReconnectSmtpForClient: (...a: unknown[]) => bulkReconnectSmtpForClientMock(...a),
}))
vi.mock('@/lib/supabase/auth-admin', () => ({ deleteAuthUsers: (...a: unknown[]) => deleteAuthUsersMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))
```

(Note: the file doesn't currently mock `updateClientWarmupProfile` at all — the route still imports it, so leave that gap as-is; it's pre-existing and out of scope here. Do not "fix" it as a drive-by change.)

In `beforeEach`, add the two new resets next to the existing ones:

```ts
  updateClientMailreachEnabledMock.mockReset()
  bulkDisconnectForClientMock.mockReset()
  bulkReconnectSmtpForClientMock.mockReset()
```

Append a new `describe` block after the existing `describe('PATCH /api/clients/[clientId]', ...)` block:

```ts
describe('PATCH /api/clients/[clientId] — mailreachEnabled', () => {
  it('should bulk-disconnect when turned off', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: true })
    updateClientMailreachEnabledMock.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: false })
    bulkDisconnectForClientMock.mockResolvedValue({ attempted: 2, succeeded: 2, failed: 0 })
    const res = await PATCH(req({ mailreachEnabled: false }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(bulkDisconnectForClientMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(bulkReconnectSmtpForClientMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.mailreach_enabled_changed' }))
  })

  it('should bulk-reconnect smtp mailboxes when turned on', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: false })
    updateClientMailreachEnabledMock.mockResolvedValue({ id: 'c1', name: 'Acme', mailreach_enabled: true })
    bulkReconnectSmtpForClientMock.mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0 })
    const res = await PATCH(req({ mailreachEnabled: true }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(bulkReconnectSmtpForClientMock).toHaveBeenCalledWith(expect.anything(), 'c1', expect.any(Date))
    expect(bulkDisconnectForClientMock).not.toHaveBeenCalled()
  })

  it('should reject a client-role user', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const res = await PATCH(req({ mailreachEnabled: true }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(updateClientMailreachEnabledMock).not.toHaveBeenCalled()
  })
})
```

This reuses the file's existing `req`/`ctx` helper functions — no new test-only helpers needed.

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]"`
Expected: FAIL — `mailreachEnabled` isn't accepted by the schema yet.

- [x] **Step 3: Implement**

In `src/app/api/clients/[clientId]/route.ts`, add the imports:

```ts
import { updateClientMailreachEnabled } from '@/lib/db/clients' // add alongside the existing named imports from './lib/db/clients'
import { bulkDisconnectForClient, bulkReconnectSmtpForClient } from '@/lib/mailreach/enrollment'
```

Extend `patchSchema`:

```ts
const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    warmupProfile: z.enum(['standard', 'slow', 'none']).optional(),
    domain: domainSchema.optional(),
    mailreachEnabled: z.boolean().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.warmupProfile !== undefined ||
      body.domain !== undefined ||
      body.mailreachEnabled !== undefined,
    { message: 'At least one field must be provided' },
  )
```

Add a branch after the existing `if (body.domain !== undefined) { ... }` block, before `return NextResponse.json({ ok: true, client: updated })`:

```ts
    if (body.mailreachEnabled !== undefined) {
      updated = await updateClientMailreachEnabled(admin, clientId, body.mailreachEnabled)
      const bulkResult = body.mailreachEnabled
        ? await bulkReconnectSmtpForClient(admin, clientId, new Date())
        : await bulkDisconnectForClient(admin, clientId)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.mailreach_enabled_changed',
          payload: { from: client.mailreach_enabled, to: body.mailreachEnabled, bulkResult },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]"`
Expected: PASS.

- [x] **Step 5: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/clients/[clientId]/route.ts" "src/app/api/clients/[clientId]/route.test.ts"
git commit -m "feat: add the client-level mailreach master switch"
```

---

## Task 10: `/settings` UI — per-mailbox checkbox and day-count display

**Files:**
- Create: `src/app/(app)/settings/mailreach-controls.tsx`
- Modify: `src/app/(app)/settings/mailbox-row.tsx`, `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `mailreachElapsedDays`, `MAILREACH_CAMPAIGN_GATE_DAYS` (Task 2); `POST /api/mailboxes/[id]/mailreach/connect` and `.../disconnect` (Task 6).
- Produces: visible mailreach status text (both roles); operator-only checkbox.

- [x] **Step 1: Implement `MailreachControls`**

Create `src/app/(app)/settings/mailreach-controls.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { Database } from '@/types/database'

type MailboxProvider = Database['public']['Enums']['mailbox_provider']

interface MailreachControlsProps {
  id: string
  provider: MailboxProvider
  enabled: boolean
}

// SMTP mailboxes toggle synchronously (we hold real IMAP/SMTP credentials).
// Gmail/Outlook mailboxes need Mailreach's own OAuth consent — checking the
// box for those navigates the browser instead of firing an async POST.
export function MailreachControls({ id, provider, enabled }: MailreachControlsProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBusy = isPending || isSubmitting

  async function toggle(next: boolean): Promise<void> {
    if (isBusy) return
    setError(null)

    if (next && provider !== 'smtp') {
      const response = await fetch(`/api/mailboxes/${id}/mailreach/connect`, { method: 'POST' })
      const json: unknown = await response.json()
      if (
        response.ok &&
        typeof json === 'object' &&
        json !== null &&
        'authorizeUrl' in json &&
        typeof (json as { authorizeUrl: unknown }).authorizeUrl === 'string'
      ) {
        window.location.href = (json as { authorizeUrl: string }).authorizeUrl
        return
      }
      setError('Could not start the Mailreach connection.')
      return
    }

    setIsSubmitting(true)
    try {
      const path = next ? 'connect' : 'disconnect'
      const response = await fetch(`/api/mailboxes/${id}/mailreach/${path}`, { method: 'POST' })
      if (!response.ok) {
        setError('Could not apply that change.')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('network')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-[11px]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isBusy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        Mailreach warmup
      </label>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [x] **Step 2: Extend `MailboxRow` to show the status and mount the controls**

In `src/app/(app)/settings/mailbox-row.tsx`, add the import and props:

```ts
import { mailreachElapsedDays, MAILREACH_CAMPAIGN_GATE_DAYS } from '@/lib/mailbox/mailreach-gate'
import { MailreachControls } from './mailreach-controls'
import type { Database } from '@/types/database'

type MailreachStatus = Database['public']['Enums']['mailreach_status']
```

Extend `MailboxRowProps`:

```ts
interface MailboxRowProps {
  id: string
  provider: 'gmail' | 'outlook' | 'smtp'
  emailAddress: string
  displayName: string | null
  health: 'ok' | 'warning' | 'blocked'
  healthReason: string | null
  warmupProfile: WarmupProfile
  warmupStartedAt: string | null
  dailyCap: number
  sentToday: number
  viewerRole: UserRole
  mailreachEnabled: boolean
  mailreachStartedAt: string | null
  mailreachStatus: MailreachStatus
  mailreachReputationScore: number | null
}
```

Add a small formatter above the component (visible to both roles, so it belongs in the row body, not behind `viewerRole === 'operator'`):

```ts
function mailreachStatusText(props: {
  enabled: boolean
  startedAt: string | null
  status: MailreachStatus
  reputationScore: number | null
}): string | null {
  if (!props.enabled || props.startedAt === null) return null
  if (props.status !== 'connected') return 'Mailreach: needs reconnect'
  const elapsed = mailreachElapsedDays(props.startedAt, new Date())
  if (elapsed < MAILREACH_CAMPAIGN_GATE_DAYS) {
    return `Mailreach: day ${elapsed}/${MAILREACH_CAMPAIGN_GATE_DAYS} · warming`
  }
  return props.reputationScore !== null ? `Mailreach: warm · reputation ${props.reputationScore}` : 'Mailreach: warm'
}
```

In the component body, compute it and render it next to the existing cap/ramp text, and mount the operator-only checkbox next to `MailboxControls`:

```tsx
  const mailreachText = mailreachStatusText({
    enabled: props.mailreachEnabled,
    startedAt: props.mailreachStartedAt,
    status: props.mailreachStatus,
    reputationScore: props.mailreachReputationScore,
  })
```

```tsx
        <p className="text-faint truncate text-[11px]">
          {props.displayName ?? 'No display name'} · {props.provider} ·{' '}
          <span className="tnum">
            {props.sentToday}/{capToday} today
          </span>
          {isRamping ? ` · warming up (cap ${props.dailyCap})` : null}
          {props.healthReason ? ` · ${props.healthReason.replaceAll('_', ' ')}` : null}
          {mailreachText ? ` · ${mailreachText}` : null}
        </p>
```

```tsx
      {props.viewerRole === 'operator' ? (
        <>
          <MailboxControls id={props.id} isBlocked={props.health === 'blocked'} warmupProfile={props.warmupProfile} />
          <MailreachControls id={props.id} provider={props.provider} enabled={props.mailreachEnabled} />
        </>
      ) : null}
```

- [x] **Step 3: Pass the new fields from `page.tsx`**

In `src/app/(app)/settings/page.tsx`, extend the `<MailboxRow ... />` call:

```tsx
                <MailboxRow
                  id={mailbox.id}
                  provider={mailbox.provider}
                  emailAddress={mailbox.email_address}
                  displayName={mailbox.display_name}
                  health={mailbox.health}
                  healthReason={mailbox.health_reason}
                  warmupProfile={mailbox.warmup_profile}
                  warmupStartedAt={mailbox.warmup_started_at}
                  dailyCap={mailbox.daily_cap}
                  sentToday={mailbox.sent_today}
                  viewerRole={appUser.role}
                  mailreachEnabled={mailbox.mailreach_enabled}
                  mailreachStartedAt={mailbox.mailreach_started_at}
                  mailreachStatus={mailbox.mailreach_status}
                  mailreachReputationScore={mailbox.mailreach_reputation_score}
                />
```

- [x] **Step 4: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [x] **Step 5: Run the full lint pass**

Run: `pnpm eslint src/app/\(app\)/settings`
Expected: PASS.

- [ ] **Step 6: Manually verify in the browser**

Run the dev server (`pnpm dev`), sign in as an operator, open `/settings`. Confirm: the mailreach checkbox appears on each mailbox row; checking it on an SMTP mailbox flips synchronously and the row shows `Mailreach: day 0/14 · warming`; checking it on a Gmail/Outlook mailbox navigates toward Mailreach's OAuth URL (it will fail past that point without real Mailreach credentials — confirming the redirect fires is sufficient here). Sign in as a client-role user and confirm the status text is visible but no checkbox renders.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/settings/mailreach-controls.tsx" "src/app/(app)/settings/mailbox-row.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "feat: add per-mailbox mailreach controls to /settings"
```

---

## Task 11: `/clients/[id]` UI — client-level master switch

**Files:**
- Create: `src/app/(app)/clients/[id]/mailreach-toggle.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `PATCH /api/clients/[clientId]` with `{ mailreachEnabled }` (Task 9).

- [x] **Step 1: Implement `MailreachToggle`**

Create `src/app/(app)/clients/[id]/mailreach-toggle.tsx` (mirrors `warmup-profile-select.tsx`'s PATCH pattern exactly):

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'

interface MailreachToggleProps {
  clientId: string
  enabled: boolean
}

// Client-level kill switch. Turning it off bulk-disconnects every currently
// connected mailbox under this client (best-effort); turning it back on
// silently reconnects the SMTP ones and leaves gmail/outlook ones showing
// "needs reconnect" on /settings, since OAuth needs interactive consent.
export function MailreachToggle({ clientId, enabled }: MailreachToggleProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function toggle(next: boolean): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mailreachEnabled: next }),
    })
    if (!response.ok) {
      setError('Could not save that.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-[11px]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isPending}
          onChange={(event) => void toggle(event.target.checked)}
        />
        Mailreach warmup for this client
      </label>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [x] **Step 2: Mount it on the client detail page**

In `src/app/(app)/clients/[id]/page.tsx`, add the import next to `WarmupProfileSelect`:

```ts
import { MailreachToggle } from './mailreach-toggle'
```

Render it in the header controls row, next to the existing `WarmupProfileSelect`:

```tsx
          <div className="flex flex-wrap items-center gap-3">
            <ClientLifecycleActions clientId={client.id} status={client.status} />
            <WarmupProfileSelect clientId={client.id} value={client.warmup_profile} />
            <MailreachToggle clientId={client.id} enabled={client.mailreach_enabled} />
          </div>
```

- [x] **Step 3: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Manually verify in the browser**

Sign in as an operator, open any `/clients/[id]` page, confirm the checkbox renders and toggling it round-trips (network tab shows the PATCH, page refreshes with the new state).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/clients/[id]/mailreach-toggle.tsx" "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat: add the client-level mailreach master switch to the client page"
```

---

## Task 12: Stats sync cron

**Files:**
- Create: `src/lib/pipeline/mailreach-sync.ts`
- Create: `src/app/api/pipeline/mailreach-sync/route.ts`
- Create: `scripts/schedule-mailreach-sync-cron.ts`
- Test: `src/lib/pipeline/mailreach-sync.test.ts`, `src/app/api/pipeline/mailreach-sync/route.test.ts`

**Interfaces:**
- Consumes: `listMailreachConnectedMailboxes`, `updateMailboxMailreachStats` (Task 4); `getAccountStats` (Task 3).
- Produces: `runMailreachStatsSync(supabase, { now }): Promise<{ evaluated: number; failed: number }>`; `POST /api/pipeline/mailreach-sync` (QStash-signed cron entry).

- [x] **Step 1: Write the failing pipeline test**

Create `src/lib/pipeline/mailreach-sync.test.ts` (mirrors `mailbox-health.test.ts`'s shape):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMailreachConnectedMailboxes = vi.fn()
const updateMailboxMailreachStats = vi.fn()
const getAccountStats = vi.fn()

vi.mock('@/lib/db/mailboxes', () => ({
  listMailreachConnectedMailboxes: (...args: unknown[]) => listMailreachConnectedMailboxes(...args),
  updateMailboxMailreachStats: (...args: unknown[]) => updateMailboxMailreachStats(...args),
}))
vi.mock('@/lib/mailreach/client', () => ({ getAccountStats: (...args: unknown[]) => getAccountStats(...args) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

import { runMailreachStatsSync } from './mailreach-sync'

const now = new Date('2026-07-29T00:00:00.000Z')

beforeEach(() => vi.clearAllMocks())

describe('runMailreachStatsSync', () => {
  it('should sync every connected mailbox and report zero failures', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccountStats.mockResolvedValue({ reputationScore: 90 })

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 0 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm1', { reputationScore: 90, syncedAt: now.toISOString() })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm2', { reputationScore: 90, syncedAt: now.toISOString() })
  })

  it('should count a per-mailbox failure without stopping the sweep', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccountStats.mockRejectedValueOnce(new Error('vendor down')).mockResolvedValueOnce({ reputationScore: 80 })

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 1 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledTimes(1)
  })

  it('should skip a mailbox with no account id', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', mailreach_account_id: null }])
    const result = await runMailreachStatsSync({} as never, { now })
    expect(result).toEqual({ evaluated: 1, failed: 0 })
    expect(getAccountStats).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/mailreach-sync.test.ts`
Expected: FAIL — module doesn't exist yet.

- [x] **Step 3: Implement the sync sweep**

Create `src/lib/pipeline/mailreach-sync.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listMailreachConnectedMailboxes, updateMailboxMailreachStats } from '@/lib/db/mailboxes'
import { getAccountStats } from '@/lib/mailreach/client'
import { logEventSafe } from '@/lib/events/log-event'

export interface MailreachSyncSummary {
  evaluated: number
  failed: number
}

/**
 * Refreshes the cached reputation score for every mailbox currently connected
 * to Mailreach, so /settings can show it to both operator and client without
 * calling the vendor API on every page load. Best-effort per mailbox — one
 * vendor failure doesn't stop the rest of the sweep.
 */
export async function runMailreachStatsSync(
  supabase: SupabaseClient<Database>,
  { now }: { now: Date },
): Promise<MailreachSyncSummary> {
  const mailboxes = await listMailreachConnectedMailboxes(supabase)
  let failed = 0
  for (const mailbox of mailboxes) {
    if (!mailbox.mailreach_account_id) continue
    try {
      const stats = await getAccountStats(mailbox.mailreach_account_id)
      await updateMailboxMailreachStats(supabase, mailbox.id, {
        reputationScore: stats.reputationScore,
        syncedAt: now.toISOString(),
      })
    } catch (error) {
      failed += 1
      await logEventSafe({
        clientId: mailbox.client_id,
        actor: 'mailreach_stats_sync',
        type: 'mailbox.mailreach_stats_sync_failed',
        source: 'mailbox',
        payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return { evaluated: mailboxes.length, failed }
}
```

- [x] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/mailreach-sync.test.ts`
Expected: PASS.

- [x] **Step 5: Write the failing route test**

Create `src/app/api/pipeline/mailreach-sync/route.test.ts` (mirrors `mailbox-health/route.ts`'s pattern — check for an existing `.test.ts` next to it first and copy its shape if present):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyQstashSignature = vi.fn()
const runMailreachStatsSync = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...args: unknown[]) => verifyQstashSignature(...args) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/mailreach-sync', () => ({
  runMailreachStatsSync: (...args: unknown[]) => runMailreachStatsSync(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

beforeEach(() => {
  vi.clearAllMocks()
  verifyQstashSignature.mockResolvedValue(undefined)
  runMailreachStatsSync.mockResolvedValue({ evaluated: 3, failed: 0 })
})

describe('POST /api/pipeline/mailreach-sync', () => {
  it('should run the sweep and return the summary', async () => {
    const response = await POST(new Request('http://x', { method: 'POST' }))
    expect(response.status).toBe(200)
    const body = await response.json()
    expect(body).toEqual({ ok: true, evaluated: 3, failed: 0 })
  })

  it('should return 401 when the qstash signature is invalid', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyQstashSignature.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const response = await POST(new Request('http://x', { method: 'POST' }))
    expect(response.status).toBe(401)
  })
})
```

- [x] **Step 6: Run the test to verify it fails**

Run: `pnpm vitest run src/app/api/pipeline/mailreach-sync/route.test.ts`
Expected: FAIL — route doesn't exist yet.

- [x] **Step 7: Implement the route**

Create `src/app/api/pipeline/mailreach-sync/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runMailreachStatsSync } from '@/lib/pipeline/mailreach-sync'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const summary = await runMailreachStatsSync(admin, { now: new Date() })
    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'mailbox.mailreach_sync.completed',
      source: 'pipeline',
      payload: { ...summary },
    })
    return NextResponse.json({ ok: true, ...summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [x] **Step 8: Run the test to verify it passes**

Run: `pnpm vitest run src/app/api/pipeline/mailreach-sync/route.test.ts`
Expected: PASS.

- [x] **Step 9: Add the schedule script**

Create `scripts/schedule-mailreach-sync-cron.ts`:

```ts
// One-time setup: registers the QStash schedule that refreshes every
// Mailreach-connected mailbox's cached reputation score. Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-mailreach-sync-cron.ts [cron-expression]
// Default cron: "0 */6 * * *" (every 6 hours — same cadence as the existing
// mailbox-health sweep).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 */6 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailreach-sync', cron)
  process.stdout.write(`Scheduled mailreach-sync cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [x] **Step 10: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add src/lib/pipeline/mailreach-sync.ts src/lib/pipeline/mailreach-sync.test.ts src/app/api/pipeline/mailreach-sync scripts/schedule-mailreach-sync-cron.ts
git commit -m "feat: add the mailreach stats sync cron"
```

---

## Task 13: Full verification + roadmap

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: every test file passes, including all new files from Tasks 1-12.

- [ ] **Step 2: Run the type checker**

Run: `pnpm tsc --noEmit`
Expected: PASS, zero errors.

- [ ] **Step 3: Run the linter**

Run: `pnpm eslint .`
Expected: PASS (or only pre-existing warnings unrelated to this feature — confirm any warning shown was already present before this branch by checking `git stash` / `git diff` against `master`).

- [ ] **Step 4: Update the roadmap**

Add a new section to `.claude/roadmap.md`, in the same style as the existing `P4 — Deliverability Hardening` entry, listing each task above as a checked-off bullet with the same one-line-per-deliverable format already used there (schema, gate logic, API client, orchestration, routes, sender wiring, client switch, UI, stats sync), plus a one-line demo description: "an operator flips Mailreach on for a client, an SMTP mailbox connects immediately and shows day-count progress to both roles, campaign sends stay gated until day 14, and turning the client switch off bulk-disconnects everything."

- [ ] **Step 5: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: record the mailreach warmup integration in the roadmap"
```

---

## Post-plan note

`MAILREACH_API_KEY` must be set in every environment (local `.env.local`, Vercel project settings) before Task 1's env-schema change ships, or every deploy will fail fast at boot (`env.ts` throws `CONFIG_ERROR` for any missing required var) — this is intentional fail-fast behavior per `QUALITY.md`, not a bug to work around.
