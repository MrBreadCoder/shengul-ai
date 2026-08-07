# Per-client/per-campaign discovery scheduling + timezone Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single global 06:00/07:00/08:00 UTC discover/research/write crons with a per-client (with per-campaign override) discovery schedule and timezone, and a 5-minute poll cadence for every pipeline stage.

**Architecture:** Only discovery becomes a real scheduled-per-campaign event, driven by a `next_discover_at` column the scheduler tick (`discover-fanout`, now polling every 5 min) filters on. Research and write need zero logic changes — they already scan globally by case status — only their QStash cron cadence changes to `*/5 * * * *`. A new pure `computeNextRunAt` utility (Intl-based, no new dependency) handles DST-correct timezone math.

**Tech Stack:** Next.js Route Handlers, Supabase/Postgres, Zod, QStash (`@upstash/qstash`), Vitest, next-intl.

## Global Constraints

- `strict: true` TypeScript, no `any`, no unexplained `!` — see `.claude/QUALITY.md`.
- Zod validates every external input (route bodies, Server Action FormData).
- DB columns are `snake_case`; TypeScript fields are `camelCase` — map explicitly, never assume they match.
- Every DB function maps Supabase errors to `AppError('DB_ERROR', ...)`; never let a raw Supabase error escape `lib/db/`.
- Every Server Action logs a structured event (`logEvent`) and calls `revalidatePath`, matching existing `settings` actions.
- `src/types/database.ts` is **hand-authored** (no live Postgres available to run `supabase gen types`) — every migration must be mirrored there by hand in the same task.
- No `console.log` anywhere. No commented-out code. Named exports only (except Next.js pages).
- New i18n keys go in **both** `src/messages/en.json` and `src/messages/tr.json` — untranslated English left in `tr.json` is not acceptable.
- Colocated tests: `feature.test.ts` next to `feature.ts`, Vitest, Arrange-Act-Assert, mocked Supabase/QStash — never hit real external services.

---

## File Structure

New files:
- `supabase/migrations/0032_campaign_scheduling.sql` — schema.
- `src/lib/validation/schedule.ts` (+ `.test.ts`) — `timeOfDaySchema`, `timezoneSchema`, `isValidTimezone`.
- `src/lib/scheduling/next-run.ts` (+ `.test.ts`) — `computeNextRunAt`, the DST-aware pure scheduling function.
- `src/app/api/pipeline/discover-fanout/route.test.ts` — new (route previously had no test file).
- `src/app/(app)/settings/schedule-actions.ts` (+ `.test.ts`) — client-owned Server Action.
- `src/app/(app)/settings/schedule-section.tsx` — client settings UI.

Modified files:
- `src/types/database.ts` — new columns on `clients`/`campaigns`.
- `src/lib/db/clients.ts` (+ `.test.ts`) — `updateClientSchedule`.
- `src/lib/db/campaigns.ts` (+ `.test.ts`) — remove `listActiveCampaigns`; add `listCampaignsDueForDiscovery`, `updateCampaignNextDiscoverAt`, `recomputeCampaignNextDiscoverAt`, `recomputeClientCampaignSchedules`; extend `CampaignSettingsPatch`.
- `src/lib/apollo/campaign-settings-schema.ts` (+ `.test.ts`) — `discoverTime`/`discoverTimezone` fields.
- `src/app/api/campaigns/route.ts` (+ `.test.ts`) — compute `next_discover_at` at creation.
- `src/app/api/campaigns/[campaignId]/route.ts` (+ `.test.ts`) — accept overrides, recompute on edit.
- `src/app/api/campaigns/[campaignId]/resume/route.ts` (+ `.test.ts`) — recompute on resume.
- `src/app/api/pipeline/discover-fanout/route.ts` — due-campaign query + advance-after-publish.
- `scripts/schedule-discover-cron.ts`, `scripts/schedule-research-cron.ts`, `scripts/schedule-write-cron.ts` — cadence.
- `src/app/(app)/settings/page.tsx` — mount `ScheduleSection`.
- `src/app/(app)/campaigns/campaign-settings-fields.tsx` — new run-time/timezone fieldset.
- `src/app/(app)/campaigns/new-campaign-form.tsx`, `src/app/(app)/campaigns/[campaignId]/edit/edit-campaign-form.tsx` — wire the new fields into the submitted body.
- `src/messages/en.json`, `src/messages/tr.json` — new keys.

---

### Task 1: Migration + hand-authored types

**Files:**
- Create: `supabase/migrations/0032_campaign_scheduling.sql`
- Modify: `src/types/database.ts:17` (clients Row), `:36` (clients Insert), `:92` (campaigns Row), `:107` (campaigns Insert)

**Interfaces:**
- Produces: `clients.timezone: string`, `clients.default_discover_time: string`, `campaigns.discover_time: string | null`, `campaigns.discover_timezone: string | null`, `campaigns.next_discover_at: string` (ISO timestamptz) — every later task's DB layer code depends on these exact column names.

This repo has no automated migration test (no live Postgres in CI — see the constraint above); this task's "test" is `tsc --noEmit` catching any type drift.

- [x] **Step 1: Write the migration**

```sql
-- Per-client default discovery schedule + optional per-campaign overrides,
-- replacing the single global 06:00 UTC discover cron with a per-campaign
-- scheduled instant the scheduler tick (discover-fanout) polls every 5
-- minutes. See docs/superpowers/specs/2026-08-07-campaign-scheduling-design.md

alter table clients
  add column timezone text not null default 'UTC',
  add column default_discover_time text not null default '06:00';

alter table campaigns
  add column discover_time text,
  add column discover_timezone text,
  add column next_discover_at timestamptz not null default now();

-- Backfill: every campaign that existed before this migration was already
-- running on the old global 06:00 UTC cron. Point next_discover_at at the
-- next real occurrence of 06:00 UTC from right now, so nothing changes
-- behavior for an existing campaign until its client/operator touches the
-- new settings.
update campaigns
set next_discover_at = case
  when (date_trunc('day', now() at time zone 'utc') + interval '6 hours') at time zone 'utc' > now()
    then (date_trunc('day', now() at time zone 'utc') + interval '6 hours') at time zone 'utc'
  else (date_trunc('day', now() at time zone 'utc') + interval '1 day 6 hours') at time zone 'utc'
end;

create index idx_campaigns_next_discover_at
  on campaigns (next_discover_at)
  where status = 'active';
```

- [x] **Step 2: Update `src/types/database.ts` — clients table**

In the `clients.Row` block (currently ends `...followup_delays_days: number[]` then `default_locale: ...`), add the two new fields. Find:

```ts
          followup_delays_days: number[]
          default_locale: Database['public']['Enums']['app_locale']
```

Replace with:

```ts
          followup_delays_days: number[]
          default_locale: Database['public']['Enums']['app_locale']
          timezone: string
          default_discover_time: string
```

In the `clients.Insert` block, find the matching line:

```ts
          followup_delays_days?: number[]
          default_locale?: Database['public']['Enums']['app_locale']
```

Replace with:

```ts
          followup_delays_days?: number[]
          default_locale?: Database['public']['Enums']['app_locale']
          timezone?: string
          default_discover_time?: string
```

- [x] **Step 3: Update `src/types/database.ts` — campaigns table**

In the `campaigns.Row` block, find:

```ts
          mailbox_ids: string[]
          daily_target: number
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          name: string
          status?: Database['public']['Enums']['campaign_status']
          icp?: Json
          value_prop?: string | null
          booking_link?: string | null
          reply_mode?: Database['public']['Enums']['reply_mode']
          price_handoff_mode?: Database['public']['Enums']['price_handoff_mode']
          mailbox_ids?: string[]
          daily_target?: number
          created_at?: string
          updated_at?: string
        }
```

Replace with:

```ts
          mailbox_ids: string[]
          daily_target: number
          discover_time: string | null
          discover_timezone: string | null
          next_discover_at: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          name: string
          status?: Database['public']['Enums']['campaign_status']
          icp?: Json
          value_prop?: string | null
          booking_link?: string | null
          reply_mode?: Database['public']['Enums']['reply_mode']
          price_handoff_mode?: Database['public']['Enums']['price_handoff_mode']
          mailbox_ids?: string[]
          daily_target?: number
          discover_time?: string | null
          discover_timezone?: string | null
          next_discover_at?: string
          created_at?: string
          updated_at?: string
        }
```

- [x] **Step 4: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: no new errors (existing errors, if any, are pre-existing and unrelated).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0032_campaign_scheduling.sql src/types/database.ts
git commit -m "feat(db): add client timezone/discover-time defaults + campaign schedule overrides

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Schedule validation (`timeOfDaySchema` / `timezoneSchema`)

**Files:**
- Create: `src/lib/validation/schedule.ts`
- Test: `src/lib/validation/schedule.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module — only `zod` and the global `Intl`).
- Produces: `timeOfDaySchema: ZodString` (validates `HH:mm`, 24h, zero-padded), `isValidTimezone(timezone: string): boolean`, `timezoneSchema: ZodEffects<ZodString>`. Consumed by Task 3 (`next-run.ts`), Task 6 (`campaign-settings-schema.ts`), Task 12 (`schedule-actions.ts`).

- [x] **Step 1: Write the failing test**

Create `src/lib/validation/schedule.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { timeOfDaySchema, timezoneSchema, isValidTimezone } from './schedule'

