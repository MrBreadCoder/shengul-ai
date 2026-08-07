# Per-client/per-campaign discovery scheduling + timezone

**Date:** 2026-08-07
**Status:** Approved, ready for implementation plan

## Problem

Every stage of the outbound pipeline currently runs on one fixed global QStash
cron, in UTC, identical for every client and every campaign:

| Stage | Cron | UTC |
|---|---|---|
| Discovery (`discover-fanout`) | `0 6 * * *` | 06:00 |
| Research (`research-fanout`) | `0 7 * * *` | 07:00 |
| Write & send (`write-fanout`) | `0 8 * * *` | 08:00 |

There is no way for an operator to run a client's campaigns at a time that
matches that client's business hours, no way to stagger two campaigns for the
same client, and the 1-hour gaps between stages are much wider than they need
to be.

`research-fanout` and `write-fanout` are already campaign-agnostic — they pull
every case in the whole system by status (`new` → research, `ready` → write),
not scoped to a campaign or client. Only `discover-fanout` is genuinely
per-campaign (`listActiveCampaigns`, one discover job published per campaign).

## Scope

In scope:
- A `timezone` + default discovery run time on each **client**, editable by
  the client on `/settings`.
- An optional per-**campaign** override of both run time and timezone,
  editable by the operator on create + edit.
- Discovery becomes a real per-campaign scheduled event, computed from the
  effective (override-or-inherited) time + timezone.
- Research and write move from once-daily to a 5-minute poll, system-wide —
  no per-campaign scheduling logic needed for them (see Architecture).
- DST-correct recompute of each campaign's next discovery run.

Out of scope (explicitly deferred):
- Mailbox reset, inbound poll, stuck-sweep, mailbox health, MailReach sync,
  log retention crons — stay global and untouched.
- Per-campaign override of research/write cadence — both remain global
  5-minute pollers for every campaign.
- Surfacing the computed next-run time in the campaign list/card UI —
  backend scheduling only for this feature; addable later without a schema
  change.

## Data model

New migration `supabase/migrations/0032_campaign_scheduling.sql`:

```sql
alter table clients
  add column timezone text not null default 'UTC',
  add column default_discover_time text not null default '06:00';

alter table campaigns
  add column discover_time text,
  add column discover_timezone text,
  add column next_discover_at timestamptz not null default now();

create index idx_campaigns_next_discover_at
  on campaigns(next_discover_at) where status = 'active';

-- Backfill existing active campaigns to today's actual default (06:00 UTC),
-- computed from each client's now-defaulted 'UTC' + '06:00' — preserves
-- current behavior for every existing client/campaign.
```

The backfill of `next_discover_at` for pre-existing rows runs as a one-off
data migration step in the same file, using the SQL equivalent of "next
occurrence of 06:00 UTC from now" (today 06:00 UTC if still in the future,
else tomorrow 06:00 UTC) — not a call into application code.

`discover_time`/`discover_timezone` are `null`-able overrides: `null` means
"inherit the client's value." Effective schedule for a campaign:

```
effectiveTime = campaign.discover_time ?? client.default_discover_time
effectiveTz   = campaign.discover_timezone ?? client.timezone
```

`next_discover_at` is a precomputed UTC instant so the scheduler tick can
filter with a plain indexed `<= now()` comparison instead of doing timezone
math for every active campaign on every tick.

## Architecture

### Scheduling math

New file `src/lib/scheduling/next-run.ts`:

```ts
export function computeNextRunAt(fromUtc: Date, timeOfDay: string, timezone: string): Date
```

Pure function, no I/O. Uses `Intl.DateTimeFormat` (already available, no new
dependency) to read the target zone's offset for a given calendar date,
builds the candidate UTC instant for `HH:mm` on "today" in that zone, and if
that candidate is `<= fromUtc`, advances one calendar day *in that timezone*
and recomputes the offset from scratch — so a DST transition shifts the wall
clock correctly instead of the instant silently drifting by an hour twice a
year. Throws `AppError('VALIDATION_ERROR', ...)` for a `timeOfDay` that
doesn't match `HH:mm` (00–23 / 00–59) or a `timezone` that
`Intl.DateTimeFormat` rejects — callers are expected to validate with the Zod
schemas below before this ever runs, so this is a defensive invariant check,
not a user-facing validation path.

