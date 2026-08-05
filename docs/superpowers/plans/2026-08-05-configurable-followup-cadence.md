# Configurable Follow-up Cadence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client set how many follow-up nudges go out after a first-touch email and how many days apart they are — a client-wide default on `/settings`, and a per-contact override on the case page — replacing the hardcoded 3/7/14-day, 3-step cadence in `followup.ts`.

**Architecture:** A `followup_delays_days integer[]` column on `clients` (the account-wide default, default `{3,7,14}`) and an identical column on `sequences` (snapshotted from the client default when a sequence is created, and the sole value the pipeline reads from then on). `runFollowupStep` computes its step count from `sequence.followup_delays_days.length` instead of a module constant, and gains a guard so a step that outlives a shrunk cadence quietly no-ops instead of sending. Two new Server Actions — one client-wide (`/settings`), one per-lead (`/cases/[id]`) — write to these columns through two new `lib/db` functions, sharing one Zod bounds schema and one editor UI component.

**Tech Stack:** Next.js Server Actions, Supabase/Postgres, Zod, Vitest, React/Tailwind.

## Global Constraints

- `src/types/database.ts` is hand-authored (no live `supabase gen types` connection) — edit it by hand to match the migration exactly.
- Bounds, shared by every write path: 1–10 follow-up steps, each 1–90 days. No ascending-order requirement — each array element is an independent step-to-step gap, not a cumulative offset.
- `sequences.followup_delays_days` is a snapshot taken once, at sequence creation, from `clients.followup_delays_days`. Changing the client default never retroactively touches an existing sequence; only the per-lead override (editing that sequence's own row) does.
- A cadence edit never changes the delay of a QStash message already published — only the delay computed for the *next* step after the edit.
- No `any`, no bare `Error` — `AppError` with a typed `code` on every failure path; every Supabase call destructures `{ data, error }` and handles both.
- One function per DB operation in `src/lib/db/`. Follow `.claude/QUALITY.md`.
- This codebase has no `.test.tsx` component tests anywhere (`vitest.config.ts` only includes `src/**/*.test.ts`, runs in a `node` environment, no DOM/testing-library setup) — new `.tsx` components are verified manually, matching every other component in `/inbox`, `/settings`, `/cases`.
- Never use array index as a `key` prop for a mutable list (BEHAVIORS.md) — the follow-up delays editor's rows are add/removable, so it must generate stable per-row keys (see Task 8).
- Design doc: `docs/superpowers/specs/2026-08-05-configurable-followup-cadence-design.md`.

---

### Task 1: Migration + hand-authored database types

**Files:**
- Create: `supabase/migrations/0028_configurable_followup_cadence.sql`
- Modify: `src/types/database.ts:12-41` (`clients` table), `src/types/database.ts:518-545` (`sequences` table)

**Interfaces:**
- Consumes: nothing new.
- Produces: `ClientRow['followup_delays_days']: number[]`, `ClientInsert['followup_delays_days']?: number[]`, `SequenceRow['followup_delays_days']: number[]`, `SequenceInsert['followup_delays_days']?: number[]` — used by every later task.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0028_configurable_followup_cadence.sql`:

```sql
-- supabase/migrations/0028_configurable_followup_cadence.sql
-- Client-wide default cadence (edited on /settings) and the per-lead
-- snapshot/override the pipeline actually reads from (edited on a case
-- page). Both default to today's hardcoded 3/7/14-day, 3-step cadence, so
-- every existing row keeps sending on exactly the schedule it does today.
-- See docs/superpowers/specs/2026-08-05-configurable-followup-cadence-design.md

alter table clients add column followup_delays_days integer[] not null default '{3,7,14}';
alter table sequences add column followup_delays_days integer[] not null default '{3,7,14}';
```

- [ ] **Step 2: Update `src/types/database.ts` for `clients`**

In `src/types/database.ts`, the `clients` table (lines 12-41) currently reads:

```ts
      clients: {
        Row: {
          id: string
          name: string
          status: Database['public']['Enums']['client_status']
          settings: Json
          warmup_profile: Database['public']['Enums']['warmup_profile']
          mailreach_enabled: boolean
          reply_mode: Database['public']['Enums']['reply_mode']
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
          reply_mode?: Database['public']['Enums']['reply_mode']
          domain?: string | null
          logo_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
```

Replace with:

```ts
      clients: {
        Row: {
          id: string
          name: string
          status: Database['public']['Enums']['client_status']
          settings: Json
          warmup_profile: Database['public']['Enums']['warmup_profile']
          mailreach_enabled: boolean
          reply_mode: Database['public']['Enums']['reply_mode']
          followup_delays_days: number[]
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
          reply_mode?: Database['public']['Enums']['reply_mode']
          followup_delays_days?: number[]
          domain?: string | null
          logo_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
```

- [ ] **Step 3: Update `src/types/database.ts` for `sequences`**

In `src/types/database.ts`, the `sequences` table's `Row`/`Insert` (lines 519-544) currently reads:

```ts
        Row: {
          id: string
          client_id: string
          case_id: string
          lead_id: string
          state: Database['public']['Enums']['sequence_state']
          current_step: number
          next_action_at: string | null
          qstash_message_id: string | null
          skip_next_step: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          lead_id: string
          state?: Database['public']['Enums']['sequence_state']
          current_step?: number
          next_action_at?: string | null
          qstash_message_id?: string | null
          skip_next_step?: boolean
          created_at?: string
          updated_at?: string
        }
```

Replace with:

```ts
        Row: {
          id: string
          client_id: string
          case_id: string
          lead_id: string
          state: Database['public']['Enums']['sequence_state']
          current_step: number
          next_action_at: string | null
          qstash_message_id: string | null
          skip_next_step: boolean
          followup_delays_days: number[]
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          lead_id: string
          state?: Database['public']['Enums']['sequence_state']
          current_step?: number
          next_action_at?: string | null
          qstash_message_id?: string | null
          skip_next_step?: boolean
          followup_delays_days?: number[]
          created_at?: string
          updated_at?: string
        }
```

(`Update` on both tables is already `Partial<...Insert>` — no change needed there.)

- [ ] **Step 4: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: no errors (both new columns are additive and optional on `Insert`, so no existing call site breaks).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0028_configurable_followup_cadence.sql src/types/database.ts
git commit -m "feat(db): add followup_delays_days to clients and sequences"
```

---

### Task 2: Shared validation — `src/lib/validation/followup-limits.ts`

**Files:**
- Create: `src/lib/validation/followup-limits.ts`
- Test: `src/lib/validation/followup-limits.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `MIN_FOLLOWUP_STEPS`, `MAX_FOLLOWUP_STEPS`, `MIN_FOLLOWUP_DELAY_DAYS`, `MAX_FOLLOWUP_DELAY_DAYS` (all `number`), `DEFAULT_FOLLOWUP_DELAYS_DAYS: number[]`, `followupDelaysSchema: z.ZodArray<z.ZodNumber>` — used by Tasks 4, 6, 7, 9, 10.

- [ ] **Step 1: Write the failing test**

Create `src/lib/validation/followup-limits.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { followupDelaysSchema, MIN_FOLLOWUP_STEPS, MAX_FOLLOWUP_STEPS, MAX_FOLLOWUP_DELAY_DAYS } from './followup-limits'

describe('followupDelaysSchema', () => {
  it('should accept the default 3/7/14 cadence', () => {
    const result = followupDelaysSchema.safeParse([3, 7, 14])
    expect(result.success).toBe(true)
  })

  it('should coerce string form-data values to numbers', () => {
    const result = followupDelaysSchema.safeParse(['3', '7', '14'])
    expect(result).toMatchObject({ success: true, data: [3, 7, 14] })
  })

  it('should reject an empty array (below the step floor)', () => {
    const result = followupDelaysSchema.safeParse([])
    expect(result.success).toBe(false)
  })

  it('should reject more than MAX_FOLLOWUP_STEPS entries', () => {
    const result = followupDelaysSchema.safeParse(Array.from({ length: MAX_FOLLOWUP_STEPS + 1 }, () => 3))
    expect(result.success).toBe(false)
  })

  it('should accept exactly MIN_FOLLOWUP_STEPS entries', () => {
    const result = followupDelaysSchema.safeParse(Array.from({ length: MIN_FOLLOWUP_STEPS }, () => 5))
    expect(result.success).toBe(true)
  })

  it('should reject a day value below 1', () => {
    const result = followupDelaysSchema.safeParse([0])
    expect(result.success).toBe(false)
  })

  it('should reject a day value above MAX_FOLLOWUP_DELAY_DAYS', () => {
    const result = followupDelaysSchema.safeParse([MAX_FOLLOWUP_DELAY_DAYS + 1])
    expect(result.success).toBe(false)
  })

  it('should reject a non-integer day value', () => {
    const result = followupDelaysSchema.safeParse([3.5])
    expect(result.success).toBe(false)
  })

  it('should not require ascending order', () => {
    const result = followupDelaysSchema.safeParse([14, 3, 7])
    expect(result.success).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/validation/followup-limits.test.ts`
Expected: FAIL — `./followup-limits` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/lib/validation/followup-limits.ts`:

```ts
import { z } from 'zod'

// Shared between the client-default Settings form and the per-lead override
// form on a case page, so the two never validate against different bounds.
export const MIN_FOLLOWUP_STEPS = 1
export const MAX_FOLLOWUP_STEPS = 10
export const MIN_FOLLOWUP_DELAY_DAYS = 1
export const MAX_FOLLOWUP_DELAY_DAYS = 90

// Today's hardcoded cadence, preserved as the default for both clients.followup_delays_days
// (column default) and any caller needing a fallback (see scheduleFirstFollowup).
export const DEFAULT_FOLLOWUP_DELAYS_DAYS: number[] = [3, 7, 14]

// z.coerce because every write path is a Server Action reading FormData —
// formData.getAll('delaysDays') always yields strings.
export const followupDelaysSchema = z
  .array(z.coerce.number().int().min(MIN_FOLLOWUP_DELAY_DAYS).max(MAX_FOLLOWUP_DELAY_DAYS))
  .min(MIN_FOLLOWUP_STEPS)
  .max(MAX_FOLLOWUP_STEPS)
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/validation/followup-limits.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/followup-limits.ts src/lib/validation/followup-limits.test.ts
git commit -m "feat: add shared followup-delays validation schema"
```

---

### Task 3: `updateClientFollowupDelays` in `lib/db/clients.ts`

**Files:**
- Modify: `src/lib/db/clients.ts` (insert after `updateClientReplyMode`, at the end of the file before `updateClientStatus`)
- Test: `src/lib/db/clients.test.ts` (add after the `updateClientReplyMode` describe block, and add the import)

**Interfaces:**
- Consumes: `ClientRow` (already exported from this file).
- Produces: `updateClientFollowupDelays(supabase: SupabaseClient<Database>, id: string, delaysDays: number[]): Promise<ClientRow>` — used by the Settings Server Action in Task 9.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/clients.test.ts`, add `updateClientFollowupDelays` to the top-of-file import from `./clients` (alongside `updateClientReplyMode`), then add this block at the end of the file:

```ts
describe('updateClientFollowupDelays', () => {
  it('should persist the cadence and return the updated row', async () => {
    const row = { id: 'c1', followup_delays_days: [2, 5, 9] }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientFollowupDelays({ from: () => ({ update }) } as never, 'c1', [2, 5, 9])
    expect(update).toHaveBeenCalledWith({ followup_delays_days: [2, 5, 9] })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientFollowupDelays({ from: () => ({ update }) } as never, 'c1', [3, 7, 14]),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/clients.test.ts -t "updateClientFollowupDelays"`
Expected: FAIL — `updateClientFollowupDelays` is not exported from `./clients`.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/clients.ts`, insert at the end of the file, after `updateClientReplyMode` and before `updateClientStatus`:

```ts
// The client-level default. Sequences snapshot it at creation time rather
// than reading it live (see scheduleFirstFollowup in lib/pipeline/followup.ts),
// so changing this never retroactively reschedules a sequence already
// running — a per-lead override on that sequence's own row does that.
export async function updateClientFollowupDelays(
  supabase: SupabaseClient<Database>,
  id: string,
  delaysDays: number[],
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ followup_delays_days: delaysDays })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client follow-up delays', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/db/clients.test.ts -t "updateClientFollowupDelays"`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts
git commit -m "feat: add updateClientFollowupDelays to lib/db/clients"
```

---

### Task 4: `listSequencesForCase` and `updateSequenceFollowupDelays` in `lib/db/sequences.ts`

**Files:**
- Modify: `src/lib/db/sequences.ts` (append both functions at the end of the file)
- Test: `src/lib/db/sequences.test.ts` (add both imports, append two describe blocks)

**Interfaces:**
- Consumes: `SequenceRow` (already exported from this file).
- Produces: `listSequencesForCase(supabase: SupabaseClient<Database>, caseId: string): Promise<SequenceRow[]>` — used by the case page in Task 10. `updateSequenceFollowupDelays(supabase: SupabaseClient<Database>, leadId: string, delaysDays: number[]): Promise<SequenceRow | null>` — used by the per-lead Server Action in Task 10.

- [ ] **Step 1: Write the failing tests**

In `src/lib/db/sequences.test.ts`, add `listSequencesForCase, updateSequenceFollowupDelays` to the top-of-file import from `./sequences`, then append at the end of the file:

```ts
describe('listSequencesForCase', () => {
  it('should return every sequence for the case', async () => {
    const rows = [{ id: 'seq1', case_id: 'case1', lead_id: 'lead1' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listSequencesForCase(supabase, 'case1')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listSequencesForCase(supabase, 'case1')).rejects.toBeInstanceOf(AppError)
  })
})

function mockUpdateInSelect(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      update: () => ({ eq: () => ({ in: () => ({ select: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('updateSequenceFollowupDelays', () => {
  it('should persist the cadence and return the updated row', async () => {
    const row = { id: 'seq1', lead_id: 'lead1', followup_delays_days: [2, 5] }
    const result = await updateSequenceFollowupDelays(mockUpdateInSelect({ data: [row], error: null }), 'lead1', [2, 5])
    expect(result).toEqual(row)
  })

  it('should return null when the lead has no active or paused sequence', async () => {
    const result = await updateSequenceFollowupDelays(mockUpdateInSelect({ data: [], error: null }), 'lead1', [2, 5])
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateSequenceFollowupDelays(mockUpdateInSelect({ data: null, error: { message: 'boom' } }), 'lead1', [2, 5]),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/db/sequences.test.ts`
Expected: FAIL — `listSequencesForCase`/`updateSequenceFollowupDelays` are not exported from `./sequences`.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/sequences.ts`, append at the end of the file:

```ts
// Every sequence for a case in one query — the case page renders every
// contact's status at once and must not issue one query per lead.
export async function listSequencesForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<SequenceRow[]> {
  const { data, error } = await supabase.from('sequences').select('*').eq('case_id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list sequences for case', { caseId, cause: error.message })
  }
  return data ?? []
}

// Overwrites the effective cadence for one lead's sequence — the per-lead
// override. Guarded to active/paused sequences only: a stopped/completed
// sequence has nothing left to reschedule, so this returns null rather than
// silently writing to a dead row (same "already gone" shape as
// updateDraftContent in lib/db/emails.ts).
export async function updateSequenceFollowupDelays(
  supabase: SupabaseClient<Database>,
  leadId: string,
  delaysDays: number[],
): Promise<SequenceRow | null> {
  const { data, error } = await supabase
    .from('sequences')
    .update({ followup_delays_days: delaysDays })
    .eq('lead_id', leadId)
    .in('state', ['active', 'paused'])
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update sequence follow-up delays', { leadId, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/db/sequences.test.ts`
Expected: PASS (all existing tests plus 5 new ones)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/sequences.ts src/lib/db/sequences.test.ts
git commit -m "feat: add listSequencesForCase and updateSequenceFollowupDelays"
```

---

### Task 5: `formatFollowupCountdown` and `formatFollowupStatus` in `lib/format.ts`

**Files:**
- Modify: `src/lib/format.ts` (append both functions at the end of the file)
- Test: Create `src/lib/format.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `formatFollowupCountdown(nextActionAtIso: string | null, now: Date): string | null`, `formatFollowupStatus(currentStep: number, totalSteps: number, countdown: string | null): string` — both used by the case page and `LeadFollowupControl` in Task 10.

- [ ] **Step 1: Write the failing test**

Create `src/lib/format.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatFollowupCountdown, formatFollowupStatus } from './format'

const NOW = new Date('2026-08-05T12:00:00.000Z')

describe('formatFollowupCountdown', () => {
  it('should return null when there is nothing scheduled', () => {
    expect(formatFollowupCountdown(null, NOW)).toBeNull()
  })

  it('should round up to the next whole day', () => {
    const in36Hours = new Date(NOW.getTime() + 36 * 60 * 60 * 1000).toISOString()
    expect(formatFollowupCountdown(in36Hours, NOW)).toBe('2d')
  })

  it('should return "today" for a timestamp in the past or present', () => {
    const anHourAgo = new Date(NOW.getTime() - 60 * 60 * 1000).toISOString()
    expect(formatFollowupCountdown(anHourAgo, NOW)).toBe('today')
    expect(formatFollowupCountdown(NOW.toISOString(), NOW)).toBe('today')
  })

  it('should return null for an unparseable timestamp', () => {
    expect(formatFollowupCountdown('not-a-date', NOW)).toBeNull()
  })
})

describe('formatFollowupStatus', () => {
  it('should include the countdown clause when one is given', () => {
    expect(formatFollowupStatus(1, 3, '3d')).toBe('1/3 follow-ups sent · next in 3d')
  })

  it('should omit the countdown clause when null', () => {
    expect(formatFollowupStatus(3, 3, null)).toBe('3/3 follow-ups sent')
  })

  it('should use the singular "follow-up" for a one-step cadence', () => {
    expect(formatFollowupStatus(0, 1, '5d')).toBe('0/1 follow-up sent · next in 5d')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/format.test.ts`
Expected: FAIL — `formatFollowupCountdown`/`formatFollowupStatus` are not exported from `./format`.

- [ ] **Step 3: Write the implementation**

In `src/lib/format.ts`, append at the end of the file:

```ts
/**
 * "3d" / "today" for a future timestamp; null when nothing is scheduled
 * (sequence paused, exhausted, or no next follow-up yet). `now` is explicit
 * for the same server/client hydration reason as formatRelative.
 */
export function formatFollowupCountdown(nextActionAtIso: string | null, now: Date): string | null {
  if (!nextActionAtIso) return null
  const next = new Date(nextActionAtIso)
  const remainingMs = next.getTime() - now.getTime()
  if (Number.isNaN(remainingMs)) return null
  if (remainingMs <= 0) return 'today'
  return `${Math.ceil(remainingMs / DAY_MS)}d`
}

/** e.g. "1/3 follow-ups sent · next in 3d" — the countdown clause is omitted
 *  when nothing is currently scheduled. */
export function formatFollowupStatus(currentStep: number, totalSteps: number, countdown: string | null): string {
  const sent = `${currentStep}/${totalSteps} follow-up${totalSteps === 1 ? '' : 's'} sent`
  return countdown ? `${sent} · next in ${countdown}` : sent
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/format.test.ts`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/format.ts src/lib/format.test.ts
git commit -m "feat: add formatFollowupCountdown and formatFollowupStatus"
```

---

### Task 6: Rewrite `lib/pipeline/followup.ts` to use per-sequence cadence

**Files:**
- Modify: `src/lib/pipeline/followup.ts`
- Modify: `src/lib/pipeline/collision-notify.ts:16` (comment only)
- Test: `src/lib/pipeline/followup.test.ts` (full rewrite)

**Interfaces:**
- Consumes: `getClientById` (`@/lib/db/clients`, already exists); `DEFAULT_FOLLOWUP_DELAYS_DAYS` (`@/lib/validation/followup-limits`, Task 2).
- Produces: `scheduleFirstFollowup` and `runFollowupStep` keep their existing signatures. `FOLLOWUP_DELAYS_SECONDS` and `MAX_FOLLOWUP_STEP` are **removed** as exports — Task 7 updates the one remaining consumer (`route.ts`).

- [ ] **Step 1: Update the failing test file first (drives the implementation)**

Replace the full contents of `src/lib/pipeline/followup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSequenceByIdMock = vi.fn()
const consumeFollowupSkipMock = vi.fn()
const hasInboundReplyMock = vi.fn()
const stopSequenceMock = vi.fn()
const advanceSequenceMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getClientByIdMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const isSuppressedMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateTextMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const publishDelayMock = vi.fn()
const logEventMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const createSequenceMock = vi.fn()

vi.mock('@/lib/db/sequences', () => ({
  getSequenceById: (...a: unknown[]) => getSequenceByIdMock(...a),
  createSequence: (...a: unknown[]) => createSequenceMock(...a),
  stopSequence: (...a: unknown[]) => stopSequenceMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
  consumeFollowupSkip: (...a: unknown[]) => consumeFollowupSkipMock(...a),
}))
vi.mock('@/lib/db/emails', () => ({
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ isSuppressed: (...a: unknown[]) => isSuppressedMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a), logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/knowledge/client-context', () => ({ retrieveClientKnowledge: vi.fn().mockResolvedValue('') }))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))

import { runFollowupStep, scheduleFirstFollowup } from './followup'

const DAY_SECONDS = 86_400

// 3/7/14 default cadence, snapshotted onto the sequence — matches every
// existing sequence row until a client or per-lead edit changes it.
const sequence = {
  id: 'seq1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  current_step: 0, state: 'active', followup_delays_days: [3, 7, 14],
}
const lead = { id: 'lead1', email: 'jane@acme.com', full_name: 'Jane', title: 'CTO' }

beforeEach(() => {
  for (const m of [getSequenceByIdMock, hasInboundReplyMock, stopSequenceMock, advanceSequenceMock,
    getLeadByIdMock, getClientByIdMock, listThreadEmailsMock, claimOutboundEmailMock, markEmailSentMock,
    markEmailFailedMock, isSuppressedMock, sendViaMailboxMock, generateTextMock, getCampaignForCaseMock,
    updateCaseStatusMock, publishDelayMock, logEventMock, consumeFollowupSkipMock, enqueueCrmSyncMock,
    createSequenceMock]) m.mockReset()
  getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: false })
  consumeFollowupSkipMock.mockResolvedValue(false)
  hasInboundReplyMock.mockResolvedValue(false)
  getLeadByIdMock.mockResolvedValue(lead)
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14] })
  isSuppressedMock.mockResolvedValue(false)
  listThreadEmailsMock.mockResolvedValue([
    { direction: 'outbound', subject: 'Quick idea', body: 'Hi', thread_id: 'thr1', provider_message_id: '<a@mail>' },
  ])
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'active' })
  generateTextMock.mockResolvedValue('Just following up, Jane.')
})

describe('scheduleFirstFollowup', () => {
  it('should snapshot the client default cadence onto the new sequence and schedule step 1', async () => {
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })

    expect(createSequenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      client_id: 'c1', case_id: 'case1', lead_id: 'lead1', followup_delays_days: [3, 7, 14],
    }))
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, 3 * DAY_SECONDS,
    )
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 0, nextActionAt: expect.any(String), qstashMessageId: 'qmsg1',
    })
  })

  it('should fall back to the default cadence when the client lookup returns null', async () => {
    getClientByIdMock.mockResolvedValue(null)
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })

    expect(createSequenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      followup_delays_days: [3, 7, 14],
    }))
  })

  it('should no-op when a sequence already exists for the lead', async () => {
    createSequenceMock.mockResolvedValue(null)
    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should use a client cadence other than the default', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [1, 4] })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await scheduleFirstFollowup({} as never, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })

    expect(createSequenceMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      followup_delays_days: [1, 4],
    }))
    expect(publishDelayMock).toHaveBeenCalledWith('/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, 1 * DAY_SECONDS)
  })
})

describe('runFollowupStep', () => {
  it('should send the nudge, advance the step, and enqueue the next follow-up', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('sent')
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 1, nextActionAt: expect.any(String), qstashMessageId: 'qmsg2',
    })
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 2 }, 7 * DAY_SECONDS,
    )
  })

  it('should complete the sequence when a reply exists', async () => {
    hasInboundReplyMock.mockResolvedValue(true)
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('completed')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'completed')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence and mark the case dead after the final step', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 }) // sitting at step 2, driving step 3 (of 3)
    claimOutboundEmailMock.mockResolvedValue({ id: 'e4' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<d@mail>', threadId: 'thr1' })
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('stopped')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'dead')
    expect(publishDelayMock).not.toHaveBeenCalled() // nothing after step 3
  })

  it('should skip when the sequence step no longer matches (stale/duplicate delivery)', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 }) // already past step 1
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should skip without sending when a shrunk cadence no longer has this step', async () => {
    // Cadence was 3 steps when step 3 was enqueued; a client edit since then
    // shrank it to 1. QStash still delivers the old step-3 message on its
    // original timer — it must no-op, not send an unwanted extra nudge.
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2, followup_delays_days: [3] })
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(stopSequenceMock).not.toHaveBeenCalled()
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should keep going past the old 3-step ceiling when the cadence was grown', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2, followup_delays_days: [3, 7, 14, 21, 28] })
    claimOutboundEmailMock.mockResolvedValue({ id: 'e4' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<d@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg4')
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('sent')
    expect(stopSequenceMock).not.toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 4 }, 21 * DAY_SECONDS,
    )
  })

  it('should mark the email failed and return skipped when every mailbox is rate limited', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no mailbox available'))
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('skipped')
    expect(markEmailFailedMock).toHaveBeenCalledWith(expect.anything(), 'e2')
    expect(markEmailSentMock).not.toHaveBeenCalled()
  })

  it('should not mark the email failed when the send succeeded but markEmailSent throws', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    markEmailSentMock.mockRejectedValue(new Error('db unreachable'))

    await expect(runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })).rejects.toThrow('db unreachable')
    expect(markEmailFailedMock).not.toHaveBeenCalled()
  })

  it('should skip and reschedule the same step when the campaign is not active', async () => {
    getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'paused' })
    publishDelayMock.mockResolvedValue('msg-retry-1')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result).toEqual({ sequenceId: 'seq1', action: 'skipped' })
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup',
      { sequenceId: 'seq1', step: 1 },
      expect.any(Number),
    )
  })
})

