# Configurable Follow-up Cadence — Design

**Status:** Approved design
**Date:** 2026-08-05
**Scope:** Let a client choose how many follow-up nudges go out after a first-touch email and how many days apart they are — a client-wide default on `/settings`, and a per-contact override on the case page.

---

## 1. Problem

Today `src/lib/pipeline/followup.ts` hardcodes the entire follow-up cadence as two module constants:

```ts
export const FOLLOWUP_DELAYS_SECONDS: readonly number[] = [3 * DAY_SECONDS, 7 * DAY_SECONDS, 14 * DAY_SECONDS]
export const MAX_FOLLOWUP_STEP = 3
```

Every client, every campaign, every contact gets exactly three follow-ups at 3/7/14 days, with no way to see or change that. Clients have asked for control over both numbers: how many follow-ups, and how many days apart.

## 2. Scope

- A client-wide default cadence, edited on `/settings` (mirrors the existing `reply_mode` client setting) — defaults to 3/7/14 days (i.e. `{3,7,14}`).
- A per-contact (`leads` row / that lead's `sequences` row) override, edited on the case page (`/cases/[id]`) contacts list, next to the existing `StopLeadButton`.
- The array *is* both numbers at once: its length is the follow-up count, each element is the day-gap before that step fires. No separate "count" field.
- Bounds: 1–10 steps, each 1–90 days — enforced by one shared Zod schema used by both the Settings form and the per-lead form.
- Out of scope: campaign-level cadence (rejected during design in favor of client-wide + per-lead, matching the `reply_mode` precedent); retroactively rescheduling a QStash message that is already queued (its delay is fixed at publish time — see §5); changing `collision-notify.ts`'s unrelated notice cadence.

## 3. Data model

Migration `supabase/migrations/0028_configurable_followup_cadence.sql`:

```sql
alter table clients add column followup_delays_days integer[] not null default '{3,7,14}';
alter table sequences add column followup_delays_days integer[] not null default '{3,7,14}';
```

- `clients.followup_delays_days` — the account-wide default. Read once, at sequence-creation time, by `scheduleFirstFollowup`; otherwise only ever read/written by the Settings form.
- `sequences.followup_delays_days` — snapshotted from the client's default the moment a sequence is created, and the sole source of truth `runFollowupStep` reads from for the rest of that sequence's life. A later change to the client default never reaches back into an already-running sequence — only new sequences pick it up. A per-lead override is simply an update to this column on that one row; there is no separate "is this overridden" flag, since the row always holds the effective cadence for that lead, whatever its origin.
- Both columns default to `{3,7,14}` so every existing row keeps sending on exactly the schedule it does today — nothing changes until a client edits something.

Regenerate `src/types/database.ts` after the migration so `ClientRow['followup_delays_days']` and `SequenceRow['followup_delays_days']` are typed as `number[]`.

## 4. Shared validation

New `src/lib/validation/followup-limits.ts`, following the pattern of `email-limits.ts`:

```ts
// Shared between the client-default Settings form and the per-lead override
// form on the case page, so the two never validate against different bounds.
export const MIN_FOLLOWUP_STEPS = 1
export const MAX_FOLLOWUP_STEPS = 10
export const MIN_FOLLOWUP_DELAY_DAYS = 1
export const MAX_FOLLOWUP_DELAY_DAYS = 90

export const followupDelaysSchema = z
  .array(z.number().int().min(MIN_FOLLOWUP_DELAY_DAYS).max(MAX_FOLLOWUP_DELAY_DAYS))
  .min(MIN_FOLLOWUP_STEPS)
  .max(MAX_FOLLOWUP_STEPS)
```

No ascending-order constraint — each element is an independent step-to-step gap (not a cumulative offset from first touch), so e.g. `{7,3,14}` is a legal (if unusual) cadence.

## 5. Pipeline changes — `src/lib/pipeline/followup.ts`

- `FOLLOWUP_DELAYS_SECONDS` and `MAX_FOLLOWUP_STEP` are deleted as module constants.
- `scheduleFirstFollowup` gains a `getClientById` lookup, writes `client.followup_delays_days` onto the new `sequences` row via `createSequence`, and uses `delays[0]` for the first `publishJsonWithDelay` call (in place of `FOLLOWUP_DELAYS_SECONDS[0]`).
- `runFollowupStep` computes `const maxStep = sequence.followup_delays_days.length` immediately after loading the sequence, and uses `sequence.followup_delays_days[input.step - 1]` / `[input.step]` (converted to seconds via `* DAY_SECONDS`) everywhere the code currently indexes the deleted constant.
- **New guard**, placed alongside the existing stale-delivery check at the top of the function: if `input.step > maxStep`, return `{ action: 'skipped' }` without sending. This is what makes shrinking an active sequence's array safe — if a client edits a running 3-step sequence down to 1 step while step 3 is already sitting in QStash with a fixed delay, that step silently no-ops instead of sending an unwanted extra nudge.
- Growing the array (e.g. 3 → 5 mid-flight) needs no special-case code: the existing "final step" check (`input.step >= maxStep`) naturally keeps going once `maxStep` is re-read as larger on the next run, since the sequence row is re-fetched fresh every invocation.
- A cadence edit never changes the delay of a message *already* published to QStash — only the delay computed for the *next* step after the edit. Both the Settings and per-lead UI copy should say so plainly, so no one expects an in-flight wait to jump.
- **Targeted fix, needed for §8's "next in Nd" status line:** every `advanceSequence` call in this file currently passes `nextActionAt: null` — `sequences.next_action_at` is written but never actually populated with a real timestamp on any live run (only `src/lib/seed/generate.ts` fakes one, for demo data). Each of the four call sites that schedules a future step already knows the delay it just gave `publishJsonWithDelay`, so each now passes `nextActionAt: new Date(Date.now() + delaySeconds * 1000).toISOString()` instead of `null`. The three call sites that don't schedule anything (final-step exhaustion, terminal skip) keep passing `null`, which is already correct there.
- `src/app/api/pipeline/followup/route.ts`'s `z.number().int().min(1).max(MAX_FOLLOWUP_STEP)` becomes `.max(MAX_FOLLOWUP_STEPS)` (the new shared hard ceiling, `followup-limits.ts`) — a sanity bound on the webhook payload, not the authoritative last-step check, which now lives inside `runFollowupStep` against that sequence's own array.
- `collision-notify.ts`'s comment referencing `0..MAX_FOLLOWUP_STEP` is updated to describe the per-sequence array instead; no behavioral change there.

## 6. Data layer

`src/lib/db/clients.ts` — new function, same shape as `updateClientReplyMode`:

```ts
export async function updateClientFollowupDelays(
  supabase: SupabaseClient<Database>,
  id: string,
  delaysDays: number[],
): Promise<ClientRow>
```

`src/lib/db/sequences.ts` — new function to persist a per-lead override:

```ts
// Overwrites the effective cadence for one lead's sequence. Guarded to
// active/paused sequences only — editing a stopped/completed sequence has
// nothing left to reschedule.
export async function updateSequenceFollowupDelays(
  supabase: SupabaseClient<Database>,
  leadId: string,
  delaysDays: number[],
): Promise<SequenceRow | null>
```

Both destructure `{ data, error }`, map errors to `AppError('DB_ERROR', ...)`, matching every other function in these files.

## 7. UI — client-wide default (`/settings`)

New `followup-cadence-section.tsx` + `followup-cadence-actions.ts`, placed next to `reply-mode-section.tsx` / `reply-mode-actions.ts` and following the same shape exactly:

- Renders the current array as one row per step ("Follow-up 1: **[3]** days later", "Follow-up 2: **[7]** days later", …), each a numeric input bounded client-side by `MIN/MAX_FOLLOWUP_DELAY_DAYS`.
- "Add follow-up" appends a row (disabled at `MAX_FOLLOWUP_STEPS`); a remove control on each row deletes it (disabled at `MIN_FOLLOWUP_STEPS`, i.e. the last remaining row can't be removed).
- Save-on-change per edit, no confirm dialog — matching `reply_mode`.
- One line of copy: *"Applies to new contacts going forward — an already-running follow-up sequence for a contact keeps its cadence unless you edit that contact directly."*
- Restricted to `appUser.role === 'client'`, same `AppError('FORBIDDEN', ...)` shape as `updateReplyMode`.
- Deliberately **does not** bulk-sync onto existing `sequences` rows — unlike `reply_mode`'s bulk sync onto `campaigns`. A client changing their default should not silently reschedule every in-flight contact's cadence; the per-lead override (§8) is the explicit tool for fixing one that's already running.

## 8. UI — per-lead override (`/cases/[id]`)

The contacts list (`page.tsx`, the `<ul aria-label="Contacts">` block) currently shows no sequence information. This adds, next to the existing `StopLeadButton` for each contact with an `active`/`paused` sequence:

- A status line: `Follow-up {current_step} of {followup_delays_days.length} · next in {n}d`, where `{n}` is `Math.ceil((next_action_at - now) / DAY_MS)` (now populated for real — see §5). If `current_step` has already reached `followup_delays_days.length` (the sequence is mid-processing its terminal step) or `next_action_at` is null for any other reason, the line reads `Follow-up {current_step} of {total}` with no "next in" clause rather than a wrong or empty number. Plus a small edit (pencil) affordance.
- Clicking edit opens the same day-array editor component used in Settings (extracted as a shared client component, e.g. `followup-delays-editor.tsx`, parameterized by its save action), prefilled with that contact's current `sequences.followup_delays_days`.
- No status/edit control for a lead with no sequence yet, or one that's `stopped`/`completed` — nothing to edit.
- Available to both `client` and `operator` roles — no role gate, matching `StopLeadButton`'s current behavior.
- Saving calls `updateSequenceFollowupDelays` (§6) for that lead's sequence only; other contacts on the same case, and every other case, are untouched.

## 9. Edge cases

- **Shrinking below the current step** (e.g. current_step=2, array edited down to length 1): the already-enqueued next QStash step still fires on its old timer, but `runFollowupStep`'s new `input.step > maxStep` guard (§5) turns it into a no-op skip rather than an unwanted send — no eager cancellation of the queued message is needed or attempted.
- **Growing the array**: handled automatically by re-reading the sequence row fresh on each run (§5) — no special code path.
- **Editing a paused sequence** (lead replied, or campaign paused): allowed — the new cadence takes effect whenever the sequence next resumes/fires.
- **Editing a stopped/completed sequence**: not offered in the UI (§8); `updateSequenceFollowupDelays`'s guard returns `null` defensively if attempted anyway (e.g. a stale tab), same "already gone" shape as `updateDraftContent`.
- **Concurrent edit + step firing**: no special locking needed — `runFollowupStep` already re-fetches the sequence row at the start of each invocation, so whichever value is persisted at that moment is what's used; there's no window where a stale in-memory array gets used.

---

## Files touched

- `supabase/migrations/0028_configurable_followup_cadence.sql` (new)
- `src/types/database.ts` (regenerated)
- `src/lib/validation/followup-limits.ts` (new)
- `src/lib/db/clients.ts` (add `updateClientFollowupDelays`)
- `src/lib/db/sequences.ts` (add `updateSequenceFollowupDelays`)
- `src/lib/pipeline/followup.ts` (remove constants, thread `sequence.followup_delays_days` through)
- `src/app/api/pipeline/followup/route.ts` (bound update)
- `src/lib/pipeline/collision-notify.ts` (comment only)
- `src/app/(app)/settings/followup-cadence-section.tsx`, `followup-cadence-actions.ts` (new)
- `src/app/(app)/settings/page.tsx` (wire in the new section)
- `src/app/(app)/cases/[id]/followup-delays-editor.tsx` (new, shared with Settings)
- `src/app/(app)/cases/[id]/page.tsx` (fetch each lead's sequence summary, render status + edit control)
- Corresponding `.test.ts` files for every DB/pipeline function above.