describe('timeOfDaySchema', () => {
  it('should accept a zero-padded 24-hour time', () => {
    expect(timeOfDaySchema.safeParse('06:00').success).toBe(true)
    expect(timeOfDaySchema.safeParse('23:59').success).toBe(true)
    expect(timeOfDaySchema.safeParse('00:00').success).toBe(true)
  })

  it('should reject an hour above 23', () => {
    expect(timeOfDaySchema.safeParse('24:00').success).toBe(false)
  })

  it('should reject a minute above 59', () => {
    expect(timeOfDaySchema.safeParse('06:60').success).toBe(false)
  })

  it('should reject a non-zero-padded hour', () => {
    expect(timeOfDaySchema.safeParse('9:00').success).toBe(false)
  })

  it('should reject a non-time string', () => {
    expect(timeOfDaySchema.safeParse('not-a-time').success).toBe(false)
  })
})

describe('isValidTimezone / timezoneSchema', () => {
  it('should accept a real IANA timezone name', () => {
    expect(isValidTimezone('America/New_York')).toBe(true)
    expect(timezoneSchema.safeParse('Europe/Istanbul').success).toBe(true)
  })

  it('should accept UTC', () => {
    expect(isValidTimezone('UTC')).toBe(true)
  })

  it('should reject an unrecognized timezone name', () => {
    expect(isValidTimezone('Not/AZone')).toBe(false)
    expect(timezoneSchema.safeParse('Not/AZone').success).toBe(false)
  })

  it('should reject an empty string', () => {
    expect(isValidTimezone('')).toBe(false)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/validation/schedule.test.ts`
Expected: FAIL — `Cannot find module './schedule'`

- [x] **Step 3: Write the implementation**

Create `src/lib/validation/schedule.ts`:

```ts
import { z } from 'zod'

// HH:mm, 24-hour, zero-padded — matches the wire format of an
// <input type="time"> element, used by both the client settings form and
// the per-campaign override fields.
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm, 24-hour, zero-padded')

// Intl.DateTimeFormat throws RangeError for any string it doesn't recognize
// as a valid IANA timezone name — this is the standard runtime way to
// validate one without a database of zone names to maintain ourselves.
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export const timezoneSchema = z.string().refine(isValidTimezone, { message: 'Invalid IANA timezone' })
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/validation/schedule.test.ts`
Expected: PASS (10 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/schedule.ts src/lib/validation/schedule.test.ts
git commit -m "feat(validation): add timeOfDay/timezone schemas for campaign scheduling

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `computeNextRunAt` — DST-aware scheduling math

**Files:**
- Create: `src/lib/scheduling/next-run.ts`
- Test: `src/lib/scheduling/next-run.test.ts`

**Interfaces:**
- Consumes: `isValidTimezone` from `@/lib/validation/schedule` (Task 2), `AppError` from `@/lib/errors/app-error`.
- Produces: `computeNextRunAt(fromUtc: Date, timeOfDay: string, timezone: string): Date`. Consumed by Task 5 (`recomputeCampaignNextDiscoverAt`), Task 7 (create-campaign route).

- [x] **Step 1: Write the failing test**

Create `src/lib/scheduling/next-run.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { computeNextRunAt } from './next-run'
import { AppError } from '@/lib/errors/app-error'

describe('computeNextRunAt', () => {
  it("should return today's occurrence when it has not happened yet, UTC", () => {
    const from = new Date('2026-06-15T00:00:00Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-06-15T06:00:00.000Z')
  })

  it("should roll to tomorrow when today's occurrence has already passed, UTC", () => {
    const from = new Date('2026-06-15T07:00:00Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-06-16T06:00:00.000Z')
  })

  it('should roll across a month boundary', () => {
    const from = new Date('2026-01-31T23:00:00Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-02-01T06:00:00.000Z')
  })

  it('should roll to tomorrow when fromUtc exactly equals the candidate instant', () => {
    // Matches listCampaignsDueForDiscovery's lte() semantics: a campaign
    // fired at exactly its due instant must not be immediately due again.
    const from = new Date('2026-06-15T06:00:00.000Z')
    const result = computeNextRunAt(from, '06:00', 'UTC')
    expect(result.toISOString()).toBe('2026-06-16T06:00:00.000Z')
  })

  it('should convert a non-UTC, non-DST timezone correctly', () => {
    // Asia/Tokyo has no DST — a fixed UTC+9 offset year-round.
    const from = new Date('2026-06-15T00:00:00Z')
    const result = computeNextRunAt(from, '09:00', 'Asia/Tokyo')
    expect(result.toISOString()).toBe('2026-06-15T00:00:00.000Z')
  })

  it('should shift the UTC offset correctly across a US spring-forward transition', () => {
    // 2026-03-08: America/New_York goes from EST (UTC-5) to EDT (UTC-4) at 02:00 local.
    const beforeTransition = computeNextRunAt(new Date('2026-03-07T00:00:00Z'), '06:00', 'America/New_York')
    expect(beforeTransition.toISOString()).toBe('2026-03-07T11:00:00.000Z') // 06:00 EST = 11:00 UTC

    const onTransitionDay = computeNextRunAt(new Date('2026-03-08T00:00:00Z'), '06:00', 'America/New_York')
    expect(onTransitionDay.toISOString()).toBe('2026-03-08T10:00:00.000Z') // 06:00 EDT = 10:00 UTC
  })

  it('should shift the UTC offset correctly across a US fall-back transition', () => {
    // 2026-11-01: America/New_York goes from EDT (UTC-4) back to EST (UTC-5) at 02:00 local.
    const beforeTransition = computeNextRunAt(new Date('2026-10-31T00:00:00Z'), '06:00', 'America/New_York')
    expect(beforeTransition.toISOString()).toBe('2026-10-31T10:00:00.000Z') // 06:00 EDT = 10:00 UTC

    const onTransitionDay = computeNextRunAt(new Date('2026-11-01T00:00:00Z'), '06:00', 'America/New_York')
    expect(onTransitionDay.toISOString()).toBe('2026-11-01T11:00:00.000Z') // 06:00 EST = 11:00 UTC
  })

  it('should throw INVARIANT_VIOLATION for a malformed timeOfDay', () => {
    expect(() => computeNextRunAt(new Date(), '25:00', 'UTC')).toThrow(AppError)
    expect(() => computeNextRunAt(new Date(), '9:00', 'UTC')).toThrow(AppError)
    expect(() => computeNextRunAt(new Date(), 'not-a-time', 'UTC')).toThrow(AppError)
  })

  it('should throw INVARIANT_VIOLATION for an unrecognized timezone', () => {
    expect(() => computeNextRunAt(new Date(), '06:00', 'Not/AZone')).toThrow(AppError)
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/scheduling/next-run.test.ts`
Expected: FAIL — `Cannot find module './next-run'`

- [x] **Step 3: Write the implementation**

Create `src/lib/scheduling/next-run.ts`:

```ts
import { AppError } from '@/lib/errors/app-error'
import { isValidTimezone } from '@/lib/validation/schedule'

const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/
const MS_PER_DAY = 24 * 60 * 60 * 1000

function datePartsIn(instant: Date, timezone: string): { year: number; month: number; day: number } {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  })
  const parts = formatter.formatToParts(instant)
  const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
  return { year: get('year'), month: get('month'), day: get('day') }
}

// Converts a wall-clock date+time in an arbitrary IANA timezone into the
// precise UTC instant it represents. Uses the standard "guess, observe,
// correct" technique: treat the wall clock as if it were UTC to get a
// starting instant, format that instant back in the target timezone to see
// what it actually reads as there, and shift by the difference. Two passes
// handle the rare case where the first correction itself crosses a DST
// boundary.
function zonedWallClockToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timezone: string,
): Date {
  const formatter = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })

  let guessMs = Date.UTC(year, month - 1, day, hour, minute, 0)
  for (let pass = 0; pass < 2; pass += 1) {
    const parts = formatter.formatToParts(new Date(guessMs))
    const get = (type: string): number => Number(parts.find((p) => p.type === type)?.value ?? 0)
    const shownMs = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
    const diffMs = guessMs - shownMs
    if (diffMs === 0) break
    guessMs += diffMs
  }
  return new Date(guessMs)
}

/**
 * Computes the next UTC instant at which `timeOfDay` (wall clock, "HH:mm")
 * occurs in `timezone`, strictly after `fromUtc`. If today's occurrence in
 * that timezone is still in the future, returns today's; otherwise advances
 * one calendar day *in that timezone* and recomputes — so a DST transition
 * shifts the resulting UTC instant correctly instead of the offset silently
 * carrying over from the previous day.
 *
 * Pure function, no I/O. Throws INVARIANT_VIOLATION for malformed input —
 * callers (routes, Server Actions) are expected to validate with
 * `timeOfDaySchema`/`timezoneSchema` before calling this, so a failure here
 * signals a programming bug, not a user input error.
 */
export function computeNextRunAt(fromUtc: Date, timeOfDay: string, timezone: string): Date {
  const match = TIME_OF_DAY_PATTERN.exec(timeOfDay)
  const hourStr = match?.[1]
  const minuteStr = match?.[2]
  if (!hourStr || !minuteStr) {
    throw new AppError('INVARIANT_VIOLATION', 'computeNextRunAt received a malformed timeOfDay', { timeOfDay })
  }
  if (!isValidTimezone(timezone)) {
    throw new AppError('INVARIANT_VIOLATION', 'computeNextRunAt received an unrecognized timezone', { timezone })
  }
  const hour = Number(hourStr)
  const minute = Number(minuteStr)

  const today = datePartsIn(fromUtc, timezone)
  const todayCandidate = zonedWallClockToUtc(today.year, today.month, today.day, hour, minute, timezone)
  if (todayCandidate.getTime() > fromUtc.getTime()) {
    return todayCandidate
  }

  // Today's occurrence already passed (or is exactly now) — advance one real
  // day from today's already-correct instant, then re-derive the calendar
  // date in the target timezone from that point. A plain +24h on the final
  // answer would be wrong across a DST transition; deriving the date this
  // way and re-running zonedWallClockToUtc for it is what makes the offset
  // recompute correctly.
  const tomorrowGuess = new Date(todayCandidate.getTime() + MS_PER_DAY)
  const tomorrow = datePartsIn(tomorrowGuess, timezone)
  return zonedWallClockToUtc(tomorrow.year, tomorrow.month, tomorrow.day, hour, minute, timezone)
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/scheduling/next-run.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/scheduling/next-run.ts src/lib/scheduling/next-run.test.ts
git commit -m "feat(scheduling): add DST-aware computeNextRunAt

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `updateClientSchedule` in `lib/db/clients.ts`

**Files:**
- Modify: `src/lib/db/clients.ts` (add after `updateClientFollowupDelays`, currently ending around line 282)
- Test: `src/lib/db/clients.test.ts`

**Interfaces:**
- Consumes: `ClientRow` (already exported, now includes `timezone`/`default_discover_time` from Task 1).
- Produces: `ClientSchedulePatch { timezone: string; default_discover_time: string }`, `updateClientSchedule(supabase, id, patch): Promise<ClientRow>`. Consumed by Task 12 (`schedule-actions.ts`).

- [x] **Step 1: Write the failing test**

Add to `src/lib/db/clients.test.ts` (find the existing `updateClientFollowupDelays` describe block and add this new one after it — check the top of the file for its existing import style first and add `updateClientSchedule` to the import list):

```ts
describe('updateClientSchedule', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  it('should return the updated client row', async () => {
    const row = { id: 'c1', timezone: 'America/New_York', default_discover_time: '08:30' }
    const result = await updateClientSchedule(mockSupabase({ data: row, error: null }), 'c1', {
      timezone: 'America/New_York',
      default_discover_time: '08:30',
    })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateClientSchedule(mockSupabase({ data: null, error: { message: 'boom' } }), 'c1', {
        timezone: 'UTC',
        default_discover_time: '06:00',
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Also update the import at the top of the file to include `updateClientSchedule` alongside the existing named imports from `./clients`.

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/clients.test.ts`
Expected: FAIL — `updateClientSchedule is not a function` / `does not provide an export named 'updateClientSchedule'`

- [x] **Step 3: Write the implementation**

In `src/lib/db/clients.ts`, add after `updateClientFollowupDelays`:

```ts
export interface ClientSchedulePatch {
  timezone: string
  default_discover_time: string
}

// The client-level default discovery schedule. Campaigns that don't set
// their own discover_time/discover_timezone override inherit this — see
// recomputeClientCampaignSchedules in lib/db/campaigns.ts, called by the
// caller of this function right after it succeeds.
export async function updateClientSchedule(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: ClientSchedulePatch,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update(patch).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client schedule', { id, cause: error?.message })
  }
  return data
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/db/clients.test.ts`
Expected: PASS (all existing tests plus the 2 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts
git commit -m "feat(db): add updateClientSchedule

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Campaign schedule functions in `lib/db/campaigns.ts`

**Files:**
- Modify: `src/lib/db/campaigns.ts`
- Test: `src/lib/db/campaigns.test.ts`

**Interfaces:**
- Consumes: `getClientById` from `@/lib/db/clients` (Task 4's file — `ClientRow` now has `timezone`/`default_discover_time`), `computeNextRunAt` from `@/lib/scheduling/next-run` (Task 3).
- Produces: `listCampaignsDueForDiscovery(supabase, nowIso): Promise<CampaignRow[]>`, `updateCampaignNextDiscoverAt(supabase, id, nextDiscoverAt: Date): Promise<CampaignRow>`, `recomputeCampaignNextDiscoverAt(supabase, campaignId, now?: Date): Promise<CampaignRow>`, `recomputeClientCampaignSchedules(supabase, clientId): Promise<void>`. `CampaignSettingsPatch` gains `discover_time: string | null` and `discover_timezone: string | null`. `listActiveCampaigns` is **removed** (dead after this task — its only caller, `discover-fanout`, is rewritten in Task 10). Consumed by: Task 8 (edit route), Task 9 (resume route), Task 10 (discover-fanout), Task 12 (`schedule-actions.ts`).

- [x] **Step 1: Write the failing tests**

In `src/lib/db/campaigns.test.ts`:

1. Remove the entire `describe('listActiveCampaigns', ...)` block (lines ~63-79) and remove `listActiveCampaigns` from the import list at the top.
2. Update the `import { ... } from './campaigns'` list to add: `listCampaignsDueForDiscovery`, `updateCampaignNextDiscoverAt`, `recomputeCampaignNextDiscoverAt`, `recomputeClientCampaignSchedules`.
3. Update the `updateCampaignSettings` describe block's `patch` fixture (around line 211) to include the two new fields:

```ts
  const patch = {
    name: 'Updated',
    value_prop: 'New prop',
    booking_link: null,
    daily_target: 25,
    icp: {},
    discover_time: null,
    discover_timezone: null,
  }
```

4. Add these new describe blocks (place them after `updateCampaignSettings`, before `deleteCampaign`):

```ts
describe('listCampaignsDueForDiscovery', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => ({ lte: () => Promise.resolve(result) }) }) }),
    } as never
  }

  it('should return campaigns whose next_discover_at is due', async () => {
    const rows = [{ id: 'camp1', status: 'active', next_discover_at: '2026-06-15T06:00:00Z' }]
    const result = await listCampaignsDueForDiscovery(mockSupabase({ data: rows, error: null }), '2026-06-15T06:00:00Z')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      listCampaignsDueForDiscovery(mockSupabase({ data: null, error: { message: 'boom' } }), '2026-06-15T06:00:00Z'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateCampaignNextDiscoverAt', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  it('should return the updated campaign row', async () => {
    const row = { id: 'camp1', next_discover_at: '2026-06-16T06:00:00.000Z' }
    const result = await updateCampaignNextDiscoverAt(
      mockSupabase({ data: row, error: null }),
      'camp1',
      new Date('2026-06-16T06:00:00.000Z'),
    )
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateCampaignNextDiscoverAt(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1', new Date()),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('recomputeCampaignNextDiscoverAt', () => {
  function mockSupabase(campaign: unknown, client: unknown, updateResult: { data: unknown; error: unknown }) {
    return {
      from: (table: string) => {
        if (table === 'campaigns') {
          return {
            select: () => ({
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: campaign, error: null }) }),
            }),
            update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(updateResult) }) }) }),
          }
        }
        return {
          select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: client, error: null }) }) }),
        }
      },
    } as never
  }

  it("should use the campaign's own override when set", async () => {
    const campaign = { id: 'camp1', client_id: 'c1', discover_time: '08:00', discover_timezone: 'Europe/Istanbul' }
    const client = { id: 'c1', timezone: 'UTC', default_discover_time: '06:00' }
    const updatedRow = { id: 'camp1', next_discover_at: '2026-06-15T05:00:00.000Z' }
    const supabase = mockSupabase(campaign, client, { data: updatedRow, error: null })

    const result = await recomputeCampaignNextDiscoverAt(supabase, 'camp1', new Date('2026-06-15T00:00:00Z'))

    expect(result).toEqual(updatedRow)
  })

  it("should fall back to the client's default when the campaign has no override", async () => {
    const campaign = { id: 'camp1', client_id: 'c1', discover_time: null, discover_timezone: null }
    const client = { id: 'c1', timezone: 'UTC', default_discover_time: '06:00' }
    const updatedRow = { id: 'camp1', next_discover_at: '2026-06-15T06:00:00.000Z' }
    const supabase = mockSupabase(campaign, client, { data: updatedRow, error: null })

    const result = await recomputeCampaignNextDiscoverAt(supabase, 'camp1', new Date('2026-06-15T00:00:00Z'))

    expect(result).toEqual(updatedRow)
  })

  it('should throw NOT_FOUND when the campaign does not exist', async () => {
    const supabase = mockSupabase(null, null, { data: null, error: null })
    await expect(recomputeCampaignNextDiscoverAt(supabase, 'missing')).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the campaign references a missing client', async () => {
    const campaign = { id: 'camp1', client_id: 'c1', discover_time: null, discover_timezone: null }
    const supabase = mockSupabase(campaign, null, { data: null, error: null })
    await expect(recomputeCampaignNextDiscoverAt(supabase, 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('recomputeClientCampaignSchedules', () => {
  it('should recompute only active campaigns with no schedule override', async () => {
    const campaigns = [
      { id: 'camp1', client_id: 'c1', status: 'active', discover_time: null, discover_timezone: null },
      { id: 'camp2', client_id: 'c1', status: 'active', discover_time: '09:00', discover_timezone: 'UTC' },
      { id: 'camp3', client_id: 'c1', status: 'paused', discover_time: null, discover_timezone: null },
    ]
    const client = { id: 'c1', timezone: 'UTC', default_discover_time: '06:00' }
    const recomputed: string[] = []
    const supabase = {
      from: (table: string) => {
        if (table === 'campaigns') {
          return {
            select: () => ({
              order: () => ({ eq: () => Promise.resolve({ data: campaigns, error: null }) }),
              eq: () => ({ maybeSingle: () => Promise.resolve({ data: campaigns[0], error: null }) }),
            }),
            update: () => ({
              eq: () => ({
                select: () => ({
                  single: () => {
                    recomputed.push('called')
                    return Promise.resolve({ data: { id: 'camp1' }, error: null })
                  },
                }),
              }),
            }),
          }
        }
        return { select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: client, error: null }) }) }) }
      },
    } as never

    await recomputeClientCampaignSchedules(supabase, 'c1')

    expect(recomputed).toHaveLength(1)
  })

  it('should not throw when an individual recompute fails', async () => {
    const campaigns = [{ id: 'camp1', client_id: 'c1', status: 'active', discover_time: null, discover_timezone: null }]
    const supabase = {
      from: () => ({
        select: () => ({
          order: () => ({ eq: () => Promise.resolve({ data: campaigns, error: null }) }),
          eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
        }),
      }),
    } as never

    await expect(recomputeClientCampaignSchedules(supabase, 'c1')).resolves.toBeUndefined()
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/campaigns.test.ts`
Expected: FAIL — the new functions don't exist yet; `listActiveCampaigns` import errors are gone since it was removed from the test file too.

- [x] **Step 3: Write the implementation**

In `src/lib/db/campaigns.ts`:

1. Update imports at the top:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { getClientById } from '@/lib/db/clients'
import { computeNextRunAt } from '@/lib/scheduling/next-run'
```

2. Delete the entire `listActiveCampaigns` function (currently lines 28-34).

3. Extend `CampaignSettingsPatch`:

```ts
export interface CampaignSettingsPatch {
  name: string
  value_prop: string
  booking_link: string | null
  daily_target: number
  icp: Json
  discover_time: string | null
  discover_timezone: string | null
}
```

4. Add these functions after `updateCampaignSettings` (before `deleteCampaign`):

```ts
export async function listCampaignsDueForDiscovery(
  supabase: SupabaseClient<Database>,
  nowIso: string,
): Promise<CampaignRow[]> {
  const { data, error } = await supabase
    .from('campaigns')
    .select('*')
    .eq('status', 'active')
    .lte('next_discover_at', nowIso)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list campaigns due for discovery', { cause: error.message })
  }
  return data ?? []
}

export async function updateCampaignNextDiscoverAt(
  supabase: SupabaseClient<Database>,
  id: string,
  nextDiscoverAt: Date,
): Promise<CampaignRow> {
  const { data, error } = await supabase
    .from('campaigns')
    .update({ next_discover_at: nextDiscoverAt.toISOString() })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update campaign next_discover_at', { id, cause: error?.message })
  }
  return data
}

// Resolves this campaign's effective schedule (its own override, or the
// owning client's default) and writes the next occurrence. Called after a
// successful discovery publish, after a schedule-affecting edit, and after
// a resume — always with a fresh `now` so a long-paused campaign or a
// campaign edited mid-day doesn't inherit a stale computation.
export async function recomputeCampaignNextDiscoverAt(
  supabase: SupabaseClient<Database>,
  campaignId: string,
  now: Date = new Date(),
): Promise<CampaignRow> {
  const campaign = await getCampaignById(supabase, campaignId)
  if (!campaign) {
    throw new AppError('NOT_FOUND', 'Cannot recompute schedule for a campaign that does not exist', { campaignId })
  }
  const client = await getClientById(supabase, campaign.client_id)
  if (!client) {
    throw new AppError('DB_ERROR', 'Campaign references a client that no longer exists', {
      campaignId,
      clientId: campaign.client_id,
    })
  }
  const time = campaign.discover_time ?? client.default_discover_time
  const timezone = campaign.discover_timezone ?? client.timezone
  return updateCampaignNextDiscoverAt(supabase, campaignId, computeNextRunAt(now, time, timezone))
}

// Recomputes next_discover_at for every one of this client's active
// campaigns that has no schedule override of its own — called after the
// client's timezone or default discovery time changes. A campaign with its
// own discover_time/discover_timezone override is deliberately left alone;
// only campaigns actually inheriting the client default need to move.
// Best-effort per campaign, matching removeMailboxFromCampaigns — one
// campaign's recompute failing must not block the others or fail the whole
// settings save.
export async function recomputeClientCampaignSchedules(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<void> {
  const campaigns = await listCampaignsForClient(supabase, clientId)
  const inheriting = campaigns.filter(
    (campaign) =>
      campaign.status === 'active' && campaign.discover_time === null && campaign.discover_timezone === null,
  )
  for (const campaign of inheriting) {
    try {
      await recomputeCampaignNextDiscoverAt(supabase, campaign.id)
    } catch {
      // Best-effort — the next scheduler tick or manual edit retries it.
    }
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/db/campaigns.test.ts`
Expected: PASS (all tests, `listActiveCampaigns` gone, new describe blocks green)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat(db): add campaign discovery-schedule functions, remove dead listActiveCampaigns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: `campaignSettingsSchema` — `discoverTime`/`discoverTimezone`

**Files:**
- Modify: `src/lib/apollo/campaign-settings-schema.ts`
- Test: `src/lib/apollo/campaign-settings-schema.test.ts`

**Interfaces:**
- Consumes: `timeOfDaySchema`, `timezoneSchema` from `@/lib/validation/schedule` (Task 2).
- Produces: `campaignSettingsSchema` now includes `discoverTime: string | null` (default `null`) and `discoverTimezone: string | null` (default `null`). Consumed by Task 7 and Task 8 (create/edit routes).

- [x] **Step 1: Write the failing test**

Add to `src/lib/apollo/campaign-settings-schema.test.ts`, after the existing tests:

```ts
  it('should default discoverTime and discoverTimezone to null when omitted', () => {
    const result = campaignSettingsSchema.parse(valid)
    expect(result.discoverTime).toBeNull()
    expect(result.discoverTimezone).toBeNull()
  })

  it('should accept a valid discoverTime and discoverTimezone', () => {
    const result = campaignSettingsSchema.parse({ ...valid, discoverTime: '08:30', discoverTimezone: 'Europe/Istanbul' })
    expect(result.discoverTime).toBe('08:30')
    expect(result.discoverTimezone).toBe('Europe/Istanbul')
  })

  it('should reject a malformed discoverTime', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, discoverTime: '8:30' })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid discoverTimezone', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, discoverTimezone: 'Not/AZone' })
    expect(result.success).toBe(false)
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/apollo/campaign-settings-schema.test.ts`
Expected: FAIL — `result.discoverTime` is `undefined`, not `null`

- [x] **Step 3: Write the implementation**

In `src/lib/apollo/campaign-settings-schema.ts`, add the import and the two fields:

```ts
import { z } from 'zod'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from './types'
import { timeOfDaySchema, timezoneSchema } from '@/lib/validation/schedule'

// Shared between POST /api/campaigns (create) and PATCH /api/campaigns/[campaignId]
// (edit) — every field a campaign's settings form submits, except clientId
// (set once at creation, immutable afterward).
export const campaignSettingsSchema = z.object({
  name: z.string().min(1),
  valueProp: z.string().min(1),
  bookingLink: z.string().url().nullable().default(null),
  dailyTarget: z.number().int().min(1).max(100).default(50),
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nullable().default(null),
  employeeRangeMax: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  excludeOrganizationLocations: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  personSeniorities: z.array(z.enum(apolloPersonSeniorities)).default([]),
  contactEmailStatuses: z.array(z.enum(apolloContactEmailStatuses)).default([]),
  // null = inherit the owning client's timezone/default_discover_time.
  discoverTime: timeOfDaySchema.nullable().default(null),
  discoverTimezone: timezoneSchema.nullable().default(null),
})

export type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/apollo/campaign-settings-schema.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/apollo/campaign-settings-schema.ts src/lib/apollo/campaign-settings-schema.test.ts
git commit -m "feat(campaigns): add discoverTime/discoverTimezone to campaign settings schema

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: `POST /api/campaigns` — compute `next_discover_at` at creation

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Test: `src/app/api/campaigns/route.test.ts`

**Interfaces:**
- Consumes: `computeNextRunAt` (Task 3), the extended `campaignSettingsSchema` (Task 6), `client.timezone`/`client.default_discover_time` (Task 1).
- Produces: `insertCampaign` is now called with `discover_time`, `discover_timezone`, `next_discover_at` populated in the row.

- [x] **Step 1: Write the failing test**

Add to `src/app/api/campaigns/route.test.ts`, after the existing `'should use the client current reply_mode...'` test:

```ts
  it('should compute next_discover_at from the client default when no override is given', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'human_approve',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ discover_time: null, discover_timezone: null, next_discover_at: expect.any(String) }),
    )
  })

  it("should store the campaign's own discoverTime/discoverTimezone override", async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({
      id: validBody.clientId,
      reply_mode: 'human_approve',
      timezone: 'UTC',
      default_discover_time: '06:00',
    })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req({ ...validBody, discoverTime: '09:00', discoverTimezone: 'Europe/Istanbul' }))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ discover_time: '09:00', discover_timezone: 'Europe/Istanbul' }),
    )
  })
```

Also update the shared `getClientByIdMock` default in `beforeEach` (so the other, already-passing tests keep working) to include the two new fields:

```ts
  getClientByIdMock.mockReset().mockResolvedValue({
    id: validBody.clientId,
    reply_mode: 'human_approve',
    timezone: 'UTC',
    default_discover_time: '06:00',
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/api/campaigns/route.test.ts`
Expected: FAIL — `insertCampaignMock` was not called with `discover_time`/`next_discover_at`

- [x] **Step 3: Write the implementation**

In `src/app/api/campaigns/route.ts`, add the `computeNextRunAt` import and compute the schedule fields:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { campaignSettingsSchema } from '@/lib/apollo/campaign-settings-schema'
import { computeNextRunAt } from '@/lib/scheduling/next-run'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
```

Then, in `POST`, right after the existing `client` null-check and before building `icp` (or after — order doesn't matter as long as it's before the `insertCampaign` call), add:

```ts
    const effectiveTime = body.discoverTime ?? client.default_discover_time
    const effectiveTimezone = body.discoverTimezone ?? client.timezone
    const nextDiscoverAt = computeNextRunAt(new Date(), effectiveTime, effectiveTimezone)
```

And extend the `insertCampaign` call:

```ts
    const campaign = await insertCampaign(admin, {
      client_id: body.clientId,
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      reply_mode: client.reply_mode,
      icp,
      discover_time: body.discoverTime,
      discover_timezone: body.discoverTimezone,
      next_discover_at: nextDiscoverAt.toISOString(),
    })
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/api/campaigns/route.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/campaigns/route.ts src/app/api/campaigns/route.test.ts
git commit -m "feat(campaigns): compute next_discover_at when a campaign is created

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `PATCH /api/campaigns/[campaignId]` — accept overrides, recompute on edit

**Files:**
- Modify: `src/app/api/campaigns/[campaignId]/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/route.test.ts`

**Interfaces:**
- Consumes: `recomputeCampaignNextDiscoverAt` from `@/lib/db/campaigns` (Task 5).
- Produces: `PATCH` now passes `discover_time`/`discover_timezone` into `updateCampaignSettings` and calls `recomputeCampaignNextDiscoverAt` afterward; the response `campaign` reflects the recomputed row.

- [x] **Step 1: Write the failing test**

In `src/app/api/campaigns/[campaignId]/route.test.ts`:

1. Add `recomputeCampaignNextDiscoverAt` to the `vi.mock('@/lib/db/campaigns', ...)` block and declare its mock at the top alongside the others:

```ts
const recomputeCampaignNextDiscoverAtMock = vi.fn()

vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  deleteCampaign: (...a: unknown[]) => deleteCampaignMock(...a),
  updateCampaignSettings: (...a: unknown[]) => updateCampaignSettingsMock(...a),
  recomputeCampaignNextDiscoverAt: (...a: unknown[]) => recomputeCampaignNextDiscoverAtMock(...a),
}))
```

2. Reset it in `beforeEach`:

```ts
  recomputeCampaignNextDiscoverAtMock.mockReset()
```

3. In `validPatchBody`, add the two new fields to the default object:

```ts
function validPatchBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Updated name',
    valueProp: 'Updated value prop',
    bookingLink: null,
    dailyTarget: 25,
    personTitles: [],
    organizationLocations: [],
    employeeRangeMin: null,
    employeeRangeMax: null,
    keywords: [],
    excludeOrganizationLocations: [],
    excludeKeywords: [],
    personSeniorities: [],
    contactEmailStatuses: [],
    discoverTime: null,
    discoverTimezone: null,
    ...overrides,
  }
}
```

(If the existing fixture is missing `excludeKeywords`/`personSeniorities`/`contactEmailStatuses`, keep whatever fields it already has — only add the two new ones and merge `overrides` last as shown.)

4. Add a new test in the `PATCH` describe block:

```ts
  it("should recompute next_discover_at after a successful update", async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Old name' })
    updateCampaignSettingsMock.mockResolvedValue({ id: 'camp1', name: 'Updated name' })
    recomputeCampaignNextDiscoverAtMock.mockResolvedValue({ id: 'camp1', name: 'Updated name', next_discover_at: '2026-06-16T09:00:00.000Z' })

    const res = await PATCH(patchReq(validPatchBody({ discoverTime: '09:00', discoverTimezone: 'Europe/Istanbul' })), ctx('camp1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(updateCampaignSettingsMock).toHaveBeenCalledWith(
      {},
      'camp1',
      expect.objectContaining({ discover_time: '09:00', discover_timezone: 'Europe/Istanbul' }),
    )
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp1')
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', name: 'Updated name', next_discover_at: '2026-06-16T09:00:00.000Z' } })
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run "src/app/api/campaigns/[campaignId]/route.test.ts"`
Expected: FAIL — `recomputeCampaignNextDiscoverAtMock` not called; response `campaign` is the un-recomputed row

- [x] **Step 3: Write the implementation**

In `src/app/api/campaigns/[campaignId]/route.ts`:

1. Update the import:

```ts
import { getCampaignById, deleteCampaign, updateCampaignSettings, recomputeCampaignNextDiscoverAt } from '@/lib/db/campaigns'
```

2. In `PATCH`, extend the `updateCampaignSettings` call and add the recompute step right after it:

```ts
    const updated = await updateCampaignSettings(admin, campaignId, {
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      icp,
      discover_time: body.discoverTime,
      discover_timezone: body.discoverTimezone,
    })
    // Recompute unconditionally rather than diffing old vs. new — cheap,
    // and correctly handles every case: an override changed, an override
    // was cleared back to null (reverts to inheriting the client's current
    // default), or neither changed (recomputes to the same instant).
    const rescheduled = await recomputeCampaignNextDiscoverAt(admin, campaignId)
```

3. Update the response and event payload to use `rescheduled` instead of `updated`:

```ts
    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.updated',
        payload: { campaignId, name: rescheduled.name },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: rescheduled })
```

(The unused `updated` variable name is replaced entirely — do not leave both `updated` and `rescheduled` declared.)

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run "src/app/api/campaigns/[campaignId]/route.test.ts"`
Expected: PASS (all PATCH and DELETE tests)

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/campaigns/[campaignId]/route.ts" "src/app/api/campaigns/[campaignId]/route.test.ts"
git commit -m "feat(campaigns): recompute next_discover_at on campaign edit

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: `POST /api/campaigns/[campaignId]/resume` — recompute on resume

**Files:**
- Modify: `src/app/api/campaigns/[campaignId]/resume/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/resume/route.test.ts`

**Interfaces:**
- Consumes: `recomputeCampaignNextDiscoverAt` from `@/lib/db/campaigns` (Task 5).
- Produces: resuming a campaign now also recomputes `next_discover_at` from "now," so a campaign paused for days doesn't fire on the very next scheduler tick from a stale value.

- [x] **Step 1: Write the failing test**

In `src/app/api/campaigns/[campaignId]/resume/route.test.ts`:

1. Add the mock:

```ts
const recomputeCampaignNextDiscoverAtMock = vi.fn()

vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  updateCampaignStatus: (...a: unknown[]) => updateCampaignStatusMock(...a),
  recomputeCampaignNextDiscoverAt: (...a: unknown[]) => recomputeCampaignNextDiscoverAtMock(...a),
}))
```

2. Reset it in `beforeEach`: `recomputeCampaignNextDiscoverAtMock.mockReset()`.

3. Update the existing `'should resume a paused campaign and log the event'` test to mock and assert the recompute step:

```ts
  it('should resume a paused campaign, recompute its schedule, and log the event', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' })
    updateCampaignStatusMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active' })
    recomputeCampaignNextDiscoverAtMock.mockResolvedValue({
      id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active', next_discover_at: '2026-06-16T06:00:00.000Z',
    })

    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({
      ok: true,
      campaign: { id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active', next_discover_at: '2026-06-16T06:00:00.000Z' },
    })
    expect(updateCampaignStatusMock).toHaveBeenCalledWith(expect.anything(), 'camp1', 'active')
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.resumed' }))
  })
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run "src/app/api/campaigns/[campaignId]/resume/route.test.ts"`
Expected: FAIL — response `campaign` doesn't include `next_discover_at`; `recomputeCampaignNextDiscoverAtMock` not called

- [x] **Step 3: Write the implementation**

In `src/app/api/campaigns/[campaignId]/resume/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, updateCampaignStatus, recomputeCampaignNextDiscoverAt } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (campaign.status !== 'paused') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }

  try {
    await updateCampaignStatus(admin, campaignId, 'active')
    // Recomputed from "now" rather than the status update's return value —
    // a campaign paused for days must not fire on the very next scheduler
    // tick from a next_discover_at left over from before it was paused.
    const updated = await recomputeCampaignNextDiscoverAt(admin, campaignId)
    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.resumed',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the resume already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run "src/app/api/campaigns/[campaignId]/resume/route.test.ts"`
Expected: PASS (all tests)

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/campaigns/[campaignId]/resume/route.ts" "src/app/api/campaigns/[campaignId]/resume/route.test.ts"
git commit -m "feat(campaigns): recompute next_discover_at on resume

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: `discover-fanout` — due-campaign scheduler tick

**Files:**
- Modify: `src/app/api/pipeline/discover-fanout/route.ts`
- Test: Create `src/app/api/pipeline/discover-fanout/route.test.ts` (route had no test file before this plan)

**Interfaces:**
- Consumes: `listCampaignsDueForDiscovery`, `recomputeCampaignNextDiscoverAt` (Task 5).
- Produces: response shape changes from `{ ok, campaignCount, failedCampaignIds }` to `{ ok, campaignCount, firedCampaignIds, failedCampaignIds, staleScheduleCampaignIds }`.

- [x] **Step 1: Write the failing test**

Create `src/app/api/pipeline/discover-fanout/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyQstashSignatureMock = vi.fn()
const listCampaignsDueForDiscoveryMock = vi.fn()
const recomputeCampaignNextDiscoverAtMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  listCampaignsDueForDiscovery: (...a: unknown[]) => listCampaignsDueForDiscoveryMock(...a),
  recomputeCampaignNextDiscoverAt: (...a: unknown[]) => recomputeCampaignNextDiscoverAtMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue('{}')
  listCampaignsDueForDiscoveryMock.mockReset().mockResolvedValue([])
  recomputeCampaignNextDiscoverAtMock.mockReset().mockResolvedValue({ id: 'camp1' })
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/discover-fanout', () => {
  it('should return 401 when the QStash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req())
    expect(res.status).toBe(401)
    expect(listCampaignsDueForDiscoveryMock).not.toHaveBeenCalled()
  })

  it('should publish nothing and return an empty result when no campaign is due', async () => {
    const res = await POST(req())
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaignCount: 0, firedCampaignIds: [], failedCampaignIds: [], staleScheduleCampaignIds: [] })
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should publish a discover job and recompute the schedule for each due campaign', async () => {
    listCampaignsDueForDiscoveryMock.mockResolvedValue([{ id: 'camp1' }, { id: 'camp2' }])

    const res = await POST(req())
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/discover', { campaignId: 'camp1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/discover', { campaignId: 'camp2' })
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp1', expect.any(Date))
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp2', expect.any(Date))
    expect(json.firedCampaignIds).toEqual(['camp1', 'camp2'])
    expect(json.failedCampaignIds).toEqual([])
  })

  it('should isolate a publish failure without recomputing that campaign\'s schedule', async () => {
    listCampaignsDueForDiscoveryMock.mockResolvedValue([{ id: 'camp1' }, { id: 'camp2' }])
    publishJsonMock.mockImplementation((path: string, body: { campaignId: string }) => {
      if (body.campaignId === 'camp2') return Promise.reject(new Error('qstash down'))
      return Promise.resolve('msg1')
    })

    const res = await POST(req())
    const json = await res.json()

    expect(json.firedCampaignIds).toEqual(['camp1'])
    expect(json.failedCampaignIds).toEqual(['camp2'])
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledTimes(1)
    expect(recomputeCampaignNextDiscoverAtMock).toHaveBeenCalledWith({}, 'camp1', expect.any(Date))
  })

  it('should track a recompute failure separately, without re-firing that campaign next tick', async () => {
    listCampaignsDueForDiscoveryMock.mockResolvedValue([{ id: 'camp1' }])
    recomputeCampaignNextDiscoverAtMock.mockRejectedValue(new Error('db down'))

    const res = await POST(req())
    const json = await res.json()

    // The publish already succeeded — camp1 must NOT be in failedCampaignIds
    // (that list drives nothing here, but conflating it with a recompute
    // failure would be indistinguishable from "never fired," which is false
    // and would risk a second, duplicate discover run once the DB recovers).
    expect(json.firedCampaignIds).toEqual(['camp1'])
    expect(json.failedCampaignIds).toEqual([])
    expect(json.staleScheduleCampaignIds).toEqual(['camp1'])
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/api/pipeline/discover-fanout/route.test.ts`
Expected: FAIL — current route imports `listActiveCampaigns` (deleted in Task 5), response shape doesn't match

- [x] **Step 3: Write the implementation**

Replace `src/app/api/pipeline/discover-fanout/route.ts` entirely:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCampaignsDueForDiscovery, recomputeCampaignNextDiscoverAt } from '@/lib/db/campaigns'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const now = new Date()
    const campaigns = await listCampaignsDueForDiscovery(admin, now.toISOString())
    const firedCampaignIds: string[] = []
    const failedCampaignIds: string[] = []
    const staleScheduleCampaignIds: string[] = []

    for (const campaign of campaigns) {
      let published = false
      try {
        await publishJson('/api/pipeline/discover', { campaignId: campaign.id })
        published = true
        firedCampaignIds.push(campaign.id)
      } catch {
        // Isolate per-campaign publish failures — one bad QStash publish
        // doesn't stop the rest of the due campaigns. Left due; retried on
        // the next 5-minute tick instead of waiting a full day.
        failedCampaignIds.push(campaign.id)
      }

      if (published) {
        try {
          await recomputeCampaignNextDiscoverAt(admin, campaign.id, now)
        } catch {
          // The discover job already published successfully — this is
          // deliberately NOT added to failedCampaignIds. Doing so would make
          // the next tick re-publish a second, duplicate discover run for a
          // campaign that already fired. A stuck next_discover_at here is
          // caught by the next client-settings save or campaign edit, both
          // of which recompute it unconditionally.
          staleScheduleCampaignIds.push(campaign.id)
        }
      }
    }

    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.discover_fanout.completed',
        payload: { campaignCount: campaigns.length, firedCampaignIds, failedCampaignIds, staleScheduleCampaignIds },
      })
    } catch {
      // Audit logging is best-effort — it must not turn a completed fanout
      // into a 500 response.
    }
    return NextResponse.json({
      ok: true,
      campaignCount: campaigns.length,
      firedCampaignIds,
      failedCampaignIds,
      staleScheduleCampaignIds,
    })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/api/pipeline/discover-fanout/route.test.ts`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/pipeline/discover-fanout/route.ts src/app/api/pipeline/discover-fanout/route.test.ts
git commit -m "feat(pipeline): discover-fanout polls due campaigns instead of firing all active ones

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Cron cadence — discover/research/write every 5 minutes

**Files:**
- Modify: `scripts/schedule-discover-cron.ts`, `scripts/schedule-research-cron.ts`, `scripts/schedule-write-cron.ts`

**Interfaces:**
- No runtime interface change — these are one-time manual registration scripts (per their own header comments). No test (nothing to unit-test in a CLI default-string change); verified by reading the diff.

- [x] **Step 1: Update `scripts/schedule-discover-cron.ts`**

```ts
// One-time setup: registers the QStash schedule that ticks the discovery
// scheduler every 5 minutes. Each tick fires only the campaigns whose own
// next_discover_at is due (see /api/pipeline/discover-fanout) — not every
// active campaign. Run manually once per environment after deploy:
//   Usage: tsx scripts/schedule-discover-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/discover-fanout', cron)
  process.stdout.write(`Scheduled discover-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [x] **Step 2: Update `scripts/schedule-research-cron.ts`**

Change the header comment and default to match (open the file, apply the same shape of edit as above): default cron becomes `'*/5 * * * *'`, comment explains research now polls every 5 minutes system-wide (no per-campaign scheduling needed — it already scans every `new` case regardless of campaign).

- [x] **Step 3: Update `scripts/schedule-write-cron.ts`**

Same edit: default cron becomes `'*/5 * * * *'`, comment explains write now polls every 5 minutes system-wide.

- [x] **Step 4: Verify with a dry read**

Run: `grep -n "process.argv\[2\] ??" scripts/schedule-discover-cron.ts scripts/schedule-research-cron.ts scripts/schedule-write-cron.ts`
Expected: all three print `process.argv[2] ?? '*/5 * * * *'`

- [ ] **Step 5: Commit**

```bash
git add scripts/schedule-discover-cron.ts scripts/schedule-research-cron.ts scripts/schedule-write-cron.ts
git commit -m "chore(pipeline): poll discover/research/write every 5 minutes instead of once daily

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Client settings UI — timezone + default discovery time

**Files:**
- Create: `src/app/(app)/settings/schedule-actions.ts`, `src/app/(app)/settings/schedule-actions.test.ts`, `src/app/(app)/settings/schedule-section.tsx`
- Modify: `src/app/(app)/settings/page.tsx`, `src/messages/en.json`, `src/messages/tr.json`

**Interfaces:**
- Consumes: `updateClientSchedule` (Task 4), `recomputeClientCampaignSchedules` (Task 5), `timeOfDaySchema`/`timezoneSchema` (Task 2).
- Produces: `updateSchedule(formData: FormData): Promise<void>` Server Action; `ScheduleSection` component taking `{ initialTimezone: string; initialDefaultDiscoverTime: string }`.

- [x] **Step 1: Write the failing test**

Create `src/app/(app)/settings/schedule-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateSchedule } from './schedule-actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateClientSchedule: vi.fn(),
  recomputeClientCampaignSchedules: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/clients', () => ({ updateClientSchedule: hoisted.updateClientSchedule }))
vi.mock('@/lib/db/campaigns', () => ({ recomputeClientCampaignSchedules: hoisted.recomputeClientCampaignSchedules }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: hoisted.logEvent }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(timezone: string, defaultDiscoverTime: string): FormData {
  const data = new FormData()
  data.set('timezone', timezone)
  data.set('defaultDiscoverTime', defaultDiscoverTime)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.updateClientSchedule.mockResolvedValue({ id: 'c1', timezone: 'Europe/Istanbul', default_discover_time: '08:00' })
  hoisted.recomputeClientCampaignSchedules.mockResolvedValue(undefined)
})

describe('updateSchedule', () => {
  it("should update the client's schedule and recompute its campaigns", async () => {
    await updateSchedule(form('Europe/Istanbul', '08:00'))

    expect(hoisted.updateClientSchedule).toHaveBeenCalledWith({}, 'c1', {
      timezone: 'Europe/Istanbul',
      default_discover_time: '08:00',
    })
    expect(hoisted.recomputeClientCampaignSchedules).toHaveBeenCalledWith({}, 'c1')
    expect(hoisted.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      type: 'client.schedule_changed',
      payload: { timezone: 'Europe/Istanbul', defaultDiscoverTime: '08:00' },
    }))
  })

  it('should reject an operator, who does not own a schedule preference', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(updateSchedule(form('UTC', '06:00'))).rejects.toThrow()
    expect(hoisted.updateClientSchedule).not.toHaveBeenCalled()
  })

  it('should reject an invalid timezone', async () => {
    await expect(updateSchedule(form('Not/AZone', '06:00'))).rejects.toThrow()
    expect(hoisted.updateClientSchedule).not.toHaveBeenCalled()
  })

  it('should reject a malformed time', async () => {
    await expect(updateSchedule(form('UTC', '9:00'))).rejects.toThrow()
    expect(hoisted.updateClientSchedule).not.toHaveBeenCalled()
  })
})
```

- [x] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/\(app\)/settings/schedule-actions.test.ts`
Expected: FAIL — `Cannot find module './schedule-actions'`

- [x] **Step 3: Write the implementation**

Create `src/app/(app)/settings/schedule-actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateClientSchedule } from '@/lib/db/clients'
import { recomputeClientCampaignSchedules } from '@/lib/db/campaigns'
import { timeOfDaySchema, timezoneSchema } from '@/lib/validation/schedule'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