describe('runFollowupStep — manual-send skip', () => {
  it('should send nothing, consume the flag and enqueue the next step', async () => {
    consumeFollowupSkipMock.mockResolvedValue(true)
    publishDelayMock.mockResolvedValue('qmsg-next')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
    expect(consumeFollowupSkipMock).toHaveBeenCalledWith(expect.anything(), 'seq1')
    // Step 2 enqueued at the step-1 delay index (7 days).
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup',
      { sequenceId: 'seq1', step: 2 },
      7 * DAY_SECONDS,
    )
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 1, nextActionAt: expect.any(String), qstashMessageId: 'qmsg-next',
    })
  })

  it('should not enqueue twice when another delivery already consumed the flag', async () => {
    consumeFollowupSkipMock.mockResolvedValue(false)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(publishDelayMock).not.toHaveBeenCalled()
    expect(advanceSequenceMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence on a skipped final step without killing the case', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 })
    consumeFollowupSkipMock.mockResolvedValue(true)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })

    expect(result.action).toBe('skipped')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'stopped')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should let an inbound reply win over a pending skip', async () => {
    consumeFollowupSkipMock.mockResolvedValue(true)
    hasInboundReplyMock.mockResolvedValue(true)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('completed')
    expect(consumeFollowupSkipMock).not.toHaveBeenCalled()
  })

  it('should postpone the skip while the campaign is paused', async () => {
    consumeFollowupSkipMock.mockResolvedValue(true)
    getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'paused' })
    publishDelayMock.mockResolvedValue('qmsg-retry')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(consumeFollowupSkipMock).not.toHaveBeenCalled()
    // Same step re-queued, so the skip is still pending when the client resumes.
    expect(publishDelayMock).toHaveBeenCalledWith(
      '/api/pipeline/followup', { sequenceId: 'seq1', step: 1 }, expect.any(Number),
    )
  })

  it('should honor a skip requested after this run already loaded a stale sequence snapshot', async () => {
    // Regression test for the race this fix closes: the initial getSequenceById
    // read has skip_next_step: false, but a concurrent manual send flips the DB
    // flag before this run reaches the skip check. consumeFollowupSkip is the
    // atomic, DB-level source of truth here, not the in-memory `sequence` object.
    getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: false })
    consumeFollowupSkipMock.mockResolvedValue(true)
    publishDelayMock.mockResolvedValue('qmsg-race')

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(generateTextMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run src/lib/pipeline/followup.test.ts`
Expected: FAIL — `scheduleFirstFollowup` doesn't yet call `getClientById`/snapshot the array; `FOLLOWUP_DELAYS_SECONDS`/`MAX_FOLLOWUP_STEP` indexing means the new shrink/grow tests and `nextActionAt` assertions don't match.

- [ ] **Step 3: Update the imports and remove the two module constants**

In `src/lib/pipeline/followup.ts`, replace lines 1-34:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  getSequenceById,
  createSequence,
  advanceSequence,
  stopSequence,
  consumeFollowupSkip,
} from '@/lib/db/sequences'
import {
  hasInboundReply,
  listThreadEmails,
  claimOutboundEmail,
  markEmailSent,
  markEmailFailed,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateText, type LlmCallContext } from '@/lib/llm/client'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'

const DAY_SECONDS = 86_400
export const FOLLOWUP_DELAYS_SECONDS: readonly number[] = [3 * DAY_SECONDS, 7 * DAY_SECONDS, 14 * DAY_SECONDS]
export const MAX_FOLLOWUP_STEP = 3
export const FIRST_TOUCH_STEP = 0
```

with:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  getSequenceById,
  createSequence,
  advanceSequence,
  stopSequence,
  consumeFollowupSkip,
} from '@/lib/db/sequences'
import {
  hasInboundReply,
  listThreadEmails,
  claimOutboundEmail,
  markEmailSent,
  markEmailFailed,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getClientById } from '@/lib/db/clients'
