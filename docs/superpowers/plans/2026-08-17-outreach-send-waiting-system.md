# Outreach Send Waiting System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop `runWriteForCase` from marking a case `contacted` (and CRM-syncing "First outreach sent") when nothing was actually sent — a gate-blocked lead currently vanishes with no retry, and a `human_approve` case with only drafts falsely reports contact to the client's CRM before anyone approves.

**Architecture:** A new `waiting` case status (with a `wait_reason` enum: `mailreach_gate` / `daily_cap` / `no_healthy_mailbox` / `awaiting_manual_approval` / `no_viable_leads`) replaces the unconditional end-of-loop `contacted` write. A new `getOutreachEligibility` probe runs before any lead work, so a gated case's retries cost a DB read, not an LLM call. The three mailbox-availability reasons ride the *existing* 5-minute write-fanout cron; the other two clear only via `approveDraft` (a human) or a future discovery pass — neither is time-based, so neither is auto-retried. Send-time enforcement (`sender.ts`) is unchanged and remains the actual point of enforcement; this is a cheaper probe in front of it.

**Tech Stack:** TypeScript, Zod, Vitest, Supabase (Postgres), Next.js Route Handlers, QStash cron.

**Spec:** `docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md`

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (QUALITY.md).
- No `!` non-null assertions without a comment proving safety — prefer a null check that lets TypeScript narrow instead.
- Every thrown/returned error carries `code`/`message`/`context` via `AppError` — never a bare `Error` from a `lib/db` function.
- DB columns snake_case, TypeScript camelCase — mapped explicitly, never assumed to match.
- Named exports only (no default exports outside Next.js pages/layouts).
- Early returns over nested conditionals.
- `ALTER TYPE ... ADD VALUE` must not be *used* as a literal in the same migration transaction that adds it (PG12+ rule, already followed by migrations 0011/0040) — this plan's migration only adds enum values, never references them.
- `sender.ts`'s `rotationOrder` and the atomic `claim_mailbox_send`/`claim_mailbox_send_uncapped` RPCs are not touched by this plan.
- `pnpm typecheck && pnpm lint && pnpm test` must be clean at the end of every task, not just at the end of the plan.

---

## Task 1: Migration — `waiting` case status + `wait_reason` + status labels

**Files:**
- Create: `supabase/migrations/0049_case_waiting_state.sql`
- Modify: `src/types/database.ts:1246-1256` (`case_status` enum), `src/types/database.ts:1225` area (new `case_wait_reason` enum), `src/types/database.ts:192-219` (`cases` table `Row`/`Insert`), `src/lib/ui/status.ts` (`CASE_STATUS`, new `CASE_WAIT_REASON`), `src/app/globals.css` (new `--status-waiting` token)

**Interfaces:**
- Produces: `case_status` gains `'waiting'`; new enum `case_wait_reason` = `'mailreach_gate' | 'daily_cap' | 'no_healthy_mailbox' | 'awaiting_manual_approval' | 'no_viable_leads'`; `cases.wait_reason: CaseWaitReason | null`; `CASE_STATUS['waiting']`; `export const CASE_WAIT_REASON: Record<CaseWaitReason, StatusMeta>`. Every later task depends on the schema/type surfaces; Task 9 consumes `CASE_STATUS['waiting']`.

**Why the status-label change lives in this task, not a separate one:** `src/lib/ui/status.ts`'s existing `CASE_STATUS` is typed `Record<CaseStatus, StatusMeta>` — the moment `case_status` gains `'waiting'`, that `Record` is missing a required key and **`pnpm typecheck` fails at `status.ts`'s own declaration** until `'waiting'` is added there too. Landing both in one task/commit means the build is never broken in between, honoring this plan's "clean at the end of every task" constraint.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0049_case_waiting_state.sql`:

```sql
-- New case-status value for "write was attempted this tick and did not reach
-- a terminal outcome, but will (or may) be retried" — distinct from 'ready'
-- (never attempted) and 'writing' (actively running this instant). Fixes two
-- bugs sharing one root cause (runWriteForCase's unconditional end-of-loop
-- `contacted` write): a gate-blocked first touch silently losing the lead
-- (nothing retried a 'contacted' case with a failed step-0 email), and a
-- human_approve case with only drafts falsely CRM-syncing "First outreach
-- sent" before anyone approved. See
-- docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PG12+ so long
-- as the new value is not *used* in the same transaction (0011, 0040) —
-- nothing below references 'waiting' as a case_status literal, so this is
-- safe under `supabase db push`.
alter type case_status add value if not exists 'waiting' after 'writing';

-- Why each case is waiting. The first three are mailbox-availability
-- conditions the 5-minute write-fanout cron re-checks automatically
-- (AUTO_RETRY_WAIT_REASONS, src/lib/db/cases.ts); 'awaiting_manual_approval'
-- clears when a human approves a draft in /inbox; 'no_viable_leads' clears
-- only if a later discovery pass adds a new lead to the case.
create type case_wait_reason as enum (
  'mailreach_gate',
  'daily_cap',
  'no_healthy_mailbox',
  'awaiting_manual_approval',
  'no_viable_leads'
);

alter table cases add column wait_reason case_wait_reason;

-- Keeps the two columns from ever disagreeing: a reason with no 'waiting'
-- status, or 'waiting' with no reason, are both invalid states. Same
-- cross-column guard pattern as app_users' role/client_id check (0001).
alter table cases add constraint cases_wait_reason_matches_status
  check ((status = 'waiting') = (wait_reason is not null));
```

- [ ] **Step 2: Apply the migration locally and verify it applies cleanly**

