# Configurable Per-Mailbox Warmup Caps Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator configure, per mailbox, the warmup ramp's start cap, step increment, and target cap (where ramping stops), plus an independently editable already-warm daily cap — surfaced in a new Warmup tab on the Clients detail page.

**Architecture:** Replace the two hardcoded global ramp constants with three new per-mailbox columns. The ramp-to-warm transition stays fully derived (no new cron, no persisted state flag): once the computed ramp value reaches the target cap, the same pure function starts returning the already-warm cap (the existing `daily_cap` column) on every call. The existing per-mailbox `POST /api/mailboxes/[id]/warmup` route is extended to a partial update covering all four numeric fields plus the profile, reused by both the existing `/settings` page and the new Clients-page tab.

**Tech Stack:** Next.js Route Handlers, Supabase/Postgres, Zod, Vitest, React (Server + Client Components).

## Global Constraints

- Per-mailbox only, operator-only — no client-level defaults for the four new numeric fields.
- The ramp-to-warm transition is fully computed on every read — no new cron job, no persisted "is warm" flag.
- Editing any of the four numeric fields (start cap, increment, target cap, already-warm cap) never resets `warmup_started_at`. Only an actual `profile` value change resets it, via the existing `warmupInsertFields`.
- `src/types/database.ts` is hand-authored (no live `supabase gen types` connection) — edit it by hand to match the migration exactly.
- Follow `.claude/QUALITY.md`: one function per DB operation, Zod validation on every route input, `{ data, error }` handled on every Supabase call, `AppError` (never a bare `Error`) on every failure path, no `any`.
- Matches the codebase's existing convention (see `reply-mode-section.tsx`) of not adding component-level tests for small settings UI — the pure functions and route handler underneath carry full test coverage instead.
- Design doc: `docs/superpowers/specs/2026-08-03-configurable-warmup-caps-design.md`.

---

### Task 1: Migration — three new `mailboxes` columns + hand-authored types

**Files:**
- Create: `supabase/migrations/0024_configurable_warmup_caps.sql`
- Modify: `src/types/database.ts:664-723` (the `mailboxes` table `Row`/`Insert` shape)

**Interfaces:**
- Produces: `mailboxes.warmup_start_cap` (int, not null, default 5), `mailboxes.warmup_increment` (int, not null, default 3), `mailboxes.warmup_target_cap` (int, not null, backfilled from `daily_cap`) — Postgres columns, and `Database['public']['Tables']['mailboxes']['Row']['warmup_start_cap' | 'warmup_increment' | 'warmup_target_cap']` (all `number`, optional on `Insert`).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0024_configurable_warmup_caps.sql`:

```sql
-- Configurable per-mailbox warmup ramp: start cap, increment, and the target
-- cap where ramping stops. Defaults match the ramp's previous hardcoded
-- constants (WARMUP_START_CAP=5, WARMUP_INCREMENT=3); warmup_target_cap
-- backfills from the existing daily_cap so every existing mailbox computes
-- the exact same cap today as it did yesterday. From the moment the ramp
-- value reaches warmup_target_cap, effectiveDailyCap() serves daily_cap
-- instead — the existing "already warm" cap, now independently editable from
-- the Clients page's Warmup tab. See
-- docs/superpowers/specs/2026-08-03-configurable-warmup-caps-design.md.

alter table mailboxes add column warmup_start_cap  integer not null default 5;
alter table mailboxes add column warmup_increment  integer not null default 3;
alter table mailboxes add column warmup_target_cap integer;
update mailboxes set warmup_target_cap = daily_cap where warmup_target_cap is null;
alter table mailboxes alter column warmup_target_cap set not null;
```

- [ ] **Step 2: Update the hand-authored database types**

In `src/types/database.ts`, the `mailboxes` table `Row` currently reads (lines 664-688):

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
```

Add the three new fields immediately after `warmup_started_at`:

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
          warmup_start_cap: number
          warmup_increment: number
          warmup_target_cap: number
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
```

The `Insert` type currently reads (lines 689-712), unchanged except the same three additions after `warmup_started_at?: string | null`:

```ts
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
          warmup_start_cap?: number
          warmup_increment?: number
          warmup_target_cap?: number
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
```

(`Update` is already `Partial<Database['public']['Tables']['mailboxes']['Insert']>` at line 713 — no separate edit needed there.)

- [ ] **Step 3: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: PASS, no new errors. Widening `Row`/`Insert` with new required fields is backward-compatible for every existing reader (nothing in the codebase constructs a hand-typed `MailboxRow` object literal — every value comes back from a Supabase query, and every consumer only reads the specific fields it already used). The three new columns aren't referenced by any call site yet — that starts in Task 2 (which changes what `effectiveDailyCap` accepts) and Task 3 (the first real caller to pass them).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0024_configurable_warmup_caps.sql src/types/database.ts
git commit -m "feat: add configurable warmup cap columns to mailboxes"
```

---

### Task 2: Ramp math — `effectiveDailyCap` + `getMailboxWarmthStatus` in `lib/mailbox/warmup.ts`

**Files:**
- Modify: `src/lib/mailbox/warmup.ts` (full rewrite of the ramp section, lines 1-58; `warmupInsertFields`, lines 60-73, is unchanged)
- Test: `src/lib/mailbox/warmup.test.ts` (full rewrite)