import { isSuppressed } from '@/lib/db/suppressions'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateText, type LlmCallContext } from '@/lib/llm/client'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { logEventSafe } from '@/lib/events/log-event'
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
import { DEFAULT_FOLLOWUP_DELAYS_DAYS } from '@/lib/validation/followup-limits'

const DAY_SECONDS = 86_400
export const FIRST_TOUCH_STEP = 0
```

- [ ] **Step 4: Rewrite `scheduleFirstFollowup` to snapshot the client's cadence**

Replace the existing `scheduleFirstFollowup` function:

```ts
// Shared post-first-touch bookkeeping: create the sequence row and enqueue the
// step-1 follow-up (3-day delay). Idempotent — createSequence returns null when
// a sequence already exists for the lead, so a retry never double-schedules.
// Called by both the automated write path and the manual /inbox approval path.
export async function scheduleFirstFollowup(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; caseId: string; leadId: string },
): Promise<void> {
  const sequence = await createSequence(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: input.leadId,
    current_step: FIRST_TOUCH_STEP,
    state: 'active',
  })
  if (!sequence) return
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: 1 },
    FOLLOWUP_DELAYS_SECONDS[0]!, // step 1 delay (3d); index 0 always exists
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: FIRST_TOUCH_STEP,
    nextActionAt: null,
    qstashMessageId: messageId,
  })
}
```

with:

```ts
// Shared post-first-touch bookkeeping: create the sequence row — snapshotting
// the client's current default cadence onto it, so a later change to that
// default never reaches back into this sequence (see
// docs/superpowers/specs/2026-08-05-configurable-followup-cadence-design.md §3)
// — and enqueue the step-1 follow-up. Idempotent — createSequence returns null
// when a sequence already exists for the lead, so a retry never
// double-schedules. Called by both the automated write path and the manual
// /inbox approval path.
export async function scheduleFirstFollowup(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; caseId: string; leadId: string },
): Promise<void> {
  const client = await getClientById(supabase, input.clientId)
  const delaysDays = client?.followup_delays_days ?? DEFAULT_FOLLOWUP_DELAYS_DAYS
  const sequence = await createSequence(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: input.leadId,
    current_step: FIRST_TOUCH_STEP,
    state: 'active',
    followup_delays_days: delaysDays,
  })
  if (!sequence) return
  const delaySeconds = delaysDays[0]! * DAY_SECONDS // array is never empty — schema floor is 1 (Task 2)
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: 1 },
    delaySeconds,
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: FIRST_TOUCH_STEP,
    nextActionAt: new Date(Date.now() + delaySeconds * 1000).toISOString(),
    qstashMessageId: messageId,
  })
}
```

- [ ] **Step 5: Thread `maxStep` through `buildNudgePrompt`**

Replace the `buildNudgePrompt` function signature and its first array entry:

```ts
function buildNudgePrompt(
  priorSubject: string,
  priorBody: string,
  valueProp: string | null,
  bookingLink: string | null,
  step: number,
  clientKnowledge: string,
): string {
  const showBookingLink = bookingLink !== null && step >= BOOKING_LINK_ELIGIBLE_STEP
  return [
    `This is follow-up number ${step} (of ${MAX_FOLLOWUP_STEP}).`,
```

with:

```ts
function buildNudgePrompt(
  priorSubject: string,
  priorBody: string,
  valueProp: string | null,
  bookingLink: string | null,
  step: number,
  maxStep: number,
  clientKnowledge: string,
): string {
  const showBookingLink = bookingLink !== null && step >= BOOKING_LINK_ELIGIBLE_STEP
  return [
    `This is follow-up number ${step} (of ${maxStep}).`,
```

- [ ] **Step 6: Compute `maxStep` and add the shrunk-cadence guard in `runFollowupStep`**

Replace:

```ts
  const sequence = await getSequenceById(supabase, input.sequenceId)
  if (!sequence) throw new AppError('NOT_FOUND', 'Sequence not found', { sequenceId: input.sequenceId })

  // Stale/duplicate QStash delivery guard: this message drives step N only when
  // the sequence is still active and sitting at step N-1.
  if (sequence.state !== 'active' || sequence.current_step !== input.step - 1) {
    return { sequenceId: sequence.id, action: 'skipped' }
  }
```

with:

```ts
  const sequence = await getSequenceById(supabase, input.sequenceId)
  if (!sequence) throw new AppError('NOT_FOUND', 'Sequence not found', { sequenceId: input.sequenceId })

  const maxStep = sequence.followup_delays_days.length

  // Stale/duplicate QStash delivery guard: this message drives step N only when
  // the sequence is still active and sitting at step N-1.
  if (sequence.state !== 'active' || sequence.current_step !== input.step - 1) {
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  // The cadence may have been shrunk (fewer follow-ups) since this step was
  // enqueued — its QStash delay was fixed at publish time and can't be pulled
  // back. A step beyond the current array length is stale and must not send.
  if (input.step > maxStep) {
    return { sequenceId: sequence.id, action: 'skipped' }
  }
```

- [ ] **Step 7: Replace `MAX_FOLLOWUP_STEP`/`FOLLOWUP_DELAYS_SECONDS` in the manual-skip branch**

Replace:

```ts
  const consumedSkip = await consumeFollowupSkip(supabase, sequence.id)
  if (consumedSkip) {
    if (input.step >= MAX_FOLLOWUP_STEP) {
      await stopSequence(supabase, sequence.id, 'stopped')
      // Deliberately NOT updateCaseStatus('dead'), unlike the send path below:
      // a human is in this thread, so the case is not a cold lead that ran out
      // of nudges.
      await logEventSafe({
        clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
        type: 'pipeline.followup.skipped_final', payload: { sequenceId: sequence.id, step: input.step },
      })
      return { sequenceId: sequence.id, action: 'skipped' }
    }

    const skipMessageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: input.step + 1 },
      FOLLOWUP_DELAYS_SECONDS[input.step]!, // same index rule as the send path; always in range for step < MAX
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: input.step,
      nextActionAt: null,
      qstashMessageId: skipMessageId,
    })
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.skipped_manual', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'skipped' }
  }
```

with:

```ts
  const consumedSkip = await consumeFollowupSkip(supabase, sequence.id)
  if (consumedSkip) {
    if (input.step >= maxStep) {
      await stopSequence(supabase, sequence.id, 'stopped')
      // Deliberately NOT updateCaseStatus('dead'), unlike the send path below:
      // a human is in this thread, so the case is not a cold lead that ran out
      // of nudges.
      await logEventSafe({
        clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
        type: 'pipeline.followup.skipped_final', payload: { sequenceId: sequence.id, step: input.step },
      })
      return { sequenceId: sequence.id, action: 'skipped' }
    }

    // Same index rule as the send path below (Step 9): always in range for step < maxStep.
    const skipDelaySeconds = sequence.followup_delays_days[input.step]! * DAY_SECONDS
    const skipMessageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: input.step + 1 },
      skipDelaySeconds,
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: input.step,
      nextActionAt: new Date(Date.now() + skipDelaySeconds * 1000).toISOString(),
      qstashMessageId: skipMessageId,
    })
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.skipped_manual', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'skipped' }
  }
