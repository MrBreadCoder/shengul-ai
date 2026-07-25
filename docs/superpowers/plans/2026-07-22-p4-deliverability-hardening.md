# P4 — Deliverability Hardening + Observability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** make the outreach pipeline safe to run at real volume — new mailboxes ramp their send cap instead of starting at full throttle, bounces suppress the address and downgrade the mailbox, suppression is enforced at the single send chokepoint instead of per-caller, and an operator (or a client) can stop a mailbox or an individual lead instantly.

**Architecture:** Four layers, in dependency order. (1) Pure, unit-testable logic modules under `src/lib/mailbox/` — the warmup ramp, the bounce-rate health verdict, and DSN/auto-reply detection. (2) A single migration adding warmup + health columns, a bounce-stats RPC, and a re-signed `claim_mailbox_send` that takes the caller-computed effective cap so the cap comparison stays inside the atomic UPDATE while the ramp math stays in TypeScript where it can be tested without Docker. (3) Enforcement wired into the two chokepoints every send and every inbound message already flows through — `sendViaMailbox` and `ingestInboundForMailbox`. (4) Operator/client surfaces: mailbox pause/resume, per-client warmup profile, per-lead stop, and a runbook.

**Tech Stack:** Next.js 15 App Router (Server Components + Server Actions), Supabase Postgres (RLS, SECURITY DEFINER/INVOKER RPCs), supabase-js v2, Zod, Vitest, QStash cron, Gmail API + Microsoft Graph, Tailwind v4 + shadcn/ui + Phosphor icons.

---

## Research Findings (2026 deliverability consensus)

These numbers are why the constants below have the values they do. Do not change them without re-checking the sources.

| Signal | Consensus | Where it lands in this plan |
|---|---|---|
| New-mailbox ramp | Start 5–10/day, ramp over 2–4 weeks, never +30%/day | `WARMUP_START_CAP = 5`, `WARMUP_INCREMENT = 3` |
| Steady-state per mailbox | 15–25/day is the sweet spot; deliverability drops above 30/day | Existing `mailboxes.daily_cap` default of 20 is kept as the ramp ceiling |
| Scaling method | Add warmed mailboxes and rotate; never push one mailbox harder | Existing least-used-first rotation in `sender.ts` is unchanged |
| Hard-bounce rate | Under 2% is healthy, above 3% is at risk, above 5% stop sending | `BOUNCE_WARNING_RATE = 0.03`, `BOUNCE_BLOCK_RATE = 0.05` |
| Spam complaint rate | Under 0.1%; Google's hard limit is 0.3% | Not observable per-mailbox via Gmail API / Graph — documented as a known gap in the runbook (Task 17) |
| Bounce identification | Gmail: `from:mailer-daemon` + RFC 3464 DSN parts. Exchange: `report-type=delivery-status` or the `X-MS-Exchange-Message-Is-Ndr` header | `detectBounce` in Task 4 uses sender + subject + headers + body status code |