// Client-owned preference, same shape as updateReplyMode/updateFollowupCadence.
// Recomputes next_discover_at for every campaign that inherits this default
// (recomputeClientCampaignSchedules) — a campaign with its own override is
// left untouched.
export async function updateSchedule(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their discovery schedule', { role: appUser.role })
  }

  const timezoneParsed = timezoneSchema.safeParse(formData.get('timezone'))
  if (!timezoneParsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid timezone', { issues: timezoneParsed.error.flatten() })
  }
  const timeParsed = timeOfDaySchema.safeParse(formData.get('defaultDiscoverTime'))
  if (!timeParsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid default discovery time', { issues: timeParsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateClientSchedule(admin, appUser.client_id, {
    timezone: timezoneParsed.data,
    default_discover_time: timeParsed.data,
  })
  await recomputeClientCampaignSchedules(admin, appUser.client_id)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.schedule_changed',
    payload: { timezone: timezoneParsed.data, defaultDiscoverTime: timeParsed.data },
  })
  revalidatePath(SETTINGS_PATH)
}
```

- [x] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/\(app\)/settings/schedule-actions.test.ts`
Expected: PASS (4 tests)

- [x] **Step 5: Create the UI component**

Create `src/app/(app)/settings/schedule-section.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { updateSchedule } from './schedule-actions'

const TIMEZONE_OPTIONS: readonly string[] = Intl.supportedValuesOf('timeZone')

interface ScheduleSectionProps {
  initialTimezone: string
  initialDefaultDiscoverTime: string
}

export function ScheduleSection({
  initialTimezone,
  initialDefaultDiscoverTime,
}: ScheduleSectionProps): React.ReactElement {
  const t = useTranslations('settings')
  const [timezone, setTimezone] = useState(initialTimezone)
  const [defaultDiscoverTime, setDefaultDiscoverTime] = useState(initialDefaultDiscoverTime)
  const [savedTimezone, setSavedTimezone] = useState(initialTimezone)
  const [savedTime, setSavedTime] = useState(initialDefaultDiscoverTime)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const isDirty = timezone !== savedTimezone || defaultDiscoverTime !== savedTime

  function onSave(): void {
    setError(null)
    setShowSaved(false)
    const formData = new FormData()
    formData.set('timezone', timezone)
    formData.set('defaultDiscoverTime', defaultDiscoverTime)
    startTransition(async () => {
      try {
        await updateSchedule(formData)
        setSavedTimezone(timezone)
        setSavedTime(defaultDiscoverTime)
        setShowSaved(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('scheduleSaveFailed'))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-[12px]">{t('scheduleHint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs">{t('scheduleTimezoneLabel')}</span>
          <select
            value={timezone}
            disabled={isPending}
            onChange={(event) => setTimezone(event.target.value)}
            className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs">{t('scheduleTimeLabel')}</span>
          <input
            type="time"
            value={defaultDiscoverTime}
            disabled={isPending}
            onChange={(event) => setDefaultDiscoverTime(event.target.value)}
            className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
          />
        </label>
        <Button type="button" size="sm" disabled={isPending || !isDirty} onClick={onSave}>
          {isPending ? t('scheduleSaving') : t('scheduleSaveChanges')}
        </Button>
        {showSaved && !isDirty ? <span className="text-faint text-[11px]">{t('scheduleSaved')}</span> : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
```