```

- [ ] **Step 8: Pass `maxStep` into the `generateText` call**

Replace:

```ts
  const nudgeBody = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildNudgePrompt(
      priorSubject,
      firstOutbound?.body ?? '',
      campaign.value_prop,
      campaign.booking_link,
      input.step,
      clientKnowledge,
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
```

with:

```ts
  const nudgeBody = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildNudgePrompt(
      priorSubject,
      firstOutbound?.body ?? '',
      campaign.value_prop,
      campaign.booking_link,
      input.step,
      maxStep,
      clientKnowledge,
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
```

- [ ] **Step 9: Replace `MAX_FOLLOWUP_STEP`/`FOLLOWUP_DELAYS_SECONDS` in the send path**

Replace:

```ts
  // Final step? Stop the sequence and mark the case dead. Otherwise advance and
  // enqueue the next delay (index step-1 → step's own delay; step 1 used index 0
  // at first-touch, so step N enqueues index N).
  if (input.step >= MAX_FOLLOWUP_STEP) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, sequence.case_id, 'dead')
    await enqueueCrmSync(sequence.case_id, 'dead')
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const nextStep = input.step + 1
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: nextStep },
    FOLLOWUP_DELAYS_SECONDS[input.step]!, // index = current step → delay before nextStep; always in range for step < MAX
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: input.step,
    nextActionAt: null,
    qstashMessageId: messageId,
  })
  await logEventSafe({
    clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
    type: 'pipeline.followup.sent', payload: { sequenceId: sequence.id, step: input.step },
  })
  return { sequenceId: sequence.id, action: 'sent' }
}
```

with:

```ts
  // Final step? Stop the sequence and mark the case dead. Otherwise advance and
  // enqueue the next delay (index step-1 → step's own delay; step 1 used index 0
  // at first-touch, so step N enqueues index N).
  if (input.step >= maxStep) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, sequence.case_id, 'dead')
    await enqueueCrmSync(sequence.case_id, 'dead')
    await logEventSafe({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const nextStep = input.step + 1
  // Index = current step → delay before nextStep; always in range for step < maxStep.
  const nextDelaySeconds = sequence.followup_delays_days[input.step]! * DAY_SECONDS
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: nextStep },
    nextDelaySeconds,
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: input.step,
    nextActionAt: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
    qstashMessageId: messageId,
  })
  await logEventSafe({
    clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
    type: 'pipeline.followup.sent', payload: { sequenceId: sequence.id, step: input.step },
  })
  return { sequenceId: sequence.id, action: 'sent' }
}
```

- [ ] **Step 10: Update the `collision-notify.ts` comment**

In `src/lib/pipeline/collision-notify.ts:16`, replace:

```ts
// Regular cadence steps (followup.ts/write.ts) are 0..MAX_FOLLOWUP_STEP.
```

with:

```ts
// Regular cadence steps (followup.ts/write.ts) are 0..sequence.followup_delays_days.length,
// a per-sequence value now rather than a fixed constant.
```

- [ ] **Step 11: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/pipeline/followup.test.ts`
Expected: PASS (all tests, including the 2 new shrink/grow tests and the 4 new `scheduleFirstFollowup` tests)

