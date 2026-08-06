# Lazy-start warmup ramp — design

**Date:** 2026-08-06
**Status:** approved, ready for an implementation plan

## Problem

`warmup_started_at` (the clock `effectiveDailyCap`/`getMailboxWarmthStatus`
ramp from — `src/lib/mailbox/warmup.ts`) is stamped the moment a mailbox is
*connected* (`warmupInsertFields`, called from the three connect routes:
`google/callback`, `outlook/callback`, `smtp/connect`). It has nothing to do
with when the mailbox actually sends anything.

This is a separate clock from `mailreach_started_at`, which gates whether a
mailbox may send *any* outreach mail at all for 14 days
(`MAILREACH_CAMPAIGN_GATE_DAYS`, `src/lib/mailbox/mailreach-gate.ts`). A
mailbox enrolled in Mailreach warmup sits fully blocked from outreach sends
for those 14 days — but its daily-cap ramp has been ticking upward the whole
time regardless, since it started counting at connect time, not at the
mailbox's first real send. The operator sees the cap climbing on a mailbox
that has sent nothing yet, which reads as a bug even though no mail actually
goes out early (`isEligibleForCampaignSend` is a hard, independent gate in
`rotationOrder`, `src/lib/mailbox/sender.ts:96-101`).

## Scope

- The ramp clock (`warmup_started_at`) starts on the mailbox's first
  *actual* successful send of any kind — outreach, reply, or manual — not at
  connect time.
- Applies to every mailbox on a ramp (`warmup_profile` `'standard'`/`'slow'`),
  not just Mailreach-enrolled ones: a non-Mailreach mailbox can equally sit
  connected-but-unassigned for days before a campaign first uses it.
- One-time backfill: existing mailboxes that are ramping but have never
  actually sent anything get their stamp cleared, so they pick up lazy-start
  immediately on deploy.
- Explicitly unchanged: the operator-driven profile-change path
  (`POST /api/mailboxes/[id]/warmup`) keeps restarting the ramp immediately
  when an operator picks a new profile — that's a deliberate "reset now"
  action, not a "wait for the next send" one.
- Out of scope: the Mailreach 14-day gate itself (`mailreach-gate.ts`,
  `mailreach_started_at`) — untouched, orthogonal system. The ramp math
  (`effectiveDailyCap`'s day-to-day formula) — unchanged, only its zero point
  moves.

## Data flow

```
connect route ──► insert mailbox, warmup_started_at = null   (was: now())
                                        │
                     (mailbox idle — nothing sent yet)
                                        │
first claim_mailbox_send(_uncapped) ──► atomically: sent_today++,
                                         warmup_started_at = coalesce(., now())
                                        │
effectiveDailyCap on all later calls ──► ramps from that stamped instant
```

## Migration `0030`

```sql
-- Lazy-start warmup ramp: the ramp clock now starts on a mailbox's first
-- actual send, not at connect time. See
-- docs/superpowers/specs/2026-08-06-lazy-start-warmup-ramp-design.md.

-- ---------- claim RPCs stamp warmup_started_at on first send ----------
-- coalesce() inside the single atomic UPDATE means only the first send ever
-- sets it; a later send is a no-op on this column. Guarded to profile <>
-- 'none' so an already-warm mailbox (which never ramps) never gets a
-- meaningless timestamp written to it.
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
-- Same "has this mailbox ever sent" filter mailbox_send_stats (0012) already
-- uses, so "never sent" means the same thing everywhere in the codebase.
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

## Ramp calculation — `src/lib/mailbox/warmup.ts`

`computeRampState` currently treats `warmupStartedAt === null` as "not
ramping at all" for every profile, which was correct when only `'none'`
mailboxes had a null timestamp. Now a ramping profile can also be null
(mailbox connected, hasn't sent yet), and that case must compute the
day-one allowance, not fall through to `dailyCap`:

```ts
function computeRampState(input: EffectiveCapInput): RampState | null {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0) return null // 'none' — never ramps, regardless of the timestamp

  if (input.warmupStartedAt === null) {
    // Ramping profile, never sent yet: day-one allowance, clock not running.
    return { rampValue: input.startCap, elapsedDays: 0 }
  }

  const startedAt = Date.parse(input.warmupStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox warmup_started_at is not a valid timestamp', {
      warmupStartedAt: input.warmupStartedAt,
    })
  }
  const elapsedDays = Math.max(0, Math.floor((input.now.getTime() - startedAt) / MS_PER_DAY))
  const steps = Math.floor(elapsedDays / stepDays)
  return { rampValue: input.startCap + input.increment * steps, elapsedDays }
}
```

`effectiveDailyCap` is unchanged (still `state === null ? dailyCap :
ramp-vs-target`) — its behavior for the new pre-first-send case falls out
correctly: `rampValue = startCap`, which is exactly what day 1 already
returns today, so the actual number a caller gets on the literal first send
does not change. What changes is that days spent idle no longer advance the
clock.

`WarmthStatus` gains a fourth variant so the UI can distinguish "hasn't sent
yet" from "day 1 of an active ramp":

```ts
export type WarmthStatus =
  | { kind: 'not_ramping' }                                    // profile === 'none'
  | { kind: 'not_started'; startCap: number }                  // ramping profile, never sent
  | { kind: 'ramping'; currentCap: number; dayNumber: number }
  | { kind: 'ramp_complete' }