- [x] **Step 6: Wire it into the settings page**

In `src/app/(app)/settings/page.tsx`, add the import:

```ts
import { ScheduleSection } from './schedule-section'
```

Find the existing follow-up cadence section block:

```tsx
      {client ? (
        <Section title={t('followupCadenceSectionTitle')}>
          <FollowupCadenceSection initialDelaysDays={client.followup_delays_days} />
        </Section>
      ) : null}
```

Add a new section right after it:

```tsx
      {client ? (
        <Section title={t('followupCadenceSectionTitle')}>
          <FollowupCadenceSection initialDelaysDays={client.followup_delays_days} />
        </Section>
      ) : null}

      {client ? (
        <Section title={t('scheduleSectionTitle')}>
          <ScheduleSection initialTimezone={client.timezone} initialDefaultDiscoverTime={client.default_discover_time} />
        </Section>
      ) : null}
```

- [x] **Step 7: Add i18n keys**

In `src/messages/en.json`, find:

```json
    "replyModeSectionTitle": "Reply mode",
    "followupCadenceSectionTitle": "Follow-up cadence",
    "connectMailboxSectionTitle": "Connect a mailbox",
```

Replace with:

```json
    "replyModeSectionTitle": "Reply mode",
    "followupCadenceSectionTitle": "Follow-up cadence",
    "scheduleSectionTitle": "Discovery schedule",
    "connectMailboxSectionTitle": "Connect a mailbox",
```