- [ ] **Step 12: Typecheck**

Run: `pnpm typecheck`
Expected: no errors (this surfaces the now-broken import of `MAX_FOLLOWUP_STEP` in `route.ts` — that's fixed in Task 7, next).

- [ ] **Step 13: Commit**

```bash
git add src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts src/lib/pipeline/collision-notify.ts
git commit -m "feat(followup): drive cadence from sequence.followup_delays_days"
```

---

### Task 7: Update the follow-up webhook route's step bound

**Files:**
- Modify: `src/app/api/pipeline/followup/route.ts:5,14`
- Modify: `src/app/api/pipeline/followup/route.test.ts:8-11,47-51`

**Interfaces:**
- Consumes: `MAX_FOLLOWUP_STEPS` (`@/lib/validation/followup-limits`, Task 2).
- Produces: no change to `POST`'s external behavior beyond the bound moving from 3 to 10.

- [ ] **Step 1: Update the failing test**

In `src/app/api/pipeline/followup/route.test.ts`, replace the `@/lib/pipeline/followup` mock (lines 8-11):

```ts
vi.mock('@/lib/pipeline/followup', () => ({
  runFollowupStep: (...a: unknown[]) => runFollowupMock(...a),
  MAX_FOLLOWUP_STEP: 3,
}))
```

with:

```ts
vi.mock('@/lib/pipeline/followup', () => ({
  runFollowupStep: (...a: unknown[]) => runFollowupMock(...a),
}))
```

Then replace the out-of-range test (lines 47-51):

```ts
  it('should return 400 when the step is out of range', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 9 }))
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
```

with:

```ts
  it('should return 400 when the step is out of range', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 11 }))
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/api/pipeline/followup/route.test.ts`
Expected: FAIL — `route.ts` still imports the now-removed `MAX_FOLLOWUP_STEP` from `@/lib/pipeline/followup`, so step 11 is still accepted (bound is undefined/NaN) or the module import itself errors.

- [ ] **Step 3: Update the implementation**

In `src/app/api/pipeline/followup/route.ts`, replace:

```ts
import { runFollowupStep, MAX_FOLLOWUP_STEP } from '@/lib/pipeline/followup'
```

with:

```ts
import { runFollowupStep } from '@/lib/pipeline/followup'
import { MAX_FOLLOWUP_STEPS } from '@/lib/validation/followup-limits'
```

Then replace:

```ts
const bodySchema = z.object({
  sequenceId: z.string().uuid(),
  step: z.number().int().min(1).max(MAX_FOLLOWUP_STEP),
})
```

with:

```ts
// A sanity ceiling on the webhook payload — not the authoritative last-step
// check, which lives inside runFollowupStep against that sequence's own
// followup_delays_days array (a per-sequence value, not a fixed constant).
const bodySchema = z.object({
  sequenceId: z.string().uuid(),
  step: z.number().int().min(1).max(MAX_FOLLOWUP_STEPS),
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/app/api/pipeline/followup/route.test.ts`
Expected: PASS (all tests)

- [ ] **Step 5: Full typecheck**

Run: `pnpm typecheck`
Expected: no errors anywhere in the project.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/followup/route.ts src/app/api/pipeline/followup/route.test.ts
git commit -m "feat: bound the followup webhook step by the shared step ceiling"
```

---

### Task 8: Shared `FollowupDelaysEditor` component

**Files:**
- Create: `src/components/followup-delays-editor.tsx`

**Interfaces:**
- Consumes: `MIN_FOLLOWUP_STEPS`, `MAX_FOLLOWUP_STEPS`, `MIN_FOLLOWUP_DELAY_DAYS`, `MAX_FOLLOWUP_DELAY_DAYS` (`@/lib/validation/followup-limits`, Task 2).
- Produces: `FollowupDelaysEditor({ idPrefix, delaysDays, onChange, disabled? })` — a controlled, presentation-only component with no save logic of its own. Used by `FollowupCadenceSection` (Task 9) and `LeadFollowupControl` (Task 10).

No test — no `.tsx` component in this repo has one (see Global Constraints); verified manually at the end of Tasks 9 and 10.

- [ ] **Step 1: Write the component**

Create `src/components/followup-delays-editor.tsx`:

```tsx
'use client'

import { useState } from 'react'
import {
  MIN_FOLLOWUP_STEPS,
  MAX_FOLLOWUP_STEPS,
  MIN_FOLLOWUP_DELAY_DAYS,
  MAX_FOLLOWUP_DELAY_DAYS,
} from '@/lib/validation/followup-limits'

interface FollowupDelaysEditorProps {
  /** Namespaces this instance's <label>/<input> ids — two editors can be on the page at once. */
  idPrefix: string
  delaysDays: readonly number[]
  onChange: (next: number[]) => void
  disabled?: boolean
}

const DEFAULT_NEW_STEP_DAYS = 7

// Monotonic, not reset between renders/instances: uniqueness is all that
// matters, and sharing the counter across every editor on the page is
// harmless.
let keySeed = 0
function nextRowKey(): string {
  keySeed += 1
  return `step-${keySeed}`
}

/**
 * Controlled array-of-days editor: add/remove/edit follow-up steps. Owns no
 * save logic — the parent holds `delaysDays` state and decides when/how to
 * persist it. Rows use a stable generated key (not array index), since this
 * list is mutable: removing a middle row must not cause React to reuse a
 * later row's <input> for an earlier value. If the parent ever replaces the
 * whole `delaysDays` array from outside (e.g. a "Reset to last saved"
 * control), it should remount this component via a `key` prop so the row
 * keys reseed correctly — see followup-cadence-section.tsx.
 */
export function FollowupDelaysEditor({
  idPrefix,
  delaysDays,
  onChange,
  disabled = false,
}: FollowupDelaysEditorProps): React.ReactElement {
  const [rowKeys, setRowKeys] = useState<string[]>(() => delaysDays.map(() => nextRowKey()))

  function setDay(index: number, value: number): void {
    const next = [...delaysDays]
    next[index] = value
    onChange(next)
  }

  function addStep(): void {
    setRowKeys([...rowKeys, nextRowKey()])
    onChange([...delaysDays, DEFAULT_NEW_STEP_DAYS])
  }

  function removeStep(index: number): void {
    setRowKeys(rowKeys.filter((_, i) => i !== index))
    onChange(delaysDays.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-2">
      {delaysDays.map((days, index) => {
        const rowKey = rowKeys[index] ?? `fallback-${index}`
        const inputId = `${idPrefix}-${rowKey}`
        return (
          <div key={rowKey} className="flex items-center gap-2">
            <label htmlFor={inputId} className="text-muted-foreground w-20 shrink-0 text-[12px]">
              Follow-up {index + 1}
            </label>
            <input
              id={inputId}
              type="number"
              min={MIN_FOLLOWUP_DELAY_DAYS}
              max={MAX_FOLLOWUP_DELAY_DAYS}
              step={1}
              value={days}
              disabled={disabled}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (Number.isInteger(value)) setDay(index, value)
              }}
              className="border-hairline bg-surface w-16 rounded-md border px-2 py-1 text-[11px]"
            />
            <span className="text-faint text-[11px]">days later</span>
            <button
              type="button"
              disabled={disabled || delaysDays.length <= MIN_FOLLOWUP_STEPS}
              onClick={() => removeStep(index)}
              className="text-faint hover:text-destructive text-[11px] underline underline-offset-2 disabled:no-underline disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        )
      })}
      <button
        type="button"
        disabled={disabled || delaysDays.length >= MAX_FOLLOWUP_STEPS}
        onClick={addStep}
        className="text-faint hover:text-foreground self-start text-[11px] underline underline-offset-2 disabled:no-underline disabled:opacity-40"
      >
        + Add follow-up
      </button>
    </div>
  )
}
```

- [ ] **Step 2: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors. (Manual verification happens once this is wired into Tasks 9 and 10 — nothing renders this component yet.)

- [ ] **Step 3: Commit**

```bash
git add src/components/followup-delays-editor.tsx
git commit -m "feat: add shared FollowupDelaysEditor component"
```

---

### Task 9: Client-wide default cadence — `/settings`

**Files:**
- Create: `src/app/(app)/settings/followup-cadence-actions.ts`
- Test: `src/app/(app)/settings/followup-cadence-actions.test.ts`
- Create: `src/app/(app)/settings/followup-cadence-section.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `updateClientFollowupDelays` (`@/lib/db/clients`, Task 3); `followupDelaysSchema` (`@/lib/validation/followup-limits`, Task 2); `FollowupDelaysEditor` (`@/components/followup-delays-editor`, Task 8); `requireUser`, `createAdminClient`, `AppError`, `revalidatePath`, `logEvent` (all already used elsewhere in this directory).
- Produces: `updateFollowupCadence(formData: FormData): Promise<void>` — a client-only Server Action. `FollowupCadenceSection({ initialDelaysDays })` — rendered from `page.tsx` next to `ReplyModeSection`.

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/settings/followup-cadence-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateFollowupCadence } from './followup-cadence-actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateClientFollowupDelays: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/clients', () => ({ updateClientFollowupDelays: hoisted.updateClientFollowupDelays }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: hoisted.logEvent }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(days: number[]): FormData {
  const data = new FormData()
  for (const day of days) data.append('delaysDays', String(day))
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.updateClientFollowupDelays.mockResolvedValue({ id: 'c1', followup_delays_days: [2, 5, 9] })
})