**Interfaces:**
- Consumes: nothing new.
- Produces: `EffectiveCapInput` (now with `startCap: number`, `increment: number`, `targetCap: number` in addition to the existing `profile`, `warmupStartedAt`, `dailyCap`, `now`); `effectiveDailyCap(input: EffectiveCapInput): number`; `WarmthStatus` (discriminated union: `{kind:'not_ramping'} | {kind:'ramping'; currentCap: number; dayNumber: number} | {kind:'ramp_complete'}`); `getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus`. Used by Task 3 (`sender.ts`), Task 5 (`mailbox-row.tsx`), and Task 7 (`warmup-mailbox-row.tsx`). `WARMUP_START_CAP`/`WARMUP_INCREMENT` module constants are deleted — confirmed unused anywhere outside this file and its own test.

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/mailbox/warmup.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest'
import { effectiveDailyCap, getMailboxWarmthStatus, warmupInsertFields } from './warmup'
import { AppError } from '@/lib/errors/app-error'

const START = '2026-07-01T00:00:00.000Z'

function atDay(day: number): Date {
  return new Date(Date.parse(START) + day * 86_400_000)
}

const BASE = { startCap: 5, increment: 3, targetCap: 40, dailyCap: 40 }

describe('effectiveDailyCap', () => {
  it('should return the already-warm daily cap when the profile is none', () => {
    const cap = effectiveDailyCap({ profile: 'none', warmupStartedAt: START, ...BASE, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should return the already-warm daily cap when warmup never started', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should step every day when the profile is standard', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, ...BASE, targetCap: 1000, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 8, 11, 14, 17, 20])
  })

  it('should hold each level for two days when the profile is slow', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'slow', warmupStartedAt: START, ...BASE, targetCap: 1000, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 5, 8, 8, 11, 11])
  })

  it('should return the already-warm cap once the ramp value reaches the target', () => {
    // start 5 + increment 3 * 2 steps = 11, target 11 -> boundary, ramp complete.
    const cap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 50, now: atDay(2),
    })
    expect(cap).toBe(50)
  })

  it('should stay on the already-warm cap long after the ramp completes', () => {
    const cap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 50, now: atDay(30),
    })
    expect(cap).toBe(50)
  })

  it('should resume ramping if the target cap is raised after completion', () => {
    const completedCap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 50, now: atDay(2),
    })
    expect(completedCap).toBe(50)
    const resumedCap = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 100, dailyCap: 50, now: atDay(2),
    })
    expect(resumedCap).toBe(11)
  })

  it('should use each mailbox own start cap and increment', () => {
    const gentle = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 2, increment: 1, targetCap: 1000, dailyCap: 999, now: atDay(3),
    })
    const aggressive = effectiveDailyCap({
      profile: 'standard', warmupStartedAt: START, startCap: 10, increment: 10, targetCap: 1000, dailyCap: 999, now: atDay(3),
    })
    expect(gentle).toBe(5)
    expect(aggressive).toBe(40)
  })

  it('should start at the configured start cap on a partial first day', () => {
    const now = new Date(Date.parse(START) + 23 * 3_600_000)
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, ...BASE, targetCap: 1000, now })
    expect(cap).toBe(5)
  })

  it('should clamp to the start cap when the clock is behind the start date', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, ...BASE, targetCap: 1000, now: atDay(-5) })
    expect(cap).toBe(5)
  })

  it('should throw INVARIANT_VIOLATION when the start timestamp is unparseable', () => {
    expect(() =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: 'not-a-date', ...BASE, now: atDay(0) }),
    ).toThrow(AppError)
  })
})