### Validation

New file `src/lib/validation/schedule.ts`:

```ts
export const timeOfDaySchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/)
export const isValidTimezone = (tz: string): boolean => { /* try/catch Intl.DateTimeFormat */ }
export const timezoneSchema = z.string().refine(isValidTimezone, 'Invalid IANA timezone')
```

### Discovery: scheduler tick

`discover-fanout`'s route body changes from "fire every active campaign" to
"fire every active campaign that's due":

- `listActiveCampaigns` in `src/lib/db/campaigns.ts` is replaced by
  `listCampaignsDueForDiscovery(supabase, nowIso: string): Promise<CampaignRow[]>`
  — `.eq('status', 'active').lte('next_discover_at', nowIso)`. (`listActiveCampaigns`
  has no other caller after this change, so it — and its test block — are
  removed rather than left as dead code.)
- For each due campaign the route now also computes and writes its next
  occurrence before moving on: `updateCampaignNextDiscoverAt(supabase, campaignId, computeNextRunAt(now, effectiveTime, effectiveTz))`.
  Publish-then-advance, not advance-then-publish, so a publish failure
  (already isolated per-campaign, existing `failedCampaignIds` pattern) still
  leaves the campaign due and it gets retried on the very next tick 5 minutes
  later rather than waiting a full day.
- Cron cadence: `scripts/schedule-discover-cron.ts` default changes from
  `'0 6 * * *'` to `'*/5 * * * *'`.

### Research & write: faster polling, no other change

`research-fanout` and `write-fanout` route code is untouched. Only their
registered QStash cron cadence changes, in `scripts/schedule-research-cron.ts`
and `scripts/schedule-write-cron.ts`, from `'0 7 * * *'` / `'0 8 * * *'` to
`'*/5 * * * *'`. Because they already scan by case status system-wide, a case
that just went `new` from a discovery run gets picked up on the next tick —
≤5 minutes later — regardless of which campaign or client it belongs to or
how long that campaign's discovery run took. This removes the
discovery-duration race a fixed `+5min` offset would have created (a
discovery run taking longer than 5 minutes would strand its later cases until
the next day under a rigid offset; the poller has no such window).

Since these scripts only register QStash schedules once per environment
(per their own header comments), the existing `0 7 * * *` / `0 8 * * *` /
`0 6 * * *` schedules must be deleted and recreated against the live QStash
account as a deploy step — noted in Rollout below, not a code change.

### DB layer

`src/lib/db/clients.ts`:
- `updateClientSchedule(supabase, id, { timezone, defaultDiscoverTime }): Promise<ClientRow>`
  — one `.update(...).eq('id', id).select('*').single()`, same shape as
  `updateClientFollowupDelays`.
- `recomputeClientCampaignSchedules(supabase, clientId): Promise<void>` —
  lists the client's campaigns (`listCampaignsForClient`), filters to
  `status === 'active' && discover_time === null && discover_timezone === null`
  (the ones actually inheriting the client default), and for each calls the
  same compute-and-write path as below. Called after `updateClientSchedule`
  succeeds, so a client changing their timezone reschedules every campaign
  that hasn't overridden it — a campaign with its own override is
  deliberately left alone.

`src/lib/db/campaigns.ts`:
- `listCampaignsDueForDiscovery` (replaces `listActiveCampaigns`, see above).
- `updateCampaignNextDiscoverAt(supabase, id, nextDiscoverAt: Date): Promise<CampaignRow>`
  — single-column update, used by the scheduler tick.
- `recomputeCampaignNextDiscoverAt(supabase, campaignId): Promise<CampaignRow>`
  — fetches the campaign and its client, computes the effective time/tz,
  calls `computeNextRunAt(new Date(), ...)`, writes it. Used by: campaign
  edit (override changed), campaign resume (see below), and
  `recomputeClientCampaignSchedules`'s per-campaign step.
- `updateCampaignSettings` gains `discover_time`/`discover_timezone` in its
  patch type (both `string | null`).

### Campaign create/edit routes