describe('updateFollowupCadence', () => {
  it('should update the client-wide default cadence', async () => {
    await updateFollowupCadence(form([2, 5, 9]))

    expect(hoisted.updateClientFollowupDelays).toHaveBeenCalledWith({}, 'c1', [2, 5, 9])
    expect(hoisted.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      type: 'client.followup_cadence_changed',
      payload: { delaysDays: [2, 5, 9] },
    }))
  })

  it('should reject an operator, who does not own a cadence preference', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(updateFollowupCadence(form([2, 5, 9]))).rejects.toThrow()
    expect(hoisted.updateClientFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject an empty cadence', async () => {
    await expect(updateFollowupCadence(form([]))).rejects.toThrow()
    expect(hoisted.updateClientFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject a day value out of bounds', async () => {
    await expect(updateFollowupCadence(form([0]))).rejects.toThrow()
    expect(hoisted.updateClientFollowupDelays).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/\(app\)/settings/followup-cadence-actions.test.ts`
Expected: FAIL — `./followup-cadence-actions` does not exist.

- [ ] **Step 3: Write the Server Action**

Create `src/app/(app)/settings/followup-cadence-actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateClientFollowupDelays } from '@/lib/db/clients'
import { followupDelaysSchema } from '@/lib/validation/followup-limits'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

// Client-owned preference, same shape as updateReplyMode. Does NOT bulk-sync
// onto existing sequences — a client changing their default should not
// silently reschedule every in-flight contact; the per-lead override on the
// case page is the explicit tool for that.
export async function updateFollowupCadence(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their follow-up cadence', { role: appUser.role })
  }

  const parsed = followupDelaysSchema.safeParse(formData.getAll('delaysDays'))
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid follow-up cadence', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  await updateClientFollowupDelays(admin, appUser.client_id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.followup_cadence_changed',
    payload: { delaysDays: parsed.data },
  })
  revalidatePath(SETTINGS_PATH)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/\(app\)/settings/followup-cadence-actions.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5: Write the section component**

Create `src/app/(app)/settings/followup-cadence-section.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { FollowupDelaysEditor } from '@/components/followup-delays-editor'
import { Button } from '@/components/ui/button'
import { updateFollowupCadence } from './followup-cadence-actions'

interface FollowupCadenceSectionProps {
  initialDelaysDays: readonly number[]
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function FollowupCadenceSection({ initialDelaysDays }: FollowupCadenceSectionProps): React.ReactElement {
  const [delaysDays, setDelaysDays] = useState<number[]>([...initialDelaysDays])
  const [savedDelaysDays, setSavedDelaysDays] = useState<number[]>([...initialDelaysDays])
  // Bumped on Reset to force FollowupDelaysEditor to remount — its internal
  // row keys must reseed when the array is replaced wholesale from outside.
  const [resetVersion, setResetVersion] = useState(0)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const isDirty = !arraysEqual(delaysDays, savedDelaysDays)

  function onSave(): void {
    setError(null)
    setShowSaved(false)
    const formData = new FormData()
    for (const day of delaysDays) formData.append('delaysDays', String(day))
    startTransition(async () => {
      try {
        await updateFollowupCadence(formData)
        setSavedDelaysDays([...delaysDays])
        setShowSaved(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that change. Please try again.')
      }
    })
  }

  function onReset(): void {
    setDelaysDays([...savedDelaysDays])
    setResetVersion((v) => v + 1)
    setError(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-[12px]">
        Applies to new contacts going forward — an already-running follow-up sequence for a contact keeps its
        cadence unless you edit that contact directly, from its case page.
      </p>
      <FollowupDelaysEditor
        key={resetVersion}
        idPrefix="client-default"
        delaysDays={delaysDays}
        onChange={setDelaysDays}
        disabled={isPending}
      />
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={isPending || !isDirty} onClick={onSave}>
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {isDirty ? (
          <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={onReset}>
            Reset
          </Button>
        ) : null}
        {showSaved && !isDirty ? <span className="text-faint text-[11px]">Saved</span> : null}
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

- [ ] **Step 6: Wire the section into `/settings`**

In `src/app/(app)/settings/page.tsx`, add the import next to `ReplyModeSection`:

```ts
import { ReplyModeSection } from './reply-mode-section'
```

becomes:

```ts
import { ReplyModeSection } from './reply-mode-section'
import { FollowupCadenceSection } from './followup-cadence-section'
```

Then, immediately after the existing Reply mode section:

```tsx
      {client ? (
        <Section title="Reply mode">
          <ReplyModeSection currentMode={client.reply_mode} />
        </Section>
      ) : null}
