# Configurable per-mailbox warmup caps + Clients page Warmup tab — design

**Date:** 2026-08-03
**Status:** approved, ready for an implementation plan

## Problem

The warmup ramp (`src/lib/mailbox/warmup.ts`) is a pure function of a mailbox's
`warmup_profile`, `warmup_started_at`, and `daily_cap`, but the numbers that
drive it — the day-one send allowance (`WARMUP_START_CAP = 5`) and the size of
each step up (`WARMUP_INCREMENT = 3`) — are hardcoded constants shared by
every mailbox on the platform. There is also no notion of "stop ramping once
you hit N and switch to a steady-state cap" — today `daily_cap` plays double
duty as both the ramp's ceiling *and* the already-warm cap, so an operator
can't set a mailbox to ramp up to 30/day while ending up at a different
steady-state cap once warm.

There's also nowhere on the Clients page to see or edit any of this per
mailbox. The only warmup-related controls there today
(`warmup-profile-select.tsx`, `mailreach-toggle.tsx`) are client-level
defaults applied to *newly connected* mailboxes, rendered in the page header.
An operator has to go to `/settings` (which is scoped to the viewer's own
mailboxes via RLS) to see or change an existing mailbox's ramp.

## Scope

- Three ramp inputs become configurable per mailbox instead of global
  constants: start cap, increment, and a target cap (the number the ramp
  stops raising at).
- The already-warm cap (`daily_cap`) becomes independently editable at any
  time, regardless of current ramp state.
- Once the ramp's computed value reaches the target cap, the mailbox is
  "Already warm" from that point on — computed on every read, no new
  persisted flag and no new cron job. If the target is later raised, ramping
  quietly resumes.
- A new **Warmup** tab on the client detail page (`/clients/[id]`,
  operator-only) lists that client's mailboxes with editable fields for all
  of the above.
- Per-mailbox only, operator-only — no client-level defaults for the new
  numeric fields (the existing client-level `warmup_profile` default for
  newly-connected mailboxes is untouched).
- Out of scope: the Mailreach vendor-warmup system (`mailreach_*` columns,
  `mailreach-gate.ts`) — orthogonal, untouched. Any change to
  `claim_mailbox_send`'s SQL. The `/settings` page's own warmup controls
  beyond the shared pure-function change (they keep working, same behavior).
  `webmcp-app.ts`'s `MailboxHealthEntry` projection — additive columns don't
  break its explicit field list, and it's not part of this ask.

## Data model — migration `0024`

```sql
alter table mailboxes add column warmup_start_cap  integer not null default 5;
alter table mailboxes add column warmup_increment  integer not null default 3;
alter table mailboxes add column warmup_target_cap integer;
update mailboxes set warmup_target_cap = daily_cap where warmup_target_cap is null;
alter table mailboxes alter column warmup_target_cap set not null;
```

Backfilling `warmup_target_cap` from the existing `daily_cap` and defaulting
`warmup_start_cap`/`warmup_increment` to today's constants (5/3) means every
existing mailbox computes the exact same `effectiveDailyCap` the day this
ships as it did the day before — nothing changes until an operator edits a
field on the new tab.

No new column for the already-warm cap: `daily_cap` already serves that role
today (`effectiveDailyCap` returns it unchanged when `profile === 'none'`) —
this design keeps that meaning and simply exposes it as an editable field on
the new tab, and as the value the ramp lands on once it completes (see
below), rather than adding a redundant column.

`MailboxRow`/`MailboxInsert` in `src/types/database.ts` gain the three new
columns; `MailboxSummary` in `src/lib/db/mailboxes.ts:265-271` picks up
`warmup_start_cap`, `warmup_increment`, `warmup_target_cap` alongside the
existing warmup fields, since `mailbox-row.tsx` needs them for the status
label (below).

## Ramp calculation — `src/lib/mailbox/warmup.ts`