Sources: [MailReach Gmail warmup](https://www.mailreach.co/blog/gmail-warmup) · [MailReach volume guide](https://www.mailreach.co/blog/how-many-cold-emails-to-send-per-day) · [InboxKit 14-day warmup](https://www.inboxkit.com/learn/cold-email-warmup-guide) · [LiteMail bounce thresholds](https://litemail.ai/blog/cold-email-inbox-bounce-rate-thresholds-2026) · [Gmail sender guidelines FAQ](https://support.google.com/a/answer/14229414?hl=en) · [Exchange Online NDRs](https://learn.microsoft.com/en-us/troubleshoot/exchange/email-delivery/ndr/non-delivery-reports-in-exchange-online)

**Explicitly out of scope**, by decision on 2026-07-22: one-click unsubscribe / `List-Unsubscribe` headers (architecture.md §3 — "safety over legal compliance"), Google Postmaster Tools integration (needs domain ownership and 5k/day volume), and a global all-clients emergency stop (per-mailbox + per-campaign + per-client stops cover the real cases).

---

## Global Constants

Every task's requirements implicitly include this section. Values are copied verbatim into the code they belong in.

- Warmup: `WARMUP_START_CAP = 5`, `WARMUP_INCREMENT = 3`, step cadence `standard` = every 1 day, `slow` = every 2 days, `none` = no ramp.
- Health: `MIN_SENDS_FOR_HEALTH = 20`, `BOUNCE_WARNING_RATE = 0.03`, `BOUNCE_BLOCK_RATE = 0.05`, bounce window `HEALTH_WINDOW_DAYS = 7`.
- Health semantics change: `warning` becomes a **soft** state that still sends. Only `blocked` removes a mailbox from rotation. This changes both `rotationOrder` in `sender.ts` and the `claim_mailbox_send` RPC.
- Auto-recovery: a mailbox may auto-recover `warning → ok`, but **never** `blocked → ok`. A blocked mailbox needs an operator.
- Only **hard** bounces (5.x.x) suppress the address and mark the outbound email `bounced`. Soft bounces (4.x.x) and unparseable DSNs log an event and change nothing.
- Suppression at send time: `purpose: 'outreach'` is blocked by any suppression; `purpose: 'reply'` is blocked only by a `bounced` suppression (never send to a dead address; a human who wrote to us still deserves an answer).
- Package manager is **pnpm**. `npm install` corrupts this repo's tree.
- No `console.log`, no `any`, no non-null assertion without a comment proving it is safe, explicit return types on every function.
- Test names read `it('should [behavior] when [condition]')`, Arrange-Act-Assert.
- Every state change writes an `events` row via `logEvent` / `logEventSafe` / `logWarn` / `logError`.
- **Docker is not available on this machine.** `supabase db reset` and `pnpm test:integration` cannot be run. All new logic is therefore unit-testable in TypeScript; the SQL in Task 1 is written but stays unverified, and the plan says so where it matters.

---

## File Structure

**New files**

| File | Responsibility |
|---|---|
| `supabase/migrations/0012_p4_deliverability.sql` | warmup + health columns, `mailbox_send_stats` RPC, re-signed `claim_mailbox_send` |
| `src/lib/mailbox/warmup.ts` + `.test.ts` | pure ramp math and connect-time field helper |
| `src/lib/mailbox/health.ts` + `.test.ts` | pure bounce-rate → health verdict |
| `src/lib/mailbox/bounce.ts` + `.test.ts` | pure DSN + auto-reply detection from an `InboundMessage` |
| `src/lib/pipeline/bounce.ts` + `.test.ts` | bounce side effects: suppress, stop sequence, park lead, mark email bounced |
| `src/lib/pipeline/mailbox-health.ts` + `.test.ts` | the health sweep over every mailbox |
| `src/app/api/pipeline/mailbox-health/route.ts` + `.test.ts` | QStash cron entry for the sweep |
| `src/app/api/mailboxes/[id]/pause/route.ts` + `.test.ts` | per-mailbox kill switch (operator) |
| `src/app/api/mailboxes/[id]/resume/route.ts` | undo the kill switch |
| `src/app/api/mailboxes/[id]/warmup/route.ts` | per-mailbox warmup profile override |
| `scripts/schedule-mailbox-health-cron.ts` | registers the 6-hourly sweep schedule |
| `src/app/(app)/cases/[id]/actions.ts` + `.test.ts` | `stopLead` Server Action (operator **or** the lead's own client) |
| `src/app/(app)/cases/[id]/stop-lead-button.tsx` | confirm dialog + `useTransition` |
| `src/app/(app)/settings/mailbox-controls.tsx` | pause/resume + warmup profile select |
| `src/app/(app)/clients/[id]/warmup-profile-select.tsx` | per-client default warmup profile |
| `docs/runbooks/deliverability.md` | the operational runbook |

**Modified files**

| File | Change |
|---|---|
| `src/types/database.ts` | new enum, new columns, re-signed + new RPCs |
| `src/lib/mailbox/provider.ts` | `InboundMessage.headers` |
| `src/lib/mailbox/gmail-provider.ts` / `outlook-provider.ts` | populate `headers` |
| `src/lib/mailbox/sender.ts` | warmup cap, suppression gate, auth-failure downgrade, soft-warning rotation |
| `src/lib/db/mailboxes.ts` | `claimMailboxSend` signature, `setMailboxHealth`, `mailboxSendStats`, `updateMailboxWarmup` |
| `src/lib/db/suppressions.ts` | `getSuppression`, `isSuppressed` rebuilt on it |
| `src/lib/db/emails.ts` | `markLatestOutboundBounced` |
| `src/lib/db/leads.ts` | `parkLead` |
| `src/lib/db/clients.ts` | `updateClientWarmupProfile` |
| `src/lib/pipeline/inbound.ts` | bounce + auto-reply branches before the lead match |
| `src/lib/pipeline/write.ts`, `followup.ts`, `reply.ts` | pass `purpose` to `sendViaMailbox` |
| `src/app/(app)/inbox/actions.ts` | pass `purpose` |
| `src/app/api/mailboxes/{google,outlook}/callback/route.ts` | stamp warmup fields at connect |
| `src/app/api/clients/[clientId]/route.ts` | PATCH accepts `warmupProfile` |
| `src/app/(app)/settings/page.tsx`, `mailbox-row.tsx` | health reason, today's cap, controls |
| `src/app/(app)/cases/[id]/page.tsx` | stop-lead button in the contacts grid |
| `src/lib/seed/generate.ts`, `supabase/seed.sql` | `warmup_state` replaced by the new columns |
| `.claude/roadmap.md`, `.claude/architecture.md` | P4 progress |

---

## Task 1: Migration + generated types

**Files:**
- Create: `supabase/migrations/0012_p4_deliverability.sql`
- Modify: `src/types/database.ts` (Enums block ~line 631, `clients` ~line 12, `mailboxes` ~line 419, `Functions` ~line 530)
- Modify: `src/lib/seed/generate.ts:334`
- Modify: `supabase/seed.sql:90-110`

**Interfaces:**
- Produces: enum `warmup_profile` (`'standard' | 'slow' | 'none'`); `clients.warmup_profile`; `mailboxes.warmup_profile`, `mailboxes.warmup_started_at`, `mailboxes.health_reason`, `mailboxes.health_changed_at`; `mailboxes.warmup_state` **dropped**; RPC `claim_mailbox_send(p_mailbox_id uuid, p_effective_cap integer)`; RPC `mailbox_send_stats(p_since timestamptz) → (mailbox_id uuid, sent_count bigint, bounced_count bigint)`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0012_p4_deliverability.sql`:

```sql
-- P4 deliverability hardening: warmup ramp, mailbox health attribution,
-- bounce-rate stats, and a cap check that accounts for the ramp.

-- ---------- warmup profiles ----------
-- 'standard' raises the cap every day, 'slow' every 2 days (for a domain that
-- needs a gentler ramp), 'none' skips the ramp for an already-warm mailbox.
create type warmup_profile as enum ('standard', 'slow', 'none');

alter table clients add column warmup_profile warmup_profile not null default 'standard';

alter table mailboxes add column warmup_profile   warmup_profile not null default 'standard';
alter table mailboxes add column warmup_started_at timestamptz;
-- Machine-readable reason the current health was set (see src/lib/mailbox/health.ts
-- HEALTH_REASON) plus when it changed, so the operator can tell an auto-pause
-- from a manual one without digging through events.
alter table mailboxes add column health_reason     text;
alter table mailboxes add column health_changed_at timestamptz;

-- Mailboxes connected before this migration are already in service; retro-ramping
-- them would cut their throughput for no deliverability benefit.
update mailboxes set warmup_profile = 'none';

-- Superseded by the three typed columns above. It was never read by application
-- code — only written by the seed generator.
alter table mailboxes drop column warmup_state;

-- ---------- bounce-rate stats ----------
-- Hot path for mailbox_send_stats and the /settings screen.
create index idx_emails_mailbox_sent on emails (mailbox_id, sent_at) where mailbox_id is not null;

-- Per-mailbox outbound volume and hard-bounce count over a window.
-- SECURITY INVOKER so RLS decides the row set: /settings sees only the viewer's
-- mailboxes, the health sweep (admin client) sees every one. Every column is
-- qualified with `e.` because the OUT parameter names shadow the table columns.
create or replace function public.mailbox_send_stats(p_since timestamptz)
returns table (
  mailbox_id    uuid,
  sent_count    bigint,
  bounced_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select e.mailbox_id,
         count(*) filter (where e.status in ('sent', 'delivered', 'bounced')) as sent_count,
         count(*) filter (where e.status = 'bounced')                          as bounced_count
    from public.emails e
   where e.direction = 'outbound'
     and e.mailbox_id is not null
     and e.sent_at >= p_since
   group by e.mailbox_id;
$$;

-- ---------- cap claim, warmup-aware ----------
-- Adding a parameter creates an overload rather than replacing, so drop first.
drop function if exists public.claim_mailbox_send(uuid);

-- p_effective_cap is the ramp-adjusted cap computed by the caller
-- (src/lib/mailbox/warmup.ts effectiveDailyCap). The ramp math lives in
-- TypeScript so it is unit-testable without a database; the *comparison* stays
-- here so the claim is still atomic. least(daily_cap, ...) means a caller can
-- only ever lower the ceiling, never raise it above the configured cap.
--
-- health <> 'blocked' (not health = 'ok'): 'warning' is a soft flag that still
-- sends, so the bounce-rate warning threshold is meaningful.
create or replace function public.claim_mailbox_send(p_mailbox_id uuid, p_effective_cap integer)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
     and sent_today < least(daily_cap, greatest(p_effective_cap, 0))
  returning *;
$$;
```

- [ ] **Step 2: Update the hand-maintained database types**

In `src/types/database.ts`, add to the `Enums` block (after `mailbox_health`):

```ts
      warmup_profile: 'standard' | 'slow' | 'none'
```

In `clients`, add to both `Row` and `Insert` (optional in `Insert`) after `settings`:

```ts
          warmup_profile: Database['public']['Enums']['warmup_profile']
```
```ts
          warmup_profile?: Database['public']['Enums']['warmup_profile']
```

In `mailboxes`, **delete** `warmup_state: Json` from `Row` and `warmup_state?: Json` from `Insert`, and add in their place:

```ts
          warmup_profile: Database['public']['Enums']['warmup_profile']
          warmup_started_at: string | null
          health_reason: string | null
          health_changed_at: string | null
```
```ts
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          warmup_started_at?: string | null
          health_reason?: string | null
          health_changed_at?: string | null
```

In `Functions`, replace the `claim_mailbox_send` entry and add `mailbox_send_stats`:

```ts
      claim_mailbox_send: {
        Args: { p_mailbox_id: string; p_effective_cap: number }
        Returns: Database['public']['Tables']['mailboxes']['Row'][]
      }
      mailbox_send_stats: {
        Args: { p_since: string }
        Returns: {
          mailbox_id: string
          sent_count: number
          bounced_count: number
        }[]
      }
```

- [ ] **Step 3: Update both seeds for the dropped column**

In `src/lib/seed/generate.ts:334`, replace the `warmup_state` line with:

```ts
      warmup_profile: fixture.health === 'ok' ? 'none' : 'standard',
      warmup_started_at: fixture.health === 'ok' ? null : createdAt,
```

In `supabase/seed.sql`, change the mailboxes column list from `... sent_today, warmup_state, health, ...` to `... sent_today, warmup_profile, warmup_started_at, health, ...` and replace each row's jsonb literal:

- row `...0001` (`40, 12, '{"stage":"steady",...}'::jsonb, 'ok',`) → `40, 12, 'none', null, 'ok',`
- row `...0002` (`30, 28, '{"stage":"ramping",...}'::jsonb, 'warning',`) → `30, 28, 'standard', now() - interval '7 days', 'warning',`
- row `...0003` (`25, 5, '{"stage":"steady",...}'::jsonb, 'ok',`) → `25, 5, 'none', null, 'ok',`

- [ ] **Step 4: Verify the types compile**

Run: `pnpm tsc --noEmit`
Expected: errors only in `src/lib/db/mailboxes.ts` (the `claim_mailbox_send` call is now missing `p_effective_cap`) — Task 5 fixes that. If `generate.ts` or `seed.sql` still mention `warmup_state`, fix them now.

- [ ] **Step 5: Attempt to apply the migration**

Run: `pnpm supabase db reset`
Expected: succeeds and applies 0001–0012. **If Docker is unavailable this will fail to start** — that is the known state of this machine. Record it and move on; every task after this one is unit-testable without a database.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0012_p4_deliverability.sql src/types/database.ts src/lib/seed/generate.ts supabase/seed.sql
git commit -m "feat: add P4 warmup, mailbox health, and bounce-stats schema"
```

---

## Task 2: Warmup ramp math

**Files:**
- Create: `src/lib/mailbox/warmup.ts`
- Test: `src/lib/mailbox/warmup.test.ts`

**Interfaces:**
- Consumes: `Database['public']['Enums']['warmup_profile']` from Task 1.
- Produces: `WarmupProfile`, `WARMUP_START_CAP`, `WARMUP_INCREMENT`, `WARMUP_STEP_DAYS`, `effectiveDailyCap(input: EffectiveCapInput): number`, `warmupInsertFields(profile: WarmupProfile, now: Date): { warmup_profile: WarmupProfile; warmup_started_at: string | null }`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/warmup.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { effectiveDailyCap, warmupInsertFields, WARMUP_START_CAP } from './warmup'
import { AppError } from '@/lib/errors/app-error'

const START = '2026-07-01T00:00:00.000Z'

function atDay(day: number): Date {
  return new Date(Date.parse(START) + day * 86_400_000)
}

describe('effectiveDailyCap', () => {
  it('should return the configured cap when the profile is none', () => {
    const cap = effectiveDailyCap({ profile: 'none', warmupStartedAt: START, dailyCap: 40, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should return the configured cap when warmup never started', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: null, dailyCap: 40, now: atDay(0) })
    expect(cap).toBe(40)
  })

  it('should step every day when the profile is standard', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 40, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 8, 11, 14, 17, 20])
  })

  it('should hold each level for two days when the profile is slow', () => {
    const caps = [0, 1, 2, 3, 4, 5].map((day) =>
      effectiveDailyCap({ profile: 'slow', warmupStartedAt: START, dailyCap: 40, now: atDay(day) }),
    )
    expect(caps).toEqual([5, 5, 8, 8, 11, 11])
  })

  it('should never exceed the configured daily cap', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 12, now: atDay(30) })
    expect(cap).toBe(12)
  })

  it('should start at WARMUP_START_CAP on a partial first day', () => {
    const now = new Date(Date.parse(START) + 23 * 3_600_000)
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 40, now })
    expect(cap).toBe(WARMUP_START_CAP)
  })

  it('should clamp to the start cap when the clock is behind the start date', () => {
    const cap = effectiveDailyCap({ profile: 'standard', warmupStartedAt: START, dailyCap: 40, now: atDay(-5) })
    expect(cap).toBe(WARMUP_START_CAP)
  })

  it('should throw INVARIANT_VIOLATION when the start timestamp is unparseable', () => {
    expect(() =>
      effectiveDailyCap({ profile: 'standard', warmupStartedAt: 'not-a-date', dailyCap: 40, now: atDay(0) }),
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

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/mailbox/warmup.test.ts`
Expected: FAIL — "Failed to resolve import './warmup'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/mailbox/warmup.ts`:

```ts
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type WarmupProfile = Database['public']['Enums']['warmup_profile']

/**
 * Day-one send allowance for a ramping mailbox. 2026 deliverability consensus
 * is to open a new mailbox at 5-10 sends/day and ramp over 2-4 weeks.
 */
export const WARMUP_START_CAP = 5

/** Sends added at each step of the ramp. */
export const WARMUP_INCREMENT = 3

/**
 * Days a mailbox holds each level before stepping up. 'standard' steps daily
 * (5, 8, 11, ...); 'slow' holds each level for two days (5, 5, 8, 8, ...) for a
 * domain that needs a gentler ramp; 'none' is an already-warm mailbox and skips
 * the ramp entirely.
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
  dailyCap: number
  now: Date
}

/**
 * Today's send allowance for one mailbox: the ramp level, never above the
 * operator-configured `daily_cap`. Pure so it can be exhaustively tested; the
 * atomic enforcement lives in the claim_mailbox_send RPC, which takes this
 * number and clamps it with `least(daily_cap, ...)`.
 */
export function effectiveDailyCap({ profile, warmupStartedAt, dailyCap, now }: EffectiveCapInput): number {
  const stepDays = WARMUP_STEP_DAYS[profile]
  if (stepDays === 0 || warmupStartedAt === null) return dailyCap

  const startedAt = Date.parse(warmupStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox warmup_started_at is not a valid timestamp', {
      warmupStartedAt,
    })
  }

  // Clamped at 0 so clock skew (or a start date stamped slightly in the future)
  // opens the mailbox at the start cap rather than a negative one.
  const elapsedDays = Math.floor((now.getTime() - startedAt) / MS_PER_DAY)
  const steps = Math.max(0, Math.floor(elapsedDays / stepDays))
  return Math.min(dailyCap, WARMUP_START_CAP + WARMUP_INCREMENT * steps)
}

/**
 * The warmup columns to write when a mailbox is connected or its profile is
 * changed. Shared by both OAuth callbacks and the per-mailbox override route so
 * the "ramping profiles get a start date, 'none' does not" rule lives once.
 */
export function warmupInsertFields(
  profile: WarmupProfile,
  now: Date,
): { warmup_profile: WarmupProfile; warmup_started_at: string | null } {
  return {
    warmup_profile: profile,
    warmup_started_at: profile === 'none' ? null : now.toISOString(),
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/mailbox/warmup.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/warmup.ts src/lib/mailbox/warmup.test.ts
git commit -m "feat: add warmup ramp math for mailbox daily caps"
```

---

## Task 3: Bounce-rate health verdict

**Files:**
- Create: `src/lib/mailbox/health.ts`
- Test: `src/lib/mailbox/health.test.ts`

**Interfaces:**
- Produces: `MailboxHealth`, `HEALTH_REASON`, `MIN_SENDS_FOR_HEALTH`, `BOUNCE_WARNING_RATE`, `BOUNCE_BLOCK_RATE`, `HEALTH_WINDOW_DAYS`, `HealthVerdict { health: MailboxHealth; reason: string }`, `evaluateBounceHealth(input): HealthVerdict | null` (null = leave it alone).

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/health.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { evaluateBounceHealth, HEALTH_REASON } from './health'

describe('evaluateBounceHealth', () => {
  it('should return null when the sample is too small to judge', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 19, bouncedCount: 19 })
    expect(verdict).toBeNull()
  })

  it('should return null when a healthy mailbox is below the warning rate', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 100, bouncedCount: 2 })
    expect(verdict).toBeNull()
  })

  it('should warn when the bounce rate reaches the warning threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 100, bouncedCount: 3 })
    expect(verdict).toEqual({ health: 'warning', reason: HEALTH_REASON.bounceRateElevated })
  })

  it('should block when the bounce rate reaches the block threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 100, bouncedCount: 5 })
    expect(verdict).toEqual({ health: 'blocked', reason: HEALTH_REASON.bounceRateHigh })
  })

  it('should escalate a warning mailbox to blocked when it crosses the block threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'warning', sentCount: 200, bouncedCount: 20 })
    expect(verdict).toEqual({ health: 'blocked', reason: HEALTH_REASON.bounceRateHigh })
  })

  it('should recover a warning mailbox once the rate falls back below the warning threshold', () => {
    const verdict = evaluateBounceHealth({ current: 'warning', sentCount: 100, bouncedCount: 1 })
    expect(verdict).toEqual({ health: 'ok', reason: HEALTH_REASON.bounceRateNormal })
  })

  it('should never auto-recover a blocked mailbox', () => {
    const verdict = evaluateBounceHealth({ current: 'blocked', sentCount: 100, bouncedCount: 0 })
    expect(verdict).toBeNull()
  })

  it('should return null when a warning mailbox is still elevated but not blocked', () => {
    const verdict = evaluateBounceHealth({ current: 'warning', sentCount: 100, bouncedCount: 4 })
    expect(verdict).toBeNull()
  })

  it('should return null when nothing was sent in the window', () => {
    const verdict = evaluateBounceHealth({ current: 'ok', sentCount: 0, bouncedCount: 0 })
    expect(verdict).toBeNull()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/mailbox/health.test.ts`
Expected: FAIL — "Failed to resolve import './health'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/mailbox/health.ts`:

```ts
import type { Database } from '@/types/database'

export type MailboxHealth = Database['public']['Enums']['mailbox_health']

/**
 * Machine-readable values for mailboxes.health_reason. The operator UI and the
 * runbook branch on these, so they are stable strings, not prose.
 */
export const HEALTH_REASON = {
  bounceRateHigh: 'bounce_rate_high',
  bounceRateElevated: 'bounce_rate_elevated',
  bounceRateNormal: 'bounce_rate_normal',
  operatorPaused: 'operator_paused',
  authFailure: 'auth_failure',
} as const

/** Rolling window the bounce rate is measured over. */
export const HEALTH_WINDOW_DAYS = 7

/**
 * Below this many sends in the window the rate is noise — three sends and one
 * bad address is not a 33% bounce rate worth pausing a mailbox over.
 */
export const MIN_SENDS_FOR_HEALTH = 20

/** 2026 consensus: under 2% is healthy, 3%+ puts domain reputation at risk. */
export const BOUNCE_WARNING_RATE = 0.03

/** 5%+ is the "stop sending immediately and clean the list" line. */
export const BOUNCE_BLOCK_RATE = 0.05

export interface HealthVerdict {
  health: MailboxHealth
  reason: string
}

export interface BounceHealthInput {
  current: MailboxHealth
  sentCount: number
  bouncedCount: number
}

/**
 * The health a mailbox should have given its recent hard-bounce rate, or null
 * when the current health should be left alone.
 *
 * A blocked mailbox never auto-recovers: bad sends age out of the window on
 * their own, so an automatic un-block would resume sending into a mailbox
 * nobody has looked at. Recovering `warning -> ok` is safe because a warning
 * mailbox is still sending anyway.
 */
export function evaluateBounceHealth({ current, sentCount, bouncedCount }: BounceHealthInput): HealthVerdict | null {
  if (current === 'blocked') return null
  if (sentCount < MIN_SENDS_FOR_HEALTH) return null

  const rate = bouncedCount / sentCount

  if (rate >= BOUNCE_BLOCK_RATE) {
    return { health: 'blocked', reason: HEALTH_REASON.bounceRateHigh }
  }
  if (rate >= BOUNCE_WARNING_RATE) {
    return current === 'warning' ? null : { health: 'warning', reason: HEALTH_REASON.bounceRateElevated }
  }
  return current === 'warning' ? { health: 'ok', reason: HEALTH_REASON.bounceRateNormal } : null
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/mailbox/health.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/health.ts src/lib/mailbox/health.test.ts
git commit -m "feat: add bounce-rate health verdict for mailboxes"
```

---

## Task 4: Provider headers + DSN/auto-reply detection

**Files:**
- Modify: `src/lib/mailbox/provider.ts` (`InboundMessage`)
- Modify: `src/lib/mailbox/gmail-provider.ts` (the `messages.push` block in `fetchInbound`)
- Modify: `src/lib/mailbox/outlook-provider.ts` (`INBOX_DELTA_URL`, `graphMessageSchema`, `toInboundMessage`)
- Modify: `src/lib/mailbox/provider.test.ts` (compile-guard stub)
- Create: `src/lib/mailbox/bounce.ts`
- Test: `src/lib/mailbox/bounce.test.ts`

**Interfaces:**
- Produces: `InboundMessage.headers: Record<string, string>` (lowercased header names, last value wins, `{}` when the provider does not expose them); `BounceKind = 'hard' | 'soft'`; `BounceReport { kind; recipient: string | null; statusCode: string | null; diagnostic: string | null }`; `detectBounce(message: InboundMessage, mailboxAddress: string): BounceReport | null`; `detectAutoReply(message: InboundMessage): boolean`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/bounce.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { detectBounce, detectAutoReply } from './bounce'
import type { InboundMessage } from './provider'

const SELF = 'ops@acmerobotics.com'

function message(overrides: Partial<InboundMessage>): InboundMessage {
  return {
    providerMessageId: 'pm1',
    threadId: 't1',
    fromEmail: 'someone@example.com',
    subject: 'Re: quick question',
    body: 'Sure, happy to chat.',
    receivedAt: '2026-07-22T10:00:00.000Z',
    headers: {},
    ...overrides,
  }
}

const GMAIL_DSN_BODY = [
  'Address not found',
  '',
  'Your message wasn\'t delivered to vp.eng@target.com because the address',
  'couldn\'t be found.',
  '',
  'Final-Recipient: rfc822; vp.eng@target.com',
  'Action: failed',
  'Status: 5.1.1',
  'Diagnostic-Code: smtp; 550 5.1.1 The email account does not exist.',
].join('\n')

describe('detectBounce', () => {
  it('should detect a Gmail hard bounce from mailer-daemon', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Failure)',
        body: GMAIL_DSN_BODY,
        headers: { 'content-type': 'multipart/report; report-type=delivery-status; boundary="x"' },
      }),
      SELF,
    )
    expect(report).toEqual({
      kind: 'hard',
      recipient: 'vp.eng@target.com',
      statusCode: '5.1.1',
      diagnostic: 'smtp; 550 5.1.1 The email account does not exist.',
    })
  })

  it('should detect an Exchange NDR from its X-MS header', () => {
    const report = detectBounce(
      message({
        fromEmail: 'postmaster@acmerobotics.com',
        subject: 'Undeliverable: Quick question about your QA process',
        body: 'Your message to cto@target.com couldn\'t be delivered.\nStatus: 5.4.1',
        headers: { 'x-ms-exchange-message-is-ndr': 'true' },
      }),
      SELF,
    )
    expect(report?.kind).toBe('hard')
    expect(report?.recipient).toBe('cto@target.com')
    expect(report?.statusCode).toBe('5.4.1')
  })

  it('should classify a 4.x.x status as a soft bounce', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Delivery Status Notification (Delay)',
        body: 'Final-Recipient: rfc822; vp.eng@target.com\nStatus: 4.2.2\nDiagnostic-Code: smtp; 452 mailbox full',
      }),
      SELF,
    )
    expect(report?.kind).toBe('soft')
  })

  it('should default to a soft bounce when no status code can be parsed', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Failure notice',
        body: 'Sorry, we were unable to deliver your message to vp.eng@target.com.',
      }),
      SELF,
    )
    expect(report).toEqual({ kind: 'soft', recipient: 'vp.eng@target.com', statusCode: null, diagnostic: null })
  })

  it('should ignore the mailbox own address when guessing the failed recipient', () => {
    const report = detectBounce(
      message({
        fromEmail: 'mailer-daemon@googlemail.com',
        subject: 'Failure notice',
        body: `A message sent from ${SELF} could not be delivered to vp.eng@target.com.`,
      }),
      SELF,
    )
    expect(report?.recipient).toBe('vp.eng@target.com')
  })

  it('should return null for an ordinary human reply', () => {
    expect(detectBounce(message({}), SELF)).toBeNull()
  })

  it('should return null for a newsletter from a noreply address', () => {
    const report = detectBounce(
      message({ fromEmail: 'noreply@vendor.com', subject: 'Your weekly digest', body: 'Top stories this week' }),
      SELF,
    )
    expect(report).toBeNull()
  })

  it('should return null for a daemon sender with no bounce subject and no status code', () => {
    const report = detectBounce(
      message({ fromEmail: 'postmaster@vendor.com', subject: 'Mailbox quota notice', body: 'You are using 80% of your quota.' }),
      SELF,
    )
    expect(report).toBeNull()
  })
})

