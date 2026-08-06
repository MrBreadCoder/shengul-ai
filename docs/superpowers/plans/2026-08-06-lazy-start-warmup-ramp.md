# Lazy-Start Warmup Ramp Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The mailbox daily-cap ramp (`warmup_started_at`) starts counting from a mailbox's first actual send instead of from the moment it's connected, so the displayed cap no longer climbs during the 14-day Mailreach gate (or any other idle period) before anything has actually gone out.

**Architecture:** `warmup_started_at` becomes lazily-stamped: connect routes leave it `null`; the atomic `claim_mailbox_send`/`claim_mailbox_send_uncapped` Postgres functions stamp it with `coalesce(warmup_started_at, now())` as part of the same atomic row update on a mailbox's first successful send (any purpose — outreach, reply, or manual). `src/lib/mailbox/warmup.ts`'s pure ramp functions treat "ramping profile + null started_at" as day one, not "not ramping." The one explicit-reset path (an operator changing a mailbox's profile) keeps stamping immediately, unchanged.

**Tech Stack:** Next.js route handlers, Supabase Postgres (SQL migration + RPC), TypeScript pure functions, Vitest, next-intl (en/tr).

## Global Constraints

- No branches — work directly on `master` (per `CLAUDE.md`).
- No `any`; no unjustified `!` (every non-null assertion carries a comment proving it's safe).
- Exhaustive `switch` with an `assertNever` default for every discriminated union consumed in this plan (`.claude/QUALITY.md`).
- Test naming: `it('should [expected behavior] when [condition]')`, Arrange-Act-Assert (`.claude/QUALITY.md`).
- Migration files are sequentially numbered; the next free number is `0030`.
- Commit messages end with `Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>`.
- Update `.claude/roadmap.md` with progress before the final commit (per `CLAUDE.md`).
- Verification commands: `pnpm typecheck`, `pnpm exec vitest run <path>`, `pnpm test` (full suite).

---

### Task 1: Migration `0030` — lazy-stamp `warmup_started_at` on first send

**Files:**
- Create: `supabase/migrations/0030_lazy_start_warmup_ramp.sql`

**Interfaces:**
- Produces: `claim_mailbox_send(p_mailbox_id uuid, p_effective_cap integer)` and `claim_mailbox_send_uncapped(p_mailbox_id uuid)` — same signatures and return type (`setof public.mailboxes`) as today, now also stamping `warmup_started_at` on a mailbox's first claimed send. No TypeScript signature changes — `src/lib/db/mailboxes.ts`'s `claimMailboxSend`/`claimMailboxSendUncapped` wrappers are untouched.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0030_lazy_start_warmup_ramp.sql`:

```sql
-- Lazy-start warmup ramp: the ramp clock now starts on a mailbox's first
-- actual send, not at connect time. Previously warmup_started_at was
-- stamped the moment a mailbox was connected (see warmupInsertFields,
-- src/lib/mailbox/warmup.ts), so the daily-cap ramp climbed every day even
-- while a mailbox sat idle through the whole 14-day Mailreach gate
-- (mailreach_started_at / MAILREACH_CAMPAIGN_GATE_DAYS,
-- src/lib/mailbox/mailreach-gate.ts — a separate, unrelated clock). See
-- docs/superpowers/specs/2026-08-06-lazy-start-warmup-ramp-design.md.

-- ---------- claim RPCs stamp warmup_started_at on first send ----------
-- coalesce() inside the single atomic UPDATE means only the first send ever
-- sets it; a later send is a no-op on this column, and two concurrent first
-- sends can't double-stamp since only one UPDATE commits first. Guarded to
-- warmup_profile <> 'none' so an already-warm mailbox (which never ramps,
-- see WARMUP_STEP_DAYS.none === 0) never gets a meaningless timestamp
-- written to it.
create or replace function public.claim_mailbox_send(p_mailbox_id uuid, p_effective_cap integer)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         warmup_started_at = case
           when warmup_profile <> 'none' then coalesce(warmup_started_at, now())
           else warmup_started_at
         end,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
     and sent_today < least(daily_cap, greatest(p_effective_cap, 0))
  returning *;
$$;

create or replace function public.claim_mailbox_send_uncapped(p_mailbox_id uuid)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         warmup_started_at = case
           when warmup_profile <> 'none' then coalesce(warmup_started_at, now())
           else warmup_started_at
         end,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
  returning *;
$$;

-- ---------- backfill: reset mailboxes that are ramping but never sent ----------
-- Mailboxes connected before this migration already have warmup_started_at
-- stamped from connect time even though most have never sent anything —
-- exactly the reported bug. Reset those (and only those) back to null so
-- they pick up lazy-start on their next send. Uses the same "has this
-- mailbox ever sent" filter mailbox_send_stats (migration 0012) already
-- uses, so "never sent" means the same thing everywhere in the codebase.
-- Mailboxes that have already sent something are left untouched — resetting
-- their clock would cut their ramp progress, not fix anything.
update mailboxes m
   set warmup_started_at = null
 where m.warmup_profile <> 'none'
   and m.warmup_started_at is not null
   and not exists (
     select 1 from emails e
      where e.mailbox_id = m.id
        and e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
   );
```

- [ ] **Step 2: Review the SQL against the functions it replaces**

This migration has no Vitest coverage — `claim_mailbox_send`/`claim_mailbox_send_uncapped` are thin RPC wrappers in TypeScript (`src/lib/db/mailboxes.ts`) that pass through whatever Postgres returns, so the wrapper tests can't exercise the SQL itself (same pattern as migrations 0012/0020, which also ship without a SQL test). Confirm by inspection:
- Diff against `supabase/migrations/0012_p4_deliverability.sql`'s `claim_mailbox_send` and `0020_client_notes_and_manual_send.sql`'s `claim_mailbox_send_uncapped` — only the new `warmup_started_at = case ... end` line is added; every existing column, `where` clause, and guard is untouched.
- Confirm the `case` expression can never turn a `null` into anything other than `now()` or leave it exactly as the row already had it — no path sets it to an arbitrary value.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0030_lazy_start_warmup_ramp.sql
git commit -m "feat(warmup): lazy-stamp warmup_started_at on first send

claim_mailbox_send / claim_mailbox_send_uncapped now stamp
warmup_started_at with coalesce(warmup_started_at, now()) on a
mailbox's first successful send, instead of relying on connect-time
stamping. One-time backfill resets mailboxes that are ramping but
have never sent anything back to null.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `src/lib/mailbox/warmup.ts` — lazy-start ramp math

**Files:**
- Modify: `src/lib/mailbox/warmup.ts` (full file, 114 lines)
- Test: `src/lib/mailbox/warmup.test.ts`
- Test: `src/lib/mailbox/sender.test.ts` (new coverage only, no source change)

**Interfaces:**
- Consumes: nothing new — same `EffectiveCapInput` shape as today.
- Produces:
  - `computeRampState(input: EffectiveCapInput): RampState | null` — now returns `null` **only** when `WARMUP_STEP_DAYS[input.profile] === 0` (i.e. `profile === 'none'`). A ramping profile with `warmupStartedAt === null` now returns `{ rampValue: input.startCap, elapsedDays: 0 }` instead of `null`.
  - `effectiveDailyCap(input: EffectiveCapInput): number` — same signature; for a ramping profile with `warmupStartedAt === null` now returns `input.startCap` instead of `input.dailyCap`.
  - `WarmthStatus` gains a fourth variant: `{ kind: 'not_started'; startCap: number }`.
  - `getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus` — for a ramping profile with `warmupStartedAt === null`, now returns `{ kind: 'not_started', startCap: input.startCap }` instead of `{ kind: 'not_ramping' }`.
  - `warmupInsertFields(profile: WarmupProfile): { warmup_profile: WarmupProfile; warmup_started_at: null }` — **signature change**: drops the `now: Date` parameter, always returns `warmup_started_at: null`. Used by Task 3.
  - New: `warmupRestartFields(profile: WarmupProfile, now: Date): { warmup_profile: WarmupProfile; warmup_started_at: string | null }` — the old `warmupInsertFields` behavior verbatim (stamps `now()` for a ramping profile, `null` for `'none'`). Used by Task 4.

- [ ] **Step 1: Write the failing tests**

Replace the three tests in `src/lib/mailbox/warmup.test.ts` that assert the old "null means not ramping" behavior, and the `warmupInsertFields` describe block. Full replacement content for the file:

```ts
import { describe, it, expect } from 'vitest'
import {
  effectiveDailyCap,
  getMailboxWarmthStatus,
  warmupInsertFields,
  warmupRestartFields,
  DEFAULT_MAILBOX_DAILY_CAP,
} from './warmup'
import { AppError } from '@/lib/errors/app-error'

// Guards against the mailboxes.daily_cap column default (migration 0001)
// silently drifting away from this mirrored constant — connect routes rely
// on both staying in sync (see the constant's own comment).
describe('DEFAULT_MAILBOX_DAILY_CAP', () => {
  it('should match the mailboxes.daily_cap column default', () => {
    expect(DEFAULT_MAILBOX_DAILY_CAP).toBe(20)
  })
})

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

  it('should return the already-warm daily cap when the profile is none and never started', () => {
    const cap = effectiveDailyCap({ profile: 'none', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should return the start cap when a ramping mailbox has never sent yet', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(cap).toBe(5)
  })

  it('should return the start cap for a slow-profile mailbox that has never sent yet', () => {
    const cap = effectiveDailyCap({ profile: 'slow', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(cap).toBe(5)
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

  it('should report not_started with the start cap when a standard-profile mailbox has never sent', () => {
    const status = getMailboxWarmthStatus({ profile: 'standard', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(status).toEqual({ kind: 'not_started', startCap: 5 })
  })

  it('should report not_started with the start cap when a slow-profile mailbox has never sent', () => {
    const status = getMailboxWarmthStatus({ profile: 'slow', warmupStartedAt: null, ...BASE, now: atDay(0) })
    expect(status).toEqual({ kind: 'not_started', startCap: 5 })
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
  it('should leave the start time null for a ramping profile at connect time', () => {
    expect(warmupInsertFields('standard')).toEqual({ warmup_profile: 'standard', warmup_started_at: null })
  })

  it('should leave the start time null for a slow profile at connect time', () => {
    expect(warmupInsertFields('slow')).toEqual({ warmup_profile: 'slow', warmup_started_at: null })
  })

  it('should leave the start time null for an already-warm mailbox', () => {
    expect(warmupInsertFields('none')).toEqual({ warmup_profile: 'none', warmup_started_at: null })
  })
})

describe('warmupRestartFields', () => {
  it('should stamp a start time for a ramping profile', () => {
    const fields = warmupRestartFields('standard', atDay(0))
    expect(fields).toEqual({ warmup_profile: 'standard', warmup_started_at: START })
  })

  it('should leave the start time null for an already-warm mailbox', () => {
    const fields = warmupRestartFields('none', atDay(0))
    expect(fields).toEqual({ warmup_profile: 'none', warmup_started_at: null })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm exec vitest run src/lib/mailbox/warmup.test.ts`
Expected: FAIL — `warmupRestartFields` is not exported yet; the `not_started`/start-cap assertions don't match current output (`{ kind: 'not_ramping' }` / `40` returned instead).

- [ ] **Step 3: Rewrite `src/lib/mailbox/warmup.ts`**

Full replacement content:

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

// Mirrors `mailboxes.daily_cap`'s own column default (migration 0001) — kept
// as a named constant here because `warmup_target_cap` has no column default
// of its own (migration 0024, deliberately: it's meant to be an explicit
// per-mailbox value). A newly connected mailbox has no daily_cap override
// yet, so its target cap should start equal to the daily_cap it will
// actually get, matching the pre-0024 behavior where the ramp's implicit
// target was always daily_cap itself.
export const DEFAULT_MAILBOX_DAILY_CAP = 20

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
 * and ramp-value math lives once. Returns null only for profile 'none',
 * which never ramps (WARMUP_STEP_DAYS.none === 0). A ramping profile with no
 * `warmupStartedAt` yet — the mailbox is connected but has never actually
 * sent anything (see migration 0030's lazy stamp in claim_mailbox_send /
 * claim_mailbox_send_uncapped) — is day one of the ramp with the clock not
 * running yet: it returns the day-one allowance, not null, so a caller can't
 * mistake "hasn't sent yet" for "already warm".
 */
function computeRampState(input: EffectiveCapInput): RampState | null {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0) return null

  if (input.warmupStartedAt === null) {
    return { rampValue: input.startCap, elapsedDays: 0 }
  }

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
 * simply makes the ramp resume on the next call. For a ramping profile that
 * has never sent, this returns startCap — the same number the mailbox's
 * literal first send will ramp from.
 */
export function effectiveDailyCap(input: EffectiveCapInput): number {
  const state = computeRampState(input)
  if (state === null) return input.dailyCap
  return state.rampValue >= input.targetCap ? input.dailyCap : state.rampValue
}

export type WarmthStatus =
  | { kind: 'not_ramping' }
  | { kind: 'not_started'; startCap: number }
  | { kind: 'ramping'; currentCap: number; dayNumber: number }
  | { kind: 'ramp_complete' }

/**
 * Display-only status for the settings screen and the Clients-page Warmup
 * tab, so both surfaces label a mailbox the same way. 'not_started' (ramping
 * profile, never sent — see computeRampState) is a distinct variant from
 * 'not_ramping' (profile 'none') so the UI never mislabels a mailbox that
 * simply hasn't sent its first email yet as "already warm".
 */
export function getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0) return { kind: 'not_ramping' }
  if (input.warmupStartedAt === null) return { kind: 'not_started', startCap: input.startCap }

  // Non-null is guaranteed here: computeRampState only returns null when
  // stepDays === 0, already handled above, or (unreachably, since we just
  // checked it) warmupStartedAt === null.
  const state = computeRampState(input)!
  if (state.rampValue >= input.targetCap) return { kind: 'ramp_complete' }
  return { kind: 'ramping', currentCap: state.rampValue, dayNumber: state.elapsedDays + 1 }
}

/**
 * The warmup columns to write when a mailbox is newly connected (the three
 * OAuth/SMTP connect routes). The ramp clock does not start here — it starts
 * lazily on the mailbox's first actual send (migration 0030's
 * claim_mailbox_send / claim_mailbox_send_uncapped), so a freshly connected
 * mailbox always begins with a null started_at, whatever its profile.
 */
export function warmupInsertFields(
  profile: WarmupProfile,
): { warmup_profile: WarmupProfile; warmup_started_at: null } {
  return { warmup_profile: profile, warmup_started_at: null }
}

/**
 * The warmup columns to write when an operator explicitly changes a
 * mailbox's profile (POST /api/mailboxes/[id]/warmup). Unlike
 * warmupInsertFields, this restarts the ramp immediately — a profile change
 * is a deliberate "re-warm starting now" action (reconnected, previously
 * blocked, new domain), not a "wait for the next send" one.
 */
export function warmupRestartFields(
  profile: WarmupProfile,
  now: Date,
): { warmup_profile: WarmupProfile; warmup_started_at: string | null } {
  return {
    warmup_profile: profile,
    warmup_started_at: profile === 'none' ? null : now.toISOString(),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/lib/mailbox/warmup.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Add sender.ts wiring coverage (no source change)**

`src/lib/mailbox/sender.ts` calls `effectiveDailyCap` and passes the result straight to `claimMailboxSend` — nothing there needs to change, but add a regression test proving a mailbox that has never sent claims at `startCap`, not `dailyCap`, confirming the new pure-function behavior is correctly wired through. Add to `src/lib/mailbox/sender.test.ts`, inside the existing `describe('sendViaMailbox', ...)` block (after the "should claim a healthy mailbox..." test):

```ts
  it('should claim at the mailbox start cap, not the daily cap, on its first-ever send', async () => {
    const neverSent = mailboxWith({
      warmup_profile: 'standard',
      warmup_started_at: null,
      warmup_start_cap: 7,
      daily_cap: 50,
    })
    listMailboxesByIdsMock.mockResolvedValue([neverSent])
    claimMailboxSendMock.mockResolvedValue({ ...neverSent, sent_today: 1 })
    const { provider, sendEmail } = okProvider()
    getMailboxProviderMock.mockReturnValue({ provider, sendEmail })
    await sendViaMailbox({} as never, { ...baseInput, mailboxIds: ['m1'], purpose: 'reply' })
    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm1', 7)
  })
```

- [ ] **Step 6: Run the sender test to verify it passes**

Run: `pnpm exec vitest run src/lib/mailbox/sender.test.ts`
Expected: PASS, including the new test.

- [ ] **Step 7: Commit**

Do **not** run `pnpm typecheck` yet — `warmupInsertFields` just lost its second parameter, and the three connect routes plus the warmup PATCH route still call it with two arguments (Tasks 3 and 4 fix those call sites next). `tsc` would correctly flag this; `vitest` won't, since esbuild's transform doesn't enforce call arity, so the test runs above are a true signal on their own. Full-repo typecheck is deferred to the end of Task 4, once every call site is updated.

```bash
git add src/lib/mailbox/warmup.ts src/lib/mailbox/warmup.test.ts src/lib/mailbox/sender.test.ts
git commit -m "feat(warmup): treat a never-sent ramping mailbox as day one, not warm

computeRampState/effectiveDailyCap/getMailboxWarmthStatus now
distinguish 'ramping profile, never sent' (day-one allowance, new
WarmthStatus 'not_started') from 'profile none' (never ramps).
warmupInsertFields no longer stamps a timestamp at connect time;
the immediate-restart behavior moves to the new warmupRestartFields,
used only by the explicit profile-change route.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Connect routes stop stamping `warmup_started_at`

**Files:**
- Modify: `src/app/api/mailboxes/google/callback/route.ts:66`
- Modify: `src/app/api/mailboxes/outlook/callback/route.ts:66`
- Modify: `src/app/api/mailboxes/smtp/connect/route.ts:163`
- Test: `src/app/api/mailboxes/smtp/connect/route.test.ts`

**Interfaces:**
- Consumes: `warmupInsertFields(profile: WarmupProfile)` from Task 2 (dropped the `now` argument).

- [ ] **Step 1: Write the failing test**

In `src/app/api/mailboxes/smtp/connect/route.test.ts`, replace the assertion in `'should insert an smtp mailbox with encrypted credentials and warmup fields on success'`:

```ts
    expect(row.warmup_started_at).toEqual(expect.any(String))
```

with:

```ts
    expect(row.warmup_started_at).toBeNull()
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/app/api/mailboxes/smtp/connect/route.test.ts`
Expected: FAIL — `row.warmup_started_at` is currently an ISO string, not `null`.

- [ ] **Step 3: Update the three connect routes**

`src/app/api/mailboxes/google/callback/route.ts:66` — change:

```ts
      ...warmupInsertFields(client?.warmup_profile ?? 'standard', new Date()),
```

to:

```ts
      ...warmupInsertFields(client?.warmup_profile ?? 'standard'),
```

`src/app/api/mailboxes/outlook/callback/route.ts:66` — same change:

```ts
      ...warmupInsertFields(client?.warmup_profile ?? 'standard'),
```

`src/app/api/mailboxes/smtp/connect/route.ts:163` — same change:

```ts
      ...warmupInsertFields(client?.warmup_profile ?? 'standard'),
```

None of the three files need an import change — `warmupInsertFields` is already imported by name in all three; only the call arguments shrink.

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm exec vitest run src/app/api/mailboxes/smtp/connect/route.test.ts`
Expected: PASS.

Still don't run `pnpm typecheck` — the warmup PATCH route (Task 4) still imports `warmupInsertFields` and calls it with two arguments (it needs to switch to `warmupRestartFields`). Google and outlook callback routes have no dedicated test files (matching the existing pattern — neither has ever had one), so `vitest` provides no direct signal for those two beyond "the app still imports/parses"; they get their first real compile check at the end of Task 4, alongside everything else.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mailboxes/google/callback/route.ts src/app/api/mailboxes/outlook/callback/route.ts src/app/api/mailboxes/smtp/connect/route.ts src/app/api/mailboxes/smtp/connect/route.test.ts
git commit -m "feat(warmup): connect routes leave warmup_started_at null

A newly connected mailbox no longer stamps the ramp clock at
connect time — it starts on the mailbox's first actual send (see
migration 0030).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Warmup PATCH route uses `warmupRestartFields`

**Files:**
- Modify: `src/app/api/mailboxes/[id]/warmup/route.ts:6,42`
- Test: `src/app/api/mailboxes/[id]/warmup/route.test.ts`

**Interfaces:**
- Consumes: `warmupRestartFields(profile: WarmupProfile, now: Date)` from Task 2.

- [ ] **Step 1: Write the failing test**

The existing test `'should reset the ramp clock when the profile actually changes'` (switching to `'none'`) already passes unchanged either way, since both old and new functions return `null` for `'none'`. Add a new test to `src/app/api/mailboxes/[id]/warmup/route.test.ts` that only the new function can satisfy — promoting from `'none'` to a ramping profile must still stamp `now()` immediately (proving the route calls `warmupRestartFields`, not the Task-2-changed `warmupInsertFields`, which would now write `null` instead). Add after `'should reset the ramp clock when the profile actually changes'`:

```ts
  it('should stamp a fresh start time when the profile changes to a ramping one', async () => {
    getMailboxById.mockResolvedValue({
      id: 'm1', client_id: 'c1', warmup_profile: 'none',
      warmup_start_cap: 5, warmup_increment: 3, warmup_target_cap: 40, daily_cap: 40,
    })
    const response = await POST(req({ profile: 'standard' }), context)
    expect(response.status).toBe(200)
    const call = updateMailboxWarmup.mock.calls[0]?.[2] as Record<string, unknown>
    expect(call.warmup_profile).toBe('standard')
    expect(typeof call.warmup_started_at).toBe('string')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm exec vitest run src/app/api/mailboxes/\[id\]/warmup/route.test.ts`
Expected: FAIL on the new test — the route still calls the old import name `warmupInsertFields(body.profile, new Date())`, which after Task 2 always returns `warmup_started_at: null` (the extra `Date` argument is silently ignored at runtime; JS doesn't enforce arity). So `call.warmup_started_at` is `null`, and `expect(typeof call.warmup_started_at).toBe('string')` fails for exactly the right reason — a real runtime signal, not just a would-be `tsc` error.

- [ ] **Step 3: Update the route**

`src/app/api/mailboxes/[id]/warmup/route.ts` — change the import on line 6:

```ts
import { warmupInsertFields } from '@/lib/mailbox/warmup'
```

to:

```ts
import { warmupRestartFields } from '@/lib/mailbox/warmup'
```

and the call on line 42:

```ts
      Object.assign(fields, warmupInsertFields(body.profile, new Date()))
```

to:

```ts
      Object.assign(fields, warmupRestartFields(body.profile, new Date()))
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm exec vitest run src/app/api/mailboxes/\[id\]/warmup/route.test.ts`
Expected: PASS, all cases including the new one.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/mailboxes/\[id\]/warmup/route.ts src/app/api/mailboxes/\[id\]/warmup/route.test.ts
git commit -m "feat(warmup): profile-change route restarts the ramp immediately

Uses the new warmupRestartFields instead of warmupInsertFields — an
explicit operator profile change is a deliberate 're-warm starting
now' action, unlike a fresh connect (Task 3), which now waits for
the mailbox's first actual send.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Settings page — `mailbox-row.tsx` shows the `not_started` status

**Files:**
- Modify: `src/app/(app)/settings/mailbox-row.tsx:9,129-131`
- Modify: `src/messages/en.json` (`settings.mailboxRow`, after line 99)
- Modify: `src/messages/tr.json` (`settings.mailboxRow`, after line 99)

**Interfaces:**
- Consumes: `WarmthStatus` (now 4 variants) from Task 2.

- [ ] **Step 1: Add the i18n keys**

`src/messages/en.json` — in the `settings.mailboxRow` block, after `"rampingSuffix": "warming up (day {day}, target {target})",` (line 99), add:

```json
      "notStartedSuffix": "warmup starts on first send (day-1 cap {startCap})",
```

`src/messages/tr.json` — in the same block, after `"rampingSuffix": "ısınıyor (gün {day}, hedef {target})",` (line 99), add:

```json
      "notStartedSuffix": "ilk gönderimde ısınma başlayacak (1. gün sınırı {startCap})",
```

- [ ] **Step 2: Update `mailbox-row.tsx`**

Change the import on line 9 from:

```ts
import { effectiveDailyCap, getMailboxWarmthStatus, type WarmupProfile } from '@/lib/mailbox/warmup'
```

to:

```ts
import { effectiveDailyCap, getMailboxWarmthStatus, type WarmupProfile, type WarmthStatus } from '@/lib/mailbox/warmup'
```

Add a module-level helper above `export function MailboxRow` (after the existing `mailreachStatusText` function, before `type SendState`):

```ts
function assertNever(x: never): never {
  throw new Error('Unhandled WarmthStatus kind: ' + String(x))
}

function warmthStatusSuffix(
  t: ReturnType<typeof useTranslations<'settings'>>,
  status: WarmthStatus,
  targetCap: number,
): string | null {
  switch (status.kind) {
    case 'not_ramping':
      return null
    case 'not_started':
      return t('mailboxRow.notStartedSuffix', { startCap: status.startCap })
    case 'ramping':
      return t('mailboxRow.rampingSuffix', { day: status.dayNumber, target: targetCap })
    case 'ramp_complete':
      return null
    default:
      return assertNever(status)
  }
}
```

Inside `export function MailboxRow`, after the existing `const warmthStatus = getMailboxWarmthStatus(rampInput)` line, add:

```ts
  const warmthSuffix = warmthStatusSuffix(t, warmthStatus, props.warmupTargetCap)
```

Replace lines 129-131:

```tsx
          {warmthStatus.kind === 'ramping'
            ? ` · ${t('mailboxRow.rampingSuffix', { day: warmthStatus.dayNumber, target: props.warmupTargetCap })}`
            : null}
```

with:

```tsx
          {warmthSuffix ? ` · ${warmthSuffix}` : null}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors. (`mailbox-row.tsx` has no dedicated Vitest file — it's a Client Component rendering path verified by typecheck plus the manual browser check in Task 7.)

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/settings/mailbox-row.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(warmup): settings mailbox row shows 'not started' status

Exhaustive switch over WarmthStatus (assertNever default) replaces
the two-way ternary, which would have silently shown no suffix for
the new not_started variant. New copy: 'warmup starts on first send
(day-1 cap N)'.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Clients Warmup tab — `warmup-mailbox-row.tsx` shows the `not_started` status

**Files:**
- Modify: `src/app/(app)/clients/[id]/warmup-mailbox-row.tsx:6,47-50`
- Modify: `src/messages/en.json` (`clients.warmupMailboxRow`, after line 227)
- Modify: `src/messages/tr.json` (`clients.warmupMailboxRow`, after line 227)

**Interfaces:**
- Consumes: `WarmthStatus` (now 4 variants) from Task 2.

- [ ] **Step 1: Add the i18n keys**

`src/messages/en.json` — in the `clients.warmupMailboxRow` block, after `"alreadyWarm": "Already warm",` (line 227), add:

```json
      "notStarted": "Not started · day-1 cap {startCap}",
```

`src/messages/tr.json` — in the same block, after `"alreadyWarm": "Zaten ısınmış",` (line 227), add:

```json
      "notStarted": "Başlamadı · 1. gün sınırı {startCap}",
```

- [ ] **Step 2: Update `warmup-mailbox-row.tsx`**

Change the import on line 6 from:

```ts
import { getMailboxWarmthStatus, type WarmupProfile } from '@/lib/mailbox/warmup'
```

to:

```ts
import { getMailboxWarmthStatus, type WarmupProfile, type WarmthStatus } from '@/lib/mailbox/warmup'
```

Add a module-level helper above `export function WarmupMailboxRow` (after the `WarmupPatchBody` interface):

```ts
function assertNever(x: never): never {
  throw new Error('Unhandled WarmthStatus kind: ' + String(x))
}

function warmthStatusLabel(t: ReturnType<typeof useTranslations<'clients'>>, status: WarmthStatus): string {
  switch (status.kind) {
    case 'not_ramping':
      return t('warmupMailboxRow.alreadyWarm')
    case 'not_started':
      return t('warmupMailboxRow.notStarted', { startCap: status.startCap })
    case 'ramping':
      return t('warmupMailboxRow.ramping', { day: status.dayNumber, cap: status.currentCap })
    case 'ramp_complete':
      return t('warmupMailboxRow.alreadyWarm')
    default:
      return assertNever(status)
  }
}
```

Replace lines 47-50:

```ts
  const statusLabel =
    status.kind === 'ramping'
      ? t('warmupMailboxRow.ramping', { day: status.dayNumber, cap: status.currentCap })
      : t('warmupMailboxRow.alreadyWarm')
```

with:

```ts
  const statusLabel = warmthStatusLabel(t, status)
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add src/app/\(app\)/clients/\[id\]/warmup-mailbox-row.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(warmup): clients Warmup tab shows 'not started' status

Exhaustive switch over WarmthStatus (assertNever default) replaces
the two-way ternary. New copy: 'Not started · day-1 cap N'.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Full verification, manual check, roadmap update

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Run the full automated suite**

Run: `pnpm typecheck && pnpm test`
Expected: all green, no regressions in any other suite (in particular `src/lib/mailbox/mailreach-gate.test.ts` and `src/lib/mailbox/sender.test.ts`'s existing `describe('mailreach gate', ...)` block, which this change deliberately leaves untouched).

- [ ] **Step 2: Manual verification in-browser**

Per the `run` skill: start the app, connect a fresh mailbox with a ramping profile (`standard` or `slow`) on the Settings page. Confirm:
- The mailbox row shows "Not started" (or the day-1-cap suffix), not a climbing day count, before any send.
- Use "Send test" on that mailbox; after it completes, refresh and confirm the row now shows "Ramping · day 1 · cap N" (or the settings-page equivalent suffix) rather than "Not started."
- On the Clients page's Warmup tab for the same client, confirm the same mailbox shows the matching status.

- [ ] **Step 3: Update the roadmap**

Append an entry to `.claude/roadmap.md` describing what shipped: the lazy-start warmup ramp (spec + plan file paths), the migration number (`0030`), and the full-suite pass/fail counts from Step 1.

- [ ] **Step 4: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs(roadmap): lazy-start warmup ramp shipped

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