Run: `pnpm supabase db reset` (or your project's equivalent local-apply command)
Expected: migration `0049_case_waiting_state.sql` applies with no errors; `cases` now has a `wait_reason` column and `case_status` includes `'waiting'`.

Verify with:
```bash
pnpm supabase db diff --schema public 2>&1 | grep -i "wait_reason\|case_status" || echo "no pending diff — migration matches applied schema"
```

- [ ] **Step 3: Verify the check constraint actually rejects a mismatched row**

Run this against your local DB (psql, Supabase Studio SQL editor, or `pnpm supabase db execute` — whichever this project's existing migration-verification workflow uses):

```sql
-- Should fail: 'waiting' with no reason
insert into cases (client_id, campaign_id, company_name, company_key, status)
select id, (select id from campaigns limit 1), 'Test Co', 'test-co-wait-check', 'waiting'
from clients limit 1;
```
Expected: rejected with a `cases_wait_reason_matches_status` check violation.

```sql
-- Should fail: a reason with a non-'waiting' status
insert into cases (client_id, campaign_id, company_name, company_key, status, wait_reason)
select id, (select id from campaigns limit 1), 'Test Co', 'test-co-reason-check', 'ready', 'daily_cap'
from clients limit 1;
```
Expected: rejected with the same constraint violation. Neither test row should persist — no cleanup needed if both inserts were rejected.

- [ ] **Step 4: Update the hand-authored database types**

Edit `src/types/database.ts`. In the `cases` table block (currently lines 192-219), add `wait_reason` to `Row` and `Insert`:

```ts
      cases: {
        Row: {
          id: string
          client_id: string
          campaign_id: string
          company_name: string
          company_domain: string | null
          company_key: string
          status: Database['public']['Enums']['case_status']
          wait_reason: Database['public']['Enums']['case_wait_reason'] | null
          summary: string | null
          created_at: string
          updated_at: string
          collision_notified_at: string | null
        }
        Insert: {
          id?: string
          client_id: string
          campaign_id: string
          company_name: string
          company_domain?: string | null
          company_key: string
          status?: Database['public']['Enums']['case_status']
          wait_reason?: Database['public']['Enums']['case_wait_reason'] | null
          summary?: string | null
          created_at?: string
          updated_at?: string
          collision_notified_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['cases']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'cases_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'cases_campaign_id_fkey'
            columns: ['campaign_id']
            isOneToOne: false
            referencedRelation: 'campaigns'
            referencedColumns: ['id']
          },
        ]
      }
```

In the `Enums` block (currently lines 1225-1264), add `'waiting'` to `case_status` and a new `case_wait_reason` entry right after it:

```ts
      case_status:
        | 'new'
        | 'researching'
        | 'ready'
        | 'writing'
        | 'waiting'
        | 'contacted'
        | 'in_conversation'
        | 'hot_handoff'
        | 'won'
        | 'lost'
        | 'dead'
      case_wait_reason:
        | 'mailreach_gate'
        | 'daily_cap'
        | 'no_healthy_mailbox'
        | 'awaiting_manual_approval'
        | 'no_viable_leads'
```

- [ ] **Step 5: Add the status label and per-reason messaging**

Edit `src/lib/ui/status.ts`. Add the type alias right after the existing `CaseStatus` one:

```ts
type CaseStatus = Database['public']['Enums']['case_status']
type CaseWaitReason = Database['public']['Enums']['case_wait_reason']
```

Insert `waiting` into `CASE_STATUS`, between `writing` and `contacted`:

```ts
export const CASE_STATUS: Record<CaseStatus, StatusMeta> = {
  new: { label: 'New', color: 'var(--status-new)' },
  researching: { label: 'Researching', color: 'var(--status-researching)' },
  ready: { label: 'Ready', color: 'var(--status-ready)' },
  writing: { label: 'Writing', color: 'var(--status-writing)' },
  waiting: { label: 'Waiting', color: 'var(--status-waiting)' },
  contacted: { label: 'Contacted', color: 'var(--status-contacted)' },
  in_conversation: { label: 'In conversation', color: 'var(--status-in-conversation)' },
  hot_handoff: { label: 'Hot handoff', color: 'var(--status-hot-handoff)' },
  won: { label: 'Won', color: 'var(--status-won)' },
  lost: { label: 'Lost', color: 'var(--status-lost)' },
  dead: { label: 'Dead', color: 'var(--status-dead)' },
}

// Why a 'waiting' case is waiting — distinct from the status label because it
// matters operationally: no_healthy_mailbox needs an operator now; the other
// four don't need anyone (mailreach_gate/daily_cap resolve automatically,
// awaiting_manual_approval is a human's own queue in /inbox, no_viable_leads
// only changes if discovery adds a lead). Reuses existing status colors
// rather than adding new tokens — dead/lost read as "needs attention",
// ready/writing read as "in motion, no action needed".
export const CASE_WAIT_REASON: Record<CaseWaitReason, StatusMeta> = {
  mailreach_gate: { label: 'Mailbox still warming up', color: 'var(--status-writing)' },
  daily_cap: { label: 'Daily send cap reached', color: 'var(--status-writing)' },
  no_healthy_mailbox: { label: 'No healthy mailbox — needs attention', color: 'var(--status-lost)' },
  awaiting_manual_approval: { label: 'Drafts ready for approval', color: 'var(--status-ready)' },
  no_viable_leads: { label: 'No contactable leads', color: 'var(--status-dead)' },
}
```

- [ ] **Step 6: Add the CSS color token**

Edit `src/app/globals.css`. In the light-mode block (`:root`), add `--status-waiting` between `--status-writing` and `--status-contacted`:

```css
  --status-writing: oklch(0.59 0.13 250);
  --status-waiting: oklch(0.575 0.13 258);
  --status-contacted: oklch(0.56 0.14 265);
```

In the dark-mode block (`.dark`), same insertion point:

```css
  --status-writing: oklch(0.73 0.13 250);
  --status-waiting: oklch(0.715 0.13 258);
  --status-contacted: oklch(0.7 0.13 265);
```

In the `@theme` bridge block, same insertion point:

```css
  --color-status-writing: var(--status-writing);
  --color-status-waiting: var(--status-waiting);
  --color-status-contacted: var(--status-contacted);
```

- [ ] **Step 7: Typecheck**

Run: `pnpm typecheck`
Expected: clean. (`CASE_STATUS`/`CASE_WAIT_REASON` are `Record<Enum, StatusMeta>` — the compiler rejects a missing key by construction, which is the actual verification here; no dedicated runtime test exists for these static tables, consistent with `status.test.ts`'s existing scope of testing only the `leadEmailStatusMetaFor` function, not the plain data records.)

- [ ] **Step 8: Visually verify in the running app**

Run: `pnpm dev`, sign in as an operator, open `/crm`. Expected: no broken/missing color anywhere case status pills already render (the `Waiting` filter chip itself doesn't exist until Task 9, but every existing pill — e.g. any case still reading `writing`/`contacted` — must render exactly as it did before this task; nothing regresses).

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0049_case_waiting_state.sql src/types/database.ts src/lib/ui/status.ts src/app/globals.css
git commit -m "feat(cases): add waiting case status, wait_reason enum, and labels

New case_status value 'waiting' + case_wait_reason enum (mailreach_gate,
daily_cap, no_healthy_mailbox, awaiting_manual_approval, no_viable_leads),
guarded by a check constraint, plus the CASE_STATUS/CASE_WAIT_REASON UI
labels and color token landed in the same commit so the build is never
broken in between. Nothing writes or reads wait_reason yet.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 2: `src/lib/db/cases.ts` — waiting-aware DB functions

**Files:**
- Modify: `src/lib/db/cases.ts:1-100` (`updateCaseStatus`, `listCasesByStatus`, new `updateCaseWaiting`, new `CaseWaitReason` type, new `AUTO_RETRY_WAIT_REASONS`)
- Test: `src/lib/db/cases.test.ts`

**Interfaces:**
- Consumes: `CaseRow`/`CaseStatus` (existing, `cases.ts:5-6`), `case_wait_reason` enum (Task 1).
- Produces: `export type CaseWaitReason`; `export const AUTO_RETRY_WAIT_REASONS: readonly CaseWaitReason[]`; `export async function updateCaseWaiting(supabase, caseId: string, reason: CaseWaitReason): Promise<void>`; `updateCaseStatus`'s update payload now always includes `wait_reason: null`; `listCasesByStatus(supabase, status: CaseStatus | CaseStatus[], limit: number): Promise<CaseRow[]>` (widened from single-status only). All three functions are consumed directly by Tasks 4-9.

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/db/cases.test.ts`. First, widen `mockStatusUpdate` to capture the update payload (needed to assert `wait_reason: null` is included), and widen `mockByStatus`'s chain from `.eq()` to `.in()`:

```ts
function mockStatusUpdate(result: { error: unknown }) {
  const updateCalls: unknown[] = []
  const supabase = {
    from: () => ({
      update: (payload: unknown) => {
        updateCalls.push(payload)
        return { eq: () => Promise.resolve(result) }
      },
    }),
  } as never
  return { supabase, updateCalls }
}
function mockByStatus(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ in: () => ({ order: () => ({ limit: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}
```

Update the existing `updateCaseStatus` describe block for the new helper shape and add the `wait_reason: null` assertion:

```ts
describe('updateCaseStatus', () => {
  it('should resolve when the update succeeds', async () => {
    const { supabase } = mockStatusUpdate({ error: null })
    await expect(updateCaseStatus(supabase, 'case1', 'ready')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockStatusUpdate({ error: { message: 'boom' } })
    await expect(updateCaseStatus(supabase, 'case1', 'ready')).rejects.toBeInstanceOf(AppError)
  })

  it('should always clear wait_reason, so a case leaving waiting never violates the DB check constraint', async () => {
    const { supabase, updateCalls } = mockStatusUpdate({ error: null })
    await updateCaseStatus(supabase, 'case1', 'contacted')
    expect(updateCalls[0]).toMatchObject({ status: 'contacted', wait_reason: null })
  })
})

describe('updateCaseWaiting', () => {
  it('should set status to waiting with the given reason', async () => {
    const { supabase, updateCalls } = mockStatusUpdate({ error: null })
    await expect(updateCaseWaiting(supabase, 'case1', 'mailreach_gate')).resolves.toBeUndefined()
    expect(updateCalls[0]).toMatchObject({ status: 'waiting', wait_reason: 'mailreach_gate' })
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const { supabase } = mockStatusUpdate({ error: { message: 'boom' } })
    await expect(updateCaseWaiting(supabase, 'case1', 'daily_cap')).rejects.toBeInstanceOf(AppError)
  })
})
```

Update the `listCasesByStatus` describe block for the array form:

```ts
describe('listCasesByStatus', () => {
  it('should return rows when the query succeeds with a single status', async () => {
    const rows = [{ id: 'case1' }]
    expect(await listCasesByStatus(mockByStatus({ data: rows, error: null }), 'new', 100)).toEqual(rows)
  })

  it('should return rows when the query succeeds with an array of statuses', async () => {
    const rows = [{ id: 'case1' }, { id: 'case2' }]
    expect(await listCasesByStatus(mockByStatus({ data: rows, error: null }), ['ready', 'waiting'], 100)).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listCasesByStatus(mockByStatus({ data: null, error: { message: 'boom' } }), 'new', 100),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `updateCaseWaiting` to the import list at the top of the file:

```ts
import {
  findOrCreateCase,
  getCaseById,
  updateCaseStatus,
  updateCaseWaiting,
  listCasesByStatus,
  listStuckCases,
  countCasesForCampaign,
  claimCollisionNotice,
} from './cases'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db/cases.test.ts`
Expected: FAIL — `updateCaseWaiting` is not exported yet; `mockStatusUpdate`'s new destructured shape breaks the two pre-existing `updateCaseStatus` tests until Step 1's rewrite of those two tests (above) is in place; `listCasesByStatus` array-form test fails because `.in` isn't called by the current implementation.

- [ ] **Step 3: Implement**

Edit `src/lib/db/cases.ts`. Add the new type and constant right after the existing `CaseStatus` export:

```ts
export type CaseRow = Database['public']['Tables']['cases']['Row']
export type CaseStatus = Database['public']['Enums']['case_status']
export type CaseWaitReason = Database['public']['Enums']['case_wait_reason']

// The three mailbox-availability reasons the write-fanout cron (every 5
// minutes) re-checks automatically. 'awaiting_manual_approval' clears via a
// human clicking Approve in /inbox; 'no_viable_leads' clears only if
// discovery adds a new lead — neither is time-based, so neither belongs
// here. See docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md.
export const AUTO_RETRY_WAIT_REASONS: readonly CaseWaitReason[] = [
  'mailreach_gate',
  'daily_cap',
  'no_healthy_mailbox',
]
```

Replace `updateCaseStatus` and `listCasesByStatus`:

```ts
// Every call site here sets a non-waiting status, so unconditionally
// clearing wait_reason is always correct — and required: the
// cases_wait_reason_matches_status check constraint (0049) rejects any row
// where status != 'waiting' but wait_reason is still set.
export async function updateCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
  status: CaseStatus,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status, wait_reason: null, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case status', { caseId, status, cause: error.message })
  }
}

export async function updateCaseWaiting(
  supabase: SupabaseClient<Database>,
  caseId: string,
  reason: CaseWaitReason,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status: 'waiting', wait_reason: reason, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case to waiting', { caseId, reason, cause: error.message })
  }
}

export async function listCasesByStatus(
  supabase: SupabaseClient<Database>,
  status: CaseStatus | CaseStatus[],
  limit: number,
): Promise<CaseRow[]> {
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .in('status', Array.isArray(status) ? status : [status])
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list cases by status', { status, cause: error.message })
  }
  return data ?? []
}
```

`research-fanout/route.ts`'s existing call `listCasesByStatus(admin, 'new', FANOUT_LIMIT)` needs no change — `'new'` still matches the `CaseStatus` branch of the widened union.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/cases.test.ts`
Expected: PASS, all tests including the new ones.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/cases.ts src/lib/db/cases.test.ts
git commit -m "feat(cases): add updateCaseWaiting, widen listCasesByStatus to arrays

updateCaseStatus now always clears wait_reason (required by the 0049
check constraint). listCasesByStatus accepts a single status or an array;
research-fanout's existing single-status call is unaffected.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 3: `src/lib/mailbox/eligibility.ts` — the up-front probe

**Files:**
- Create: `src/lib/mailbox/eligibility.ts`
- Test: Create `src/lib/mailbox/eligibility.test.ts`

**Interfaces:**
- Consumes: `listMailboxesByIds(supabase, ids: string[]): Promise<MailboxRow[]>` (existing, `src/lib/db/mailboxes.ts:47-57`); `isEligibleForCampaignSend`, `MAILREACH_CAMPAIGN_GATE_DAYS` (existing, `src/lib/mailbox/mailreach-gate.ts`); `effectiveDailyCap` (existing, `src/lib/mailbox/warmup.ts:88-92`).
- Produces: `export type OutreachEligibility = { eligible: true } | { eligible: false; reason: 'mailreach_gate'; retryAfter: Date } | { eligible: false; reason: 'daily_cap'; retryAfter: Date } | { eligible: false; reason: 'no_healthy_mailbox' }`; `export async function getOutreachEligibility(supabase, input: { mailboxIds: string[]; clientMailreachEnabled: boolean; now: Date }): Promise<OutreachEligibility>`. Consumed directly by Task 4.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/mailbox/eligibility.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getOutreachEligibility } from './eligibility'
import type { MailboxRow } from '@/lib/db/mailboxes'

function mailbox(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: 'm1', client_id: 'c1', provider: 'gmail', email_address: 'a@x.com',
    display_name: null, first_name: null, last_name: null, oauth: {},
    daily_cap: 30, sent_today: 0,
    warmup_profile: 'none', warmup_started_at: null, warmup_start_cap: 5, warmup_increment: 2, warmup_target_cap: 30,
    health: 'ok', health_reason: null, health_changed_at: null,
    mailreach_enabled: false, mailreach_started_at: null, mailreach_account_id: null, mailreach_status: 'disconnected',
    mailreach_reputation_score: null, mailreach_total_messages_sent: null, mailreach_total_messages_received: null,
    mailreach_total_spam: null, mailreach_current_conversations: null, mailreach_stats_synced_at: null,
    inbound_cursor: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function mockSupabaseMailboxes(rows: MailboxRow[]) {
  return {
    from: () => ({ select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) }),
  } as never
}

const NOW = new Date('2026-08-17T12:00:00Z')

describe('getOutreachEligibility', () => {
  it('should return no_healthy_mailbox when mailboxIds is empty', async () => {
    const result = await getOutreachEligibility(mockSupabaseMailboxes([]), {
      mailboxIds: [], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({ eligible: false, reason: 'no_healthy_mailbox' })
  })

  it('should return no_healthy_mailbox when every mailbox is blocked', async () => {
    const rows = [mailbox({ id: 'm1', health: 'blocked' }), mailbox({ id: 'm2', health: 'blocked' })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1', 'm2'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({ eligible: false, reason: 'no_healthy_mailbox' })
  })

  it('should return mailreach_gate with the earliest lift time when every healthy mailbox is still gated', async () => {
    const rows = [
      mailbox({ id: 'm1', mailreach_enabled: true, mailreach_started_at: '2026-08-10T00:00:00Z' }), // day 7, lifts 2026-08-24
      mailbox({ id: 'm2', mailreach_enabled: true, mailreach_started_at: '2026-08-05T00:00:00Z' }), // day 12, lifts 2026-08-19 (earlier)
    ]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1', 'm2'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({
      eligible: false, reason: 'mailreach_gate', retryAfter: new Date('2026-08-19T00:00:00Z'),
    })
  })

  it('should return daily_cap with next UTC midnight when every gate-cleared mailbox is at its cap', async () => {
    const rows = [mailbox({ id: 'm1', daily_cap: 10, sent_today: 10 })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({
      eligible: false, reason: 'daily_cap', retryAfter: new Date('2026-08-18T00:00:00Z'),
    })
  })

  it('should return eligible: true when at least one mailbox is healthy, gate-cleared, and under cap', async () => {
    const rows = [
      mailbox({ id: 'm1', health: 'blocked' }),
      mailbox({ id: 'm2', mailreach_enabled: true, mailreach_started_at: '2026-08-01T00:00:00Z' }), // day 16, cleared
      mailbox({ id: 'm3', daily_cap: 10, sent_today: 10 }), // capped
    ]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1', 'm2', 'm3'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({ eligible: true })
  })

  it('should treat sent_today === effective cap as not ready (boundary, matches claim_mailbox_send)', async () => {
    const rows = [mailbox({ id: 'm1', daily_cap: 10, sent_today: 10, warmup_profile: 'none' })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result.eligible).toBe(false)
  })

  it('should treat a mailbox as gate-cleared when the client mailreach switch is off, even mid-warmup', async () => {
    const rows = [mailbox({ id: 'm1', mailreach_enabled: true, mailreach_started_at: '2026-08-16T00:00:00Z' })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1'], clientMailreachEnabled: false, now: NOW,
    })
    expect(result).toEqual({ eligible: true })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/eligibility.test.ts`
Expected: FAIL with "Cannot find module './eligibility'".

- [ ] **Step 3: Implement**

Create `src/lib/mailbox/eligibility.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listMailboxesByIds, type MailboxRow } from '@/lib/db/mailboxes'
import { isEligibleForCampaignSend, MAILREACH_CAMPAIGN_GATE_DAYS } from '@/lib/mailbox/mailreach-gate'
import { effectiveDailyCap } from '@/lib/mailbox/warmup'

export type OutreachEligibility =
  | { eligible: true }
  | { eligible: false; reason: 'mailreach_gate'; retryAfter: Date }
  | { eligible: false; reason: 'daily_cap'; retryAfter: Date }
  | { eligible: false; reason: 'no_healthy_mailbox' }

const MS_PER_DAY = 86_400_000

// Mirrors claim_mailbox_send's own predicate exactly (migration 0012:
// `health <> 'blocked' and sent_today < least(daily_cap, greatest(p_effective_cap, 0))`)
// — a read-only echo, not the enforcement point. sender.ts's atomic RPC stays
// the real gate; this can race harmlessly (a mailbox counted "capped" here
// may have already reset by the time a real send attempt runs, and vice
// versa) since a wrong "eligible: true" here just falls through to
// sender.ts's real, atomic check.
function isCapReady(mailbox: MailboxRow, now: Date): boolean {
  const cap = Math.min(mailbox.daily_cap, Math.max(effectiveDailyCap({
    profile: mailbox.warmup_profile,
    warmupStartedAt: mailbox.warmup_started_at,
    startCap: mailbox.warmup_start_cap,
    increment: mailbox.warmup_increment,
    targetCap: mailbox.warmup_target_cap,
    dailyCap: mailbox.daily_cap,
    now,
  }), 0))
  return mailbox.sent_today < cap
}

function nextMidnightUtc(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1))
}

function gateLiftsAt(mailbox: MailboxRow): Date {
  // Only called for a mailbox already known to be gated (mailreach_started_at
  // non-null, enrolled) — see call site below.
  return new Date(Date.parse(mailbox.mailreach_started_at!) + MAILREACH_CAMPAIGN_GATE_DAYS * MS_PER_DAY)
}

export async function getOutreachEligibility(
  supabase: SupabaseClient<Database>,
  input: { mailboxIds: string[]; clientMailreachEnabled: boolean; now: Date },
): Promise<OutreachEligibility> {
  const mailboxes = await listMailboxesByIds(supabase, input.mailboxIds)
  const healthy = mailboxes.filter((m) => m.health !== 'blocked')
  if (healthy.length === 0) return { eligible: false, reason: 'no_healthy_mailbox' }

  const gateOk = (m: MailboxRow): boolean =>
    isEligibleForCampaignSend({
      mailreachEnabled: m.mailreach_enabled,
      clientMailreachEnabled: input.clientMailreachEnabled,
      mailreachStartedAt: m.mailreach_started_at,
      now: input.now,
    })

  const gatePassed = healthy.filter(gateOk)
  if (gatePassed.length === 0) {
    // Every healthy mailbox is gated — isEligibleForCampaignSend can only be
    // false when mailreachStartedAt is non-null (see mailreach-gate.ts), so
    // gateLiftsAt is well-defined for each row here. `healthy` is non-empty
    // by construction (the no_healthy_mailbox branch above already returned
    // if it were empty), so reduce without an initial value is safe — no
    // non-null assertion needed.
    const liftTimes = healthy.map(gateLiftsAt)
    const retryAfter = liftTimes.reduce((earliest, t) => (t < earliest ? t : earliest))
    return { eligible: false, reason: 'mailreach_gate', retryAfter }
  }

  if (gatePassed.some((m) => isCapReady(m, input.now))) return { eligible: true }

  // Every gate-cleared mailbox is at today's cap. A diagnostic label only —
  // the retry cadence is the same 5-minute tick regardless of reason.
  return { eligible: false, reason: 'daily_cap', retryAfter: nextMidnightUtc(input.now) }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/eligibility.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailbox/eligibility.ts src/lib/mailbox/eligibility.test.ts
git commit -m "feat(mailbox): add getOutreachEligibility up-front probe

Composes the existing isEligibleForCampaignSend gate primitive with
health and daily-cap awareness, mirroring claim_mailbox_send's own
predicate. Not yet wired into write.ts.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 4: `src/lib/pipeline/write.ts` — wire up the probe and honest status

**Files:**
- Modify: `src/lib/pipeline/write.ts` (imports, `RunWriteInput`, `processLead`'s return type and RATE_LIMITED branch, `runWriteForCase`)
- Test: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `getOutreachEligibility` (Task 3); `updateCaseWaiting`, `CaseWaitReason` (Task 2); `updateCaseStatus` (existing, now wait_reason-clearing).
- Produces: `RunWriteInput` gains `currentStatus: CaseStatus` and `currentWaitReason: CaseWaitReason | null` — Task 6 (`write/route.ts`) must pass these on every call.

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/pipeline/write.test.ts`. Add two new mocks and their `vi.mock` registrations near the top:

```ts
const getOutreachEligibilityMock = vi.fn()
const updateCaseWaitingMock = vi.fn()
```

```ts
vi.mock('@/lib/mailbox/eligibility', () => ({ getOutreachEligibility: (...a: unknown[]) => getOutreachEligibilityMock(...a) }))
vi.mock('@/lib/db/cases', () => ({
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
  updateCaseWaiting: (...a: unknown[]) => updateCaseWaitingMock(...a),
}))
```

(This replaces the existing single-export `@/lib/db/cases` mock.)

Add both new mocks to the `beforeEach` reset array, and set the eligibility default so every existing test — which doesn't care about eligibility — keeps passing unmodified:

```ts
beforeEach(() => {
  for (const m of [listKnowledgeMock, listActiveLeadsMock, isSuppressedMock, claimOutboundEmailMock,
    markEmailSentMock, markEmailFailedMock, createSequenceMock, advanceSequenceMock, sendViaMailboxMock,
    generateJsonMock, updateCaseStatusMock, updateCaseWaitingMock, publishDelayMock, logEventMock, enqueueCrmSyncMock,
    getClientByIdMock, getEmailTemplateByIdMock, getDefaultEmailTemplateMock, getOutreachEligibilityMock]) m.mockReset()
  listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])
  isSuppressedMock.mockResolvedValue(false)
  generateJsonMock.mockResolvedValue({ subject: 'Quick idea for Acme', body: 'Hi Jane...' })
  getOutreachEligibilityMock.mockResolvedValue({ eligible: true })
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null, company_info: null, email_template_id: null })
  getDefaultEmailTemplateMock.mockResolvedValue({ id: 'default-template', name: 'Concise (default)', template_text: 'Default voice text.', is_default: true })
})
```

Add `currentStatus`/`currentWaitReason` to the shared `input` fixture (every test inherits this via spread):

```ts
const input = {
  clientId: 'c1', campaignId: 'camp1', caseId: 'case1', replyMode: 'auto_send' as const,
  valueProp: 'We save time', bookingLink: 'https://cal.com/x', mailboxIds: ['m1'], companyName: 'Acme',
  signatureName: null, signatureTitle: null, signaturePhone: null, signatureAddress: null,
  campaignEmailTemplateId: null,
  currentStatus: 'writing' as const, currentWaitReason: null,
}
```

Now extend three existing tests and add five new ones inside `describe('runWriteForCase', ...)`.

Extend the happy-path test (assert the CRM sync that was previously unverified):

```ts
  it('should write, send, create a sequence, and enqueue the first follow-up on auto_send', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 1 })
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalled()
    expect(advanceSequenceMock).toHaveBeenCalledWith(
      expect.anything(),
      'seq1',
      expect.objectContaining({ qstashMessageId: 'qmsg1' }),
    )
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'contacted')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'contacted')
  })
```

Extend the suppressed-lead test:

```ts
  it('should skip a suppressed lead and mark the case waiting with no_viable_leads', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    isSuppressedMock.mockResolvedValue(true)
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
    expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'no_viable_leads')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
  })
```

Extend the every-mailbox-rate-limited test (the key case that motivated tracking a distinct `rate_limited` outcome — see Step 3):

```ts
  it('should mark the email failed, skip, and mark the case waiting with an auto-retry reason when every mailbox is rate limited', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no mailbox available'))

    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(markEmailFailedMock).toHaveBeenCalledWith(expect.anything(), 'e1')
    expect(markEmailSentMock).not.toHaveBeenCalled()
    // Re-probed after the loop (getOutreachEligibilityMock's beforeEach
    // default of `{ eligible: true }` applies to this recheck too) — labeled
    // 'daily_cap' rather than left unlabeled, so the fanout still retries it.
    expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'daily_cap')
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'contacted')
  })
```

New tests — the up-front short-circuit:

```ts
  it('should mark the case waiting and skip all lead work when the eligibility probe says ineligible', async () => {
    getOutreachEligibilityMock.mockResolvedValue({
      eligible: false, reason: 'mailreach_gate', retryAfter: new Date('2026-08-19T00:00:00Z'),
    })
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(listKnowledgeMock).not.toHaveBeenCalled()
    expect(listActiveLeadsMock).not.toHaveBeenCalled()
    expect(generateJsonMock).not.toHaveBeenCalled()
    expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'mailreach_gate')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.write.waiting',
      payload: { reason: 'mailreach_gate', retryAfter: '2026-08-19T00:00:00.000Z' },
    }))
  })

  it('should not log a transition event when the case is already waiting for the same reason', async () => {
    getOutreachEligibilityMock.mockResolvedValue({
      eligible: false, reason: 'mailreach_gate', retryAfter: new Date('2026-08-19T00:00:00Z'),
    })
    await runWriteForCase({} as never, { ...input, currentStatus: 'waiting' as const, currentWaitReason: 'mailreach_gate' as const })
    expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'mailreach_gate')
    expect(logEventMock).not.toHaveBeenCalled()
  })

  it('should log a transition event when the wait reason changes from the previous tick', async () => {
    getOutreachEligibilityMock.mockResolvedValue({
      eligible: false, reason: 'daily_cap', retryAfter: new Date('2026-08-18T00:00:00Z'),
    })
    await runWriteForCase({} as never, { ...input, currentStatus: 'waiting' as const, currentWaitReason: 'mailreach_gate' as const })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.write.waiting' }))
  })

  it('should probe eligibility with the campaign mailbox ids and the client mailreach flag before touching leads', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null,
      signature_name: null, signature_title: null, company_info: null, email_template_id: null, mailreach_enabled: true,
    })
    listActiveLeadsMock.mockResolvedValue([])
    await runWriteForCase({} as never, input)
    expect(getOutreachEligibilityMock).toHaveBeenCalledWith(expect.anything(), {
      mailboxIds: ['m1'], clientMailreachEnabled: true, now: expect.any(Date),
    })
    expect(listActiveLeadsMock).toHaveBeenCalled() // eligible, so the loop still proceeds
  })