describe('detectAutoReply', () => {
  it('should detect an RFC 3834 auto-replied header', () => {
    expect(detectAutoReply(message({ headers: { 'auto-submitted': 'auto-replied' } }))).toBe(true)
  })

  it('should detect an X-Autoreply header', () => {
    expect(detectAutoReply(message({ headers: { 'x-autoreply': 'yes' } }))).toBe(true)
  })

  it('should detect an auto_reply precedence', () => {
    expect(detectAutoReply(message({ headers: { precedence: 'auto_reply' } }))).toBe(true)
  })

  it('should detect an out-of-office subject when headers are unavailable', () => {
    expect(detectAutoReply(message({ subject: 'Automatic reply: Quick question' }))).toBe(true)
    expect(detectAutoReply(message({ subject: 'Out of Office: back on Monday' }))).toBe(true)
  })

  it('should return false for an ordinary human reply', () => {
    expect(detectAutoReply(message({}))).toBe(false)
  })

  it('should return false when the subject merely mentions being out of office', () => {
    expect(detectAutoReply(message({ subject: 'Re: I am out of office next week' }))).toBe(false)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/mailbox/bounce.test.ts`
Expected: FAIL — "Failed to resolve import './bounce'".

- [ ] **Step 3: Add headers to the provider contract**

In `src/lib/mailbox/provider.ts`, add to `InboundMessage` after `receivedAt`:

```ts
  // Lowercased header names -> value (last wins). Gmail always populates this
  // from the full message payload; Graph only when it returns
  // internetMessageHeaders, so consumers must treat {} as "unknown", not "absent".
  headers: Record<string, string>
```

- [ ] **Step 4: Populate headers in the Gmail provider**

In `src/lib/mailbox/gmail-provider.ts`, add this helper next to `parseFromEmail`:

```ts
function toHeaderRecord(headers: { name: string; value: string }[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const header of headers) record[header.name.toLowerCase()] = header.value
  return record
}
```

Then in `fetchInbound`, where the loop already computes `const headers = message.payload?.headers ?? []`, pass them through on the pushed message:

```ts
      messages.push({
        providerMessageId: id,
        threadId: message.threadId ?? id,
        fromEmail,
        subject,
        body,
        receivedAt,
        headers: toHeaderRecord(headers),
      })
```

(Keep the existing field values exactly as they are today; only `headers` is new. If the existing push uses different local variable names, keep those — do not rename.)

- [ ] **Step 5: Populate headers in the Outlook provider**

In `src/lib/mailbox/outlook-provider.ts`:

Extend the delta select (line ~67):

```ts
const INBOX_DELTA_URL =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta' +
  '?$select=id,conversationId,subject,from,receivedDateTime,body,isDraft,internetMessageHeaders'
```

Add the field to `graphMessageSchema` (after `body`):

```ts
  internetMessageHeaders: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .nullable()
    .optional(),
```

And in `toInboundMessage`, add:

```ts
    // Graph omits internetMessageHeaders on some delta pages; {} then means
    // "unknown", and bounce detection falls back to sender + subject + body.
    headers: Object.fromEntries(
      (m.internetMessageHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value]),
    ),
```

- [ ] **Step 6: Fix the provider compile-guard stub**

In `src/lib/mailbox/provider.test.ts`, any literal `InboundMessage` in the stub now needs `headers: {}`. Add it.

- [ ] **Step 7: Write the bounce detector**

Create `src/lib/mailbox/bounce.ts`:

```ts
import type { InboundMessage } from './provider'

export type BounceKind = 'hard' | 'soft'

export interface BounceReport {
  /** 5.x.x is permanent (suppress); 4.x.x or unparseable is transient (record only). */
  kind: BounceKind
  /** The address that failed, lowercased, or null when it could not be extracted. */
  recipient: string | null
  /** RFC 3463 enhanced status code, e.g. '5.1.1'. */
  statusCode: string | null
  /** The Diagnostic-Code line, truncated — useful in the operator log. */
  diagnostic: string | null
}

// Bounces come from the receiving MTA, not a person. `noreply@` is deliberately
// excluded: it is the single biggest false-positive source (every newsletter).
const DAEMON_SENDER = /^(mailer-daemon|postmaster)@/i

const BOUNCE_SUBJECT =
  /^(undeliverable|delivery status notification|returned mail|mail delivery (failed|subsystem)|failure notice|delivery has failed)/i

const DSN_CONTENT_TYPE = /report-type=["']?delivery-status/i

const STATUS_CODE = /\b([45])\.(\d{1,3})\.(\d{1,3})\b/
const FINAL_RECIPIENT = /^(?:final|original)-recipient:\s*(?:rfc822;)?\s*<?([^\s<>]+@[^\s<>]+?)>?\s*$/im
const DIAGNOSTIC_CODE = /^diagnostic-code:\s*(.+)$/im
// The trailing group is repeated rather than a single [\w.-]+ class so a
// sentence-final period ("...to vp@target.com.") is not swallowed into the address.
const ANY_EMAIL = /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g

const MAX_DIAGNOSTIC_CHARS = 300

function extractRecipient(body: string, mailboxAddress: string): string | null {
  const explicit = FINAL_RECIPIENT.exec(body)
  if (explicit) return explicit[1]!.toLowerCase() // regex group 1 exists on a match

  // Fallback for providers that render the DSN as prose (Exchange often does):
  // the first address in the body that is neither our own mailbox nor a daemon.
  const self = mailboxAddress.toLowerCase()
  for (const candidate of body.match(ANY_EMAIL) ?? []) {
    const address = candidate.toLowerCase()
    if (address !== self && !DAEMON_SENDER.test(address)) return address
  }
  return null
}

/**
 * Whether this inbound message is a delivery status notification, and if so what
 * failed. Returns null for ordinary mail.
 *
 * Detection is deliberately layered because neither provider is reliable alone:
 * Gmail exposes the real `Content-Type: multipart/report`, Exchange exposes
 * `X-MS-Exchange-Message-Is-Ndr`, and Graph sometimes returns neither — so a
 * daemon sender still counts, but only when corroborated by a bounce subject or
 * a parseable status code, so a "mailbox quota" notice from postmaster is not
 * mistaken for a bounce.
 */
export function detectBounce(message: InboundMessage, mailboxAddress: string): BounceReport | null {
  const body = message.body
  const statusMatch = STATUS_CODE.exec(body)

  const hasDsnHeader =
    DSN_CONTENT_TYPE.test(message.headers['content-type'] ?? '') ||
    'x-ms-exchange-message-is-ndr' in message.headers
  const fromDaemon = DAEMON_SENDER.test(message.fromEmail)
  const hasBounceSubject = BOUNCE_SUBJECT.test(message.subject ?? '')

  const isBounce = hasDsnHeader || (fromDaemon && (hasBounceSubject || statusMatch !== null))
  if (!isBounce) return null

  const diagnosticMatch = DIAGNOSTIC_CODE.exec(body)
  return {
    // No parseable code means we do not know it is permanent, and guessing wrong
    // would suppress a live address forever. Treat it as soft and log it.
    kind: statusMatch?.[1] === '5' ? 'hard' : 'soft',
    recipient: extractRecipient(body, mailboxAddress),
    statusCode: statusMatch?.[0] ?? null,
    diagnostic: diagnosticMatch ? diagnosticMatch[1]!.trim().slice(0, MAX_DIAGNOSTIC_CHARS) : null,
  }
}

const AUTO_SUBMITTED = /auto-(replied|generated|notified)/i
const AUTO_SUBJECT = /^(automatic reply|auto(matic)?[-\s]?response|autoreply|out of office|ooo)\b/i

/**
 * Whether this is a vacation responder / auto-acknowledgement rather than a real
 * reply. Callers must check detectBounce first — a DSN also carries
 * `Auto-Submitted: auto-replied`.
 *
 * The subject check is anchored to the start of the line so "Re: I am out of
 * office next week" from a real person is not swallowed.
 */
export function detectAutoReply(message: InboundMessage): boolean {
  const { headers } = message
  if (AUTO_SUBMITTED.test(headers['auto-submitted'] ?? '')) return true
  if ('x-autoreply' in headers || 'x-autorespond' in headers) return true
  if ((headers['precedence'] ?? '').toLowerCase() === 'auto_reply') return true
  return AUTO_SUBJECT.test(message.subject ?? '')
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/`
Expected: PASS — `bounce.test.ts` 14 tests, plus the existing gmail/outlook/provider suites still green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/mailbox/bounce.ts src/lib/mailbox/bounce.test.ts src/lib/mailbox/provider.ts src/lib/mailbox/provider.test.ts src/lib/mailbox/gmail-provider.ts src/lib/mailbox/outlook-provider.ts
git commit -m "feat: expose inbound headers and detect DSN bounces and auto-replies"
```

---

## Task 5: Mailbox DB helpers

**Files:**
- Modify: `src/lib/db/mailboxes.ts`
- Test: `src/lib/db/mailboxes.test.ts`

**Interfaces:**
- Consumes: `mailbox_send_stats` and the re-signed `claim_mailbox_send` from Task 1; `HEALTH_REASON` from Task 3; `WarmupProfile` from Task 2.
- Produces: `claimMailboxSend(supabase, mailboxId, effectiveCap: number)`; `setMailboxHealth(supabase, id, health: MailboxHealth, reason: string | null): Promise<void>`; `mailboxSendStats(supabase, since: Date): Promise<Map<string, { sentCount: number; bouncedCount: number }>>`; `updateMailboxWarmup(supabase, id, fields: { warmup_profile: WarmupProfile; warmup_started_at: string | null }): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/db/mailboxes.test.ts` (the file already defines `mockRpc`, `mockUpdate`, and imports `AppError`; add `setMailboxHealth`, `mailboxSendStats`, `updateMailboxWarmup` to the existing import list):

```ts
describe('claimMailboxSend', () => {
  it('should pass the effective cap through to the RPC', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: 'm1' }], error: null })
    const result = await claimMailboxSend({ rpc } as never, 'm1', 8)
    expect(rpc).toHaveBeenCalledWith('claim_mailbox_send', { p_mailbox_id: 'm1', p_effective_cap: 8 })
    expect(result).toEqual({ id: 'm1' })
  })

  it('should return null when the claim is refused', async () => {
    const result = await claimMailboxSend(mockRpc({ data: [], error: null }), 'm1', 8)
    expect(result).toBeNull()
  })
})

describe('setMailboxHealth', () => {
  it('should write health, reason and a change timestamp', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await setMailboxHealth({ from: () => ({ update }) } as never, 'm1', 'blocked', 'operator_paused')
    const patch = update.mock.calls[0]?.[0] as Record<string, unknown>
    expect(patch.health).toBe('blocked')
    expect(patch.health_reason).toBe('operator_paused')
    expect(typeof patch.health_changed_at).toBe('string')
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      setMailboxHealth(mockUpdate({ error: { message: 'boom' } }), 'm1', 'ok', null),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('mailboxSendStats', () => {
  it('should index the rpc rows by mailbox id', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [{ mailbox_id: 'm1', sent_count: 100, bounced_count: 4 }],
      error: null,
    })
    const since = new Date('2026-07-15T00:00:00.000Z')
    const stats = await mailboxSendStats({ rpc } as never, since)
    expect(rpc).toHaveBeenCalledWith('mailbox_send_stats', { p_since: since.toISOString() })
    expect(stats.get('m1')).toEqual({ sentCount: 100, bouncedCount: 4 })
  })

  it('should return an empty map when no mailbox sent anything', async () => {
    const stats = await mailboxSendStats(mockRpc({ data: [], error: null }), new Date())
    expect(stats.size).toBe(0)
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    await expect(
      mailboxSendStats(mockRpc({ data: null, error: { message: 'boom' } }), new Date()),
    ).rejects.toBeInstanceOf(AppError)
  })
})

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

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/mailboxes.test.ts`
Expected: FAIL — `setMailboxHealth`, `mailboxSendStats`, `updateMailboxWarmup` are not exported, and `claimMailboxSend` ignores the third argument.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/mailboxes.ts`, replace `claimMailboxSend` and add the three new helpers. Also add `import type { WarmupProfile } from '@/lib/mailbox/warmup'` and `import type { MailboxHealth } from '@/lib/mailbox/health'` at the top.

```ts
// Atomic cap claim via the claim_mailbox_send Postgres function (migration 0012).
// effectiveCap is the warmup-ramped allowance from effectiveDailyCap(); the RPC
// clamps it with least(daily_cap, ...) so a caller can only ever lower the
// ceiling. Returns the updated row when the send is allowed, or null when the
// mailbox is at its cap for today or blocked.
export async function claimMailboxSend(
  supabase: SupabaseClient<Database>,
  mailboxId: string,
  effectiveCap: number,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.rpc('claim_mailbox_send', {
    p_mailbox_id: mailboxId,
    p_effective_cap: effectiveCap,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim mailbox send', { mailboxId, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Sets health plus the machine-readable reason and the moment it changed, so the
// operator can tell an auto-pause from a manual one without reading the audit log.
export async function setMailboxHealth(
  supabase: SupabaseClient<Database>,
  id: string,
  health: MailboxHealth,
  reason: string | null,
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({ health, health_reason: reason, health_changed_at: new Date().toISOString() })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to set mailbox health', { id, health, cause: error.message })
  }
}

export interface MailboxSendStats {
  sentCount: number
  bouncedCount: number
}

// Outbound volume and hard-bounce count per mailbox since `since`. One grouped
// RPC rather than a query per mailbox — the health sweep and the settings screen
// both need every mailbox at once. SECURITY INVOKER, so an RLS-scoped client
// only gets its own rows.
export async function mailboxSendStats(
  supabase: SupabaseClient<Database>,
  since: Date,
): Promise<Map<string, MailboxSendStats>> {
  const { data, error } = await supabase.rpc('mailbox_send_stats', { p_since: since.toISOString() })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load mailbox send stats', { cause: error.message })
  }
  return new Map(
    (data ?? []).map((row) => [row.mailbox_id, { sentCount: row.sent_count, bouncedCount: row.bounced_count }]),
  )
}

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

Also widen `MailboxSummary` so the settings screen can render the new fields:

```ts
export type MailboxSummary = Pick<
  MailboxRow,
  | 'id' | 'provider' | 'email_address' | 'display_name' | 'health' | 'created_at'
  | 'health_reason' | 'warmup_profile' | 'warmup_started_at' | 'daily_cap' | 'sent_today'
>
```

and extend the select in `listMailboxesForViewer` to match:

```ts
    .select(
      'id, provider, email_address, display_name, health, created_at, health_reason, warmup_profile, warmup_started_at, daily_cap, sent_today',
    )
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/mailboxes.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts
git commit -m "feat: add mailbox health, warmup and send-stats DB helpers"
```

---

## Task 6: Suppression lookup with reason

**Files:**
- Modify: `src/lib/db/suppressions.ts`
- Test: `src/lib/db/suppressions.test.ts`

**Interfaces:**
- Produces: `SuppressionMatch { email: string; reason: SuppressionReason }`, `getSuppression(supabase, clientId, email): Promise<SuppressionMatch | null>`. `isSuppressed` keeps its signature and is rebuilt on `getSuppression`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/db/suppressions.test.ts` (add `getSuppression` to the imports):

```ts
function mockSuppressionLookup(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('getSuppression', () => {
  it('should return the matching suppression with its reason', async () => {
    const match = await getSuppression(
      mockSuppressionLookup({ data: { email: 'a@b.com', reason: 'bounced' }, error: null }),
      'c1',
      'a@b.com',
    )
    expect(match).toEqual({ email: 'a@b.com', reason: 'bounced' })
  })

  it('should return null when the address is not suppressed', async () => {
    const match = await getSuppression(mockSuppressionLookup({ data: null, error: null }), 'c1', 'a@b.com')
    expect(match).toBeNull()
  })

  it('should throw DB_ERROR when the query fails', async () => {
    await expect(
      getSuppression(mockSuppressionLookup({ data: null, error: { message: 'boom' } }), 'c1', 'a@b.com'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('isSuppressed', () => {
  it('should be true when a suppression exists', async () => {
    const suppressed = await isSuppressed(
      mockSuppressionLookup({ data: { email: 'a@b.com', reason: 'replied' }, error: null }),
      'c1',
      'a@b.com',
    )
    expect(suppressed).toBe(true)
  })

  it('should be false when no suppression exists', async () => {
    const suppressed = await isSuppressed(mockSuppressionLookup({ data: null, error: null }), 'c1', 'a@b.com')
    expect(suppressed).toBe(false)
  })
})
```

Delete any pre-existing `describe('isSuppressed')` block that mocks the old head-count query shape — the query shape changed, so those mocks no longer represent reality.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/db/suppressions.test.ts`
Expected: FAIL — `getSuppression` is not exported.

- [ ] **Step 3: Write the implementation**

Replace `isSuppressed` in `src/lib/db/suppressions.ts` with:

```ts
export interface SuppressionMatch {
  email: string
  reason: SuppressionReason
}

// The reason matters at send time: an outreach send is blocked by any
// suppression, while a reply is blocked only by 'bounced' (see sendViaMailbox).
export async function getSuppression(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
): Promise<SuppressionMatch | null> {
  const { data, error } = await supabase
    .from('suppressions')
    .select('email, reason')
    .eq('client_id', clientId)
    .eq('email', email)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check suppression', { clientId, cause: error.message })
  }
  return data
}

export async function isSuppressed(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
): Promise<boolean> {
  return (await getSuppression(supabase, clientId, email)) !== null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/suppressions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/suppressions.ts src/lib/db/suppressions.test.ts
git commit -m "feat: expose the suppression reason for send-time decisions"
```

---

## Task 7: Bounce write helpers for emails and leads

**Files:**
- Modify: `src/lib/db/emails.ts`
- Modify: `src/lib/db/leads.ts`
- Test: `src/lib/db/emails.test.ts`, `src/lib/db/leads.test.ts`

**Interfaces:**
- Produces: `markLatestOutboundBounced(supabase, leadId): Promise<EmailRow | null>`; `parkLead(supabase, leadId): Promise<void>`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/db/emails.test.ts` (add `markLatestOutboundBounced` to the imports):

```ts
function mockBounceTarget(
  lookup: { data: unknown; error: unknown },
  update: { data: unknown; error: unknown },
) {
  const builder = {
    select: () => builder,
    eq: () => builder,
    in: () => builder,
    order: () => builder,
    limit: () => Promise.resolve(lookup),
  }
  const updateBuilder = {
    eq: () => updateBuilder,
    in: () => updateBuilder,
    select: () => Promise.resolve(update),
  }
  return { from: () => ({ select: builder.select, update: () => updateBuilder }) } as never
}

describe('markLatestOutboundBounced', () => {
  it('should flip the most recent sent outbound email to bounced', async () => {
    const result = await markLatestOutboundBounced(
      mockBounceTarget(
        { data: [{ id: 'e1', status: 'sent' }], error: null },
        { data: [{ id: 'e1', status: 'bounced' }], error: null },
      ),
      'l1',
    )
    expect(result).toEqual({ id: 'e1', status: 'bounced' })
  })

  it('should return null when the lead has no sent outbound email', async () => {
    const result = await markLatestOutboundBounced(mockBounceTarget({ data: [], error: null }, { data: [], error: null }), 'l1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the lookup fails', async () => {
    await expect(
      markLatestOutboundBounced(mockBounceTarget({ data: null, error: { message: 'boom' } }, { data: [], error: null }), 'l1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Append to `src/lib/db/leads.test.ts` (add `parkLead` to the imports):

```ts
describe('parkLead', () => {
  it('should set the lead status to parked', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await parkLead({ from: () => ({ update }) } as never, 'l1')
    expect(update).toHaveBeenCalledWith({ status: 'parked' })
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      parkLead({ from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) } as never, 'l1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/emails.test.ts src/lib/db/leads.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Write the implementations**

Add to `src/lib/db/emails.ts`:

```ts
// Flips the newest delivered/sent outbound email for a lead to 'bounced' — this
// is what makes the address show up in mailbox_send_stats' bounce numerator.
// The status guard on the update makes it a claim: a concurrent DSN for the same
// message cannot double-count. Returns null when there is nothing to flip (a
// bounce for mail we have no record of sending).
export async function markLatestOutboundBounced(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<EmailRow | null> {
  const { data: candidates, error: lookupError } = await supabase
    .from('emails')
    .select('id')
    .eq('lead_id', leadId)
    .eq('direction', 'outbound')
    .in('status', ['sent', 'delivered'])
    .order('sent_at', { ascending: false })
    .limit(1)
  if (lookupError) {
    throw new AppError('DB_ERROR', 'Failed to find outbound email to mark bounced', {
      leadId, cause: lookupError.message,
    })
  }
  const target = candidates?.[0]
  if (!target) return null

  const { data, error } = await supabase
    .from('emails')
    .update({ status: 'bounced' })
    .eq('id', target.id)
    .in('status', ['sent', 'delivered'])
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email bounced', { leadId, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

Add to `src/lib/db/leads.ts`:

```ts
// Takes a lead out of every send path without deleting it: parked leads are
// excluded by listActiveLeadsForCase. Used by the hard-bounce handler and the
// per-lead stop control.
export async function parkLead(supabase: SupabaseClient<Database>, leadId: string): Promise<void> {
  const { error } = await supabase.from('leads').update({ status: 'parked' }).eq('id', leadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to park lead', { leadId, cause: error.message })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/emails.test.ts src/lib/db/leads.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat: add bounce and park write helpers for emails and leads"
```

---

## Task 8: Sender — warmup cap, suppression gate, auth-failure downgrade

**Files:**
- Modify: `src/lib/mailbox/sender.ts`
- Test: `src/lib/mailbox/sender.test.ts`
- Modify (call sites): `src/lib/pipeline/write.ts`, `src/lib/pipeline/followup.ts`, `src/lib/pipeline/reply.ts`, `src/app/(app)/inbox/actions.ts`

**Interfaces:**
- Consumes: `effectiveDailyCap` (Task 2), `HEALTH_REASON` (Task 3), `claimMailboxSend`/`setMailboxHealth` (Task 5), `getSuppression` (Task 6).
- Produces: `SendViaMailboxInput` gains a **required** `purpose: SendPurpose` where `type SendPurpose = 'outreach' | 'reply'`. `sendViaMailbox` throws `AppError('FORBIDDEN')` when the recipient is suppressed for that purpose.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/mailbox/sender.test.ts`. It already mocks `@/lib/db/mailboxes`; extend that mock factory with `setMailboxHealth` and add a mock for `@/lib/db/suppressions`:

```ts
describe('suppression gate', () => {
  it('should refuse an outreach send to any suppressed address', async () => {
    getSuppressionMock.mockResolvedValue({ email: 'a@b.com', reason: 'replied' })
    await expect(
      sendViaMailbox(supabase, {
        clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'outreach',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(claimMailboxSendMock).not.toHaveBeenCalled()
  })

  it('should allow a reply to an address suppressed for a non-bounce reason', async () => {
    getSuppressionMock.mockResolvedValue({ email: 'a@b.com', reason: 'price_handoff' })
    const result = await sendViaMailbox(supabase, {
      clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'reply',
    })
    expect(result.mailboxId).toBe('m1')
  })

  it('should refuse even a reply to a hard-bounced address', async () => {
    getSuppressionMock.mockResolvedValue({ email: 'a@b.com', reason: 'bounced' })
    await expect(
      sendViaMailbox(supabase, {
        clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'reply',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })
})

describe('warmup cap', () => {
  it('should claim against the ramped cap for a warming mailbox', async () => {
    vi.setSystemTime(new Date('2026-07-03T12:00:00.000Z'))
    listMailboxesByIdsMock.mockResolvedValue([
      {
        id: 'm1', health: 'ok', sent_today: 0, daily_cap: 40, provider: 'gmail', oauth: {},
        warmup_profile: 'standard', warmup_started_at: '2026-07-01T00:00:00.000Z',
      },
    ])
    await sendViaMailbox(supabase, {
      clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'outreach',
    })
    // 2 days elapsed -> 5 + 3*2 = 11, not the configured 40.
    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm1', 11)
  })

  it('should claim against the configured cap for an already-warm mailbox', async () => {
    listMailboxesByIdsMock.mockResolvedValue([
      {
        id: 'm1', health: 'ok', sent_today: 0, daily_cap: 40, provider: 'gmail', oauth: {},
        warmup_profile: 'none', warmup_started_at: null,
      },
    ])
    await sendViaMailbox(supabase, {
      clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'outreach',
    })
    expect(claimMailboxSendMock).toHaveBeenCalledWith(expect.anything(), 'm1', 40)
  })
})

describe('rotation and health', () => {
  it('should still rotate through a warning mailbox', async () => {
    listMailboxesByIdsMock.mockResolvedValue([
      { id: 'm1', health: 'warning', sent_today: 0, daily_cap: 20, provider: 'gmail', oauth: {}, warmup_profile: 'none', warmup_started_at: null },
    ])
    const result = await sendViaMailbox(supabase, {
      clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'outreach',
    })
    expect(result.mailboxId).toBe('m1')
  })

  it('should skip a blocked mailbox entirely', async () => {
    listMailboxesByIdsMock.mockResolvedValue([
      { id: 'm1', health: 'blocked', sent_today: 0, daily_cap: 20, provider: 'gmail', oauth: {}, warmup_profile: 'none', warmup_started_at: null },
    ])
    await expect(
      sendViaMailbox(supabase, {
        clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'outreach',
      }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('should block a mailbox whose provider rejects the token', async () => {
    sendEmailMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'HTTP 401', { status: 401 }))
    await expect(
      sendViaMailbox(supabase, {
        clientId: 'c1', mailboxIds: ['m1'], to: 'a@b.com', subject: 's', body: 'b', purpose: 'outreach',
      }),
    ).rejects.toBeInstanceOf(AppError)
    expect(setMailboxHealthMock).toHaveBeenCalledWith(expect.anything(), 'm1', 'blocked', 'auth_failure')
  })
})
```

Match the existing file's mock-variable names; if it uses different names for the `listMailboxesByIds` / `claimMailboxSend` / provider `sendEmail` mocks, use those and add `getSuppressionMock` + `setMailboxHealthMock` in the same style. Ensure `vi.useFakeTimers()` is set up in a `beforeEach` for the warmup test and torn down after, and that `getSuppressionMock` defaults to `null` in `beforeEach` so the pre-existing tests are unaffected.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: FAIL — `purpose` is not a known property, `getSuppression` is not called, `claimMailboxSend` is called with two arguments.

- [ ] **Step 3: Write the implementation**

In `src/lib/mailbox/sender.ts`:

Add imports:

```ts
import { setMailboxHealth } from '@/lib/db/mailboxes'
import { getSuppression } from '@/lib/db/suppressions'
import { effectiveDailyCap } from '@/lib/mailbox/warmup'
import { HEALTH_REASON } from '@/lib/mailbox/health'
import { isAppError } from '@/lib/errors/app-error'
```

Add the purpose type and extend the input:

```ts
/**
 * Why we are sending. 'outreach' is anything unsolicited (first touch,
 * follow-up); 'reply' is a response to mail the recipient sent us. The two
 * differ only in how suppression is enforced.
 */
export type SendPurpose = 'outreach' | 'reply'

export interface SendViaMailboxInput {
  clientId: string
  mailboxIds: string[]
  to: string
  subject: string
  body: string
  purpose: SendPurpose
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
  maxJitterMs?: number
}
```

Replace `rotationOrder`'s filter (a warning mailbox still sends):

```ts
// Rotation: least-used-first, so sends spread evenly across a campaign's
// mailboxes and warm them uniformly. 'warning' is a soft flag that still sends;
// only 'blocked' takes a mailbox out of rotation.
function rotationOrder(mailboxes: MailboxRow[]): MailboxRow[] {
  return [...mailboxes]
    .filter((m) => m.health !== 'blocked')
    .sort((a, b) => a.sent_today - b.sent_today)
}
```

Add the suppression gate as the first thing `sendViaMailbox` does, after the empty-mailboxes guard:

```ts
  // The single suppression chokepoint. Every send path in the app funnels
  // through here, so an unsuppressed caller cannot leak an outreach email —
  // callers may still pre-check to skip work, but this is the enforcement.
  // A 'bounced' suppression blocks even a reply: the address is dead, and
  // sending to it again is exactly what drives the mailbox bounce rate up.
  const suppression = await getSuppression(supabase, input.clientId, input.to)
  if (suppression && (input.purpose === 'outreach' || suppression.reason === 'bounced')) {
    const error = new AppError('FORBIDDEN', 'Recipient is suppressed', {
      clientId: input.clientId, reason: suppression.reason, purpose: input.purpose,
    })
    await logWarn({
      clientId: input.clientId,
      actor: 'system',
      type: 'mailbox.send.suppressed',
      source: 'mailbox',
      error,
      payload: { reason: suppression.reason, purpose: input.purpose },
    })
    throw error
  }
```

In the rotation loop, compute the ramped cap and pass it to the claim:

```ts
  const now = new Date()
  for (const candidate of ordered) {
    const cap = effectiveDailyCap({
      profile: candidate.warmup_profile,
      warmupStartedAt: candidate.warmup_started_at,
      dailyCap: candidate.daily_cap,
      now,
    })
    const claimed = await claimMailboxSend(supabase, candidate.id, cap)
    if (!claimed) continue // at cap for today, or turned unhealthy — try the next
```

Wrap the provider send so a revoked grant blocks the mailbox instead of failing silently every cycle. Replace the existing `withExternalLogging(...)` call with:

```ts
    let sendResult: Awaited<ReturnType<typeof provider.sendEmail>>
    try {
      sendResult = await withExternalLogging(
        'mailbox',
        {
          clientId: input.clientId,
          actor: 'system',
          failureType: 'mailbox.send.failed',
          payload: { mailboxId: claimed.id, provider: claimed.provider },
        },
        () =>
          provider.sendEmail(tokens, {
            to: input.to,
            subject: input.subject,
            body: input.body,
            threadId: input.threadId ?? null,
            inReplyToMessageId: input.inReplyToMessageId ?? null,
            references: input.references ?? null,
          }),
      )
    } catch (error) {
      // The provider refreshes the access token immediately before sending, so a
      // 401 here means the grant itself was revoked (user removed the app,
      // password change, admin policy). Every future send will fail the same way,
      // so block the mailbox and make the operator reconnect it.
      if (isAppError(error) && error.context.status === 401) {
        await setMailboxHealth(supabase, claimed.id, 'blocked', HEALTH_REASON.authFailure)
      }
      throw error
    }
    const { result, tokens: refreshed } = sendResult
```

Keep the rest of the loop body (token persistence and the return) exactly as it is.

- [ ] **Step 4: Update every call site**

Add `purpose` to each `sendViaMailbox` call:

- `src/lib/pipeline/write.ts` (first touch) → `purpose: 'outreach'`
- `src/lib/pipeline/followup.ts` (nudge) → `purpose: 'outreach'`
- `src/lib/pipeline/reply.ts` in `sendOrDraftReply` → `purpose: 'reply'`
- `src/app/(app)/inbox/actions.ts` in `approveDraft` → `purpose: email.in_reply_to_email_id ? 'reply' : 'outreach'`

In `src/lib/pipeline/reply.ts`, extend the `catch` in `sendOrDraftReply` so a suppressed recipient does not retry forever:

```ts
  } catch (error) {
    // RATE_LIMITED is transient: leave the claimed row 'queued' (skip
    // markEmailFailed) and rethrow so the QStash delivery is retried, instead
    // of silently swallowing it and leaving the reply never sent.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') throw error
    await markEmailFailed(supabase, claimed.id)
    // FORBIDDEN means the address is hard-bounced. Retrying cannot help, and
    // the failed row is the durable record, so stop here instead of rethrowing
    // into a QStash retry loop.
    if (error instanceof AppError && error.code === 'FORBIDDEN') {
      await logEventSafe({
        clientId: input.inbound.client_id,
        caseId: input.inbound.case_id,
        actor: 'reply_agent',
        type: 'reply.send_suppressed',
        payload: { emailId: claimed.id, leadId: input.lead.id },
      })
      return
    }
    throw error
  }
```

- [ ] **Step 5: Run the full suite**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: PASS. `tsc` catches any `sendViaMailbox` call still missing `purpose`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts src/lib/pipeline/write.ts src/lib/pipeline/followup.ts src/lib/pipeline/reply.ts "src/app/(app)/inbox/actions.ts"
git commit -m "feat: enforce warmup caps and suppression at the single send chokepoint"
```

---

## Task 9: Bounce handling pipeline

**Files:**
- Create: `src/lib/pipeline/bounce.ts`
- Test: `src/lib/pipeline/bounce.test.ts`

**Interfaces:**
- Consumes: `BounceReport` (Task 4), `findContactedLeadByEmail` + `parkLead` (Task 7), `markLatestOutboundBounced` (Task 7), `addSuppression`, `stopSequenceForLead`.
- Produces: `BounceOutcome = 'suppressed' | 'recorded' | 'unmatched'`; `handleBounce(supabase, input: { mailbox: MailboxRow; report: BounceReport }): Promise<BounceOutcome>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipeline/bounce.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { handleBounce } from './bounce'
import type { BounceReport } from '@/lib/mailbox/bounce'

const findContactedLeadByEmail = vi.fn()
const parkLead = vi.fn()
const markLatestOutboundBounced = vi.fn()
const addSuppression = vi.fn()
const stopSequenceForLead = vi.fn()
const logEventSafe = vi.fn()
const logWarn = vi.fn()

vi.mock('@/lib/db/leads', () => ({
  findContactedLeadByEmail: (...args: unknown[]) => findContactedLeadByEmail(...args),
  parkLead: (...args: unknown[]) => parkLead(...args),
}))
vi.mock('@/lib/db/emails', () => ({
  markLatestOutboundBounced: (...args: unknown[]) => markLatestOutboundBounced(...args),
}))
vi.mock('@/lib/db/suppressions', () => ({
  addSuppression: (...args: unknown[]) => addSuppression(...args),
}))
vi.mock('@/lib/db/sequences', () => ({
  stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...args: unknown[]) => logEventSafe(...args),
  logWarn: (...args: unknown[]) => logWarn(...args),
}))

const mailbox = { id: 'm1', client_id: 'c1', email_address: 'ops@acme.com' } as never
const supabase = {} as never

function report(overrides: Partial<BounceReport> = {}): BounceReport {
  return { kind: 'hard', recipient: 'vp@target.com', statusCode: '5.1.1', diagnostic: null, ...overrides }
}

beforeEach(() => {
  vi.clearAllMocks()
  findContactedLeadByEmail.mockResolvedValue({ id: 'l1', case_id: 'case1', email: 'vp@target.com' })
  markLatestOutboundBounced.mockResolvedValue({ id: 'e1' })
})

describe('handleBounce', () => {
  it('should suppress, stop and park the lead on a hard bounce', async () => {
    const outcome = await handleBounce(supabase, { mailbox, report: report() })
    expect(outcome).toBe('suppressed')
    expect(markLatestOutboundBounced).toHaveBeenCalledWith(supabase, 'l1')
    expect(addSuppression).toHaveBeenCalledWith(supabase, { clientId: 'c1', email: 'vp@target.com', reason: 'bounced' })
    expect(stopSequenceForLead).toHaveBeenCalledWith(supabase, 'l1', 'stopped')
    expect(parkLead).toHaveBeenCalledWith(supabase, 'l1')
  })

  it('should record a soft bounce without suppressing or marking the email', async () => {
    const outcome = await handleBounce(supabase, { mailbox, report: report({ kind: 'soft', statusCode: '4.2.2' }) })
    expect(outcome).toBe('recorded')
    expect(addSuppression).not.toHaveBeenCalled()
    expect(stopSequenceForLead).not.toHaveBeenCalled()
    expect(parkLead).not.toHaveBeenCalled()
    expect(markLatestOutboundBounced).not.toHaveBeenCalled()
  })

  it('should report unmatched when no recipient could be extracted', async () => {
    const outcome = await handleBounce(supabase, { mailbox, report: report({ recipient: null }) })
    expect(outcome).toBe('unmatched')
    expect(logWarn).toHaveBeenCalled()
    expect(findContactedLeadByEmail).not.toHaveBeenCalled()
  })

  it('should report unmatched when the recipient is not a lead we contacted', async () => {
    findContactedLeadByEmail.mockResolvedValue(null)
    const outcome = await handleBounce(supabase, { mailbox, report: report() })
    expect(outcome).toBe('unmatched')
    expect(addSuppression).not.toHaveBeenCalled()
  })

  it('should look the recipient up in lowercase', async () => {
    await handleBounce(supabase, { mailbox, report: report({ recipient: 'VP@Target.com' }) })
    expect(findContactedLeadByEmail).toHaveBeenCalledWith(supabase, 'c1', 'vp@target.com', 'm1')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/bounce.test.ts`
Expected: FAIL — "Failed to resolve import './bounce'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/bounce.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { MailboxRow } from '@/lib/db/mailboxes'
import type { BounceReport } from '@/lib/mailbox/bounce'
import { findContactedLeadByEmail, parkLead } from '@/lib/db/leads'
import { markLatestOutboundBounced } from '@/lib/db/emails'
import { addSuppression } from '@/lib/db/suppressions'
import { stopSequenceForLead } from '@/lib/db/sequences'
import { logEventSafe, logWarn } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const ACTOR = 'bounce_handler'

export type BounceOutcome = 'suppressed' | 'recorded' | 'unmatched'

export interface HandleBounceInput {
  mailbox: MailboxRow
  report: BounceReport
}

/**
 * Applies a delivery status notification.
 *
 * Only hard (5.x.x) bounces suppress: a soft bounce is a full mailbox or a
 * greylisting retry, and suppressing on one would throw away a live prospect.
 * An unparseable DSN is treated as soft for the same reason — detectBounce
 * defaults it that way — and shows up in the log for a human to look at.
 *
 * Only hard bounces flip the outbound email to 'bounced', which is what feeds
 * the mailbox_send_stats bounce numerator, so the health signal is a hard-bounce
 * rate and comparable to the published 2-3% benchmarks.
 */
export async function handleBounce(
  supabase: SupabaseClient<Database>,
  { mailbox, report }: HandleBounceInput,
): Promise<BounceOutcome> {
  if (!report.recipient) {
    await logWarn({
      clientId: mailbox.client_id,
      actor: ACTOR,
      type: 'bounce.unmatched',
      source: 'mailbox',
      error: new AppError('VALIDATION_ERROR', 'Bounce carried no parseable recipient', {}),
      payload: { mailboxId: mailbox.id, statusCode: report.statusCode, kind: report.kind },
    })
    return 'unmatched'
  }

  const recipient = report.recipient.toLowerCase()
  const lead = await findContactedLeadByEmail(supabase, mailbox.client_id, recipient, mailbox.id)
  if (!lead) {
    await logWarn({
      clientId: mailbox.client_id,
      actor: ACTOR,
      type: 'bounce.unmatched',
      source: 'mailbox',
      error: new AppError('NOT_FOUND', 'Bounce recipient matched no contacted lead', {}),
      payload: { mailboxId: mailbox.id, statusCode: report.statusCode, kind: report.kind },
    })
    return 'unmatched'
  }

  if (report.kind === 'soft') {
    await logEventSafe({
      clientId: mailbox.client_id,
      caseId: lead.case_id,
      actor: ACTOR,
      type: 'bounce.soft',
      source: 'mailbox',
      severity: 'warn',
      payload: { mailboxId: mailbox.id, leadId: lead.id, statusCode: report.statusCode, diagnostic: report.diagnostic },
    })
    return 'recorded'
  }

  await markLatestOutboundBounced(supabase, lead.id)
  await addSuppression(supabase, { clientId: mailbox.client_id, email: recipient, reason: 'bounced' })
  await stopSequenceForLead(supabase, lead.id, 'stopped')
  await parkLead(supabase, lead.id)

  await logEventSafe({
    clientId: mailbox.client_id,
    caseId: lead.case_id,
    actor: ACTOR,
    type: 'bounce.hard',
    source: 'mailbox',
    severity: 'warn',
    payload: { mailboxId: mailbox.id, leadId: lead.id, statusCode: report.statusCode, diagnostic: report.diagnostic },
  })
  return 'suppressed'
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/bounce.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/bounce.ts src/lib/pipeline/bounce.test.ts
git commit -m "feat: suppress hard-bounced addresses and stop their sequences"
```

---

## Task 10: Wire bounce + auto-reply into inbound ingestion

**Files:**
- Modify: `src/lib/pipeline/inbound.ts`
- Test: `src/lib/pipeline/inbound.test.ts`

**Interfaces:**
- Consumes: `detectBounce`/`detectAutoReply` (Task 4), `handleBounce` (Task 9).
- Produces: `IngestSummary` gains `bounces: number` and `autoReplies: number`.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/pipeline/inbound.test.ts` (extend the existing module mocks with `@/lib/pipeline/bounce`; the existing `readInboundForMailbox` mock now needs `headers: {}` on each message):

```ts
describe('bounce and auto-reply routing', () => {
  it('should route a DSN to the bounce handler and never store it as a reply', async () => {
    readInboundForMailbox.mockResolvedValue({
      cursor: 'next',
      messages: [
        {
          providerMessageId: 'pm-dsn', threadId: 't', fromEmail: 'mailer-daemon@googlemail.com',
          subject: 'Delivery Status Notification (Failure)',
          body: 'Final-Recipient: rfc822; vp@target.com\nStatus: 5.1.1',
          receivedAt: '2026-07-22T10:00:00.000Z', headers: {},
        },
      ],
    })
    handleBounce.mockResolvedValue('suppressed')

    const summary = await ingestInboundForMailbox(supabase, mailbox)

    expect(handleBounce).toHaveBeenCalledOnce()
    expect(insertInboundEmail).not.toHaveBeenCalled()
    expect(publishJson).not.toHaveBeenCalled()
    expect(summary.bounces).toBe(1)
  })

  it('should ignore an out-of-office without pausing the sequence', async () => {
    readInboundForMailbox.mockResolvedValue({
      cursor: 'next',
      messages: [
        {
          providerMessageId: 'pm-ooo', threadId: 't', fromEmail: 'vp@target.com',
          subject: 'Automatic reply: Quick question', body: 'I am away until Monday.',
          receivedAt: '2026-07-22T10:00:00.000Z', headers: { 'auto-submitted': 'auto-replied' },
        },
      ],
    })

    const summary = await ingestInboundForMailbox(supabase, mailbox)

    expect(insertInboundEmail).not.toHaveBeenCalled()
    expect(pauseActiveSequenceForLead).not.toHaveBeenCalled()
    expect(publishJson).not.toHaveBeenCalled()
    expect(summary.autoReplies).toBe(1)
  })

  it('should still advance the cursor when every message was a bounce', async () => {
    readInboundForMailbox.mockResolvedValue({
      cursor: 'next',
      messages: [
        {
          providerMessageId: 'pm-dsn', threadId: 't', fromEmail: 'mailer-daemon@googlemail.com',
          subject: 'Failure notice', body: 'Status: 5.1.1\nFinal-Recipient: rfc822; vp@target.com',
          receivedAt: '2026-07-22T10:00:00.000Z', headers: {},
        },
      ],
    })
    handleBounce.mockResolvedValue('suppressed')

    await ingestInboundForMailbox(supabase, mailbox)

    expect(updateInboundCursor).toHaveBeenCalledWith(supabase, mailbox.id, 'next')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/inbound.test.ts`
Expected: FAIL — `handleBounce` is never called and `summary.bounces` is undefined.

- [ ] **Step 3: Write the implementation**

In `src/lib/pipeline/inbound.ts`, add imports:

```ts
import { detectBounce, detectAutoReply } from '@/lib/mailbox/bounce'
import { handleBounce } from '@/lib/pipeline/bounce'
```

Extend the summary:

```ts
export interface IngestSummary {
  mailboxId: string
  ingested: number
  enqueued: number
  bounces: number
  autoReplies: number
}
```

Initialise the two counters next to the existing ones, and insert this block at the very top of the `for (const message of messages)` loop, **before** the `findContactedLeadByEmail` call:

```ts
    // Order matters: a DSN also carries Auto-Submitted: auto-replied, so bounce
    // detection has to win. Neither branch stores an emails row — an inbound row
    // for a machine-generated message would make hasInboundReply() true and end
    // the follow-up sequence as if a human had answered.
    const bounce = detectBounce(message, mailbox.email_address)
    if (bounce) {
      await handleBounce(supabase, { mailbox, report: bounce })
      bounces += 1
      continue
    }

    if (detectAutoReply(message)) {
      autoReplies += 1
      await logEventSafe({
        clientId: mailbox.client_id,
        actor: ACTOR,
        type: 'inbound.auto_reply_ignored',
        source: 'mailbox',
        payload: { mailboxId: mailbox.id, fromEmail: message.fromEmail, subject: message.subject },
      })
      continue
    }
```

Return the two new counters in the summary. Leave the cursor advance where it is — it must still run after the loop.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/inbound.test.ts`
Expected: PASS, including the pre-existing tests (they need `headers: {}` added to their fixture messages).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/inbound.ts src/lib/pipeline/inbound.test.ts
git commit -m "feat: route bounces and auto-replies out of the reply agent path"
```

---

## Task 11: Mailbox health sweep + cron

**Files:**
- Create: `src/lib/pipeline/mailbox-health.ts`
- Test: `src/lib/pipeline/mailbox-health.test.ts`
- Create: `src/app/api/pipeline/mailbox-health/route.ts`
- Create: `scripts/schedule-mailbox-health-cron.ts`

**Interfaces:**
- Consumes: `listAllMailboxes`, `mailboxSendStats`, `setMailboxHealth` (Task 5); `evaluateBounceHealth`, `HEALTH_WINDOW_DAYS` (Task 3).
- Produces: `runMailboxHealthSweep(supabase, options: { now: Date }): Promise<{ evaluated: number; changed: number }>`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipeline/mailbox-health.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { runMailboxHealthSweep } from './mailbox-health'

const listAllMailboxes = vi.fn()
const mailboxSendStats = vi.fn()
const setMailboxHealth = vi.fn()
const logEventSafe = vi.fn()

vi.mock('@/lib/db/mailboxes', () => ({
  listAllMailboxes: (...args: unknown[]) => listAllMailboxes(...args),
  mailboxSendStats: (...args: unknown[]) => mailboxSendStats(...args),
  setMailboxHealth: (...args: unknown[]) => setMailboxHealth(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...args: unknown[]) => logEventSafe(...args),
}))

const supabase = {} as never
const NOW = new Date('2026-07-22T00:00:00.000Z')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('runMailboxHealthSweep', () => {
  it('should block a mailbox whose hard-bounce rate crossed the block threshold', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'ok', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map([['m1', { sentCount: 100, bouncedCount: 6 }]]))

    const summary = await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).toHaveBeenCalledWith(supabase, 'm1', 'blocked', 'bounce_rate_high')
    expect(summary).toEqual({ evaluated: 1, changed: 1 })
  })

  it('should leave a healthy mailbox untouched', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'ok', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map([['m1', { sentCount: 100, bouncedCount: 1 }]]))

    const summary = await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).not.toHaveBeenCalled()
    expect(summary).toEqual({ evaluated: 1, changed: 0 })
  })

  it('should treat a mailbox with no rows in the window as zero sends', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'ok', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map())

    const summary = await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).not.toHaveBeenCalled()
    expect(summary).toEqual({ evaluated: 1, changed: 0 })
  })

  it('should query stats over the configured window', async () => {
    listAllMailboxes.mockResolvedValue([])
    mailboxSendStats.mockResolvedValue(new Map())

    await runMailboxHealthSweep(supabase, { now: NOW })

    expect(mailboxSendStats).toHaveBeenCalledWith(supabase, new Date('2026-07-15T00:00:00.000Z'))
  })

  it('should log every health change', async () => {
    listAllMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', health: 'warning', email_address: 'a@b.com' }])
    mailboxSendStats.mockResolvedValue(new Map([['m1', { sentCount: 100, bouncedCount: 0 }]]))

    await runMailboxHealthSweep(supabase, { now: NOW })

    expect(setMailboxHealth).toHaveBeenCalledWith(supabase, 'm1', 'ok', 'bounce_rate_normal')
    expect(logEventSafe).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'mailbox.health_changed', clientId: 'c1' }),
    )
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/mailbox-health.test.ts`
Expected: FAIL — "Failed to resolve import './mailbox-health'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/mailbox-health.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listAllMailboxes, mailboxSendStats, setMailboxHealth } from '@/lib/db/mailboxes'
import { evaluateBounceHealth, HEALTH_WINDOW_DAYS } from '@/lib/mailbox/health'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'mailbox_health_sweep'
const MS_PER_DAY = 86_400_000

export interface HealthSweepSummary {
  evaluated: number
  changed: number
}

/**
 * Re-evaluates every mailbox's health from its recent hard-bounce rate.
 *
 * Runs on a cron rather than on every bounce so a single bad address cannot
 * flip a mailbox, and so recovery from 'warning' happens on its own once the
 * bad sends age out of the window. A blocked mailbox is never touched — see
 * evaluateBounceHealth.
 */
export async function runMailboxHealthSweep(
  supabase: SupabaseClient<Database>,
  { now }: { now: Date },
): Promise<HealthSweepSummary> {
  const since = new Date(now.getTime() - HEALTH_WINDOW_DAYS * MS_PER_DAY)
  const [mailboxes, stats] = await Promise.all([
    listAllMailboxes(supabase),
    mailboxSendStats(supabase, since),
  ])

  let changed = 0
  for (const mailbox of mailboxes) {
    const { sentCount, bouncedCount } = stats.get(mailbox.id) ?? { sentCount: 0, bouncedCount: 0 }
    const verdict = evaluateBounceHealth({ current: mailbox.health, sentCount, bouncedCount })
    if (!verdict || verdict.health === mailbox.health) continue

    await setMailboxHealth(supabase, mailbox.id, verdict.health, verdict.reason)
    changed += 1
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: ACTOR,
      type: 'mailbox.health_changed',
      source: 'mailbox',
      severity: verdict.health === 'ok' ? 'info' : 'warn',
      payload: {
        mailboxId: mailbox.id,
        emailAddress: mailbox.email_address,
        from: mailbox.health,
        to: verdict.health,
        reason: verdict.reason,
        sentCount,
        bouncedCount,
      },
    })
  }

  return { evaluated: mailboxes.length, changed }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/mailbox-health.test.ts`
Expected: PASS, 5 tests.

- [ ] **Step 5: Write the route and the cron script**

Create `src/app/api/pipeline/mailbox-health/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runMailboxHealthSweep } from '@/lib/pipeline/mailbox-health'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const summary = await runMailboxHealthSweep(admin, { now: new Date() })
    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'mailbox.health_sweep.completed',
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

Create `scripts/schedule-mailbox-health-cron.ts`:

```ts
// One-time setup: registers the QStash schedule that re-evaluates every
// mailbox's health from its recent hard-bounce rate. Run once per environment
// after deploy:
//   Usage: tsx scripts/schedule-mailbox-health-cron.ts [cron-expression]
// Default cron: "0 */6 * * *" (every 6 hours — fast enough to catch a bounce
// spike within a sending day, slow enough not to thrash on a single bad address).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 */6 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailbox-health', cron)
  process.stdout.write(`Scheduled mailbox-health cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 6: Verify the route compiles**

Run: `pnpm tsc --noEmit && pnpm vitest run src/lib/pipeline/mailbox-health.test.ts`
Expected: clean + PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/mailbox-health.ts src/lib/pipeline/mailbox-health.test.ts src/app/api/pipeline/mailbox-health/route.ts scripts/schedule-mailbox-health-cron.ts
git commit -m "feat: add the mailbox health sweep cron"
```

---

## Task 12: Per-mailbox kill switch + warmup override routes

**Files:**
- Create: `src/app/api/mailboxes/[id]/pause/route.ts`
- Create: `src/app/api/mailboxes/[id]/resume/route.ts`
- Create: `src/app/api/mailboxes/[id]/warmup/route.ts`
- Test: `src/app/api/mailboxes/[id]/pause/route.test.ts`

**Interfaces:**
- Consumes: `getMailboxById`, `setMailboxHealth`, `updateMailboxWarmup` (Task 5); `warmupInsertFields` (Task 2); `HEALTH_REASON` (Task 3).
- Produces: `POST /api/mailboxes/[id]/pause` → `{ ok: true }`; `POST /api/mailboxes/[id]/resume` → `{ ok: true }`; `POST /api/mailboxes/[id]/warmup` with body `{ profile: 'standard' | 'slow' | 'none' }` → `{ ok: true }`. All three are operator-only (403 otherwise), 404 on an unknown mailbox.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/mailboxes/[id]/pause/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getMailboxById = vi.fn()
const setMailboxHealth = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({
  getMailboxById: (...args: unknown[]) => getMailboxById(...args),
  setMailboxHealth: (...args: unknown[]) => setMailboxHealth(...args),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { POST } = await import('./route')

const context = { params: Promise.resolve({ id: 'm1' }) }

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  getMailboxById.mockResolvedValue({ id: 'm1', client_id: 'c1', email_address: 'a@b.com', health: 'ok' })
})

describe('POST /api/mailboxes/[id]/pause', () => {
  it('should block the mailbox with the operator_paused reason', async () => {
    const response = await POST(new Request('http://x/api/mailboxes/m1/pause', { method: 'POST' }), context)
    expect(response.status).toBe(200)
    expect(setMailboxHealth).toHaveBeenCalledWith(expect.anything(), 'm1', 'blocked', 'operator_paused')
  })

  it('should reject a client-role user', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client' } })
    const response = await POST(new Request('http://x/api/mailboxes/m1/pause', { method: 'POST' }), context)
    expect(response.status).toBe(403)
    expect(setMailboxHealth).not.toHaveBeenCalled()
  })

  it('should 404 an unknown mailbox', async () => {
    getMailboxById.mockResolvedValue(null)
    const response = await POST(new Request('http://x/api/mailboxes/m1/pause', { method: 'POST' }), context)
    expect(response.status).toBe(404)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run "src/app/api/mailboxes/[id]/pause/route.test.ts"`
Expected: FAIL — "Failed to resolve import './route'".

- [ ] **Step 3: Write the three routes**

Create `src/app/api/mailboxes/[id]/pause/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, setMailboxHealth } from '@/lib/db/mailboxes'
import { HEALTH_REASON } from '@/lib/mailbox/health'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// Per-mailbox kill switch. Blocking is instant: rotationOrder skips blocked
// mailboxes and claim_mailbox_send refuses them, so an in-flight campaign stops
// using this address on its very next send.
export async function POST(_request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    await setMailboxHealth(admin, id, 'blocked', HEALTH_REASON.operatorPaused)
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: `human:${appUser.id}`,
      type: 'mailbox.paused',
      source: 'mailbox',
      severity: 'warn',
      payload: { mailboxId: id, emailAddress: mailbox.email_address, from: mailbox.health },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

Create `src/app/api/mailboxes/[id]/resume/route.ts` — identical shape, but:

```ts
    await setMailboxHealth(admin, id, 'ok', null)
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: `human:${appUser.id}`,
      type: 'mailbox.resumed',
      source: 'mailbox',
      payload: { mailboxId: id, emailAddress: mailbox.email_address, previousReason: mailbox.health_reason },
    })
```

Create `src/app/api/mailboxes/[id]/warmup/route.ts`:

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

const bodySchema = z.object({ profile: z.enum(['standard', 'slow', 'none']) })

// Per-mailbox warmup override. Switching to a ramping profile restarts the ramp
// from day one on purpose: an operator only changes this when the mailbox needs
// re-warming (reconnected, previously blocked, new domain).
export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const { profile } = bodySchema.parse(await request.json())
    await updateMailboxWarmup(admin, id, warmupInsertFields(profile, new Date()))
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: `human:${appUser.id}`,
      type: 'mailbox.warmup_changed',
      source: 'mailbox',
      payload: { mailboxId: id, from: mailbox.warmup_profile, to: profile },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run "src/app/api/mailboxes/[id]/pause/route.test.ts"`
Expected: PASS, 3 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/mailboxes/[id]/pause" "src/app/api/mailboxes/[id]/resume" "src/app/api/mailboxes/[id]/warmup"
git commit -m "feat: add per-mailbox pause, resume and warmup override routes"
```

---

## Task 13: Per-client warmup profile + connect-time inheritance

**Files:**
- Modify: `src/lib/db/clients.ts`
- Modify: `src/app/api/clients/[clientId]/route.ts`
- Modify: `src/app/api/mailboxes/google/callback/route.ts`
- Modify: `src/app/api/mailboxes/outlook/callback/route.ts`
- Test: `src/lib/db/clients.test.ts`

**Interfaces:**
- Consumes: `warmupInsertFields` (Task 2), `getClientById`.
- Produces: `updateClientWarmupProfile(supabase, id, profile: WarmupProfile): Promise<ClientRow>`; `PATCH /api/clients/[clientId]` accepts `{ name?: string; warmupProfile?: 'standard' | 'slow' | 'none' }` with at least one field.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/db/clients.test.ts` (add `updateClientWarmupProfile` to the imports, reusing the file's existing update-mock helper):

```ts
describe('updateClientWarmupProfile', () => {
  it('should return the updated client', async () => {
    const row = { id: 'c1', warmup_profile: 'slow' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientWarmupProfile({ from: () => ({ update }) } as never, 'c1', 'slow')
    expect(update).toHaveBeenCalledWith({ warmup_profile: 'slow' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientWarmupProfile({ from: () => ({ update }) } as never, 'c1', 'slow'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: FAIL — `updateClientWarmupProfile` is not exported.

- [ ] **Step 3: Write the DB helper**

Add to `src/lib/db/clients.ts` (with `import type { WarmupProfile } from '@/lib/mailbox/warmup'`):

```ts
// The client-level default. Mailboxes snapshot it at connect time rather than
// reading it live, so changing this never retro-ramps a mailbox already in
// service — use the per-mailbox warmup route for that.
export async function updateClientWarmupProfile(
  supabase: SupabaseClient<Database>,
  id: string,
  profile: WarmupProfile,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ warmup_profile: profile })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client warmup profile', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Extend the client PATCH route**

In `src/app/api/clients/[clientId]/route.ts`, replace `renameSchema` and the PATCH body:

```ts
const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    warmupProfile: z.enum(['standard', 'slow', 'none']).optional(),
  })
  .refine((body) => body.name !== undefined || body.warmupProfile !== undefined, {
    message: 'At least one field must be provided',
  })
```

Inside the `try` block, replace the single `updateClientName` call with:

```ts
    const body = patchSchema.parse(await request.json())
    let updated = client

    if (body.name !== undefined) {
      updated = await updateClientName(admin, clientId, body.name)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.renamed',
          payload: { from: client.name, to: updated.name },
        })
      } catch {
        // Audit logging is best-effort — the rename already succeeded.
      }
    }

    if (body.warmupProfile !== undefined) {
      updated = await updateClientWarmupProfile(admin, clientId, body.warmupProfile)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.warmup_profile_changed',
          payload: { from: client.warmup_profile, to: body.warmupProfile },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }

    return NextResponse.json({ ok: true, client: updated })
```

Add `updateClientWarmupProfile` to the import from `@/lib/db/clients`.

- [ ] **Step 5: Inherit the profile when a mailbox is connected**

In **both** `src/app/api/mailboxes/google/callback/route.ts` and `src/app/api/mailboxes/outlook/callback/route.ts`, add the imports:

```ts
import { getOrCreateOperatorClient, getClientById } from '@/lib/db/clients'
import { warmupInsertFields } from '@/lib/mailbox/warmup'
```

and change the `insertMailbox` call (keeping the provider-specific `provider:` value):

```ts
    const clientId = await getOrCreateOperatorClient(admin)
    // A newly connected mailbox starts at the client's configured ramp. Clients
    // whose addresses are already warm are set to 'none' and skip the ramp.
    const client = await getClientById(admin, clientId)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'gmail',
      email_address: exchange.emailAddress,
      display_name: exchange.displayName,
      oauth: encryptMailboxTokens(exchange.tokens),
      ...warmupInsertFields(client?.warmup_profile ?? 'standard', new Date()),
    })
```

- [ ] **Step 6: Run the suite**

Run: `pnpm vitest run && pnpm tsc --noEmit`
Expected: PASS + clean.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts "src/app/api/clients/[clientId]/route.ts" src/app/api/mailboxes/google/callback/route.ts src/app/api/mailboxes/outlook/callback/route.ts
git commit -m "feat: make the warmup profile a per-client setting inherited at connect"
```

---

## Task 14: Per-lead stop (client-accessible)

**Files:**
- Create: `src/app/(app)/cases/[id]/actions.ts`
- Test: `src/app/(app)/cases/[id]/actions.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `createServerClient`, `createAdminClient`, `getLeadById`, `parkLead` (Task 7), `addSuppression`, `stopSequenceForLead`.
- Produces: `stopLead(formData: FormData): Promise<void>` — reads `leadId` and `caseId`.

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/cases/[id]/actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getLeadById = vi.fn()
const parkLead = vi.fn()
const addSuppression = vi.fn()
const stopSequenceForLead = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => Promise.resolve({}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('@/lib/db/leads', () => ({
  getLeadById: (...args: unknown[]) => getLeadById(...args),
  parkLead: (...args: unknown[]) => parkLead(...args),
}))
vi.mock('@/lib/db/suppressions', () => ({ addSuppression: (...args: unknown[]) => addSuppression(...args) }))
vi.mock('@/lib/db/sequences', () => ({ stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { stopLead } = await import('./actions')

function form(): FormData {
  const data = new FormData()
  data.set('leadId', '11111111-1111-4111-8111-111111111111')
  data.set('caseId', '22222222-2222-4222-8222-222222222222')
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })
  getLeadById.mockResolvedValue({
    id: '11111111-1111-4111-8111-111111111111',
    client_id: 'c1',
    case_id: '22222222-2222-4222-8222-222222222222',
    email: 'vp@target.com',
  })
})

describe('stopLead', () => {
  it('should suppress, stop the sequence and park the lead', async () => {
    await stopLead(form())
    expect(addSuppression).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', email: 'vp@target.com', reason: 'manual',
    })
    expect(stopSequenceForLead).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111', 'stopped')
    expect(parkLead).toHaveBeenCalledWith(expect.anything(), '11111111-1111-4111-8111-111111111111')
    expect(revalidatePath).toHaveBeenCalledWith('/cases/22222222-2222-4222-8222-222222222222')
  })

  it('should let a client-role user stop a lead the RLS read returned', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    await stopLead(form())
    expect(parkLead).toHaveBeenCalled()
  })

  it('should reject when the RLS-scoped read finds no such lead', async () => {
    getLeadById.mockResolvedValue(null)
    await expect(stopLead(form())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(parkLead).not.toHaveBeenCalled()
  })

  it('should reject a lead that belongs to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })
    await expect(stopLead(form())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(parkLead).not.toHaveBeenCalled()
  })

  it('should park a lead with no email address without suppressing', async () => {
    getLeadById.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111', client_id: 'c1',
      case_id: '22222222-2222-4222-8222-222222222222', email: null,
    })
    await stopLead(form())
    expect(addSuppression).not.toHaveBeenCalled()
    expect(parkLead).toHaveBeenCalled()
  })

  it('should reject a malformed lead id', async () => {
    const data = new FormData()
    data.set('leadId', 'nope')
    data.set('caseId', '22222222-2222-4222-8222-222222222222')
    await expect(stopLead(data)).rejects.toThrow()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run "src/app/(app)/cases/[id]/actions.test.ts"`
Expected: FAIL — "Failed to resolve import './actions'".

- [ ] **Step 3: Write the Server Action**

Create `src/app/(app)/cases/[id]/actions.ts`:

```ts
'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getLeadById, parkLead } from '@/lib/db/leads'
import { addSuppression } from '@/lib/db/suppressions'
import { stopSequenceForLead } from '@/lib/db/sequences'
import { logEventSafe } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const stopLeadSchema = z.object({
  leadId: z.string().uuid(),
  caseId: z.string().uuid(),
})

/**
 * Stops all outreach to one person: suppress the address, stop the sequence,
 * park the lead so it drops out of listActiveLeadsForCase.
 *
 * Unlike approveDraft this is available to client-role users, because deciding
 * "do not contact this person" is the client's call, not the operator's. The
 * authorization boundary is the RLS-scoped read below: a client-role session can
 * only resolve leads its own policies expose, and the client_id is re-checked
 * against the session afterwards. The writes then go through the admin client
 * because RLS makes client-role users read-only (migration 0002).
 */
export async function stopLead(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { leadId, caseId } = stopLeadSchema.parse({
    leadId: formData.get('leadId'),
    caseId: formData.get('caseId'),
  })

  const scoped = await createServerClient()
  const lead = await getLeadById(scoped, leadId)
  if (!lead) {
    throw new AppError('NOT_FOUND', 'Lead not found', { leadId })
  }
  if (appUser.role !== 'operator' && appUser.client_id !== lead.client_id) {
    throw new AppError('UNAUTHORIZED', 'Lead belongs to another client', { leadId, userId: appUser.id })
  }

  const admin = createAdminClient()
  // A lead can reach this state with no address (Apollo never revealed one).
  // Parking it is still the right outcome; there is just nothing to suppress.
  if (lead.email) {
    await addSuppression(admin, { clientId: lead.client_id, email: lead.email, reason: 'manual' })
  }
  await stopSequenceForLead(admin, leadId, 'stopped')
  await parkLead(admin, leadId)

  await logEventSafe({
    clientId: lead.client_id,
    caseId: lead.case_id,
    actor: `human:${appUser.id}`,
    type: 'lead.stopped',
    payload: { leadId, email: lead.email },
  })

  revalidatePath(`/cases/${caseId}`)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run "src/app/(app)/cases/[id]/actions.test.ts"`
Expected: PASS, 6 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/cases/[id]/actions.ts" "src/app/(app)/cases/[id]/actions.test.ts"
git commit -m "feat: let operators and clients stop outreach to a single lead"
```

---

## Task 15: Settings UI — health, ramp, pause, warmup

**Files:**
- Create: `src/app/(app)/settings/mailbox-controls.tsx`
- Modify: `src/app/(app)/settings/mailbox-row.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `MailboxSummary` (widened in Task 5), `effectiveDailyCap` (Task 2), the three routes from Task 12.

- [ ] **Step 1: Write the controls component**

Create `src/app/(app)/settings/mailbox-controls.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { WarmupProfile } from '@/lib/mailbox/warmup'

const WARMUP_LABEL: Record<WarmupProfile, string> = {
  standard: 'Ramp daily',
  slow: 'Ramp every 2 days',
  none: 'Already warm',
}

interface MailboxControlsProps {
  id: string
  isBlocked: boolean
  warmupProfile: WarmupProfile
}

export function MailboxControls({ id, isBlocked, warmupProfile }: MailboxControlsProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function post(path: string, body?: unknown): Promise<void> {
    setError(null)
    const response = await fetch(`/api/mailboxes/${id}/${path}`, {
      method: 'POST',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    })
    if (!response.ok) {
      setError('Could not apply that change.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <label className="sr-only" htmlFor={`warmup-${id}`}>
        Warmup profile
      </label>
      <select
        id={`warmup-${id}`}
        value={warmupProfile}
        disabled={isPending}
        onChange={(event) => void post('warmup', { profile: event.target.value })}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
      >
        {(Object.keys(WARMUP_LABEL) as WarmupProfile[]).map((profile) => (
          <option key={profile} value={profile}>
            {WARMUP_LABEL[profile]}
          </option>
        ))}
      </select>

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isPending}
        onClick={() => void post(isBlocked ? 'resume' : 'pause')}
      >
        {isBlocked ? <Play size={13} weight="light" /> : <Pause size={13} weight="light" />}
        {isBlocked ? 'Resume' : 'Pause'}
      </Button>

      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Show today's cap and the health reason in the row**

In `src/app/(app)/settings/mailbox-row.tsx`, widen the props and render the ramp:

```tsx
import { effectiveDailyCap, type WarmupProfile } from '@/lib/mailbox/warmup'
import { MailboxControls } from './mailbox-controls'

interface MailboxRowProps {
  id: string
  provider: 'gmail' | 'outlook'
  emailAddress: string
  displayName: string | null
  health: 'ok' | 'warning' | 'blocked'
  healthReason: string | null
  warmupProfile: WarmupProfile
  warmupStartedAt: string | null
  dailyCap: number
  sentToday: number
}
```

Inside the component, before the return:

```tsx
  const capToday = effectiveDailyCap({
    profile: props.warmupProfile,
    warmupStartedAt: props.warmupStartedAt,
    dailyCap: props.dailyCap,
    now: new Date(),
  })
  const isRamping = capToday < props.dailyCap
```

Replace the secondary line and add the controls, keeping the existing "Send test" button:

```tsx
        <p className="text-faint truncate text-[11px]">
          {props.displayName ?? 'No display name'} · {props.provider} ·{' '}
          <span className="tnum">
            {props.sentToday}/{capToday} today
          </span>
          {isRamping ? ` · warming up (cap ${props.dailyCap})` : null}
          {props.healthReason ? ` · ${props.healthReason.replaceAll('_', ' ')}` : null}
        </p>
```

and after the `StatusPill`:

```tsx
      <MailboxControls id={props.id} isBlocked={props.health === 'blocked'} warmupProfile={props.warmupProfile} />
```

- [ ] **Step 3: Pass the new fields from the page**

In `src/app/(app)/settings/page.tsx`, extend the `<MailboxRow ... />` props:

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
                />
```

- [ ] **Step 4: Verify it builds**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: clean; the route count grows by the three new `/api/mailboxes/[id]/*` routes and `/api/pipeline/mailbox-health`.

> If `pnpm build` fails on missing `BRIGHTDATA_SCRAPE_ZONE` (a known pre-existing `.env.local` gap noted in the roadmap), add the variable to `.env.local` first — it is unrelated to this work but blocks every local build.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings"
git commit -m "feat: surface mailbox health, ramp and kill switch on /settings"
```

---

## Task 16: Case + client UI — stop lead, client warmup profile

**Files:**
- Create: `src/app/(app)/cases/[id]/stop-lead-button.tsx`
- Modify: `src/app/(app)/cases/[id]/page.tsx` (contacts grid, ~line 127)
- Create: `src/app/(app)/clients/[id]/warmup-profile-select.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx` (header block)

- [ ] **Step 1: Write the stop-lead button**

Create `src/app/(app)/cases/[id]/stop-lead-button.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { Prohibit } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger,
} from '@/components/ui/dialog'
import { stopLead } from './actions'

interface StopLeadButtonProps {
  leadId: string
  caseId: string
  fullName: string
}

// Two-step on purpose: stopping is externally visible (it suppresses the address
// permanently for this client and kills an in-flight sequence), so it follows
// the same confirm pattern as the client pause/archive controls.
export function StopLeadButton({ leadId, caseId, fullName }: StopLeadButtonProps): React.ReactElement {
  const [isOpen, setIsOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  function confirm(): void {
    setError(null)
    const data = new FormData()
    data.set('leadId', leadId)
    data.set('caseId', caseId)
    startTransition(async () => {
      try {
        await stopLead(data)
        setIsOpen(false)
      } catch {
        setError('Could not stop this contact. Try again.')
      }
    })
  }

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={`Stop outreach to ${fullName}`}>
          <Prohibit size={13} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop outreach to {fullName}?</DialogTitle>
          <DialogDescription>
            Their address is added to your suppression list, any running follow-up sequence stops, and the
            contact is parked. Nothing is deleted, but no further email is ever sent to them.
          </DialogDescription>
        </DialogHeader>
        {error ? (
          <p role="alert" className="text-destructive text-[12px]">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => setIsOpen(false)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="destructive" onClick={confirm} disabled={isPending}>
            {isPending ? 'Stopping…' : 'Yes, stop outreach'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Render it in the contacts grid**

In `src/app/(app)/cases/[id]/page.tsx`, add `import { StopLeadButton } from './stop-lead-button'` and replace the whole `<li>` in the contacts grid (currently lines 128-155) with this — the inner `<div>` is unchanged from what is there today, the two lines after it are new:

```tsx
              <li
                key={lead.id}
                className="border-hairline bg-surface flex items-start gap-3 rounded-lg border p-3"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">{lead.full_name}</p>
                  <p className="text-faint truncate text-[11px]">{lead.title ?? 'Title unknown'}</p>
                  {lead.email ? (
                    <p className="text-muted-foreground mt-1.5 truncate font-mono text-[11px]">
                      {lead.email}
                    </p>
                  ) : null}
                  <div className="mt-2 flex items-center gap-2">
                    <StatusPill meta={LEAD_EMAIL_STATUS[lead.email_status]} />
                    {lead.linkedin_url ? (
                      <a
                        href={lead.linkedin_url}
                        target="_blank"
                        rel="noreferrer noopener"
                        aria-label={`${lead.full_name} on LinkedIn`}
                        className="text-faint hover:text-foreground transition-colors duration-200"
                      >
                        <LinkedinLogo size={14} weight="light" />
                      </a>
                    ) : null}
                  </div>
                </div>
                {lead.status === 'parked' ? (
                  <span className="text-faint shrink-0 text-[11px]">Stopped</span>
                ) : (
                  <StopLeadButton leadId={lead.id} caseId={kase.id} fullName={lead.full_name} />
                )}
              </li>
```

- [ ] **Step 3: Write the client warmup select**

Create `src/app/(app)/clients/[id]/warmup-profile-select.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { WarmupProfile } from '@/lib/mailbox/warmup'

const OPTIONS: { value: WarmupProfile; label: string }[] = [
  { value: 'standard', label: 'Warm up — raise the cap daily' },
  { value: 'slow', label: 'Warm up slowly — raise the cap every 2 days' },
  { value: 'none', label: 'Already warm — no ramp' },
]

interface WarmupProfileSelectProps {
  clientId: string
  value: WarmupProfile
}

// Applies to mailboxes connected *after* this change. Existing mailboxes keep
// the profile they were connected with — change those on /settings.
export function WarmupProfileSelect({ clientId, value }: WarmupProfileSelectProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(profile: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmupProfile: profile }),
    })
    if (!response.ok) {
      setError('Could not save that.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`warmup-${clientId}`} className="text-faint text-[11px]">
        New mailbox warmup
      </label>
      <select
        id={`warmup-${clientId}`}
        value={value}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 4: Render it in the client header**

In `src/app/(app)/clients/[id]/page.tsx`, import `WarmupProfileSelect` and render it in the header block next to `ClientLifecycleActions`:

```tsx
        <WarmupProfileSelect clientId={client.id} value={client.warmup_profile} />
```

- [ ] **Step 5: Verify it builds**

Run: `pnpm tsc --noEmit && pnpm build`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/cases/[id]" "src/app/(app)/clients/[id]"
git commit -m "feat: add per-lead stop control and per-client warmup selector"
```

---

## Task 17: Deliverability runbook

**Files:**
- Create: `docs/runbooks/deliverability.md`

- [ ] **Step 1: Write the runbook**

Create `docs/runbooks/deliverability.md`:

```markdown
# Runbook — Deliverability & Pipeline Operations

Covers the P4 controls: mailbox warmup, health, kill switches, bounces, and
recovering a stuck pipeline. Every threshold named here is defined in
`src/lib/mailbox/health.ts` or `src/lib/mailbox/warmup.ts` — change it there,
not in prose.

## Cron schedules

Each is registered once per environment with a `tsx scripts/schedule-*.ts` run.
QStash schedules do not expire, but they are per-project: **a new Vercel project
or a rotated `QSTASH_TOKEN` means re-running every one of these.**

| Schedule | Default cron | Script |
|---|---|---|
| Apollo discovery fan-out | daily | `scripts/schedule-discover-cron.ts` |
| Case research fan-out | `0 7 * * *` | `scripts/schedule-research-cron.ts` |
| Email write fan-out | `0 8 * * *` | `scripts/schedule-write-cron.ts` |
| Mailbox daily-counter reset | `0 0 * * *` | `scripts/schedule-mailbox-reset-cron.ts` |
| Inbound poll fan-out | `*/5 * * * *` | `scripts/schedule-inbound-poll-cron.ts` |
| Stuck-case sweep | `*/15 * * * *` | `scripts/schedule-stuck-sweep-cron.ts` |
| Mailbox health sweep | `0 */6 * * *` | `scripts/schedule-mailbox-health-cron.ts` |
| Log retention purge | daily | `scripts/schedule-log-retention-cron.ts` |

Verify what is actually registered in the Upstash console. A silent pipeline is
almost always a missing schedule, not broken code.

## Warmup

A newly connected mailbox starts at **5 sends/day** and gains **3/day**, capped
by its configured `daily_cap`. The profile decides the cadence:

| Profile | Cadence | Day 0 → 5 |
|---|---|---|
| `standard` | every day | 5, 8, 11, 14, 17, 20 |
| `slow` | every 2 days | 5, 5, 8, 8, 11, 11 |
| `none` | no ramp | the configured cap from day one |

The profile is chosen per client on `/clients/[id]` and inherited by mailboxes at
connect time. Override one mailbox on `/settings`. **Switching a mailbox to a
ramping profile restarts the ramp at day one** — do that after reconnecting a
mailbox or recovering a blocked one.

Today's allowance is shown on `/settings` as `sent/cap today`.

## Mailbox health

Health is re-evaluated every 6 hours from the **hard-bounce rate over the last 7
days**, ignoring any mailbox with fewer than 20 sends in that window.

| Rate | Result | Sends? |
|---|---|---|
| < 3% | `ok` | yes |
| ≥ 3% | `warning` | yes — a flag, not a stop |
| ≥ 5% | `blocked` | no |

`health_reason` records why: `bounce_rate_high`, `bounce_rate_elevated`,
`bounce_rate_normal`, `operator_paused`, `auth_failure`.

**A blocked mailbox never un-blocks itself.** That is deliberate — bad sends age
out of the window on their own, and an automatic un-block would resume sending
from a mailbox nobody has looked at.

### A mailbox went to `blocked`

1. Open `/settings` and read `health_reason`.
2. `auth_failure` → the OAuth grant was revoked. Reconnect the mailbox from
   `/settings` → *Connect a mailbox* using the same address. Then set its warmup
   profile back to `standard` so it re-ramps.
3. `bounce_rate_high` → find the bounces on `/analytics` (mailbox table) and in
   the client's Logs tab (`bounce.hard` events). If they cluster on one campaign's
   ICP, pause that campaign before resuming the mailbox. Emailable is a fail-open
   guard (see `architecture.md §12`) — a run of Emailable failures means leads
   were activated on Apollo's word alone and bounce risk is elevated.
4. When the cause is fixed, click **Resume** on `/settings`. Consider setting the
   profile to `slow` for a re-warm.

### Spam complaints

Not observable. Neither the Gmail API nor Microsoft Graph exposes a per-mailbox
complaint rate to a third-party app, and Google Postmaster Tools needs domain
ownership plus 5,000 messages/day to that domain — far above what this system
sends. Bounce rate and reply rate are the only automated signals we have. If a
client reports landing in spam, reduce `daily_cap`, re-warm, and check SPF/DKIM/
DMARC on the sending domain by hand.

## Kill switches, weakest to strongest

| Scope | Where | Effect |
|---|---|---|
| One person | `/cases/[id]` → Stop on a contact | Suppresses the address, stops the sequence, parks the lead. Available to client-role users. |
| One mailbox | `/settings` → Pause | `health = blocked`. Drops out of rotation on the next send. |
| One campaign | `/campaigns` → status `paused` | Discovery, research, write and follow-up all skip it. Follow-ups reschedule themselves a day out instead of dying. |
| One client | `/clients/[id]` → Pause | Pauses every campaign. Archive also bans the client's logins. |

## Bounces

Inbound polling classifies every message before it reaches the Reply Agent:

- **Hard (5.x.x)** → mark the outbound email `bounced`, suppress the address
  (`reason: 'bounced'`), stop the sequence, park the lead. Logged as `bounce.hard`.
- **Soft (4.x.x) or unparseable** → logged as `bounce.soft`, nothing changes. We
  never suppress on a guess.
- **Auto-reply / out-of-office** → logged as `inbound.auto_reply_ignored` and
  dropped. It is deliberately *not* stored as an inbound email: that would make
  `hasInboundReply()` true and end the follow-up sequence as if a human answered.

A `bounce.unmatched` event means a DSN arrived that we could not tie to a lead —
usually mail sent outside the pipeline from the same mailbox. Safe to ignore
unless it is frequent.

Suppression is enforced in one place: `sendViaMailbox`. An outreach send is
blocked by any suppression; a reply is blocked only by a `bounced` suppression.

## Rotating OAuth tokens

Access tokens refresh themselves on every send and poll. Only the **refresh
token** needs human action, and only when it is revoked (`auth_failure`):
reconnect the mailbox from `/settings`. Tokens are encrypted at rest
(`src/lib/mailbox/tokens.ts`); rotating `MAILBOX_TOKEN_KEY` invalidates every
stored token and requires reconnecting every mailbox.

## Recovering stuck sequences

- **Cases stuck in `researching` or `contacted`** — the stuck-sweep cron
  (`*/15`) resets them automatically. Force a run by POSTing to
  `/api/pipeline/stuck-sweep` with a valid QStash signature. Claims and unique
  slots make it safe to re-run; it cannot double-send.
- **A follow-up that never fired** — `sequences.qstash_message_id` is the
  delivery to look up in Upstash. A sequence for a paused campaign reschedules
  itself one day out, so it will look "late" but is not lost.
- **A draft stuck in `queued`** — the send threw after the claim. It is not
  retried automatically; check the client's Logs tab for `mailbox.send.failed`,
  fix the cause, and re-approve from `/inbox` after resetting the row to `draft`.
- **Nothing at all is happening** — check the QStash schedule list first (above),
  then the client's Logs tab for `error`-severity rows.
```

- [ ] **Step 2: Commit**

```bash
git add docs/runbooks/deliverability.md
git commit -m "docs: add the deliverability and pipeline operations runbook"
```

---

## Task 18: Full verification + roadmap/architecture update

**Files:**
- Modify: `.claude/roadmap.md`
- Modify: `.claude/architecture.md` (§10 provider table, §11 safety bullets)

- [ ] **Step 1: Run every gate**

```bash
pnpm vitest run
pnpm tsc --noEmit
pnpm eslint .
pnpm build
```

Expected: all tests green, `tsc` clean, `eslint` reporting only the pre-existing warnings already noted in the roadmap, `build` succeeding with the four new API routes registered. Fix anything that fails before continuing — do not record a pass you did not see.

- [ ] **Step 2: Update architecture.md**

In `.claude/architecture.md` §11 (the deliverability bullet list around lines 266-271), mark what now exists:

```markdown
- Warmup ramp for newly connected mailboxes — **shipped**: per-client
  `warmup_profile` (`standard` / `slow` / `none`), 5/day + 3/day, enforced inside
  `claim_mailbox_send`. See `src/lib/mailbox/warmup.ts`.
- Suppression on any reply, bounce, price-handoff, or opt-out language —
  **shipped**: enforced centrally in `sendViaMailbox`, not per caller.
- Per-campaign and per-mailbox **kill-switch** — **shipped**, plus a per-lead
  stop available to client-role users.
- Mailbox `health` monitoring (bounce rate) → auto-pause on `blocked` —
  **shipped** via the 6-hourly `/api/pipeline/mailbox-health` sweep. Complaint
  rate is not observable per-mailbox; see `docs/runbooks/deliverability.md`.
```

- [ ] **Step 3: Append the roadmap section**

Add to `.claude/roadmap.md` under the P4 heading (replacing the unchecked bullets with checked ones) and append a dated recap section in the style of the existing entries, recording: the migration number, the `warning`-now-sends semantics change, the `purpose` parameter on `sendViaMailbox`, the fact that hard bounces alone feed the health metric, the exact test count from Step 1, and — honestly — that `0012_p4_deliverability.sql` was never applied to a real Postgres because Docker is unavailable on this machine.

- [ ] **Step 4: Commit**

```bash
git add .claude/roadmap.md .claude/architecture.md
git commit -m "docs: record P4 deliverability hardening in the roadmap and architecture"
```

---

## Known gaps left open on purpose

- `0012_p4_deliverability.sql` is unverified against a real database (no Docker). The three SQL objects most likely to need a fix on first apply: the `mailbox_send_stats` OUT-parameter shadowing (mitigated by qualifying every column with `e.`), the `drop function` before re-signing `claim_mailbox_send`, and the partial index predicate on `idx_emails_mailbox_sent`.
- Spam-complaint rate has no data source at mailbox granularity. Documented in the runbook rather than faked.
- Graph does not reliably return `internetMessageHeaders` on delta pages, so Outlook bounce detection leans on sender + subject + body. Gmail detection uses the real DSN headers.
- A mailbox that hits the provider's own quota (`550 5.4.5`) surfaces as a `mailbox.send.failed` event and a failed email row; it does not yet burn down `sent_today` to stop retrying for the day. Worth adding if it shows up in real logs.