describe('getMailboxWarmthStatus', () => {
  it('should report not_ramping for an already-warm profile', () => {
    const status = getMailboxWarmthStatus({ profile: 'none', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(status).toEqual({ kind: 'not_ramping' })
  })

  it('should report not_ramping when warmup never started', () => {
    const status = getMailboxWarmthStatus({ profile: 'standard', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(status).toEqual({ kind: 'not_ramping' })
  })

  it('should report ramping with the current cap and day number', () => {
    const status = getMailboxWarmthStatus({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 1000, dailyCap: 40, now: atDay(2),
    })
    expect(status).toEqual({ kind: 'ramping', currentCap: 11, dayNumber: 3 })
  })

  it('should report ramp_complete exactly at the target boundary', () => {
    const status = getMailboxWarmthStatus({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 40, now: atDay(2),
    })
    expect(status).toEqual({ kind: 'ramp_complete' })
  })

  it('should report ramp_complete long after the ramp finished', () => {
    const status = getMailboxWarmthStatus({
      profile: 'standard', warmupStartedAt: START, startCap: 5, increment: 3, targetCap: 11, dailyCap: 40, now: atDay(30),
    })
    expect(status).toEqual({ kind: 'ramp_complete' })
  })

  it('should throw INVARIANT_VIOLATION when the start timestamp is unparseable', () => {
    expect(() =>
      getMailboxWarmthStatus({ profile: 'standard', warmupStartedAt: 'not-a-date', ...BASE, now: atDay(0) }),
    ).toThrow(AppError)
  })
})

describe('warmupInsertFields', () => {
  it('should stamp a start time for a ramping profile', () => {
    const fields = warmupInsertFields('standard', atDay(0))
    expect(fields).toEqual({ warmup_profile: 'standard', warmup_started_at: START })
  })

  it('should leave the start time null for an already-warm mailbox', () => {
    const fields = warmupInsertFields('none', atDay(0))
    expect(fields).toEqual({ warmup_profile: 'none', warmup_started_at: null })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/mailbox/warmup.test.ts`
Expected: FAIL — `getMailboxWarmthStatus` is not exported from `./warmup`, and the `effectiveDailyCap` tests that rely on a separate `targetCap` (the "ramp value reaches the target", "resume ramping", and "own start cap and increment" cases) fail their assertions against the current single-ceiling implementation.

- [ ] **Step 3: Write the implementation**

Replace `src/lib/mailbox/warmup.ts` lines 1-58 (everything up to, but not including, `warmupInsertFields`):

```ts
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type WarmupProfile = Database['public']['Enums']['warmup_profile']

/**
 * Days a mailbox holds each level before stepping up. 'standard' steps daily
 * (start, start+increment, start+2*increment, ...); 'slow' holds each level
 * for two days, for a domain that needs a gentler ramp; 'none' is an
 * already-warm mailbox and skips the ramp entirely.
 */
export const WARMUP_STEP_DAYS: Record<WarmupProfile, number> = {
  standard: 1,
  slow: 2,
  none: 0,
}

const MS_PER_DAY = 86_400_000

export interface EffectiveCapInput {
  profile: WarmupProfile
  warmupStartedAt: string | null
  /** Day-one send allowance, per mailbox (replaces the old global WARMUP_START_CAP). */
  startCap: number
  /** Sends added at each step of the ramp, per mailbox (replaces WARMUP_INCREMENT). */
  increment: number
  /** The ramp ceiling — once the computed ramp value reaches this, the mailbox is "Already warm". */
  targetCap: number
  /** The already-warm cap: served directly for profile 'none', and once the ramp completes. */
  dailyCap: number
  now: Date
}

interface RampState {
  rampValue: number
  elapsedDays: number
}

/**
 * Shared by effectiveDailyCap and getMailboxWarmthStatus so the elapsed-time
 * and ramp-value math lives once. Returns null when the mailbox isn't
 * ramping at all (profile 'none', or warmup never started).
 */
function computeRampState(input: EffectiveCapInput): RampState | null {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0 || input.warmupStartedAt === null) return null

  const startedAt = Date.parse(input.warmupStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox warmup_started_at is not a valid timestamp', {
      warmupStartedAt: input.warmupStartedAt,
    })
  }

  // Clamped at 0 so clock skew (or a start date stamped slightly in the future)
  // opens the mailbox at the start cap rather than a negative one.
  const elapsedDays = Math.max(0, Math.floor((input.now.getTime() - startedAt) / MS_PER_DAY))
  const steps = Math.floor(elapsedDays / stepDays)
  return { rampValue: input.startCap + input.increment * steps, elapsedDays }
}

/**
 * Today's send allowance for one mailbox. Fully derived — once the ramp value
 * reaches targetCap, this starts returning dailyCap (the already-warm cap) on
 * every subsequent call, with nothing persisted. Raising targetCap later
 * simply makes the ramp resume on the next call.
 */
export function effectiveDailyCap(input: EffectiveCapInput): number {
  const state = computeRampState(input)
  if (state === null) return input.dailyCap
  return state.rampValue >= input.targetCap ? input.dailyCap : state.rampValue
}

export type WarmthStatus =
  | { kind: 'not_ramping' }
  | { kind: 'ramping'; currentCap: number; dayNumber: number }
  | { kind: 'ramp_complete' }

/**
 * Display-only status for the settings screen and the Clients-page Warmup
 * tab, so both surfaces label a mailbox "Already warm" the same way whether
 * it was set to 'none' directly or got there by finishing its ramp.
 */
export function getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus {
  const state = computeRampState(input)
  if (state === null) return { kind: 'not_ramping' }
  if (state.rampValue >= input.targetCap) return { kind: 'ramp_complete' }
  return { kind: 'ramping', currentCap: state.rampValue, dayNumber: state.elapsedDays + 1 }
}

```

Leave the rest of the file (`warmupInsertFields`, currently lines 60-73) unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/mailbox/warmup.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/warmup.ts src/lib/mailbox/warmup.test.ts
git commit -m "feat: make warmup ramp start/increment/target configurable per mailbox"
```

---

### Task 3: Wire the new ramp fields into the send pipeline (`sender.ts`)

**Files:**
- Modify: `src/lib/mailbox/sender.ts:173-182`
- Test: `src/lib/mailbox/sender.test.ts:41-45` (fixture only — no new test cases needed)

**Interfaces:**
- Consumes: `effectiveDailyCap(input: EffectiveCapInput)` (Task 2, new shape); `MailboxRow` (Task 1, now includes `warmup_start_cap`/`warmup_increment`/`warmup_target_cap`).
- Produces: nothing new for later tasks.

- [ ] **Step 1: Update the test fixture**

In `src/lib/mailbox/sender.test.ts`, the base `mailbox` fixture currently reads (lines 41-45):

```ts
const mailbox = {
  id: 'm1', provider: 'gmail', email_address: 'me@co.com', oauth: tokens, sent_today: 0, daily_cap: 50, health: 'ok',
  warmup_profile: 'none' as 'standard' | 'slow' | 'none', warmup_started_at: null as string | null,
  mailreach_enabled: false, mailreach_started_at: null as string | null,
}
```

Add the three new fields (values chosen so the two existing "warmup cap" tests, which override only `warmup_profile`/`warmup_started_at`/`daily_cap`, keep passing unmodified — see Step 2):

```ts
const mailbox = {
  id: 'm1', provider: 'gmail', email_address: 'me@co.com', oauth: tokens, sent_today: 0, daily_cap: 50, health: 'ok',
  warmup_profile: 'none' as 'standard' | 'slow' | 'none', warmup_started_at: null as string | null,
  warmup_start_cap: 5, warmup_increment: 3, warmup_target_cap: 50,
  mailreach_enabled: false, mailreach_started_at: null as string | null,
}
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/mailbox/sender.test.ts -t "warmup cap"`
Expected: FAIL — `effectiveDailyCap` now requires `startCap`/`increment`/`targetCap`, which `sender.ts` doesn't pass yet, so the ramped-cap assertion (expects `11`) no longer matches.

- [ ] **Step 3: Write the implementation**

In `src/lib/mailbox/sender.ts`, replace lines 173-182:

```ts
      : await claimMailboxSend(
          supabase,
          candidate.id,
          effectiveDailyCap({
            profile: candidate.warmup_profile,
            warmupStartedAt: candidate.warmup_started_at,
            dailyCap: candidate.daily_cap,
            now,
          }),
        )
```

with:

```ts
      : await claimMailboxSend(
          supabase,
          candidate.id,
          effectiveDailyCap({
            profile: candidate.warmup_profile,
            warmupStartedAt: candidate.warmup_started_at,
            startCap: candidate.warmup_start_cap,
            increment: candidate.warmup_increment,
            targetCap: candidate.warmup_target_cap,
            dailyCap: candidate.daily_cap,
            now,
          }),
        )
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/mailbox/sender.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts
git commit -m "feat: pass per-mailbox ramp fields through the send pipeline"
```

---

### Task 4: DB layer — wider `MailboxSummary`/`listMailboxesForViewer`, partial `updateMailboxWarmup`

**Files:**
- Modify: `src/lib/db/mailboxes.ts:141-150` (`updateMailboxWarmup`), `:265-271` (`MailboxSummary`), `:279-292` (`listMailboxesForViewer`, select string on line 286)
- Test: `src/lib/db/mailboxes.test.ts:200-212` (`updateMailboxWarmup` describe block)

**Interfaces:**
- Consumes: `MailboxRow` (Task 1).
- Produces: `updateMailboxWarmup(supabase, id, fields: Partial<Pick<MailboxRow, 'warmup_profile'|'warmup_started_at'|'warmup_start_cap'|'warmup_increment'|'warmup_target_cap'|'daily_cap'>>): Promise<void>` — used by Task 6's route handler. `MailboxSummary` now includes `warmup_start_cap`/`warmup_increment`/`warmup_target_cap` — used by Task 5.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/mailboxes.test.ts`, the `updateMailboxWarmup` describe block currently reads (lines 200-212):

```ts
describe('updateMailboxWarmup', () => {
  it('should write both warmup columns', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await updateMailboxWarmup({ from: () => ({ update }) } as never, 'm1', {
      warmup_profile: 'slow',
      warmup_started_at: '2026-07-22T00:00:00.000Z',
    })
    expect(update).toHaveBeenCalledWith({
      warmup_profile: 'slow',
      warmup_started_at: '2026-07-22T00:00:00.000Z',
    })
  })
})
```

Add a second test in the same block:

```ts
describe('updateMailboxWarmup', () => {
  it('should write both warmup columns', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await updateMailboxWarmup({ from: () => ({ update }) } as never, 'm1', {
      warmup_profile: 'slow',
      warmup_started_at: '2026-07-22T00:00:00.000Z',
    })
    expect(update).toHaveBeenCalledWith({
      warmup_profile: 'slow',
      warmup_started_at: '2026-07-22T00:00:00.000Z',
    })
  })

  it('should write only the provided ramp fields', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await updateMailboxWarmup({ from: () => ({ update }) } as never, 'm1', {
      warmup_start_cap: 8,
      warmup_target_cap: 25,
    })
    expect(update).toHaveBeenCalledWith({ warmup_start_cap: 8, warmup_target_cap: 25 })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/mailboxes.test.ts -t "should write only the provided ramp fields"`
Expected: FAIL — TypeScript rejects `warmup_start_cap`/`warmup_target_cap` on the current narrower `fields` parameter type.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/mailboxes.ts`, replace `updateMailboxWarmup` (lines 141-150):

```ts
export async function updateMailboxWarmup(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: { warmup_profile: WarmupProfile; warmup_started_at: string | null },
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update(fields).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update mailbox warmup', { id, cause: error.message })
  }
}
```

with:

```ts
export async function updateMailboxWarmup(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: Partial<
    Pick<
      MailboxRow,
      | 'warmup_profile'
      | 'warmup_started_at'
      | 'warmup_start_cap'
      | 'warmup_increment'
      | 'warmup_target_cap'
      | 'daily_cap'
    >
  >,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update(fields).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update mailbox warmup', { id, cause: error.message })
  }
}
```

Then update `MailboxSummary` (lines 265-271):

```ts
export type MailboxSummary = Pick<
  MailboxRow,
  | 'id' | 'provider' | 'email_address' | 'display_name' | 'health' | 'created_at'
  | 'health_reason' | 'warmup_profile' | 'warmup_started_at' | 'daily_cap' | 'sent_today'
  | 'mailreach_enabled' | 'mailreach_started_at' | 'mailreach_status' | 'mailreach_reputation_score'
>
```

to:

```ts
export type MailboxSummary = Pick<
  MailboxRow,
  | 'id' | 'provider' | 'email_address' | 'display_name' | 'health' | 'created_at'
  | 'health_reason' | 'warmup_profile' | 'warmup_started_at'
  | 'warmup_start_cap' | 'warmup_increment' | 'warmup_target_cap'
  | 'daily_cap' | 'sent_today'
  | 'mailreach_enabled' | 'mailreach_started_at' | 'mailreach_status' | 'mailreach_reputation_score'
>
```

Then update the select string in `listMailboxesForViewer` (line 286):

```ts
      'id, provider, email_address, display_name, health, created_at, health_reason, warmup_profile, warmup_started_at, daily_cap, sent_today, mailreach_enabled, mailreach_started_at, mailreach_status, mailreach_reputation_score',
```

to:

```ts
      'id, provider, email_address, display_name, health, created_at, health_reason, warmup_profile, warmup_started_at, warmup_start_cap, warmup_increment, warmup_target_cap, daily_cap, sent_today, mailreach_enabled, mailreach_started_at, mailreach_status, mailreach_reputation_score',
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/db/mailboxes.test.ts`
Expected: PASS (full file)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts
git commit -m "feat: support partial warmup updates and expose ramp fields on MailboxSummary"
```

---

### Task 5: `/settings` — wire the new fields into `mailbox-row.tsx` and `page.tsx`

**Files:**
- Modify: `src/app/(app)/settings/mailbox-row.tsx`
- Modify: `src/app/(app)/settings/page.tsx:118-134`

**Interfaces:**
- Consumes: `effectiveDailyCap`, `getMailboxWarmthStatus` (Task 2); `MailboxSummary` (Task 4).
- Produces: nothing new for later tasks (this is the `/settings` page's own display, independent of the new Clients-page tab).

- [ ] **Step 1: Update `mailbox-row.tsx`**

Change the import (line 8) from:

```ts
import { effectiveDailyCap, type WarmupProfile } from '@/lib/mailbox/warmup'
```

to:

```ts
import { effectiveDailyCap, getMailboxWarmthStatus, type WarmupProfile } from '@/lib/mailbox/warmup'
```

Add three fields to `MailboxRowProps` (currently lines 17-33), immediately after `warmupStartedAt: string | null`:

```ts
  warmupStartCap: number
  warmupIncrement: number
  warmupTargetCap: number
```

Replace the cap computation (currently lines 65-71):

```ts
  const capToday = effectiveDailyCap({
    profile: props.warmupProfile,
    warmupStartedAt: props.warmupStartedAt,
    dailyCap: props.dailyCap,
    now: new Date(),
  })
  const isRamping = capToday < props.dailyCap
```

with:

```ts
  const now = new Date()
  const rampInput = {
    profile: props.warmupProfile,
    warmupStartedAt: props.warmupStartedAt,
    startCap: props.warmupStartCap,
    increment: props.warmupIncrement,
    targetCap: props.warmupTargetCap,
    dailyCap: props.dailyCap,
    now,
  }
  const capToday = effectiveDailyCap(rampInput)
  const warmthStatus = getMailboxWarmthStatus(rampInput)
```

Replace the "warming up" fragment in the rendered text (currently line 115):

```tsx
          {isRamping ? ` · warming up (cap ${props.dailyCap})` : null}
```

with (the ramp's ceiling is now `warmupTargetCap`, not `dailyCap` — `dailyCap` is the already-warm cap, a different number, so the label must reference the new field to stay accurate):

```tsx
          {warmthStatus.kind === 'ramping'
            ? ` · warming up (day ${warmthStatus.dayNumber}, target ${props.warmupTargetCap})`
            : null}
```

- [ ] **Step 2: Wire the three new props in `page.tsx`**

In `src/app/(app)/settings/page.tsx`, the `<MailboxRow>` usage currently reads (lines 118-134):

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

Add the three new props after `warmupStartedAt`:

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
                  warmupStartCap={mailbox.warmup_start_cap}
                  warmupIncrement={mailbox.warmup_increment}
                  warmupTargetCap={mailbox.warmup_target_cap}
                  dailyCap={mailbox.daily_cap}
                  sentToday={mailbox.sent_today}
                  viewerRole={appUser.role}
                  mailreachEnabled={mailbox.mailreach_enabled}
                  mailreachStartedAt={mailbox.mailreach_started_at}
                  mailreachStatus={mailbox.mailreach_status}
                  mailreachReputationScore={mailbox.mailreach_reputation_score}
                />
```

(`toWebMcpEntry` above it, and `MailboxHealthEntry` in `src/types/webmcp-app.ts`, are unchanged by design — they destructure only the specific fields they need, so the wider `MailboxSummary` doesn't affect them.)

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors in `mailbox-row.tsx` or `page.tsx`. (No new automated test for this component, matching the existing convention — see Global Constraints.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/mailbox-row.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "feat: show per-mailbox ramp target and day count on /settings"
```

---

### Task 6: API route — partial warmup update with conditional ramp reset

**Files:**
- Modify: `src/app/api/mailboxes/[id]/warmup/route.ts`
- Create: `src/app/api/mailboxes/[id]/warmup/route.test.ts`

**Interfaces:**
- Consumes: `getMailboxById`, `updateMailboxWarmup` (Task 4); `warmupInsertFields` (unchanged, Task 2 file).
- Produces: the extended `POST /api/mailboxes/[id]/warmup` contract — used by Task 7's `WarmupMailboxRow` and the existing `mailbox-controls.tsx` (which only ever sends `{ profile }`, still a valid subset of the new body).

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/mailboxes/[id]/warmup/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const updateMailboxWarmup = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  updateMailboxWarmup: (...args: unknown[]) => updateMailboxWarmup(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

function req(body: unknown) {
  return new Request('http://x/api/mailboxes/m1/warmup', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({
    id: 'm1', client_id: 'c1', warmup_profile: 'standard',
    warmup_start_cap: 5, warmup_increment: 3, warmup_target_cap: 40, daily_cap: 40,
  })
  updateMailboxWarmup.mockResolvedValue(undefined)
})

describe('POST /api/mailboxes/[id]/warmup', () => {
  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(req({ profile: 'none' }), context)
    expect(response.status).toBe(403)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(req({ profile: 'none' }), context)
    expect(response.status).toBe(404)
  })

  it('should reject a non-integer numeric field', async () => {
    const response = await POST(req({ warmupStartCap: 4.5 }), context)
    expect(response.status).toBe(400)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })

  it('should reject a zero or negative numeric field', async () => {
    const response = await POST(req({ warmupTargetCap: 0 }), context)
    expect(response.status).toBe(400)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })

  it('should update only the numeric fields provided, without resetting the ramp clock', async () => {
    const response = await POST(req({ warmupStartCap: 8, warmupTargetCap: 60 }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).toHaveBeenCalledWith(expect.anything(), 'm1', {
      warmup_start_cap: 8,
      warmup_target_cap: 60,
    })
  })

  it('should reset the ramp clock when the profile actually changes', async () => {
    const response = await POST(req({ profile: 'none' }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).toHaveBeenCalledWith(expect.anything(), 'm1', {
      warmup_profile: 'none',
      warmup_started_at: null,
    })
  })

  it('should not reset the ramp clock when the same profile value is resent', async () => {
    const response = await POST(req({ profile: 'standard', warmupIncrement: 4 }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).toHaveBeenCalledWith(expect.anything(), 'm1', {
      warmup_increment: 4,
    })
  })

  it('should not write anything when the payload changes nothing', async () => {
    const response = await POST(req({ profile: 'standard' }), context)
    expect(response.status).toBe(200)
    expect(updateMailboxWarmup).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/app/api/mailboxes/\[id\]/warmup/route.test.ts`
Expected: FAIL — the current handler only accepts `{ profile }`, always calls `warmupInsertFields`/`updateMailboxWarmup` unconditionally, and has no numeric validation.

- [ ] **Step 3: Write the implementation**

Replace `src/app/api/mailboxes/[id]/warmup/route.ts` in full:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxWarmup } from '@/lib/db/mailboxes'
import { warmupInsertFields } from '@/lib/mailbox/warmup'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({
  profile: z.enum(['standard', 'slow', 'none']).optional(),
  warmupStartCap: z.number().int().positive().optional(),
  warmupIncrement: z.number().int().positive().optional(),
  warmupTargetCap: z.number().int().positive().optional(),
  dailyCap: z.number().int().positive().optional(),
})

// Per-mailbox warmup override — a partial update. Only an actual profile
// change restarts the ramp from day one (an operator changes this when the
// mailbox needs re-warming: reconnected, previously blocked, new domain);
// editing the numeric ramp knobs alone never touches warmup_started_at.
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const body = bodySchema.parse(await request.json())

    const fields: Parameters<typeof updateMailboxWarmup>[2] = {}
    if (body.warmupStartCap !== undefined) fields.warmup_start_cap = body.warmupStartCap
    if (body.warmupIncrement !== undefined) fields.warmup_increment = body.warmupIncrement
    if (body.warmupTargetCap !== undefined) fields.warmup_target_cap = body.warmupTargetCap
    if (body.dailyCap !== undefined) fields.daily_cap = body.dailyCap
    if (body.profile !== undefined && body.profile !== mailbox.warmup_profile) {
      Object.assign(fields, warmupInsertFields(body.profile, new Date()))
    }

    if (Object.keys(fields).length > 0) {
      await updateMailboxWarmup(admin, id, fields)
      await logEventSafe({
        clientId: mailbox.client_id,
        actor: `human:${appUser.id}`,
        type: 'mailbox.warmup_changed',
        source: 'mailbox',
        payload: { mailboxId: id, changed: Object.keys(fields) },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/app/api/mailboxes/\[id\]/warmup/route.test.ts`
Expected: PASS (all 8 tests)

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/mailboxes/[id]/warmup/route.ts" "src/app/api/mailboxes/[id]/warmup/route.test.ts"
git commit -m "feat: extend the mailbox warmup route to a partial ramp-field update"
```

---

### Task 7: Warmup tab on the Clients detail page

**Files:**
- Create: `src/app/(app)/clients/[id]/warmup-mailbox-row.tsx`
- Create: `src/app/(app)/clients/[id]/warmup-tab.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `getMailboxWarmthStatus`, `type WarmupProfile` (Task 2); `listMailboxesForClient`, `type MailboxRow` (existing export, `src/lib/db/mailboxes.ts:214-221` — this task becomes its first caller); the extended `POST /api/mailboxes/[id]/warmup` (Task 6).
- Produces: nothing consumed by a later task — this is the feature's UI leaf.

- [ ] **Step 1: Create `warmup-mailbox-row.tsx`**

Create `src/app/(app)/clients/[id]/warmup-mailbox-row.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { getMailboxWarmthStatus, type WarmupProfile } from '@/lib/mailbox/warmup'

const WARMUP_LABEL: Record<WarmupProfile, string> = {
  standard: 'Warm up — raise the cap daily',
  slow: 'Warm up slowly — raise the cap every 2 days',
  none: 'Already warm — no ramp',
}

interface WarmupMailboxRowProps {
  id: string
  emailAddress: string
  profile: WarmupProfile
  warmupStartedAt: string | null
  warmupStartCap: number
  warmupIncrement: number
  warmupTargetCap: number
  dailyCap: number
  sentToday: number
}

interface WarmupPatchBody {
  profile?: WarmupProfile
  warmupStartCap?: number
  warmupIncrement?: number
  warmupTargetCap?: number
  dailyCap?: number
}

export function WarmupMailboxRow(props: WarmupMailboxRowProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBusy = isPending || isSubmitting

  const status = getMailboxWarmthStatus({
    profile: props.profile,
    warmupStartedAt: props.warmupStartedAt,
    startCap: props.warmupStartCap,
    increment: props.warmupIncrement,
    targetCap: props.warmupTargetCap,
    dailyCap: props.dailyCap,
    now: new Date(),
  })
  const statusLabel =
    status.kind === 'ramping' ? `Ramping · day ${status.dayNumber} · cap ${status.currentCap}` : 'Already warm'

  async function patch(body: WarmupPatchBody): Promise<void> {
    if (isBusy) return
    setError(null)
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/mailboxes/${props.id}/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError('Could not save that change.')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('network')
    } finally {
      setIsSubmitting(false)
    }
  }

  function onBlurNumber(current: number, apply: (value: number) => void) {
    return (event: React.FocusEvent<HTMLInputElement>): void => {
      const value = Number(event.target.value)
      if (!Number.isInteger(value) || value < 1 || value === current) return
      apply(value)
    }
  }

  return (
    <div className="border-hairline bg-surface flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{props.emailAddress}</p>
        <p className="text-faint truncate text-[11px]">
          <span className="tnum">
            {props.sentToday}/{props.dailyCap} today
          </span>{' '}
          · {statusLabel}
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Profile</span>
        <select
          value={props.profile}
          disabled={isBusy}
          onChange={(event) => void patch({ profile: event.target.value as WarmupProfile })}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {(Object.keys(WARMUP_LABEL) as WarmupProfile[]).map((profile) => (
            <option key={profile} value={profile}>
              {WARMUP_LABEL[profile]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Start cap</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.warmupStartCap}
          disabled={isBusy}
          onBlur={onBlurNumber(props.warmupStartCap, (value) => void patch({ warmupStartCap: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Increment</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.warmupIncrement}
          disabled={isBusy}
          onBlur={onBlurNumber(props.warmupIncrement, (value) => void patch({ warmupIncrement: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Target cap</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.warmupTargetCap}
          disabled={isBusy}
          onBlur={onBlurNumber(props.warmupTargetCap, (value) => void patch({ warmupTargetCap: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Already-warm cap</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.dailyCap}
          disabled={isBusy}
          onBlur={onBlurNumber(props.dailyCap, (value) => void patch({ dailyCap: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
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

- [ ] **Step 2: Create `warmup-tab.tsx`**

Create `src/app/(app)/clients/[id]/warmup-tab.tsx`:

```tsx
import { Thermometer } from '@phosphor-icons/react/dist/ssr'
import { EmptyState } from '@/components/empty-state'
import type { MailboxRow } from '@/lib/db/mailboxes'
import { WarmupMailboxRow } from './warmup-mailbox-row'

interface WarmupTabProps {
  mailboxes: readonly MailboxRow[]
}

export function WarmupTab({ mailboxes }: WarmupTabProps): React.ReactElement {
  if (mailboxes.length === 0) {
    return (
      <EmptyState
        icon={Thermometer}
        title="No mailboxes connected"
        description="Connect a mailbox for this client from their own /settings page, then configure its warmup here."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {mailboxes.map((mailbox) => (
        <li key={mailbox.id}>
          <WarmupMailboxRow
            id={mailbox.id}
            emailAddress={mailbox.email_address}
            profile={mailbox.warmup_profile}
            warmupStartedAt={mailbox.warmup_started_at}
            warmupStartCap={mailbox.warmup_start_cap}
            warmupIncrement={mailbox.warmup_increment}
            warmupTargetCap={mailbox.warmup_target_cap}
            dailyCap={mailbox.daily_cap}
            sentToday={mailbox.sent_today}
          />
        </li>
      ))}
    </ul>
  )
}
```

- [ ] **Step 3: Wire the tab into `clients/[id]/page.tsx`**

Change the icon import (line 5) from:

```ts
import { ArrowLeft, Books, ChartLineUp, Lightning, ListMagnifyingGlass, UsersThree } from '@phosphor-icons/react/dist/ssr'
```

to:

```ts
import { ArrowLeft, Books, ChartLineUp, Lightning, ListMagnifyingGlass, Thermometer, UsersThree } from '@phosphor-icons/react/dist/ssr'
```

Add a new import after `import { listCampaignsForClient } from '@/lib/db/campaigns'` (line 9):

```ts
import { listMailboxesForClient } from '@/lib/db/mailboxes'
```

Add a new import after `import { MailreachToggle } from './mailreach-toggle'` (line 33):

```ts
import { WarmupTab } from './warmup-tab'
```

Change the `tabSchema` (line 43) from:

```ts
const tabSchema = z.enum(['campaigns', 'analytics', 'users', 'knowledge', 'logs'])
```

to:

```ts
const tabSchema = z.enum(['campaigns', 'warmup', 'analytics', 'users', 'knowledge', 'logs'])
```

Add a lazily-fetched `mailboxes` variable after the existing `knowledgeSources` line (line 120: `const knowledgeSources = tab === 'knowledge' ? await listSourcesForClient(admin, clientId) : []`), matching that same lazy-fetch-per-active-tab convention:

```ts
  const mailboxes = tab === 'warmup' ? await listMailboxesForClient(admin, clientId) : []
```

Add a new `TabsTrigger` right after the Campaigns trigger's closing tag and before the Analytics trigger (currently lines 181-182):

```tsx
          <TabsTrigger value="warmup" asChild>
            <Link href={`/clients/${clientId}?tab=warmup`}>
              <Thermometer size={14} weight="light" />
              Warmup
            </Link>
          </TabsTrigger>
```

Add a new `TabsContent` right after the Campaigns content's closing tag and before the Analytics content (currently lines 232-234):

```tsx
        <TabsContent value="warmup">
          <WarmupTab mailboxes={mailboxes} />
        </TabsContent>
```

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: no errors; every test in the repo passes (no new automated test is added for these three UI files, per the Global Constraints convention — the pure functions and route handler underneath are fully covered by Tasks 2 and 6).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/clients/[id]/warmup-mailbox-row.tsx" "src/app/(app)/clients/[id]/warmup-tab.tsx" "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat: add a Warmup tab to the client detail page"
```

- [ ] **Step 6: Manual verification**

1. Run `pnpm dev`, apply the migration to your local Supabase instance (`supabase db reset` or your project's usual migration-apply step).
2. As an operator, open a client with at least one connected mailbox at `/clients/[id]?tab=warmup`. Confirm every mailbox for that client is listed with its profile, start cap, increment, target cap, already-warm cap, and today's `sent/cap` + status.
3. Edit the start cap on a ramping mailbox; confirm the row refreshes with the new value and the ramp's day count is unchanged (the clock did not reset).
4. Lower a ramping mailbox's target cap to below its current computed ramp value; confirm the status immediately reads "Already warm" without any further action.
5. Edit the already-warm cap field on a mailbox that shows "Already warm"; confirm `sent/cap` reflects the new number after refresh.
6. Switch a mailbox's profile from "Already warm" to "Warm up — raise the cap daily"; confirm the ramp restarts at day 1.
7. Open `/settings` as that mailbox's own client-role user; confirm the mailbox row there shows the same ramp state (day count / target) consistent with what the Warmup tab showed.
8. Open a client with zero connected mailboxes on the Warmup tab; confirm the empty state renders instead of an empty list.

---

## Task Order

Tasks 1 → 2 → 3 → 4 → 5 → 6 → 7, strictly sequential:

- Task 1's columns must exist before Task 2's tests can express a target cap distinct from the daily cap.
- Task 2's new `EffectiveCapInput`/`getMailboxWarmthStatus` shape is consumed directly by Tasks 3, 5, and 7.
- Task 3 (send pipeline) and Task 5 (`/settings` display) both depend on Task 1's `MailboxRow`/`MailboxSummary` widening but not on each other — they could run in either order, but are sequenced here to keep the "core pipeline first, then UI" story linear.
- Task 4's wider `MailboxSummary`/partial `updateMailboxWarmup` is required by Task 5 (display) and Task 6 (the route).
- Task 6's extended route is required by Task 7's `WarmupMailboxRow`.