export function getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus {
  const stepDays = WARMUP_STEP_DAYS[input.profile]
  if (stepDays === 0) return { kind: 'not_ramping' }
  if (input.warmupStartedAt === null) return { kind: 'not_started', startCap: input.startCap }
  const state = computeRampState(input) // non-null now that warmupStartedAt is checked above
  if (state.rampValue >= input.targetCap) return { kind: 'ramp_complete' }
  return { kind: 'ramping', currentCap: state.rampValue, dayNumber: state.elapsedDays + 1 }
}
```

## Connect routes — remove the immediate stamp

`warmupInsertFields` is split into two functions so the connect path and the
explicit-profile-change path can diverge:

```ts
// Connect-time only: the ramp clock starts on first send, not on connect.
export function warmupInsertFields(profile: WarmupProfile): { warmup_profile: WarmupProfile; warmup_started_at: null } {
  return { warmup_profile: profile, warmup_started_at: null }
}

// Explicit operator profile change: restarts the ramp immediately — this is
// a deliberate "re-warm starting now" action (reconnected, previously
// blocked, new domain), not a "wait for the next send" one.
export function warmupRestartFields(profile: WarmupProfile, now: Date): { warmup_profile: WarmupProfile; warmup_started_at: string | null } {
  return { warmup_profile: profile, warmup_started_at: profile === 'none' ? null : now.toISOString() }
}
```

- `google/callback/route.ts`, `outlook/callback/route.ts`,
  `smtp/connect/route.ts`: `...warmupInsertFields(client?.warmup_profile ?? 'standard', new Date())`
  becomes `...warmupInsertFields(client?.warmup_profile ?? 'standard')` (drops
  the `now` argument along with the signature change).
- `api/mailboxes/[id]/warmup/route.ts:42`: `warmupInsertFields(body.profile, new Date())`
  becomes `warmupRestartFields(body.profile, new Date())` — only this call
  site keeps stamping `now()` immediately.

## UI

Both render sites currently collapse every non-`'ramping'` status into
"Already warm," which would now silently mislabel `'not_started'`. Both
switch to an exhaustive check:

- `src/app/(app)/settings/mailbox-row.tsx:129-131` — add a `'not_started'`
  branch alongside the existing `'ramping'` one; `'not_ramping'` and
  `'ramp_complete'` keep rendering no suffix (i.e., the bare "Already warm"
  implied by `StatusPill`/health text stays as-is for those two).
- `src/app/(app)/clients/[id]/warmup-mailbox-row.tsx:47-50` — the
  `status.kind === 'ramping' ? ... : t('alreadyWarm')` ternary becomes a
  `switch` with an `assertNever` default, so a fifth status variant added
  later can't silently fall through to the wrong label again.

New i18n keys (`src/messages/en.json` / `tr.json`, matching the existing
`warmupMailboxRow.ramping` / `mailboxRow.rampingSuffix` pattern):

- `settings.mailboxRow.notStartedSuffix`: `"warmup starts on first send (day-1 cap {startCap})"`
- `clients.warmupMailboxRow.notStarted`: `"Not started · day-1 cap {startCap}"`

Turkish equivalents added alongside, consistent with the existing dashboard
i18n pass (`e2b2341`).

## Testing

Per `.claude/QUALITY.md`: 100% on the pure functions, 80%+ on the DB layer.

- `warmup.test.ts` (extends the existing suite):
  - ramping profile + `warmupStartedAt: null` → `effectiveDailyCap` returns
    `startCap`;
  - same input → `getMailboxWarmthStatus` returns `{ kind: 'not_started', startCap }`;
  - `'none'` profile + `warmupStartedAt: null` is unaffected (still
    `{ kind: 'not_ramping' }`, still returns `dailyCap`) — proves the two
    null-but-different-meaning cases stay distinguished by profile alone;
  - existing ramping/ramp_complete cases (non-null timestamp) unchanged —
    regression guard that the refactor of `computeRampState` didn't shift
    the boundary math.
- `sender.test.ts`: a first send (outreach, reply, and the uncapped manual
  path) against a mailbox with `warmup_started_at: null` succeeds and claims
  at `startCap`, not `dailyCap` — proves `sendViaMailbox` doesn't have to
  change, only the pure function underneath it.
- `mailboxes.test.ts` (DB layer): `claimMailboxSend`/`claimMailboxSendUncapped`
  against a mock RPC response — assert the returned row's
  `warmup_started_at` reflects what the (mocked) RPC produced; the actual
  `coalesce` atomicity lives in SQL and isn't unit-testable, so this is
  covered by the migration's own logic review, not a Vitest case.
- Route handler tests (`route.test.ts` for the three connect routes and the
  warmup PATCH route): connect routes assert the inserted row has
  `warmup_started_at: null` regardless of profile (except `'none'`, already
  null); the warmup PATCH route's existing "profile change resets the
  clock" test keeps passing unchanged (still calls the now-renamed
  `warmupRestartFields` internally, but the observable behavior — and the
  request/response contract — is identical).
- Manual verification in-browser (per `run` skill): connect a fresh mailbox
  with a ramping profile, confirm Settings shows "Not started" (not a
  climbing day count) before any send; send a test email; confirm the status
  flips to "Ramping · day 1" immediately after.

## Explicitly out of scope

- Any change to `mailreach-gate.ts`, `mailreach_started_at`, or the 14-day
  campaign gate itself — this ships alongside it, unmodified.
- Any change to the ramp's day-to-day formula (`startCap`, `increment`,
  `targetCap` math) — only the zero point of the clock moves.
- Any change to the explicit profile-change restart behavior
  (`POST /api/mailboxes/[id]/warmup`) — stays immediate.
- Bulk re-backfilling on every deploy — the `0030` migration's `update` runs
  once, at migration time, not as a recurring job.