Then find:

```json
    "followupCadenceReset": "Reset",
    "followupCadenceSaved": "Saved",
    "mailboxControls": {
```

Replace with:

```json
    "followupCadenceReset": "Reset",
    "followupCadenceSaved": "Saved",
    "scheduleHint": "Sets the default time and timezone your campaigns run their discovery search at. A campaign with its own schedule override is not affected.",
    "scheduleTimezoneLabel": "Timezone",
    "scheduleTimeLabel": "Default discovery time",
    "scheduleSaveFailed": "Could not save that change. Please try again.",
    "scheduleSaving": "Saving…",
    "scheduleSaveChanges": "Save changes",
    "scheduleSaved": "Saved",
    "mailboxControls": {
```

In `src/messages/tr.json`, find:

```json
    "replyModeSectionTitle": "Yanıt modu",
    "followupCadenceSectionTitle": "Takip periyodu",
    "connectMailboxSectionTitle": "Posta kutusu bağla",
```

Replace with:

```json
    "replyModeSectionTitle": "Yanıt modu",
    "followupCadenceSectionTitle": "Takip periyodu",
    "scheduleSectionTitle": "Keşif zamanlaması",
    "connectMailboxSectionTitle": "Posta kutusu bağla",
```

Then find:

```json
    "followupCadenceReset": "Sıfırla",
    "followupCadenceSaved": "Kaydedildi",
    "mailboxControls": {
```