`WARMUP_START_CAP` and `WARMUP_INCREMENT` are deleted as module constants.
`EffectiveCapInput` gains `startCap: number` and `increment: number`; a new
`targetCap: number` field replaces the implicit assumption that `dailyCap` is
the ceiling during ramp:

```ts
export interface EffectiveCapInput {
  profile: WarmupProfile
  warmupStartedAt: string | null
  startCap: number
  increment: number
  targetCap: number
  dailyCap: number
  now: Date
}

export function effectiveDailyCap({
  profile, warmupStartedAt, startCap, increment, targetCap, dailyCap, now,
}: EffectiveCapInput): number {
  const stepDays = WARMUP_STEP_DAYS[profile]
  if (stepDays === 0 || warmupStartedAt === null) return dailyCap

  const startedAt = Date.parse(warmupStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox warmup_started_at is not a valid timestamp', { warmupStartedAt })
  }

  const elapsedDays = Math.floor((now.getTime() - startedAt) / MS_PER_DAY)
  const steps = Math.max(0, Math.floor(elapsedDays / stepDays))
  const rampValue = startCap + increment * steps
  return rampValue >= targetCap ? dailyCap : rampValue
}
```

Once `rampValue >= targetCap`, the function returns `dailyCap` (the
already-warm cap) on every subsequent call — no write, no state to go stale.
Raising `targetCap` later simply makes `rampValue >= targetCap` false again on
the next call, so ramping resumes with no special-case code.

A new derived status helper for display, colocated in the same file:

```ts
export type WarmthStatus =
  | { kind: 'not_ramping' }                                  // profile === 'none'
  | { kind: 'ramping'; currentCap: number; dayNumber: number } // dayNumber = elapsedDays + 1
  | { kind: 'ramp_complete' }                                  // rampValue reached targetCap

export function getMailboxWarmthStatus(input: EffectiveCapInput): WarmthStatus
```

`mailbox-row.tsx:71` (`const isRamping = capToday < props.dailyCap`) is
replaced with `getMailboxWarmthStatus(...)`, so the "warming up (cap N)" label
and the new tab's status badge share one source of truth instead of each
re-deriving "is this mailbox still ramping" its own way. Both `'not_ramping'`
and `'ramp_complete'` render as "Already warm" — the operator sees the same
label whether the mailbox was set to `none` directly or got there by
finishing its ramp; the underlying `warmup_profile` column keeps its raw
value (`'standard'`/`'slow'`) in the latter case, since nothing needs to be
written for the status to compute correctly next time.

`warmupInsertFields` is unchanged — it still only sets `warmup_profile` and
`warmup_started_at`, and is only called when the profile itself changes.

## API layer

Extend the existing `POST` handler `src/app/api/mailboxes/[id]/warmup/route.ts`
rather than adding a parallel Server Action: it's already the one
operator-gated endpoint that mutates warmup config, and the new tab is
operator-only exactly like its current caller (`mailbox-controls.tsx`).

```ts
const bodySchema = z.object({
  profile: z.enum(['standard', 'slow', 'none']).optional(),
  warmupStartCap: z.number().int().positive().optional(),
  warmupIncrement: z.number().int().positive().optional(),
  warmupTargetCap: z.number().int().positive().optional(),
  dailyCap: z.number().int().positive().optional(),
})
```

All fields optional — a partial update. `warmup_started_at` is only reset
(via `warmupInsertFields`) when `profile` is present in the payload **and**
differs from the mailbox's current stored profile; a request that only
changes the numeric fields never touches the clock. The route logs
`mailbox.warmup_changed` (existing event type) with whichever fields were
actually present in the payload, `from`/`to` per field that changed.

`updateMailboxWarmup` in `src/lib/db/mailboxes.ts:141-150` takes a broader
partial-update type:

```ts
export async function updateMailboxWarmup(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: Partial<{
    warmup_profile: WarmupProfile
    warmup_started_at: string | null
    warmup_start_cap: number
    warmup_increment: number
    warmup_target_cap: number
    daily_cap: number
  }>,
): Promise<void>
```