```

becomes:

```tsx
      {client ? (
        <Section title="Reply mode">
          <ReplyModeSection currentMode={client.reply_mode} />
        </Section>
      ) : null}

      {client ? (
        <Section title="Follow-up cadence">
          <FollowupCadenceSection initialDelaysDays={client.followup_delays_days} />
        </Section>
      ) : null}
```

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/settings/followup-cadence-actions.ts" "src/app/(app)/settings/followup-cadence-actions.test.ts" \
  "src/app/(app)/settings/followup-cadence-section.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "feat(settings): add client-wide follow-up cadence control"
```

- [ ] **Step 9: Manual verification**

1. Run `pnpm dev`, sign in as a client-role user, go to `/settings`.
2. Confirm a new "Follow-up cadence" section shows three rows (3/7/14 days) below "Reply mode".
3. Edit a day value — confirm "Save changes" enables and "Reset" appears.
4. Click "+ Add follow-up" — confirm a 4th row appears (default 7 days), then remove it — confirm it's gone and no stray input keeps the old value.
5. Click "Save changes" — confirm a "Saved" label appears and the Reset button disappears (no longer dirty).
6. Reload the page — confirm the saved cadence persists.
7. Sign in as an operator — confirm the "Follow-up cadence" section does not render (operators have no `client_id`).

---

### Task 10: Per-lead override — `/cases/[id]`

**Files:**
- Modify: `src/app/(app)/cases/[id]/actions.ts` (add `updateLeadFollowupDelays`)
- Test: `src/app/(app)/cases/[id]/actions.test.ts` (add a new describe block + mocks)
- Create: `src/app/(app)/cases/[id]/lead-followup-control.tsx`
- Modify: `src/app/(app)/cases/[id]/page.tsx`

**Interfaces:**
- Consumes: `updateSequenceFollowupDelays` (`@/lib/db/sequences`, Task 4); `listSequencesForCase` (`@/lib/db/sequences`, Task 4); `followupDelaysSchema` (`@/lib/validation/followup-limits`, Task 2); `formatFollowupCountdown`, `formatFollowupStatus` (`@/lib/format`, Task 5); `FollowupDelaysEditor` (`@/components/followup-delays-editor`, Task 8).
- Produces: `updateLeadFollowupDelays(formData: FormData): Promise<void>` — a Server Action available to both roles, matching `stopLead`'s authorization shape. `LeadFollowupControl({ leadId, caseId, delaysDays, currentStep, countdownLabel })` — rendered per contact on the case page.

- [ ] **Step 1: Write the failing test**

In `src/app/(app)/cases/[id]/actions.test.ts`, add two new mocks alongside the existing ones and extend the `@/lib/db/sequences` mock:

```ts
const updateSequenceFollowupDelays = vi.fn()
```

Change:

```ts
vi.mock('@/lib/db/sequences', () => ({ stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args) }))
```

to:

```ts
vi.mock('@/lib/db/sequences', () => ({
  stopSequenceForLead: (...args: unknown[]) => stopSequenceForLead(...args),
  updateSequenceFollowupDelays: (...args: unknown[]) => updateSequenceFollowupDelays(...args),
}))
```

Change the top-of-file import:

```ts
const { stopLead } = await import('./actions')
```

to:

```ts
const { stopLead, updateLeadFollowupDelays } = await import('./actions')
```

Then append at the end of the file:

```ts
describe('updateLeadFollowupDelays', () => {
  function delaysForm(days: number[]): FormData {
    const data = new FormData()
    data.set('leadId', '11111111-1111-4111-8111-111111111111')
    data.set('caseId', '22222222-2222-4222-8222-222222222222')
    for (const day of days) data.append('delaysDays', String(day))
    return data
  }

  it('should persist the new cadence on that lead\'s sequence', async () => {
    updateSequenceFollowupDelays.mockResolvedValue({ id: 'seq1', followup_delays_days: [2, 5] })

    await updateLeadFollowupDelays(delaysForm([2, 5]))

    expect(updateSequenceFollowupDelays).toHaveBeenCalledWith(
      expect.anything(), '11111111-1111-4111-8111-111111111111', [2, 5],
    )
    expect(revalidatePath).toHaveBeenCalledWith('/cases/22222222-2222-4222-8222-222222222222')
  })

  it('should let a client-role user edit a lead the RLS read returned', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'c1' } })
    updateSequenceFollowupDelays.mockResolvedValue({ id: 'seq1', followup_delays_days: [2, 5] })

    await updateLeadFollowupDelays(delaysForm([2, 5]))

    expect(updateSequenceFollowupDelays).toHaveBeenCalled()
  })

  it('should reject a lead that belongs to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })

    await expect(updateLeadFollowupDelays(delaysForm([2, 5]))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(updateSequenceFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject when the RLS-scoped read finds no such lead', async () => {
    getLeadById.mockResolvedValue(null)

    await expect(updateLeadFollowupDelays(delaysForm([2, 5]))).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(updateSequenceFollowupDelays).not.toHaveBeenCalled()
  })

  it('should reject an out-of-bounds cadence before touching the database', async () => {
    await expect(updateLeadFollowupDelays(delaysForm([0]))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(updateSequenceFollowupDelays).not.toHaveBeenCalled()
  })

  it('should throw VALIDATION_ERROR when the sequence is no longer active or paused', async () => {
    updateSequenceFollowupDelays.mockResolvedValue(null)

    await expect(updateLeadFollowupDelays(delaysForm([2, 5]))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm exec vitest run "src/app/(app)/cases/[id]/actions.test.ts"`
Expected: FAIL — `updateLeadFollowupDelays` is not exported from `./actions`.

- [ ] **Step 3: Write the Server Action**

In `src/app/(app)/cases/[id]/actions.ts`, change the import:

```ts
import { stopSequenceForLead } from '@/lib/db/sequences'
```

to:

```ts
import { stopSequenceForLead, updateSequenceFollowupDelays } from '@/lib/db/sequences'
```

Add near the top of the file, alongside `stopLeadSchema`:

```ts
import { followupDelaysSchema } from '@/lib/validation/followup-limits'
```

Then append at the end of the file:

```ts
const updateLeadFollowupDelaysSchema = z.object({
  leadId: z.string().uuid(),
  caseId: z.string().uuid(),
})

/**
 * Per-lead override of the follow-up cadence: overwrites the effective
 * schedule for one contact's own sequence row, leaving every other contact
 * — on this case or any other — untouched.
 *
 * Same authorization shape as stopLead: available to both roles, since
 * deciding how often to nudge one person is the client's call as much as
 * the operator's. RLS-scoped read below draws the actual boundary; the
 * client_id re-check afterwards mirrors stopLead exactly.
 */
export async function updateLeadFollowupDelays(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { leadId, caseId } = updateLeadFollowupDelaysSchema.parse({
    leadId: formData.get('leadId'),
    caseId: formData.get('caseId'),
  })
  const parsedDelays = followupDelaysSchema.safeParse(formData.getAll('delaysDays'))
  if (!parsedDelays.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid follow-up cadence', { issues: parsedDelays.error.flatten() })
  }

  const scoped = await createServerClient()
  const lead = await getLeadById(scoped, leadId)
  if (!lead) {
    throw new AppError('NOT_FOUND', 'Lead not found', { leadId })
  }
  if (appUser.role !== 'operator' && appUser.client_id !== lead.client_id) {
    throw new AppError('UNAUTHORIZED', 'Lead belongs to another client', { leadId, userId: appUser.id })
  }

  const admin = createAdminClient()
  const updated = await updateSequenceFollowupDelays(admin, leadId, parsedDelays.data)
  if (!updated) {
    throw new AppError('VALIDATION_ERROR', 'No editable follow-up sequence for this contact', { leadId })
  }

  await logEventSafe({
    clientId: lead.client_id,
    caseId: lead.case_id,
    actor: `human:${appUser.id}`,
    type: 'lead.followup_cadence_changed',
    payload: { leadId, delaysDays: parsedDelays.data },
  })

  revalidatePath(`/cases/${caseId}`)
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run "src/app/(app)/cases/[id]/actions.test.ts"`
Expected: PASS (all existing tests plus 6 new ones)

- [ ] **Step 5: Write `LeadFollowupControl`**