Replace with:

```json
    "followupCadenceReset": "Sıfırla",
    "followupCadenceSaved": "Kaydedildi",
    "scheduleHint": "Kampanyalarınızın keşif taramasını varsayılan olarak hangi saatte ve saat diliminde çalıştıracağını belirler. Kendi zamanlamasını geçersiz kılan bir kampanya bundan etkilenmez.",
    "scheduleTimezoneLabel": "Saat dilimi",
    "scheduleTimeLabel": "Varsayılan keşif saati",
    "scheduleSaveFailed": "Bu değişiklik kaydedilemedi. Lütfen tekrar deneyin.",
    "scheduleSaving": "Kaydediliyor…",
    "scheduleSaveChanges": "Değişiklikleri kaydet",
    "scheduleSaved": "Kaydedildi",
    "mailboxControls": {
```

- [x] **Step 8: Verify**

Run: `pnpm exec vitest run src/app/\(app\)/settings/schedule-actions.test.ts && pnpm exec tsc --noEmit`
Expected: tests PASS, no new type errors.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/settings/schedule-actions.ts" "src/app/(app)/settings/schedule-actions.test.ts" \
  "src/app/(app)/settings/schedule-section.tsx" "src/app/(app)/settings/page.tsx" \
  src/messages/en.json src/messages/tr.json