- `POST /api/campaigns`: `campaignSettingsSchema` gains optional
  `discoverTime: timeOfDaySchema.nullable().default(null)` and
  `discoverTimezone: timezoneSchema.nullable().default(null)`. The route
  already loads the client (for `reply_mode` inheritance) — reuses that same
  `client` row to compute `effectiveTime`/`effectiveTz` and passes
  `next_discover_at: computeNextRunAt(new Date(), effectiveTime, effectiveTz)`
  into `insertCampaign`, so the row is born with a correct value instead of a
  placeholder needing a follow-up write.
- `PATCH /api/campaigns/[campaignId]`: same schema fields accepted; after
  `updateCampaignSettings` writes `discover_time`/`discover_timezone`, the
  route calls `recomputeCampaignNextDiscoverAt` (a fresh read + compute,
  rather than trying to diff old vs. new inline) so `next_discover_at` is
  always consistent with whatever was just saved, including the case where
  an override was cleared back to `null` (reverts to inheriting the client's
  current default).
- `POST /api/campaigns/[campaignId]/resume`: after `updateCampaignStatus(...,
  'active')`, calls `recomputeCampaignNextDiscoverAt` — a campaign paused for
  a week and resumed today gets its next run computed from *now*, not from
  whatever stale value was left over from before it was paused (which could
  be in the past, causing an immediate unwanted fire on the next tick).

### Settings UI