Create `src/app/(app)/cases/[id]/lead-followup-control.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { PencilSimple } from '@phosphor-icons/react'
import { FollowupDelaysEditor } from '@/components/followup-delays-editor'
import { Button } from '@/components/ui/button'
import { formatFollowupStatus } from '@/lib/format'
import { updateLeadFollowupDelays } from './actions'

interface LeadFollowupControlProps {
  leadId: string
  caseId: string
  delaysDays: readonly number[]
  currentStep: number
  /** Preformatted on the server so no clock runs during hydration (see formatFollowupCountdown). */
  countdownLabel: string | null
}

export function LeadFollowupControl({
  leadId,
  caseId,
  delaysDays,
  currentStep,
  countdownLabel,
}: LeadFollowupControlProps): React.ReactElement {
  const [isEditing, setIsEditing] = useState(false)
  const [draftDelays, setDraftDelays] = useState<number[]>([...delaysDays])
  const [isSaving, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onOpen(): void {
    setDraftDelays([...delaysDays])
    setError(null)
    setIsEditing(true)
  }

  function onSave(): void {
    const formData = new FormData()
    formData.set('leadId', leadId)
    formData.set('caseId', caseId)
    for (const day of draftDelays) formData.append('delaysDays', String(day))
    startTransition(async () => {
      try {
        await updateLeadFollowupDelays(formData)
        setIsEditing(false)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that change. Please try again.')
      }
    })
  }

  if (!isEditing) {
    return (
      <div className="mt-2 flex items-center gap-1.5">
        <p className="text-faint text-[11px]">{formatFollowupStatus(currentStep, delaysDays.length, countdownLabel)}</p>
        <button
          type="button"
          onClick={onOpen}
          aria-label="Edit follow-up cadence for this contact"
          className="text-faint hover:text-foreground transition-colors duration-200"
        >
          <PencilSimple size={12} weight="light" />
        </button>
      </div>
    )
  }

  return (
    <div className="border-hairline mt-2 flex flex-col gap-2 rounded-md border border-dashed p-2">
      <FollowupDelaysEditor
        idPrefix={`lead-${leadId}`}
        delaysDays={draftDelays}
        onChange={setDraftDelays}
        disabled={isSaving}
      />
      {error ? (
        <p role="alert" className="text-destructive text-[11px]">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={isSaving} onClick={onSave}>
          {isSaving ? 'Saving…' : 'Save'}
        </Button>
        <Button type="button" variant="ghost" size="sm" disabled={isSaving} onClick={() => setIsEditing(false)}>
          Cancel
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 6: Wire it into the case page**

In `src/app/(app)/cases/[id]/page.tsx`, add two imports:

```ts
import { formatAbsolute, formatRelative, humanizeEnum } from '@/lib/format'
```

becomes:

```ts
import { formatAbsolute, formatRelative, humanizeEnum, formatFollowupCountdown } from '@/lib/format'
```

and, alongside the `StopLeadButton` import:

```ts
import { StopLeadButton } from './stop-lead-button'
```

becomes:

```ts
import { StopLeadButton } from './stop-lead-button'
import { LeadFollowupControl } from './lead-followup-control'
```

Add `listSequencesForCase` to the `@/lib/db/sequences`-adjacent imports — there isn't an existing import from that module in this file, so add a new line near the other `@/lib/db/*` imports:

```ts
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
```

becomes:

```ts
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
import { listSequencesForCase } from '@/lib/db/sequences'
```

Extend the `Promise.all` fetch:

```ts
  const [leads, emails, knowledge, requests, events, campaign, notes, resources, crmLink] = await Promise.all([
    listLeadsForCase(supabase, caseId),
    listEmailsForCase(supabase, caseId),
    listKnowledgeForCase(supabase, caseId),
    listKnowledgeRequestsForCase(supabase, caseId),
    listEventsForCase(supabase, caseId, EVENT_LIMIT),
    getCampaignById(supabase, kase.campaign_id),
    listNotesForCase(supabase, caseId),
    listActiveResourcesForClient(supabase, kase.client_id, RESOURCE_LIMIT),
    getCaseCrmLink(supabase, caseId),
  ])
  const crmConnection = crmLink ? await getCrmConnectionForClient(supabase, kase.client_id) : null
```

becomes:

```ts
  const [leads, emails, knowledge, requests, events, campaign, notes, resources, crmLink, sequences] = await Promise.all([
    listLeadsForCase(supabase, caseId),
    listEmailsForCase(supabase, caseId),
    listKnowledgeForCase(supabase, caseId),
    listKnowledgeRequestsForCase(supabase, caseId),
    listEventsForCase(supabase, caseId, EVENT_LIMIT),
    getCampaignById(supabase, kase.campaign_id),
    listNotesForCase(supabase, caseId),
    listActiveResourcesForClient(supabase, kase.client_id, RESOURCE_LIMIT),
    getCaseCrmLink(supabase, caseId),
    listSequencesForCase(supabase, caseId),
  ])
  const crmConnection = crmLink ? await getCrmConnectionForClient(supabase, kase.client_id) : null
  // Only an active/paused sequence has anything left to edit — a
  // stopped/completed one shows no control at all (see LeadFollowupControl).
  const sequenceByLeadId = new Map(
    sequences
      .filter((sequence) => sequence.state === 'active' || sequence.state === 'paused')
      .map((sequence) => [sequence.lead_id, sequence]),
  )
```

(`now`, already defined a few lines below as `const now = new Date()`, is reused for the countdown — no new variable needed there.)

Finally, in the contacts `<li>` (inside the `min-w-0 flex-1` block), insert the follow-up control right after the existing notes/status row and before that `<div>` closes:

```tsx
                    <Link
                      href={`/cases/${kase.id}?note=${lead.id}#notes`}
                      scroll
                      className="text-faint hover:text-foreground text-[11px] underline underline-offset-2 transition-colors duration-200"
                    >
                      {(noteCountByLeadId.get(lead.id) ?? 0) > 0
                        ? `${noteCountByLeadId.get(lead.id)} note${noteCountByLeadId.get(lead.id) === 1 ? '' : 's'}`
                        : 'Add note'}
                    </Link>
                  </div>
                </div>
```

becomes:

```tsx
                    <Link
                      href={`/cases/${kase.id}?note=${lead.id}#notes`}
                      scroll
                      className="text-faint hover:text-foreground text-[11px] underline underline-offset-2 transition-colors duration-200"
                    >
                      {(noteCountByLeadId.get(lead.id) ?? 0) > 0
                        ? `${noteCountByLeadId.get(lead.id)} note${noteCountByLeadId.get(lead.id) === 1 ? '' : 's'}`
                        : 'Add note'}
                    </Link>
                  </div>
                  {sequenceByLeadId.has(lead.id) ? (
                    <LeadFollowupControl
                      leadId={lead.id}
                      caseId={kase.id}
                      delaysDays={sequenceByLeadId.get(lead.id)!.followup_delays_days}
                      currentStep={sequenceByLeadId.get(lead.id)!.current_step}
                      countdownLabel={formatFollowupCountdown(sequenceByLeadId.get(lead.id)!.next_action_at, now)}
                    />
                  ) : null}
                </div>
```

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: no errors.

- [ ] **Step 8: Run the full test suite**

Run: `pnpm test`
Expected: every test across the project passes.

- [ ] **Step 9: Commit**

```bash
git add "src/app/(app)/cases/[id]/actions.ts" "src/app/(app)/cases/[id]/actions.test.ts" \
  "src/app/(app)/cases/[id]/lead-followup-control.tsx" "src/app/(app)/cases/[id]/page.tsx"
git commit -m "feat(cases): add per-lead follow-up cadence override"
```

- [ ] **Step 10: Manual verification**

1. Run `pnpm dev`. Get a lead into an active follow-up sequence (send a first-touch email to a contact, or insert an `active` `sequences` row by hand for an existing lead).
2. Open that lead's case page — confirm the contact card shows "0/3 follow-ups sent · next in Xd" (or similar) beneath the notes row, with a pencil icon.
3. Click the pencil — confirm the inline editor opens, prefilled with 3/7/14 (or whatever the client default is).
4. Change the values, add a 4th row, remove one, then **Save** — confirm the editor closes and the status line now reads against the new cadence (e.g. "0/4 follow-ups sent…").
5. Reload the page — confirm the change persisted.
6. Click the pencil again and **Cancel** without saving — confirm the status line is unchanged from before you opened the editor.
7. Confirm a lead with `status: 'parked'` (or no sequence at all) shows no follow-up status line or pencil.
8. Sign in as the client who owns this lead's client_id — confirm they can also see and edit the control (not operator-only).

---

## Task Order

Tasks 1 → 2 are prerequisites for everything else. From there:

- Task 3 (clients.ts) and Task 4 (sequences.ts) can run in either order — both only depend on Tasks 1–2.
- Task 5 (format.ts) only depends on nothing new — can run any time after Task 1, in parallel with 3/4.
- Task 6 (followup.ts) depends on Task 3 (`getClientById` already exists, but the snapshot logic needs `DEFAULT_FOLLOWUP_DELAYS_DAYS` from Task 2) and the `followup_delays_days` column from Task 1.
- Task 7 (route.ts) depends on Task 6 (removes the constant Task 7's mock currently references) and Task 2 (`MAX_FOLLOWUP_STEPS`).
- Task 8 (shared editor component) only depends on Task 2.
- Task 9 (Settings) depends on Tasks 2, 3, 8.
- Task 10 (case page) depends on Tasks 2, 4, 5, 8.

Recommended sequential order: 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8 → 9 → 10.