```

New test — the `human_approve`/all-drafted case:

```ts
  it('should draft and mark the case waiting with awaiting_manual_approval on human_approve (not contacted)', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    const result = await runWriteForCase({} as never, { ...input, replyMode: 'human_approve' })
    expect(result).toEqual({ caseId: 'case1', drafted: 1, sent: 0 })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'awaiting_manual_approval')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/write.test.ts`
Expected: FAIL — `runWriteForCase` doesn't call `getOutreachEligibility`/`updateCaseWaiting` yet, so every new/extended assertion misses; the end-of-loop still unconditionally calls `updateCaseStatus(..., 'contacted')`.

- [ ] **Step 3: Implement**

Edit `src/lib/pipeline/write.ts`. Add imports:

```ts
import { updateCaseStatus, updateCaseWaiting, type CaseWaitReason } from '@/lib/db/cases'
import { getOutreachEligibility } from '@/lib/mailbox/eligibility'
```

(Replaces the existing `import { updateCaseStatus } from '@/lib/db/cases'`.)

Add the two new fields to `RunWriteInput`, right after `campaignEmailTemplateId`:

```ts
  // Per-campaign override of the owning client's email template — null
  // means inherit the client's template. See resolveEmailTemplate below.
  campaignEmailTemplateId: string | null
  // The case's status/wait_reason as loaded by the caller (write/route.ts)
  // just before this run — used only to suppress a redundant
  // 'pipeline.write.waiting' log when a retried, still-ineligible case
  // hasn't actually changed state since the last tick.
  currentStatus: Database['public']['Enums']['case_status']
  currentWaitReason: CaseWaitReason | null
}
```

Widen `processLead`'s return type and distinguish the RATE_LIMITED outcome from a permanent skip:

```ts
async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  client: ClientRow | null,
): Promise<'sent' | 'drafted' | 'skipped' | 'rate_limited'> {
```

```ts
  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: input.clientId,
      mailboxIds: input.mailboxIds,
      to: lead.email,
      subject: draft.subject,
      body: signedBody,
      purpose: 'outreach',
    })
  } catch (error) {
    // Only a delivery failure means the email was never sent — mark it failed.
    // A failure in the bookkeeping below means the message already went out
    // and must not be treated as a send failure.
    await markEmailFailed(supabase, claimed.id)
    // Distinct from a plain 'skipped' (permanently disqualified lead): this
    // is the up-front eligibility probe (below, before the loop) racing with
    // the real atomic send — still a mailbox-availability condition, not
    // "nothing left to do". runWriteForCase re-probes once after the loop to
    // label the case correctly instead of guessing.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') return 'rate_limited'
    throw error
  }