git commit -m "feat(settings): client timezone + default discovery time UI

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 13: Campaign form UI — per-campaign run-time/timezone override

**Files:**
- Modify: `src/app/(app)/campaigns/campaign-settings-fields.tsx`, `src/app/(app)/campaigns/new-campaign-form.tsx`, `src/app/(app)/campaigns/[campaignId]/edit/edit-campaign-form.tsx`, `src/messages/en.json`, `src/messages/tr.json`

**Interfaces:**
- Consumes: nothing new at the type level — plain form fields matching `campaignSettingsSchema`'s `discoverTime`/`discoverTimezone` (Task 6).
- Produces: both campaign forms submit `discoverTime`/`discoverTimezone` (`null` when left blank) to `POST /api/campaigns` and `PATCH /api/campaigns/[campaignId]`.

No new test file — this repo has no component tests for `new-campaign-form.tsx`/`edit-campaign-form.tsx` either (QUALITY.md scopes React component coverage to critical paths only; the underlying Zod validation is already covered by Task 6, and the route behavior by Tasks 7-8).

- [x] **Step 1: Extend `CampaignSettingsDefaults` and add the fieldset**

In `src/app/(app)/campaigns/campaign-settings-fields.tsx`, extend the interface:

```ts
export interface CampaignSettingsDefaults {
  valueProp: string
  bookingLink: string
  dailyTarget: number
  personTitles: string
  organizationLocations: string
  excludeOrganizationLocations: string
  employeeMin: number | ''
  employeeMax: number | ''
  keywords: string
  excludeKeywords: string
  personSeniorities: readonly string[]
  contactEmailStatuses: readonly string[]
  discoverTime: string
  discoverTimezone: string
}
```

Add a module-scope constant near the top of the file (after the existing `CONTACT_EMAIL_STATUS_KEY` map):