`/settings` (client-facing), new section `schedule-section.tsx` +
`schedule-actions.ts`, following the exact pattern of
`followup-cadence-section.tsx` / `followup-cadence-actions.ts`:
- Timezone `<select>`, options from `Intl.supportedValuesOf('timeZone')`.
- Default discovery time `<input type="time">`.
- Server Action `updateSchedule(formData)`: `requireUser()`,
  `appUser.role !== 'client' → AppError('FORBIDDEN', ...)` (matches
  `updateFollowupCadence`'s guard shape), validates with
  `timezoneSchema`/`timeOfDaySchema`, calls `updateClientSchedule` then
  `recomputeClientCampaignSchedules`, logs `client.schedule_changed`
  (best-effort), `revalidatePath('/settings')`.

`campaign-settings-fields.tsx` (shared by new + edit forms), new fieldset
after the ICP section:
- "Run time" (`<input type="time">`, optional) and "Timezone" (`<select>`,
  optional, includes an explicit "Inherit from client" empty option) —
  hint text shows the client's current effective default so the operator
  knows what "inherit" resolves to right now.
- `campaign-form-utils.ts`-style parsing: empty string → `null` in the
  JSON body (not the resolved value) — an operator clearing the override
  is choosing to inherit, not pinning today's inherited value forever.
- Both `new-campaign-form.tsx` and the edit form need this — run time is an
  ordinary editable setting, not a creation-only choice.

## Data flow

**Client changes timezone/default time:** `/settings` form submit →
`updateSchedule` action → `updateClientSchedule` writes the client row →
`recomputeClientCampaignSchedules` walks that client's non-overridden active
campaigns and recomputes each `next_discover_at` → `revalidatePath`.
Overridden campaigns are untouched.

**Operator sets a campaign override:** create/edit form submit → route
validates → effective time/tz resolved (override ?? client default) →
`computeNextRunAt` → row written with the new `next_discover_at` in the same
request that saves the override.

**Scheduler tick (every 5 min):** QStash → `discover-fanout` →
`listCampaignsDueForDiscovery(now)` → for each: publish `discover` job (best
effort, isolated failures) → compute and write tomorrow's `next_discover_at`
→ `pipeline.discover_fanout.completed` event, same as today.

**Research/write tick (every 5 min):** unchanged code, just ticks more often
— picks up whatever's `new`/`ready` across every client/campaign, same
`FANOUT_LIMIT = 200` cap as today.

**Resume:** `POST .../resume` → status → `active` →
`recomputeCampaignNextDiscoverAt` computes fresh from now, so a long-paused
campaign doesn't fire on the very next tick from a stale scheduled time.

## Error handling

- `computeNextRunAt` throws `AppError('VALIDATION_ERROR', ...)` on malformed
  input — an invariant violation, since both call sites (routes, actions)
  validate with the Zod schemas first.
- `timeOfDaySchema`/`timezoneSchema` failures surface exactly like existing
  campaign-settings validation failures: `400 { error: 'validation_error',
  issues }` from the JSON routes, thrown `AppError('VALIDATION_ERROR', ...)`
  from the Server Action (matches `updateFollowupCadence`).
- `updateClientSchedule` / `updateCampaignNextDiscoverAt` /
  `recomputeCampaignNextDiscoverAt` map Supabase errors to
  `AppError('DB_ERROR', ...)`, same as every other function in
  `lib/db/clients.ts` and `lib/db/campaigns.ts`.
- A per-campaign publish failure in the scheduler tick is isolated exactly
  like today (`failedCampaignIds`) — one bad QStash publish doesn't block the
  rest of the due campaigns, and since `next_discover_at` is only advanced
  *after* a successful publish, a failed campaign stays due and retries on
  the next 5-minute tick instead of waiting a full day.
- `recomputeClientCampaignSchedules` is best-effort per campaign (matches the
  existing `removeMailboxFromCampaigns` per-row-loop convention) — one
  campaign's recompute failing doesn't block the others or fail the whole
  settings save.

## Testing

- `src/lib/scheduling/next-run.test.ts` (100% coverage, pure function):
  same-day not-yet-due, same-day already-past (rolls to tomorrow), a
  spring-forward date and a fall-back date for a DST-observing zone (e.g.
  `America/New_York`), a non-DST zone (e.g. `UTC` or `Asia/Tokyo`) as a
  control, invalid `HH:mm`, invalid IANA timezone.
- `src/lib/validation/schedule.test.ts`: valid/invalid time-of-day strings
  (boundary values `00:00`, `23:59`, `24:00` rejected, `9:00` rejected —
  requires zero-padding), valid/invalid timezone strings.
- `src/lib/db/campaigns.test.ts`: `listCampaignsDueForDiscovery` (due vs.
  not-due vs. paused, filtered correctly), `updateCampaignNextDiscoverAt`,
  `recomputeCampaignNextDiscoverAt` (mocked client+campaign fetch),
  `updateCampaignSettings` with the two new fields. Remove the now-dead
  `listActiveCampaigns` describe block.
- `src/lib/db/clients.test.ts`: `updateClientSchedule`,
  `recomputeClientCampaignSchedules` (only non-overridden active campaigns
  touched; overridden and paused campaigns left alone).
- `src/app/api/pipeline/discover-fanout/route.test.ts`: only due campaigns
  published; `next_discover_at` advances correctly (including across a DST
  boundary date, via a mocked "now"); a publish failure leaves that
  campaign's `next_discover_at` unchanged.
- `src/app/api/campaigns/route.test.ts` / `.../[campaignId]/route.test.ts`:
  create/edit with an override, create/edit inheriting (fields omitted or
  explicitly `null`), invalid time/timezone → 400.
- `src/app/(app)/settings/schedule-actions.test.ts`: auth rejection
  (non-client role), validation rejection, success path asserting both
  `updateClientSchedule` and `recomputeClientCampaignSchedules` were called.

## i18n

New keys in both `src/messages/en.json` and `src/messages/tr.json`:
- `settings` namespace: a `schedule` group — section title, timezone label,
  default time label, save button, success/error toast text (mirrors
  `followupCadence`'s existing key shape).
- `campaigns` namespace, under `newCampaignForm`: `discoverTimeLabel`,
  `discoverTimeHint` ("Inherits {clientDefault} if left blank"),
  `discoverTimezoneLabel`, `discoverTimezoneHint`, plus
  `discoverTimezoneInheritOption` for the explicit "Inherit from client"
  select option.

## Rollout

1. Ship migration `0032_campaign_scheduling.sql` (additive, backward
   compatible — every existing client defaults to `UTC` / `06:00`, matching
   current behavior exactly).
2. Deploy code (scheduler tick change is gated by `next_discover_at`, which
   the migration backfills, so this is safe to deploy before step 3).
3. Re-register QStash cron schedules: delete + recreate the `discover-fanout`,
   `research-fanout`, `write-fanout` schedules at their new `*/5 * * * *`
   cadence (via the updated `scripts/schedule-*-cron.ts`, run once per
   environment as today).
4. Existing clients/campaigns continue running at 06:00/07:00/08:00 UTC
   effectively (first discovery tick that's `>= 06:00 UTC` fires them, same
   wall-clock outcome as before) until an operator or client explicitly
   changes a schedule.