## Warmup tab — `src/app/(app)/clients/[id]/`

- `page.tsx:43` — `tabSchema` gains `'warmup'`.
- `page.tsx:174-208` — new `TabsTrigger value="warmup"` (a gear/thermometer
  icon in the same `@phosphor-icons/react` set as the others), positioned
  after Campaigns since it's the next most operationally relevant tab; count
  badge shows the client's mailbox count.
- New Server Component `warmup-tab.tsx`: calls
  `listMailboxesForClient(admin, clientId)` (`lib/db/mailboxes.ts:214-221`,
  currently unused anywhere — this tab becomes its first caller) and renders
  one row per mailbox, reusing `EmptyState` when the client has none.
- New Client Component `warmup-mailbox-row.tsx` (per-mailbox row, following
  the `useTransition` + `fetch` pattern already established in
  `mailbox-controls.tsx`): the existing profile `<select>` (verbatim
  `WARMUP_LABEL` copy), plus four numeric `<input type="number" min={1}>`
  fields — start cap, increment, target cap, already-warm daily cap — each
  saved independently on blur (matching the "each control posts its own
  change" pattern already used for the profile select and pause/resume
  buttons, rather than one big form with a single submit). Read-only info
  alongside: `sentToday/effectiveCap today`, and the status badge from
  `getMailboxWarmthStatus` (`"Day N of ramp"` / `"Already warm"`).
- `MailboxRow`/`MailboxSummary` callers of `effectiveDailyCap` and the new
  status helper (`mailbox-row.tsx`, and this new tab) now pass
  `startCap`/`increment`/`targetCap` from the mailbox row instead of the
  deleted global constants.

## Testing

Per `.claude/QUALITY.md`: 100% on the pure functions, 80%+ on the DB layer.

- `warmup.test.ts` (extends the existing suite):
  - ramp value below target returns the ramp value, not `dailyCap`;
  - ramp value exactly at target returns `dailyCap` (boundary, `>=` not `>`);
  - ramp value past target (mailbox checked long after completing) returns
    `dailyCap`;
  - raising `targetCap` after completion resumes ramping (next call with a
    higher target returns a ramp value again, not `dailyCap`);
  - `profile === 'none'` still returns `dailyCap` regardless of the other new
    fields;
  - two mailboxes with different `startCap`/`increment` on the same elapsed
    time produce different ramp values (proves per-mailbox, not global);
  - `getMailboxWarmthStatus` returns each of the three variants at the
    matching boundary, including the `dayNumber` computation.
- Route handler test (`route.test.ts`): auth rejection unchanged; a
  numeric-only payload does not reset `warmup_started_at`; a payload that
  changes `profile` does reset it; a payload that repeats the *same* profile
  value does not reset it; validation rejects zero/negative/non-integer
  values for any of the four numeric fields.
- `updateMailboxWarmup` — existing DB-layer test extended for the new
  optional fields (partial update only touches provided columns).
- Manual verification in-browser (per `run` skill): open a client's Warmup
  tab, confirm every connected mailbox is listed; edit start cap on a ramping
  mailbox and confirm the displayed "day N" cap changes without resetting the
  ramp start date; lower a mailbox's target cap below its current ramp value
  and confirm it immediately shows "Already warm"; edit the already-warm
  daily cap on a mailbox that finished ramping and confirm `sentToday/cap`
  reflects the new number on the next render.

## Explicitly out of scope

- Any change to the Mailreach vendor-warmup system or its columns/UI.
- A cron/scheduled job for the ramp-to-warm transition — deliberately fully
  derived, per the recommended approach.
- Client-level defaults for the four new numeric fields — only the existing
  client-level `warmup_profile` default (for newly-connected mailboxes)
  remains.
- Any change to `claim_mailbox_send`'s SQL or the `least(daily_cap, ...)`
  atomic-claim guard.
- Bulk-editing warmup settings across multiple mailboxes at once.