```ts
const TIMEZONE_OPTIONS: readonly string[] = Intl.supportedValuesOf('timeZone')
const NATIVE_SELECT_CLASSNAME =
  'border-input bg-transparent dark:bg-input/30 h-9 w-full min-w-0 rounded-md border px-3 py-1 text-sm shadow-xs outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50'
```

Insert a new fieldset in `CampaignSettingsFields`, right after the daily-target grid and before the ICP `<fieldset>`:

```tsx
      <div className="grid gap-5 sm:grid-cols-2">
        <Field
          id="discoverTime"
          label={t('newCampaignForm.discoverTimeLabel')}
          hint={t('newCampaignForm.discoverTimeHint')}
        >
          <input
            id="discoverTime"
            name="discoverTime"
            type="time"
            defaultValue={defaultValues.discoverTime}
            className={NATIVE_SELECT_CLASSNAME}
            toolparamdescription={t('newCampaignForm.discoverTimeToolParamDescription')}
          />
        </Field>

        <Field id="discoverTimezone" label={t('newCampaignForm.discoverTimezoneLabel')}>
          <select
            id="discoverTimezone"
            name="discoverTimezone"
            defaultValue={defaultValues.discoverTimezone}
            className={NATIVE_SELECT_CLASSNAME}
            toolparamdescription={t('newCampaignForm.discoverTimezoneToolParamDescription')}
          >
            <option value="">{t('newCampaignForm.discoverTimezoneInheritOption')}</option>
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </Field>
      </div>
```

- [x] **Step 2: Wire the fields into `new-campaign-form.tsx`**

Find the `body` object construction in `onSubmit` (the block starting `const body = {`), and add the two new fields:

```ts
    const body = {
      clientId,
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
      discoverTime: formData.get('discoverTime') ? String(formData.get('discoverTime')) : null,
      discoverTimezone: formData.get('discoverTimezone') ? String(formData.get('discoverTimezone')) : null,
    }
```

And in the `<CampaignSettingsFields defaultValues={{ ... }} />` call (find the block passing `contactEmailStatuses: []` as the last default), add:

```tsx
      <CampaignSettingsFields
        defaultValues={{
          valueProp: '',
          bookingLink: '',
          dailyTarget: 50,
          personTitles: '',
          organizationLocations: '',
          excludeOrganizationLocations: '',
          employeeMin: '',
          employeeMax: '',
          keywords: '',
          excludeKeywords: '',
          personSeniorities: [],
          contactEmailStatuses: ['verified'],
          discoverTime: '',
          discoverTimezone: '',
        }}
      />
```

(Match whatever the existing default values literally are for the other fields — only add the two new `discoverTime`/`discoverTimezone: ''` lines; do not change any other default.)

- [x] **Step 3: Wire the fields into `edit-campaign-form.tsx`**

Extend `EditCampaignFormProps`:

```ts
interface EditCampaignFormProps {
  campaignId: string
  clientName: string
  name: string
  valueProp: string
  bookingLink: string | null
  dailyTarget: number
  icp: ApolloIcpFilters
  discoverTime: string | null
  discoverTimezone: string | null
}
```

Add the two new destructured props to the function signature:

```ts
export function EditCampaignForm({
  campaignId,
  clientName,
  name,
  valueProp,
  bookingLink,
  dailyTarget,
  icp,
  discoverTime,
  discoverTimezone,
}: EditCampaignFormProps): React.ReactElement {
```

In `onSubmit`, add to the `body` object:

```ts
    const body = {
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
      discoverTime: formData.get('discoverTime') ? String(formData.get('discoverTime')) : null,
      discoverTimezone: formData.get('discoverTimezone') ? String(formData.get('discoverTimezone')) : null,
    }
```

And in the `<CampaignSettingsFields defaultValues={{ ... }} />` call:

```tsx
      <CampaignSettingsFields
        defaultValues={{
          valueProp,
          bookingLink: bookingLink ?? '',
          dailyTarget,
          personTitles: icp.personTitles.join(', '),
          organizationLocations: icp.organizationLocations.join(', '),
          excludeOrganizationLocations: icp.excludeOrganizationLocations.join(', '),
          employeeMin: icp.employeeRangeMin ?? '',
          employeeMax: icp.employeeRangeMax ?? '',
          keywords: icp.keywords.join(', '),
          excludeKeywords: icp.excludeKeywords.join(', '),
          personSeniorities: icp.personSeniorities,
          contactEmailStatuses: icp.contactEmailStatuses,
          discoverTime: discoverTime ?? '',
          discoverTimezone: discoverTimezone ?? '',
        }}
      />
```

- [x] **Step 4: Pass the new fields from the edit page loader**

Open `src/app/(app)/campaigns/[campaignId]/edit/page.tsx`. Find:

```tsx
      <EditCampaignForm
        campaignId={campaign.id}
        clientName={client?.name ?? t('editCampaignForm.unknownClient')}
        name={campaign.name}
        valueProp={campaign.value_prop ?? ''}
        bookingLink={campaign.booking_link}
        dailyTarget={campaign.daily_target}
        icp={icp}
      />
```

Replace with:

```tsx
      <EditCampaignForm
        campaignId={campaign.id}
        clientName={client?.name ?? t('editCampaignForm.unknownClient')}
        name={campaign.name}
        valueProp={campaign.value_prop ?? ''}
        bookingLink={campaign.booking_link}
        dailyTarget={campaign.daily_target}
        icp={icp}
        discoverTime={campaign.discover_time}
        discoverTimezone={campaign.discover_timezone}
      />
```

- [x] **Step 5: Add i18n keys**

In `src/messages/en.json`, find:

```json
      "dailyTargetToolParamDescription": "How many new people to pull from Apollo each day, 1 to 100. Defaults to 50.",
      "icpLegend": "Ideal customer profile",
```

Replace with:

```json
      "dailyTargetToolParamDescription": "How many new people to pull from Apollo each day, 1 to 100. Defaults to 50.",
      "discoverTimeLabel": "Discovery run time",
      "discoverTimeHint": "24-hour, in the timezone below. Leave blank to inherit the client's default.",
      "discoverTimeToolParamDescription": "The time of day (24-hour, HH:mm) this campaign's daily Apollo discovery run fires. Leave blank to inherit the client's default schedule.",
      "discoverTimezoneLabel": "Discovery timezone",
      "discoverTimezoneToolParamDescription": "The IANA timezone the discovery run time above is interpreted in. Leave blank to inherit the client's default timezone.",
      "discoverTimezoneInheritOption": "Inherit from client",
      "icpLegend": "Ideal customer profile",
```

In `src/messages/tr.json`, find:

```json
      "dailyTargetToolParamDescription": "Apollo'dan her gün kaç yeni kişi çekileceği, 1 ile 100 arası. Varsayılan 50.",
      "icpLegend": "İdeal müşteri profili",
```

Replace with:

```json
      "dailyTargetToolParamDescription": "Apollo'dan her gün kaç yeni kişi çekileceği, 1 ile 100 arası. Varsayılan 50.",
      "discoverTimeLabel": "Keşif çalışma saati",
      "discoverTimeHint": "24 saat formatında, aşağıdaki saat diliminde. Müşterinin varsayılanını kullanmak için boş bırakın.",
      "discoverTimeToolParamDescription": "Bu kampanyanın günlük Apollo keşif taramasının çalışacağı saat (24 saat formatı, SS:dd). Müşterinin varsayılan zamanlamasını kullanmak için boş bırakın.",
      "discoverTimezoneLabel": "Keşif saat dilimi",
      "discoverTimezoneToolParamDescription": "Yukarıdaki keşif saatinin yorumlanacağı IANA saat dilimi. Müşterinin varsayılan saat dilimini kullanmak için boş bırakın.",
      "discoverTimezoneInheritOption": "Müşteriden devral",
      "icpLegend": "İdeal müşteri profili",
```

`campaigns.newCampaignForm` is the only key group with a `dailyTargetToolParamDescription`/`icpLegend` pair in either file (verify with `grep -n '"icpLegend"' src/messages/en.json src/messages/tr.json` — exactly one match each) — `CampaignSettingsFields` is the only place these render, shared by both the create and edit forms, so one insertion per file is sufficient.

- [x] **Step 6: Verify**

Run: `pnpm exec tsc --noEmit`
Expected: no new type errors (in particular, `EditCampaignForm`'s new required props must be satisfied by its one caller, the edit page).

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/campaigns/campaign-settings-fields.tsx" "src/app/(app)/campaigns/new-campaign-form.tsx" \
  "src/app/(app)/campaigns/[campaignId]/edit/edit-campaign-form.tsx" "src/app/(app)/campaigns/[campaignId]/edit/page.tsx" \
  src/messages/en.json src/messages/tr.json
git commit -m "feat(campaigns): per-campaign discovery run-time/timezone override in the form

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 14: Full verification pass

**Files:** none (verification only).

- [x] **Step 1: Type-check the whole project**

Run: `pnpm exec tsc --noEmit`
Expected: no errors.

- [x] **Step 2: Lint**

Run: `pnpm exec eslint .`
Expected: no errors.

- [x] **Step 3: Run the full test suite**

Run: `pnpm exec vitest run`
Expected: all tests pass, including every file touched in Tasks 1-13.

- [x] **Step 4: Update the roadmap**

Per `CLAUDE.md`, append an entry to `.claude/roadmap.md` describing what shipped: per-client/per-campaign discovery scheduling + timezone, 5-minute poll cadence for research/write, link to the spec at `docs/superpowers/specs/2026-08-07-campaign-scheduling-design.md` and this plan at `docs/superpowers/plans/2026-08-07-campaign-scheduling.md`.

- [ ] **Step 5: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs(roadmap): log campaign scheduling + timezone feature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