```

Replace `runWriteForCase` in full:

```ts
export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const client = await getClientById(supabase, input.clientId)

  const eligibility = await getOutreachEligibility(supabase, {
    mailboxIds: input.mailboxIds,
    clientMailreachEnabled: client?.mailreach_enabled ?? false,
    now: new Date(),
  })
  if (!eligibility.eligible) {
    const changed = input.currentStatus !== 'waiting' || input.currentWaitReason !== eligibility.reason
    await updateCaseWaiting(supabase, input.caseId, eligibility.reason)
    // Logged only on an actual transition — a still-gated case re-checked
    // every 5 minutes for hours must not spam the event log each tick.
    if (changed) {
      await logEventSafe({
        clientId: input.clientId,
        caseId: input.caseId,
        actor: ACTOR,
        type: 'pipeline.write.waiting',
        payload: {
          reason: eligibility.reason,
          retryAfter: 'retryAfter' in eligibility ? eligibility.retryAfter.toISOString() : null,
        },
      })
    }
    return { caseId: input.caseId, drafted: 0, sent: 0 }
  }

  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)

  let sent = 0
  let drafted = 0
  let rateLimited = 0
  for (const lead of leads) {
    // `k.lead_id ?? null` (not a bare `=== null` check) treats a row that
    // omits the field entirely the same as one that explicitly has it null —
    // both existing test fixtures and any case_knowledge row inserted before
    // this migration lack the key outright, and both mean "company-wide
    // fact," never "silently excluded."
    const leadKnowledge = knowledge.filter((k) => (k.lead_id ?? null) === null || k.lead_id === lead.id)
    const outcome = await processLead(supabase, input, lead, leadKnowledge, client)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
    if (outcome === 'rate_limited') rateLimited += 1
  }

  if (sent > 0) {
    await updateCaseStatus(supabase, input.caseId, 'contacted')
    await enqueueCrmSync(input.caseId, 'contacted')
  } else if (drafted > 0) {
    // human_approve, or hybrid's first-touch step — nothing sent yet, a
    // human owns the next move in /inbox. approveDraft is what eventually
    // advances this case to 'contacted'.
    await updateCaseWaiting(supabase, input.caseId, 'awaiting_manual_approval')
  } else if (rateLimited > 0) {
    // The up-front probe said eligible, but at least one lead's real send
    // hit RATE_LIMITED anyway (a same-tick race — see eligibility.ts's
    // isCapReady comment). Re-probe now so the case is labeled with an
    // accurate, auto-retryable reason for the next fanout tick, instead of
    // assuming.
    const recheck = await getOutreachEligibility(supabase, {
      mailboxIds: input.mailboxIds,
      clientMailreachEnabled: client?.mailreach_enabled ?? false,
      now: new Date(),
    })
    await updateCaseWaiting(supabase, input.caseId, recheck.eligible ? 'daily_cap' : recheck.reason)
  } else {
    // Every active lead was permanently disqualified this attempt (missing
    // email, suppressed) — processLead checks suppression before
    // generation, so this path never paid for an LLM call either. Not
    // 'contacted' (never sent), and not left at 'writing' (would misread as
    // stuck and get endlessly re-queued by stuck-sweep for a condition that
    // won't change on its own). 'no_viable_leads' is deliberately excluded
    // from the auto-retry set — nothing about waiting 5 more minutes
    // changes a suppression list.
    //
    // (A narrower pre-existing imprecision: a lead skipped because a
    // concurrent write already claimed its step-0 slot also lands here,
    // same as it unconditionally became 'contacted' before this change —
    // not a new regression, and case-level write concurrency is out of
    // scope for this fix.)
    await updateCaseWaiting(supabase, input.caseId, 'no_viable_leads')
  }

  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.write.completed',
    payload: { caseId: input.caseId, sent, drafted, leadCount: leads.length },
  })
  return { caseId: input.caseId, drafted, sent }
}
```

Note `const client = await getClientById(...)` moved to the top of the function (it already ran once per case, right after `listActiveLeadsForCase` — now reused for both the eligibility probe and the existing per-lead generation calls, not fetched twice).

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/write.test.ts`
Expected: PASS, all existing and new tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "fix(pipeline): stop write.ts from claiming contacted when nothing sent

Root fix for two bugs sharing one cause (unconditional end-of-loop
status write): a gate-blocked first touch silently losing the lead, and
a human_approve case with only drafts falsely CRM-syncing 'contacted'.
runWriteForCase now probes mailbox eligibility before touching any
lead (skips LLM cost entirely while gated) and only advances to
'contacted' when a lead actually sent; every other outcome lands on
'waiting' with a specific reason.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 5: `write-fanout` route — sweep waiting cases too

**Files:**
- Modify: `src/app/api/pipeline/write-fanout/route.ts`
- Test: Create `src/app/api/pipeline/write-fanout/route.test.ts` (no test file exists for this route today)

**Interfaces:**
- Consumes: `listCasesByStatus` (widened, Task 2), `AUTO_RETRY_WAIT_REASONS` (Task 2).

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/pipeline/write-fanout/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const listCasesByStatusMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  listCasesByStatus: (...a: unknown[]) => listCasesByStatusMock(...a),
  AUTO_RETRY_WAIT_REASONS: ['mailreach_gate', 'daily_cap', 'no_healthy_mailbox'],
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req() {
  return new Request('http://x/api/pipeline/write-fanout', { method: 'POST', body: '{}' })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue('{}')
  listCasesByStatusMock.mockReset()
  publishJsonMock.mockReset().mockResolvedValue('qmsg1')
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/write-fanout', () => {
  it('should query both ready and waiting cases', async () => {
    listCasesByStatusMock.mockResolvedValue([])
    await POST(req())
    expect(listCasesByStatusMock).toHaveBeenCalledWith(expect.anything(), ['ready', 'waiting'], 200)
  })

  it('should dispatch a ready case', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'ready', wait_reason: null }])
    await POST(req())
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
  })

  it('should dispatch a waiting case with an auto-retry reason', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'waiting', wait_reason: 'mailreach_gate' }])
    await POST(req())
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
  })

  it('should not dispatch a waiting case that needs manual approval', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'waiting', wait_reason: 'awaiting_manual_approval' }])
    const res = await POST(req())
    const json = await res.json()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(json.caseCount).toBe(0)
  })

  it('should not dispatch a waiting case with no viable leads', async () => {
    listCasesByStatusMock.mockResolvedValue([{ id: 'case1', status: 'waiting', wait_reason: 'no_viable_leads' }])
    await POST(req())
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should dispatch a mix, publishing and counting only the eligible ones', async () => {
    listCasesByStatusMock.mockResolvedValue([
      { id: 'case1', status: 'ready', wait_reason: null },
      { id: 'case2', status: 'waiting', wait_reason: 'daily_cap' },
      { id: 'case3', status: 'waiting', wait_reason: 'awaiting_manual_approval' },
    ])
    const res = await POST(req())
    const json = await res.json()
    expect(publishJsonMock).toHaveBeenCalledTimes(2)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case2' })
    expect(json.caseCount).toBe(2)
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req())
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/pipeline/write-fanout/route.test.ts`
Expected: FAIL — the route still queries only `'ready'` and dispatches every returned case unconditionally, so the `['ready', 'waiting']` query-shape assertion and the manual-approval/no-viable-leads filtering assertions miss.

- [ ] **Step 3: Implement**

Replace `src/app/api/pipeline/write-fanout/route.ts` in full:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCasesByStatus, AUTO_RETRY_WAIT_REASONS } from '@/lib/db/cases'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const FANOUT_LIMIT = 200

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const cases = await listCasesByStatus(admin, ['ready', 'waiting'], FANOUT_LIMIT)
    // A 'waiting' case with a non-time-based reason (awaiting a human's
    // approval click, or no viable leads) doesn't belong in this sweep —
    // only the three mailbox-availability reasons resolve by waiting.
    const dispatchable = cases.filter(
      (c) => c.status === 'ready' || (c.wait_reason !== null && AUTO_RETRY_WAIT_REASONS.includes(c.wait_reason)),
    )
    const failedCaseIds: string[] = []
    for (const c of dispatchable) {
      try {
        await publishJson('/api/pipeline/write', { caseId: c.id })
      } catch {
        failedCaseIds.push(c.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.write_fanout.completed',
        payload: { caseCount: dispatchable.length, failedCaseIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, caseCount: dispatchable.length, failedCaseIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/pipeline/write-fanout/route.test.ts`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/write-fanout/route.ts src/app/api/pipeline/write-fanout/route.test.ts
git commit -m "feat(pipeline): sweep auto-retryable waiting cases in write-fanout

The existing 5-minute cron now also picks up 'waiting' cases whose
reason is mailbox-availability-based (gate/cap/no-healthy-mailbox);
'awaiting_manual_approval' and 'no_viable_leads' cases are filtered
out before dispatch — neither resolves by waiting.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 6: `write` route — accept and thread through waiting cases

**Files:**
- Modify: `src/app/api/pipeline/write/route.ts`
- Test: `src/app/api/pipeline/write/route.test.ts`

**Interfaces:**
- Consumes: `AUTO_RETRY_WAIT_REASONS` (Task 2); `RunWriteInput.currentStatus`/`currentWaitReason` (Task 4).

- [ ] **Step 1: Write the failing tests**

Edit `src/app/api/pipeline/write/route.test.ts`. Update the `@/lib/db/cases` mock to also export `AUTO_RETRY_WAIT_REASONS`:

```ts
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
  AUTO_RETRY_WAIT_REASONS: ['mailreach_gate', 'daily_cap', 'no_healthy_mailbox'],
}))
```

Add three new tests inside `describe('POST /api/pipeline/write', ...)`:

```ts
  it('should run write for a waiting case with an auto-retry reason', async () => {
    getCaseByIdMock.mockResolvedValue({
      id: CASE_ID, client_id: 'c1', status: 'waiting', wait_reason: 'mailreach_gate', company_name: 'Acme',
    })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockResolvedValue({ caseId: CASE_ID, sent: 1, drafted: 0 })
    const res = await POST(req({ caseId: CASE_ID }))
    expect(res.status).toBe(200)
    expect(runWriteMock).toHaveBeenCalled()
  })

  it('should skip a waiting case that needs manual approval', async () => {
    getCaseByIdMock.mockResolvedValue({
      id: CASE_ID, client_id: 'c1', status: 'waiting', wait_reason: 'awaiting_manual_approval', company_name: 'Acme',
    })
    const res = await POST(req({ caseId: CASE_ID }))
    const json = await res.json()
    expect(json.skipped).toBe('case_not_ready')
    expect(runWriteMock).not.toHaveBeenCalled()
  })

  it("should pass the case's current status and wait reason through to runWriteForCase", async () => {
    getCaseByIdMock.mockResolvedValue({
      id: CASE_ID, client_id: 'c1', status: 'waiting', wait_reason: 'daily_cap', company_name: 'Acme',
    })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
      signature_name: null, signature_title: null, phone: null, address: null,
    })
    runWriteMock.mockResolvedValue({ caseId: CASE_ID, sent: 1, drafted: 0 })
    await POST(req({ caseId: CASE_ID }))
    expect(runWriteMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ currentStatus: 'waiting', currentWaitReason: 'daily_cap' }),
    )
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/pipeline/write/route.test.ts`
Expected: FAIL — the route still rejects anything but `status === 'ready'` with `case_not_ready`, and doesn't pass `currentStatus`/`currentWaitReason` to `runWriteForCase`.

- [ ] **Step 3: Implement**

Edit `src/app/api/pipeline/write/route.ts`. Update the import and the entry guard:

```ts
import { getCaseById, updateCaseStatus, AUTO_RETRY_WAIT_REASONS } from '@/lib/db/cases'
```

```ts
    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
    clientId = kase.client_id
    const resumable = kase.status === 'ready'
      || (kase.status === 'waiting' && kase.wait_reason !== null && AUTO_RETRY_WAIT_REASONS.includes(kase.wait_reason))
    if (!resumable) return NextResponse.json({ ok: true, skipped: 'case_not_ready' })
```

Pass the two new fields through to `runWriteForCase`:

```ts
      const summary = await runWriteForCase(admin, {
        clientId: kase.client_id,
        campaignId: campaign.id,
        caseId: parsedBody.caseId,
        replyMode: campaign.reply_mode,
        valueProp: campaign.value_prop,
        bookingLink: campaign.booking_link,
        mailboxIds: campaign.mailbox_ids,
        companyName: kase.company_name,
        signatureName: campaign.signature_name,
        signatureTitle: campaign.signature_title,
        signaturePhone: campaign.phone,
        signatureAddress: campaign.address,
        campaignEmailTemplateId: campaign.email_template_id,
        currentStatus: kase.status,
        currentWaitReason: kase.wait_reason,
      })
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/pipeline/write/route.test.ts`
Expected: PASS, all existing and new tests.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/write/route.ts src/app/api/pipeline/write/route.test.ts
git commit -m "feat(pipeline): accept auto-retryable waiting cases in write route

Widens the entry guard beyond status==='ready' and threads the case's
current status/wait_reason through to runWriteForCase so it can
suppress a redundant log on an unchanged retry tick.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 7: `approveDraft` — close the loop on manual approval

**Files:**
- Modify: `src/app/(app)/inbox/actions.ts`
- Test: `src/app/(app)/inbox/actions.test.ts`

**Interfaces:**
- Consumes: `getCaseById`, `updateCaseStatus` (`@/lib/db/cases`); `enqueueCrmSync` (`@/lib/crm/sync`, existing).

- [ ] **Step 1: Write the failing tests**

Edit `src/app/(app)/inbox/actions.test.ts`. Add three new mocks:

```ts
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
```

Add their `vi.mock` registrations:

```ts
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))
```

Add all three to the `beforeEach` reset array and give `getCaseByIdMock` a default that exercises the fix (a case waiting on manual approval — the common real-world state this task closes):

```ts
beforeEach(() => {
  for (const m of [requireUserMock, createAdminClientMock, getEmailByIdMock, claimDraftForSendMock,
    markEmailSentMock, markEmailFailedMock, scheduleFirstFollowupMock,
    getCampaignForCaseMock, getLeadByIdMock, sendViaMailboxMock,
    revalidatePathMock, logEventSafeMock, claimAnswerMock, getKnowledgeRequestByIdMock,
    hasReplyForInboundMock, insertKnowledgeMock, runKnowledgeAnswerMock,
    listAttachmentsForEmailMock, replaceEmailAttachmentsMock, loadResourceAttachmentsMock,
    resolveSelectedResourcesMock, updateDraftContentRowMock, regenerateDraftContentPipelineMock,
    getCaseByIdMock, updateCaseStatusMock, enqueueCrmSyncMock]) m.mockReset()
  requireUserMock.mockResolvedValue({ user: { id: 'user1' }, appUser: { id: 'user1', role: 'operator', client_id: null } })
  listAttachmentsForEmailMock.mockResolvedValue([])
  replaceEmailAttachmentsMock.mockResolvedValue(undefined)
  loadResourceAttachmentsMock.mockResolvedValue([])
  resolveSelectedResourcesMock.mockResolvedValue([])
  getKnowledgeRequestByIdMock.mockResolvedValue({ id: KR_ID, client_id: 'c1', case_id: 'case1' })
  createAdminClientMock.mockReturnValue({})
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', email: 'jane@acme.com' })
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'] })
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
  claimDraftForSendMock.mockResolvedValue(draftEmail({ status: 'queued' }))
  scheduleFirstFollowupMock.mockResolvedValue(undefined)
  claimAnswerMock.mockResolvedValue({ id: KR_ID, client_id: 'c1', case_id: 'case1' })
  getCaseByIdMock.mockResolvedValue({ id: 'case1', client_id: 'c1', status: 'waiting', wait_reason: 'awaiting_manual_approval' })
})
```

Extend the happy-path test:

```ts
  it('should send the draft, mark it sent, and schedule the follow-up sequence when approved', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())

    await approveDraft(fd(EMAIL_ID))

    expect(claimDraftForSendMock).toHaveBeenCalledWith({}, EMAIL_ID)
    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(scheduleFirstFollowupMock).toHaveBeenCalledWith({}, {
      clientId: 'c1', caseId: 'case1', leadId: 'lead1',
    })
    expect(getCaseByIdMock).toHaveBeenCalledWith({}, 'case1')
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'contacted')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'contacted')
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })
```

Add new tests:

```ts
  it('should not advance the case or re-sync the CRM when the case is already contacted', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    getCaseByIdMock.mockResolvedValue({ id: 'case1', client_id: 'c1', status: 'contacted' })

    await approveDraft(fd(EMAIL_ID))

    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })

  it('should not fail the send when advancing the case to contacted throws', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    getCaseByIdMock.mockRejectedValue(new Error('db down'))

    await expect(approveDraft(fd(EMAIL_ID))).resolves.toBeUndefined()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox.schedule_followup_failed' }),
    )
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })
```

Extend the "scheduling throws" test (it must never reach the new case-status code, since that only runs after `scheduleFirstFollowup` succeeds):

```ts
  it('should not fail the send when scheduling the first follow-up throws', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    scheduleFirstFollowupMock.mockRejectedValue(new Error('qstash down'))

    await expect(approveDraft(fd(EMAIL_ID))).resolves.toBeUndefined()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'inbox.schedule_followup_failed' }),
    )
    expect(getCaseByIdMock).not.toHaveBeenCalled()
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })
```

Extend the non-first-touch test (the whole `FIRST_TOUCH_STEP` block, including the new code, must be skipped):

```ts
  it('should not start a second sequence when approving a non-first-touch step', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ sequence_step: 2 }))
    claimDraftForSendMock.mockResolvedValue(draftEmail({ status: 'queued', sequence_step: 2 }))

    await approveDraft(fd(EMAIL_ID))

    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(scheduleFirstFollowupMock).not.toHaveBeenCalled()
    expect(getCaseByIdMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/\(app\)/inbox/actions.test.ts`
Expected: FAIL — `approveDraft` doesn't call `getCaseById`/`updateCaseStatus`/`enqueueCrmSync` yet.

- [ ] **Step 3: Implement**

Edit `src/app/(app)/inbox/actions.ts`. Add imports:

```ts
import { getCaseById, updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
```

Replace the `FIRST_TOUCH_STEP` block inside `approveDraft`:

```ts
  // Mirror the automated write path: approving the first touch starts the
  // 3/7/14-day cadence, and — for a case that was sitting on
  // 'waiting'/'awaiting_manual_approval' (see
  // docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md)
  // — is also the event that actually contacts the lead, closing the gap
  // where the case (and its CRM sync) previously claimed 'contacted' the
  // moment a draft was written, before any human approved it.
  if (email.sequence_step === FIRST_TOUCH_STEP) {
    try {
      await scheduleFirstFollowup(supabase, {
        clientId: email.client_id,
        caseId: email.case_id,
        leadId: email.lead_id,
      })
      const kase = await getCaseById(supabase, email.case_id)
      // A second lead's first-touch approval on an already-contacted case is
      // a no-op here — only the first approval on a case should advance it
      // and fire the CRM sync.
      if (kase && kase.status !== 'contacted') {
        await updateCaseStatus(supabase, email.case_id, 'contacted')
        await enqueueCrmSync(email.case_id, 'contacted')
      }
    } catch (error) {
      await logEventSafe({
        clientId: email.client_id,
        caseId: email.case_id,
        actor: 'inbox_approve_draft',
        type: 'inbox.schedule_followup_failed',
        payload: { emailId: email.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/\(app\)/inbox/actions.test.ts`
Expected: PASS, all existing and new tests in this file.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/inbox/actions.ts" "src/app/(app)/inbox/actions.test.ts"
git commit -m "fix(inbox): advance case to contacted and sync CRM on real approval

Closes the loop write.ts opened: a human_approve case now only becomes
'contacted' (and only then syncs 'First outreach sent' to the CRM)
when a draft is actually approved and sent, not the moment it's
written.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 8: `send-actions.ts` — let a manual send rescue a waiting case

**Files:**
- Modify: `src/app/(app)/cases/[id]/send-actions.ts`
- Test: `src/app/(app)/cases/[id]/send-actions.test.ts`

**Interfaces:**
- Consumes: none new — `'waiting'` is now a valid `CaseStatus` (Task 1).

- [ ] **Step 1: Write the failing test**

Edit `src/app/(app)/cases/[id]/send-actions.test.ts`. Add a new test right after the existing `'writing'` regression test (around line 177):

```ts
  it('should still advance to contacted when the case is waiting on the mailbox gate', async () => {
    // Regression test: a human manually rescuing a gate-blocked lead from
    // the case page (the safety valve this fix exists to make unnecessary,
    // but must not break — see
    // docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md)
    // must still be able to mark the case contacted, same as 'writing'.
    getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'waiting', wait_reason: 'mailreach_gate' })
    await sendManualEmail(form())
    expect(updateCaseStatus).toHaveBeenCalledWith(expect.anything(), CASE_ID, 'contacted')
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run "src/app/(app)/cases/[id]/send-actions.test.ts"`
Expected: FAIL — `PRE_CONTACT_STATUSES` doesn't include `'waiting'` yet, so `updateCaseStatus` is never called.

- [ ] **Step 3: Implement**

Edit `src/app/(app)/cases/[id]/send-actions.ts`:

```ts
// the automated write pipeline has this case claimed and may be mid-send —
// a human's manual first touch is just as much "this case has now been
// contacted" as the automated one would have produced. 'waiting' (added
// alongside the outreach waiting system) covers a case blocked on the
// mailbox gate/cap/health, or on a human's own draft approval — a manual
// send from here is exactly the rescue path for the first three.
const PRE_CONTACT_STATUSES: readonly string[] = ['new', 'researching', 'ready', 'writing', 'waiting']
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run "src/app/(app)/cases/[id]/send-actions.test.ts"`
Expected: PASS, including the new test and every pre-existing one.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/cases/[id]/send-actions.ts" "src/app/(app)/cases/[id]/send-actions.test.ts"
git commit -m "fix(cases): let a manual send advance a waiting case to contacted

Without this, a human rescuing a gate-blocked lead by emailing them
directly from the case page would send successfully but leave the
case permanently reading 'waiting'.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 9: `crm/page.tsx` — add the Waiting filter chip

**Files:**
- Modify: `src/app/(app)/crm/page.tsx`

**Interfaces:**
- Consumes: `'waiting'` as a valid `CaseStatus`, and `CASE_STATUS['waiting']` for its label — both already landed in Task 1.

- [ ] **Step 1: Implement**

Edit `src/app/(app)/crm/page.tsx`:

```ts
/** Chip order, funnel-first. Terminal stages sit last, matching the list. */
const STATUS_FILTERS = [
  'new',
  'researching',
  'ready',
  'waiting',
  'contacted',
  'in_conversation',
  'hot_handoff',
  'won',
  'lost',
  'dead',
] as const satisfies readonly CaseStatus[]
```

No test file exists for this page-level component (consistent with the rest of `(app)/crm`, `(app)/home`, `(app)/analytics`, `(app)/reports` — QUALITY.md's "React components: critical paths only," satisfied by the pure logic underneath — `CASE_STATUS`, `listCasesByStatus` — already being test-covered elsewhere).

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 3: Manually verify in the running app**

Run: `pnpm dev`, sign in as an operator, open `/crm`. Expected: a "Waiting" filter chip appears between "Ready" and "Contacted" with a `0` count (no waiting cases exist yet pre-deploy) and clicking it shows an empty list, not an error.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/crm/page.tsx"
git commit -m "feat(crm): add a Waiting filter chip to the pipeline kanban

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Task 10: `mailbox.none_healthy` log message — mention warmup specifically

**Files:**
- Modify: `src/lib/ui/log.ts`
- Test: `src/lib/ui/log.test.ts`

**Interfaces:**
- Consumes: none new — reads the existing `warmupGatedCount`/`mailboxCount` fields `sender.ts` already logs (`src/lib/mailbox/sender.ts:165`).

- [ ] **Step 1: Write the failing tests**

Edit `src/lib/ui/log.test.ts`. Add a new `describe` block:

```ts
describe('mailbox.none_healthy', () => {
  it('should mention warmup specifically when every configured mailbox is still gated', () => {
    const result = describeEvent('mailbox.none_healthy', { mailboxCount: 2, warmupGatedCount: 2 })
    expect(result).toBe('No healthy mailbox available — all 2 configured mailboxes still in Mailreach warmup.')
  })

  it('should mention both warmup and other causes when only some are gated', () => {
    const result = describeEvent('mailbox.none_healthy', { mailboxCount: 3, warmupGatedCount: 1 })
    expect(result).toBe('No healthy mailbox available — 3 configured, 1 still warming up, the rest capped or blocked.')
  })

  it('should fall back to the original wording when nothing is gated', () => {
    const result = describeEvent('mailbox.none_healthy', { mailboxCount: 2, warmupGatedCount: 0 })
    expect(result).toBe('No healthy mailbox available — 2 configured, all capped or blocked.')
  })

  it('should treat a missing warmupGatedCount as zero (payload from before this field existed)', () => {
    const result = describeEvent('mailbox.none_healthy', { mailboxCount: 2 })
    expect(result).toBe('No healthy mailbox available — 2 configured, all capped or blocked.')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/ui/log.test.ts`
Expected: FAIL — the current message never varies by `warmupGatedCount`, so the first two assertions get today's flat "all capped or blocked" wording instead.

- [ ] **Step 3: Implement**

Edit `src/lib/ui/log.ts`. Replace the `'mailbox.none_healthy'` entry in `SENTENCE_BUILDERS`:

```ts
  'mailbox.none_healthy': (p) => {
    const total = readNumber(p, 'mailboxCount')
    const gated = readNumber(p, 'warmupGatedCount')
    if (gated > 0 && gated === total) {
      return `No healthy mailbox available — all ${total} configured mailboxes still in Mailreach warmup.`
    }
    if (gated > 0) {
      return `No healthy mailbox available — ${total} configured, ${gated} still warming up, the rest capped or blocked.`
    }
    return `No healthy mailbox available — ${total} configured, all capped or blocked.`
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/ui/log.test.ts`
Expected: PASS, all tests in the file.

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/ui/log.ts src/lib/ui/log.test.ts
git commit -m "fix(logs): mailbox.none_healthy message distinguishes warmup from broken

warmupGatedCount was already logged in the payload (sender.ts) but
never rendered — an operator reading this event couldn't tell 'still
warming up, nothing to do' from 'actually broken, needs attention'.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Final verification

- [ ] **Run the full suite**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: all clean, zero failures.

- [ ] **End-to-end sanity check against the spec**

Re-read `docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md` sections 1-8 against the committed diff. Confirm: a case whose only mailbox is gated no longer becomes `contacted`; the same case is picked up again by `write-fanout` without a new cron; a `human_approve` case's CRM sync only fires once a human actually approves; `PRE_CONTACT_STATUSES` and `STATUS_FILTERS` both include `waiting`.
