# Mailreach Warmup Surfacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the broken Mailreach reputation/stats sync, then surface warmup progress on the client Home dashboard, the Analytics page, and generated Reports — including replacing the "0 leads found" report framing with honest warmup-progress copy when a client has zero sends because a mailbox is still gated.

**Architecture:** One pure summarizer function (`summarizeMailboxWarmup` in `src/lib/mailbox/mailreach-gate.ts`) computes per-mailbox warmup state from raw DB rows; three call sites (Home, Analytics, Reports) each fetch the same DB rows and feed them through it. Reports additionally freeze the summarized result into the report's stored JSON snapshot at generation time, matching the existing `weeklyBreakdown` pattern, so a report stays historically accurate after the gate later clears.

**Tech Stack:** Next.js (App Router, Server Components), Supabase/Postgres, Zod, next-intl, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-13-mailreach-warmup-surfacing-design.md`

## Global Constraints

- No `console.log`; every DB/vendor error is wrapped in `AppError` with a `code`.
- No `any`; no `!` non-null assertion without a comment proving it safe.
- Zod validates every external input (already-existing `fetchJson(..., schema)` pattern for the Mailreach client).
- `/home`, `/analytics`, `/reports` are client-facing → every new UI string needs a real English **and** real Turkish translation in `src/messages/en.json` / `tr.json`. No English fallback left in `tr.json`.
- `/settings` is operator-facing and is not touched by this plan.
- No new SQL/RPC function — the new DB reads are plain RLS-scoped `.select()` calls through `listMailreachConnectedMailboxes`, extended with an optional `clientId` filter.
- `mailboxes` is **not** added to the Supabase Realtime publication (intentional — see spec §9).
- `GET /v1/accounts/{id}/stats` is called with `past_days=180` (the endpoint's max).
- No new `.test.tsx` files — this repo has no page-level component tests anywhere; verification for UI tasks is `pnpm typecheck && pnpm lint`.
- Every task ends with `pnpm vitest run <touched test files>` passing, and the final task runs the whole suite.

---

## File Structure

New files:
- `supabase/migrations/0042_mailreach_stats_fields.sql`
- `src/app/(app)/home/warmup-banner.tsx`
- `src/app/(app)/reports/[id]/warmup-panel.tsx`

Modified files (grouped by task, see each task's **Files** block for exact line ranges):
- `src/lib/mailreach/client.ts` / `.test.ts`
- `src/types/database.ts`
- `src/lib/db/mailboxes.ts` / `.test.ts`
- `src/lib/pipeline/mailreach-sync.ts` / `.test.ts`
- `src/lib/mailbox/mailreach-gate.ts` / `.test.ts`
- `src/app/(app)/home/page.tsx`
- `src/app/(app)/analytics/analytics-view.tsx`
- `src/types/reports.ts` / `.test.ts`
- `src/lib/reports/metrics.ts` / `.test.ts`
- `src/lib/reports/commentary.ts` / `.test.ts`
- `src/lib/reports/email-templates.ts` / `.test.ts`
- `src/lib/reports/generate.ts` / `.test.ts`
- `src/app/(app)/reports/[id]/page.tsx`
- `src/messages/en.json`, `src/messages/tr.json`

---

### Task 1: Fix the Mailreach client — split `getAccountStats` into `getAccount` + a corrected `getAccountStats`

**Files:**
- Modify: `src/lib/mailreach/client.ts:100-109`
- Test: `src/lib/mailreach/client.test.ts:104-125`

**Interfaces:**
- Produces: `getAccount(accountId: string, apiKey: string): Promise<{ reputationScore: number | null }>`
- Produces: `interface MailreachAccountStats { totalMessagesSent: number | null; totalMessagesReceived: number | null; totalSpam: number | null; currentConversationsRunning: number | null }`
- Produces: `getAccountStats(accountId: string, apiKey: string): Promise<MailreachAccountStats>` — **breaking change**: old shape `{ reputationScore }` is removed entirely.

- [ ] **Step 1: Write the failing tests**

Replace the `describe('getAccountStats', ...)` block (lines 104-125) in `src/lib/mailreach/client.test.ts`, and update the import line at the top:

```ts
import { connectSmtpAccount, buildOAuthAuthorizeUrl, completeOAuthConnect, disconnectAccount, getAccount, getAccountStats } from './client'
```

```ts
describe('getAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return the reputation score', async () => {
    mockFetchJson.mockResolvedValueOnce({ score: 82 })
    const result = await getAccount('acc_123', 'test-mailreach-key')
    expect(result).toEqual({ reputationScore: 82 })
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/accounts/acc_123')
    expect(options.method).toBe('GET')
  })

  it('should return null when the score is absent', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const result = await getAccount('acc_123', 'test-mailreach-key')
    expect(result).toEqual({ reputationScore: null })
  })

  it('should send the given apiKey in the request header', async () => {
    mockFetchJson.mockResolvedValueOnce({ score: 50 })
    await getAccount('acc_123', 'uniforms-fashion-key')
    const [, options] = mockFetchJson.mock.calls[0]!
    expect(options.headers['X-Api-Key']).toBe('Bearer uniforms-fashion-key')
  })
})

describe('getAccountStats', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should return the messaging-volume fields with the real field names', async () => {
    mockFetchJson.mockResolvedValueOnce({
      total_messages_sent: 120,
      total_messages_received: 95,
      total_spam: 2,
      config_current_conversation_running: 8,
    })
    const result = await getAccountStats('acc_123', 'test-mailreach-key')
    expect(result).toEqual({
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversationsRunning: 8,
    })
  })

  it('should return null for every field when absent', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    const result = await getAccountStats('acc_123', 'test-mailreach-key')
    expect(result).toEqual({
      totalMessagesSent: null,
      totalMessagesReceived: null,
      totalSpam: null,
      currentConversationsRunning: null,
    })
  })

  it('should request the 180-day window and send the given apiKey', async () => {
    mockFetchJson.mockResolvedValueOnce({})
    await getAccountStats('acc_123', 'uniforms-fashion-key')
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/accounts/acc_123/stats?past_days=180')
    expect(options.headers['X-Api-Key']).toBe('Bearer uniforms-fashion-key')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailreach/client.test.ts`
Expected: FAIL — `getAccount` is not exported from `./client`, and the old `getAccountStats` test expectations no longer match.

- [ ] **Step 3: Replace the implementation**

In `src/lib/mailreach/client.ts`, replace lines 100-109 (the old `accountStatsResponseSchema` + `getAccountStats`) with:

```ts
const accountResponseSchema = z.object({ score: z.number().nullable().optional() }).passthrough()

export async function getAccount(accountId: string, apiKey: string): Promise<{ reputationScore: number | null }> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}`,
    { method: 'GET', headers: authHeaders(apiKey) },
    accountResponseSchema,
  )
  return { reputationScore: res.score ?? null }
}

export interface MailreachAccountStats {
  totalMessagesSent: number | null
  totalMessagesReceived: number | null
  totalSpam: number | null
  currentConversationsRunning: number | null
}

const accountStatsResponseSchema = z
  .object({
    total_messages_sent: z.number().int().nonnegative().nullable().optional(),
    total_messages_received: z.number().int().nonnegative().nullable().optional(),
    total_spam: z.number().int().nonnegative().nullable().optional(),
    config_current_conversation_running: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough()

// past_days=180 (the endpoint's max) rather than the 14-day default: the field
// names read like lifetime totals but are actually windowed by past_days. 180
// days safely covers a mailbox's whole history for the "since connecting"
// numbers this feature shows — see docs.mailreach.co/usage/account-stats.
export async function getAccountStats(accountId: string, apiKey: string): Promise<MailreachAccountStats> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}/stats?past_days=180`,
    { method: 'GET', headers: authHeaders(apiKey) },
    accountStatsResponseSchema,
  )
  return {
    totalMessagesSent: res.total_messages_sent ?? null,
    totalMessagesReceived: res.total_messages_received ?? null,
    totalSpam: res.total_spam ?? null,
    currentConversationsRunning: res.config_current_conversation_running ?? null,
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailreach/client.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck (this function's only other caller, `mailreach-sync.ts`, is fixed in Task 3 — expect it to fail here, that's fine)**

Run: `pnpm typecheck`
Expected: Errors only in `src/lib/pipeline/mailreach-sync.ts` (old `getAccountStats` shape). No errors in `client.ts`/`client.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailreach/client.ts src/lib/mailreach/client.test.ts
git commit -m "fix(mailreach): split getAccountStats into getAccount + corrected getAccountStats

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: DB schema, generated types, and `mailboxes.ts` DB-layer changes

**Files:**
- Create: `supabase/migrations/0042_mailreach_stats_fields.sql`
- Modify: `src/types/database.ts:724-793` (mailboxes `Row`/`Insert`)
- Modify: `src/lib/db/mailboxes.ts:211-240` (`updateMailboxMailreachStats`, `listMailreachConnectedMailboxes`)
- Test: `src/lib/db/mailboxes.test.ts:331-367`

**Interfaces:**
- Produces: `updateMailboxMailreachStats(supabase, id, fields: { reputationScore: number | null; totalMessagesSent: number | null; totalMessagesReceived: number | null; totalSpam: number | null; currentConversations: number | null; syncedAt: string }): Promise<void>`
- Produces: `listMailreachConnectedMailboxes(supabase, clientId?: string): Promise<MailboxRow[]>`
- Produces (via `database.ts`): `MailboxRow` gains `mailreach_total_messages_sent`, `mailreach_total_messages_received`, `mailreach_total_spam`, `mailreach_current_conversations`, all `number | null`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/db/mailboxes.test.ts`, add a `chainable` helper near the top (alongside `mockInsert`/`mockGet`/`mockUpdate`):

```ts
function chainable(result: { data: unknown; error: unknown }) {
  const node: { eq: ReturnType<typeof vi.fn>; order: ReturnType<typeof vi.fn> } = {
    eq: vi.fn(() => node),
    order: vi.fn(() => Promise.resolve(result)),
  }
  return node
}
```

Replace the `describe('updateMailboxMailreachStats', ...)` block (lines 331-340) with:

```ts
describe('updateMailboxMailreachStats', () => {
  it('should persist reputation, messaging volume, and the sync timestamp', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    await updateMailboxMailreachStats({ from: () => ({ update }) } as never, 'm1', {
      reputationScore: 94,
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
      syncedAt: '2026-07-29T00:00:00.000Z',
    })
    expect(update).toHaveBeenCalledWith({
      mailreach_reputation_score: 94,
      mailreach_total_messages_sent: 120,
      mailreach_total_messages_received: 95,
      mailreach_total_spam: 2,
      mailreach_current_conversations: 8,
      mailreach_stats_synced_at: '2026-07-29T00:00:00.000Z',
    })
  })

  it('should throw DB_ERROR when the update fails', async () => {
    await expect(
      updateMailboxMailreachStats(mockUpdate({ error: { message: 'boom' } }), 'm1', {
        reputationScore: null,
        totalMessagesSent: null,
        totalMessagesReceived: null,
        totalSpam: null,
        currentConversations: null,
        syncedAt: '2026-07-29T00:00:00.000Z',
      }),
    ).rejects.toThrow(AppError)
  })
})
```

Replace the `describe('listMailreachConnectedMailboxes', ...)` block (lines 359-367) with:

```ts
describe('listMailreachConnectedMailboxes', () => {
  it('should return every connected mailbox across all clients when no clientId is given', async () => {
    const rows = [{ id: 'm1', mailreach_status: 'connected' }]
    const node = chainable({ data: rows, error: null })
    const supabase = { from: () => ({ select: () => node }) } as never
    await expect(listMailreachConnectedMailboxes(supabase)).resolves.toEqual(rows)
    expect(node.eq).toHaveBeenCalledWith('mailreach_status', 'connected')
    expect(node.eq).toHaveBeenCalledTimes(1)
  })

  it('should scope to a single client when clientId is given', async () => {
    const rows = [{ id: 'm1', mailreach_status: 'connected', client_id: 'c1' }]
    const node = chainable({ data: rows, error: null })
    const supabase = { from: () => ({ select: () => node }) } as never
    await expect(listMailreachConnectedMailboxes(supabase, 'c1')).resolves.toEqual(rows)
    expect(node.eq).toHaveBeenCalledWith('mailreach_status', 'connected')
    expect(node.eq).toHaveBeenCalledWith('client_id', 'c1')
    expect(node.eq).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/mailboxes.test.ts`
Expected: FAIL — `updateMailboxMailreachStats` rejects the new fields (extra properties on a typed call is a TS error, not a runtime one, but the `toHaveBeenCalledWith` assertions fail since the implementation doesn't send those columns yet), and `listMailreachConnectedMailboxes(supabase, 'c1')` ignores the second argument.

- [ ] **Step 3: Write the migration**

Create `supabase/migrations/0042_mailreach_stats_fields.sql`:

```sql
-- Adds the messaging-volume fields from Mailreach's real GET /v1/accounts/{id}/stats
-- response. mailreach_reputation_score (0021) is unchanged in shape — it was always
-- the right column, just fed from the wrong endpoint until this change (see
-- docs/superpowers/specs/2026-08-13-mailreach-warmup-surfacing-design.md §1).
alter table mailboxes add column mailreach_total_messages_sent     integer;
alter table mailboxes add column mailreach_total_messages_received integer;
alter table mailboxes add column mailreach_total_spam               integer;
alter table mailboxes add column mailreach_current_conversations    integer;
```

- [ ] **Step 4: Update the hand-authored generated types**

In `src/types/database.ts`, in the `mailboxes` table's `Row` type (after `mailreach_reputation_score: number | null` on line 748), add:

```ts
          mailreach_total_messages_sent: number | null
          mailreach_total_messages_received: number | null
          mailreach_total_spam: number | null
          mailreach_current_conversations: number | null
```

And in the `Insert` type (after `mailreach_reputation_score?: number | null` on line 777), add:

```ts
          mailreach_total_messages_sent?: number | null
          mailreach_total_messages_received?: number | null
          mailreach_total_spam?: number | null
          mailreach_current_conversations?: number | null
```

(`Update` stays `Partial<Insert>` — no change needed there.)

- [ ] **Step 5: Implement the DB-layer changes**

In `src/lib/db/mailboxes.ts`, replace `updateMailboxMailreachStats` and `listMailreachConnectedMailboxes` (lines 211-240) with:

```ts
export async function updateMailboxMailreachStats(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: {
    reputationScore: number | null
    totalMessagesSent: number | null
    totalMessagesReceived: number | null
    totalSpam: number | null
    currentConversations: number | null
    syncedAt: string
  },
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({
      mailreach_reputation_score: fields.reputationScore,
      mailreach_total_messages_sent: fields.totalMessagesSent,
      mailreach_total_messages_received: fields.totalMessagesReceived,
      mailreach_total_spam: fields.totalSpam,
      mailreach_current_conversations: fields.currentConversations,
      mailreach_stats_synced_at: fields.syncedAt,
    })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox mailreach stats', { id, cause: error.message })
}

export async function listMailboxesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('client_id', clientId)
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailboxes for client', { clientId, cause: error.message })
  return data ?? []
}

// The stats-sync sweep's candidate set when called with no clientId (every
// client at once). Home/Analytics/Reports pass a clientId to scope to one
// client's mailboxes instead.
export async function listMailreachConnectedMailboxes(
  supabase: SupabaseClient<Database>,
  clientId?: string,
): Promise<MailboxRow[]> {
  let query = supabase.from('mailboxes').select('*').eq('mailreach_status', 'connected')
  if (clientId) query = query.eq('client_id', clientId)
  const { data, error } = await query.order('email_address')
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailreach-connected mailboxes', { clientId, cause: error.message })
  return data ?? []
}
```

(`listMailboxesForClient` is included above unchanged — it sits between the two modified functions in the file, shown for placement only, not modified.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/mailboxes.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0042_mailreach_stats_fields.sql src/types/database.ts src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts
git commit -m "feat(mailreach): add messaging-volume columns and clientId-scoped mailbox listing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Update the sync pipeline to call both endpoints

**Files:**
- Modify: `src/lib/pipeline/mailreach-sync.ts`
- Test: `src/lib/pipeline/mailreach-sync.test.ts`

**Interfaces:**
- Consumes: `getAccount`, `getAccountStats` (Task 1); `updateMailboxMailreachStats` (Task 2)
- Produces: `runMailreachStatsSync(supabase, { now }): Promise<{ evaluated: number; failed: number }>` (signature unchanged; internal behavior now does 2 vendor calls per mailbox, atomically)

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/pipeline/mailreach-sync.test.ts` entirely with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listMailreachConnectedMailboxes = vi.fn()
const updateMailboxMailreachStats = vi.fn()
const getAccount = vi.fn()
const getAccountStats = vi.fn()
const resolveMailreachApiKey = vi.fn((clientId: string) => `key-for-${clientId}`)

vi.mock('@/lib/db/mailboxes', () => ({
  listMailreachConnectedMailboxes: (...args: unknown[]) => listMailreachConnectedMailboxes(...args),
  updateMailboxMailreachStats: (...args: unknown[]) => updateMailboxMailreachStats(...args),
}))
vi.mock('@/lib/mailreach/client', () => ({
  getAccount: (...args: unknown[]) => getAccount(...args),
  getAccountStats: (...args: unknown[]) => getAccountStats(...args),
}))
vi.mock('@/lib/mailreach/client-api-keys', () => ({
  resolveMailreachApiKey: (...args: unknown[]) => resolveMailreachApiKey(...(args as [string])),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

import { runMailreachStatsSync } from './mailreach-sync'

const now = new Date('2026-07-29T00:00:00.000Z')
const statsPayload = { totalMessagesSent: 120, totalMessagesReceived: 95, totalSpam: 2, currentConversationsRunning: 8 }

beforeEach(() => vi.clearAllMocks())

describe('runMailreachStatsSync', () => {
  it('should sync every connected mailbox and report zero failures', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccount.mockResolvedValue({ reputationScore: 90 })
    getAccountStats.mockResolvedValue(statsPayload)

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 0 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm1', {
      reputationScore: 90,
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
      syncedAt: now.toISOString(),
    })
    expect(updateMailboxMailreachStats).toHaveBeenCalledWith({}, 'm2', {
      reputationScore: 90,
      totalMessagesSent: 120,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
      syncedAt: now.toISOString(),
    })
    expect(getAccount).toHaveBeenCalledWith('acc_1', 'key-for-c1')
    expect(getAccountStats).toHaveBeenCalledWith('acc_1', 'key-for-c1')
  })

  it("should resolve each mailbox's api key from its own client id", async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c2', mailreach_account_id: 'acc_2' },
    ])
    getAccount.mockResolvedValue({ reputationScore: 90 })
    getAccountStats.mockResolvedValue(statsPayload)

    await runMailreachStatsSync({} as never, { now })

    expect(getAccount).toHaveBeenCalledWith('acc_1', 'key-for-c1')
    expect(getAccount).toHaveBeenCalledWith('acc_2', 'key-for-c2')
  })

  it('should count a per-mailbox failure without stopping the sweep when getAccount fails', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccountStats.mockResolvedValue(statsPayload)
    getAccount.mockRejectedValueOnce(new Error('vendor down')).mockResolvedValueOnce({ reputationScore: 80 })

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 1 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledTimes(1)
  })

  it('should count a per-mailbox failure without stopping the sweep when getAccountStats fails', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([
      { id: 'm1', client_id: 'c1', mailreach_account_id: 'acc_1' },
      { id: 'm2', client_id: 'c1', mailreach_account_id: 'acc_2' },
    ])
    getAccount.mockResolvedValue({ reputationScore: 80 })
    getAccountStats.mockRejectedValueOnce(new Error('vendor down')).mockResolvedValueOnce(statsPayload)

    const result = await runMailreachStatsSync({} as never, { now })

    expect(result).toEqual({ evaluated: 2, failed: 1 })
    expect(updateMailboxMailreachStats).toHaveBeenCalledTimes(1)
  })

  it('should skip a mailbox with no account id', async () => {
    listMailreachConnectedMailboxes.mockResolvedValue([{ id: 'm1', client_id: 'c1', mailreach_account_id: null }])
    const result = await runMailreachStatsSync({} as never, { now })
    expect(result).toEqual({ evaluated: 1, failed: 0 })
    expect(getAccount).not.toHaveBeenCalled()
    expect(getAccountStats).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/mailreach-sync.test.ts`
Expected: FAIL — `getAccount` is never called by the current implementation, and `updateMailboxMailreachStats` is called with the old 2-field shape.

- [ ] **Step 3: Implement**

Replace `src/lib/pipeline/mailreach-sync.ts` in full:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { listMailreachConnectedMailboxes, updateMailboxMailreachStats } from '@/lib/db/mailboxes'
import { getAccount, getAccountStats } from '@/lib/mailreach/client'
import { resolveMailreachApiKey } from '@/lib/mailreach/client-api-keys'
import { logEventSafe } from '@/lib/events/log-event'

export interface MailreachSyncSummary {
  evaluated: number
  failed: number
}

/**
 * Refreshes the cached reputation score and messaging-volume stats for every
 * mailbox currently connected to Mailreach, so /home, /analytics, and
 * /settings can show them without calling the vendor API on every page load.
 * Best-effort per mailbox — one vendor failure doesn't stop the rest of the
 * sweep, and a failure in either of the two per-mailbox calls (getAccount /
 * getAccountStats) skips that mailbox entirely for this run rather than
 * writing partial stats. Runs the whole sweep concurrently (Promise.all over
 * per-mailbox work, each with its own try/catch) rather than one mailbox at a
 * time, so the sweep's runtime doesn't scale linearly with the number of
 * connected mailboxes.
 */
export async function runMailreachStatsSync(
  supabase: SupabaseClient<Database>,
  { now }: { now: Date },
): Promise<MailreachSyncSummary> {
  const mailboxes = await listMailreachConnectedMailboxes(supabase)
  const outcomes = await Promise.all(
    mailboxes.map(async (mailbox): Promise<boolean> => {
      if (!mailbox.mailreach_account_id) return true
      try {
        const apiKey = resolveMailreachApiKey(mailbox.client_id)
        const [account, stats] = await Promise.all([
          getAccount(mailbox.mailreach_account_id, apiKey),
          getAccountStats(mailbox.mailreach_account_id, apiKey),
        ])
        await updateMailboxMailreachStats(supabase, mailbox.id, {
          reputationScore: account.reputationScore,
          totalMessagesSent: stats.totalMessagesSent,
          totalMessagesReceived: stats.totalMessagesReceived,
          totalSpam: stats.totalSpam,
          currentConversations: stats.currentConversationsRunning,
          syncedAt: now.toISOString(),
        })
        return true
      } catch (error) {
        await logEventSafe({
          clientId: mailbox.client_id,
          actor: 'mailreach_stats_sync',
          type: 'mailbox.mailreach_stats_sync_failed',
          source: 'mailbox',
          payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
        })
        return false
      }
    }),
  )
  const failed = outcomes.filter((ok) => !ok).length
  return { evaluated: mailboxes.length, failed }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/mailreach-sync.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors in `client.ts`, `mailreach-sync.ts`, or their tests.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/mailreach-sync.ts src/lib/pipeline/mailreach-sync.test.ts
git commit -m "fix(mailreach): sync job pulls real reputation score and message-volume stats

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Shared warmup summarizer

**Files:**
- Modify: `src/lib/mailbox/mailreach-gate.ts`
- Test: `src/lib/mailbox/mailreach-gate.test.ts`

**Interfaces:**
- Consumes: `MailboxRow` (type-only, from `@/lib/db/mailboxes`, Task 2)
- Produces: `interface MailboxWarmupInfo { mailboxId, emailAddress, elapsedDays, gateDays, isGated, reputationScore, totalMessagesSent, totalMessagesReceived, totalSpam, currentConversations }`
- Produces: `type MailboxWarmupSource = Pick<MailboxRow, 'id' | 'email_address' | 'mailreach_enabled' | 'mailreach_started_at' | 'mailreach_status' | 'mailreach_reputation_score' | 'mailreach_total_messages_sent' | 'mailreach_total_messages_received' | 'mailreach_total_spam' | 'mailreach_current_conversations'>`
- Produces: `summarizeMailboxWarmup(mailboxes: MailboxWarmupSource[], clientMailreachEnabled: boolean, now: Date): MailboxWarmupInfo[]`
- Produces: `closestToReady(gated: MailboxWarmupInfo[]): MailboxWarmupInfo | null`
- Produces: `totalMessagesExchanged(mailboxes: MailboxWarmupInfo[]): number`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/mailbox/mailreach-gate.test.ts` (update the import line at the top first):

```ts
import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  MAILREACH_CAMPAIGN_GATE_DAYS,
  mailreachElapsedDays,
  isEligibleForCampaignSend,
  summarizeMailboxWarmup,
  closestToReady,
  totalMessagesExchanged,
  type MailboxWarmupSource,
  type MailboxWarmupInfo,
} from './mailreach-gate'
```

Then, at the end of the file:

```ts
function mailboxRow(overrides: Partial<MailboxWarmupSource> = {}): MailboxWarmupSource {
  return {
    id: 'm1',
    email_address: 'sales@acme.com',
    mailreach_enabled: true,
    mailreach_started_at: '2026-07-15T00:00:00Z',
    mailreach_status: 'connected',
    mailreach_reputation_score: 82,
    mailreach_total_messages_sent: 120,
    mailreach_total_messages_received: 95,
    mailreach_total_spam: 2,
    mailreach_current_conversations: 8,
    ...overrides,
  }
}

describe('summarizeMailboxWarmup', () => {
  const now = new Date('2026-07-29T00:00:00Z')

  it('should return an empty array for no mailboxes', () => {
    expect(summarizeMailboxWarmup([], true, now)).toEqual([])
  })

  it('should exclude a mailbox with mailreach_enabled false', () => {
    expect(summarizeMailboxWarmup([mailboxRow({ mailreach_enabled: false })], true, now)).toEqual([])
  })

  it('should exclude every mailbox when the client switch is off', () => {
    expect(summarizeMailboxWarmup([mailboxRow()], false, now)).toEqual([])
  })

  it('should exclude a mailbox that is not currently connected', () => {
    expect(summarizeMailboxWarmup([mailboxRow({ mailreach_status: 'error' })], true, now)).toEqual([])
  })

  it('should exclude a mailbox with no mailreach_started_at even if enabled and connected', () => {
    expect(summarizeMailboxWarmup([mailboxRow({ mailreach_started_at: null })], true, now)).toEqual([])
  })

  it('should mark a mailbox gated before day 14', () => {
    const [result] = summarizeMailboxWarmup([mailboxRow({ mailreach_started_at: '2026-07-20T00:00:00Z' })], true, now)
    expect(result).toMatchObject({ elapsedDays: 9, gateDays: 14, isGated: true })
  })

  it('should mark a mailbox warm at exactly day 14', () => {
    const [result] = summarizeMailboxWarmup([mailboxRow({ mailreach_started_at: '2026-07-15T00:00:00Z' })], true, now)
    expect(result).toMatchObject({ elapsedDays: 14, isGated: false })
  })

  it('should pass reputation and message-volume fields through unchanged, including null', () => {
    const [result] = summarizeMailboxWarmup(
      [mailboxRow({ mailreach_reputation_score: null, mailreach_total_messages_sent: null })],
      true,
      now,
    )
    expect(result).toMatchObject({
      mailboxId: 'm1',
      emailAddress: 'sales@acme.com',
      reputationScore: null,
      totalMessagesSent: null,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
    })
  })
})

describe('closestToReady', () => {
  it('should return null for an empty array', () => {
    expect(closestToReady([])).toBeNull()
  })

  it('should return the mailbox with the most elapsed days', () => {
    const a = { mailboxId: 'a', elapsedDays: 3 } as MailboxWarmupInfo
    const b = { mailboxId: 'b', elapsedDays: 9 } as MailboxWarmupInfo
    const c = { mailboxId: 'c', elapsedDays: 1 } as MailboxWarmupInfo
    expect(closestToReady([a, b, c])).toBe(b)
  })
})

describe('totalMessagesExchanged', () => {
  it('should return 0 for an empty array', () => {
    expect(totalMessagesExchanged([])).toBe(0)
  })

  it('should sum sent and received across mailboxes, treating null as 0', () => {
    const mailboxes = [
      { totalMessagesSent: 10, totalMessagesReceived: 5 } as MailboxWarmupInfo,
      { totalMessagesSent: null, totalMessagesReceived: 3 } as MailboxWarmupInfo,
    ]
    expect(totalMessagesExchanged(mailboxes)).toBe(18)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/mailreach-gate.test.ts`
Expected: FAIL — `summarizeMailboxWarmup`, `closestToReady`, `totalMessagesExchanged` are not exported yet.

- [ ] **Step 3: Implement**

Append to `src/lib/mailbox/mailreach-gate.ts` (add `import type { MailboxRow } from '@/lib/db/mailboxes'` to the top of the file alongside the existing `AppError` import):

```ts
export interface MailboxWarmupInfo {
  mailboxId: string
  emailAddress: string
  elapsedDays: number
  gateDays: number
  isGated: boolean
  reputationScore: number | null
  totalMessagesSent: number | null
  totalMessagesReceived: number | null
  totalSpam: number | null
  currentConversations: number | null
}

export type MailboxWarmupSource = Pick<
  MailboxRow,
  | 'id'
  | 'email_address'
  | 'mailreach_enabled'
  | 'mailreach_started_at'
  | 'mailreach_status'
  | 'mailreach_reputation_score'
  | 'mailreach_total_messages_sent'
  | 'mailreach_total_messages_received'
  | 'mailreach_total_spam'
  | 'mailreach_current_conversations'
>

/**
 * Every currently-connected, enrolled mailbox in `mailboxes`, gated or not.
 * Callers filter to `.isGated` themselves for "still warming" surfaces (home
 * banner, report trigger) — Analytics wants the full list including mailboxes
 * that already cleared the gate ("Warm").
 */
export function summarizeMailboxWarmup(
  mailboxes: MailboxWarmupSource[],
  clientMailreachEnabled: boolean,
  now: Date,
): MailboxWarmupInfo[] {
  const summaries: MailboxWarmupInfo[] = []
  for (const mailbox of mailboxes) {
    if (!mailbox.mailreach_enabled || !clientMailreachEnabled) continue
    if (mailbox.mailreach_status !== 'connected') continue
    if (mailbox.mailreach_started_at === null) continue
    const elapsedDays = mailreachElapsedDays(mailbox.mailreach_started_at, now)
    summaries.push({
      mailboxId: mailbox.id,
      emailAddress: mailbox.email_address,
      elapsedDays,
      gateDays: MAILREACH_CAMPAIGN_GATE_DAYS,
      isGated: elapsedDays < MAILREACH_CAMPAIGN_GATE_DAYS,
      reputationScore: mailbox.mailreach_reputation_score,
      totalMessagesSent: mailbox.mailreach_total_messages_sent,
      totalMessagesReceived: mailbox.mailreach_total_messages_received,
      totalSpam: mailbox.mailreach_total_spam,
      currentConversations: mailbox.mailreach_current_conversations,
    })
  }
  return summaries
}

/** The mailbox nearest to clearing the gate — null when none are gated. */
export function closestToReady(gated: MailboxWarmupInfo[]): MailboxWarmupInfo | null {
  if (gated.length === 0) return null
  return gated.reduce((closest, current) => (current.elapsedDays > closest.elapsedDays ? current : closest))
}

/** Sum of sent + received across the given mailboxes, treating null as 0. */
export function totalMessagesExchanged(mailboxes: MailboxWarmupInfo[]): number {
  return mailboxes.reduce((sum, m) => sum + (m.totalMessagesSent ?? 0) + (m.totalMessagesReceived ?? 0), 0)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/mailreach-gate.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/mailbox/mailreach-gate.ts src/lib/mailbox/mailreach-gate.test.ts
git commit -m "feat(mailreach): shared warmup summarizer for Home, Analytics, Reports

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Home page warmup banner

**Files:**
- Create: `src/app/(app)/home/warmup-banner.tsx`
- Modify: `src/app/(app)/home/page.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (`home.warmupBanner`)

**Interfaces:**
- Consumes: `getClientById` (`@/lib/db/clients`), `listMailreachConnectedMailboxes` (Task 2), `summarizeMailboxWarmup`, `closestToReady`, `totalMessagesExchanged`, `type MailboxWarmupInfo` (Task 4)

- [ ] **Step 1: Add the translation keys**

In `src/messages/en.json`, inside the `"home"` object, add:

```json
"warmupBanner": {
  "title": "Building your sending reputation",
  "progress": "{gated} of {total} mailboxes still warming up",
  "closest": "Closest to ready: day {elapsed} of {gate}",
  "reputation": "Reputation score: {score}",
  "messagesExchanged": "{count} messages exchanged so far",
  "viewDetails": "View mailbox details"
}
```

In `src/messages/tr.json`, inside the `"home"` object, add:

```json
"warmupBanner": {
  "title": "E-posta itibarınız oluşturuluyor",
  "progress": "{total} kutudan {gated} tanesi hâlâ ısınma sürecinde",
  "closest": "Hazıra en yakın: {gate} günün {elapsed}. günü",
  "reputation": "İtibar puanı: {score}",
  "messagesExchanged": "Şu ana kadar {count} e-posta alışverişi yapıldı",
  "viewDetails": "Kutu detaylarını görüntüle"
}
```

- [ ] **Step 2: Create the banner component**

Create `src/app/(app)/home/warmup-banner.tsx`:

```tsx
import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { closestToReady, totalMessagesExchanged, type MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

interface WarmupBannerProps {
  mailboxes: MailboxWarmupInfo[]
  gated: MailboxWarmupInfo[]
}

export async function WarmupBanner({ mailboxes, gated }: WarmupBannerProps): Promise<React.ReactElement | null> {
  const t = await getTranslations('home')
  // Only null when gated is empty — the caller in page.tsx never renders this
  // component unless gated.length > 0, so this guard is what keeps the rest
  // of the function assertion-free, not dead code.
  const closest = closestToReady(gated)
  if (!closest) return null
  const exchanged = totalMessagesExchanged(gated)
  return (
    <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
      <p className="text-sm font-medium">{t('warmupBanner.title')}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupBanner.progress', { gated: gated.length, total: mailboxes.length })}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupBanner.closest', { elapsed: closest.elapsedDays, gate: closest.gateDays })}
        {closest.reputationScore !== null ? ' · ' + t('warmupBanner.reputation', { score: closest.reputationScore }) : null}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{t('warmupBanner.messagesExchanged', { count: exchanged })}</p>
      <Link href="/settings" className="text-primary mt-3 inline-block text-xs underline underline-offset-2">
        {t('warmupBanner.viewDetails')}
      </Link>
    </div>
  )
}
```

- [ ] **Step 3: Wire it into the home page**

In `src/app/(app)/home/page.tsx`, add to the imports:

```ts
import { getClientById } from '@/lib/db/clients'
import { listMailreachConnectedMailboxes } from '@/lib/db/mailboxes'
import { summarizeMailboxWarmup } from '@/lib/mailbox/mailreach-gate'
import { WarmupBanner } from './warmup-banner'
```

Change the `Promise.all` (lines 83-92) to also fetch the client row and the client's Mailreach-connected mailboxes:

```ts
const [overview, daily, campaigns, leads, mail, drafts, knowledgeRequests, cases, client, mailreachMailboxes] = await Promise.all([
  getOverviewMetrics(supabase, { from, to, campaignId: null, clientId }),
  getDailyMetrics(supabase, { from, to, campaignId: null, clientId }),
  listCampaignsForClient(supabase, clientId),
  listRecentLeadsForClient(supabase, { limit: LIST_LIMIT }),
  listEmailsForClient(supabase, { direction: 'outbound', limit: LIST_LIMIT }),
  listDraftEmailsForClient(supabase),
  listOpenKnowledgeRequestsForClient(supabase),
  listCaseCompanyNames(supabase),
  getClientById(supabase, clientId),
  listMailreachConnectedMailboxes(supabase, clientId),
])
```

Right after the existing `const now = new Date()` line, add:

```ts
const warmup = summarizeMailboxWarmup(mailreachMailboxes, client?.mailreach_enabled ?? false, now)
const gatedWarmup = warmup.filter((w) => w.isGated)
```

In the JSX, insert the banner between the `PageHeader` and the stat-tile grid `div`:

```tsx
<PageHeader title={t('pageTitle')} description={t('description')} className="shrink-0" />

{gatedWarmup.length > 0 ? <WarmupBanner mailboxes={warmup} gated={gatedWarmup} /> : null}

<div className="grid shrink-0 gap-3 sm:grid-cols-2 lg:grid-cols-[1.5fr_1fr_1fr_1fr_1.2fr]">
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: No errors. (This repo has no page-level component tests — see Global Constraints — so typecheck/lint is this task's verification gate.)

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/home/warmup-banner.tsx src/app/\(app\)/home/page.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(home): warmup progress banner for clients with a gated mailbox

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Analytics "Mailbox Warmup" section

**Files:**
- Modify: `src/app/(app)/analytics/analytics-view.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (`analytics.sectionMailboxWarmup`, `analytics.mailboxWarmupTable`)

**Interfaces:**
- Consumes: `getClientById` (`@/lib/db/clients`), `listMailreachConnectedMailboxes` (Task 2), `summarizeMailboxWarmup` (Task 4)

- [ ] **Step 1: Add the translation keys**

In `src/messages/en.json`, inside the `"analytics"` object (after `"sectionMailboxes"` / before `"sectionAgentActivity"` is a natural spot, but anywhere in the object works — next-intl doesn't care about key order), add:

```json
"sectionMailboxWarmup": "Mailbox warmup",
```

and, as a sibling of `"mailboxesTable"`:

```json
"mailboxWarmupTable": {
  "mailbox": "Mailbox",
  "status": "Status",
  "statusWarming": "Day {elapsed} of {gate}",
  "statusWarm": "Warm",
  "reputation": "Reputation",
  "sent": "Messages sent",
  "received": "Messages received",
  "spam": "Landed in spam",
  "activeConversations": "Active conversations"
}
```

In `src/messages/tr.json`, inside `"analytics"`, add:

```json
"sectionMailboxWarmup": "Kutu ısınması",
```

```json
"mailboxWarmupTable": {
  "mailbox": "Kutu",
  "status": "Durum",
  "statusWarming": "{gate} günün {elapsed}. günü",
  "statusWarm": "Isındı",
  "reputation": "İtibar",
  "sent": "Gönderilen mesaj",
  "received": "Alınan mesaj",
  "spam": "Spam'e düşen",
  "activeConversations": "Aktif konuşmalar"
}
```

- [ ] **Step 2: Fetch and summarize the warmup data**

In `src/app/(app)/analytics/analytics-view.tsx`, change the `listClients` import to also pull `getClientById`:

```ts
import { listClients, getClientById } from '@/lib/db/clients'
```

Add two new imports:

```ts
import { listMailreachConnectedMailboxes } from '@/lib/db/mailboxes'
import { summarizeMailboxWarmup } from '@/lib/mailbox/mailreach-gate'
```

Change the existing `Promise.all` (currently `[overview, daily, byCampaign, allMailboxes, eventCounts]`) to:

```ts
const [overview, daily, byCampaign, allMailboxes, eventCounts, client, warmupMailboxes] = await Promise.all([
  getOverviewMetrics(supabase, { from, to, campaignId, clientId }),
  getDailyMetrics(supabase, { from, to, campaignId, clientId }),
  getCampaignMetrics(supabase, { from, to }),
  getMailboxMetrics(supabase),
  getEventCounts(supabase, { from, to, limit: EVENT_TYPE_LIMIT }),
  clientId ? getClientById(supabase, clientId) : Promise.resolve(null),
  listMailreachConnectedMailboxes(supabase, clientId ?? undefined),
])
```

Right after the existing `const hasAnyData = ...` line, add:

```ts
// `?? true` for the no-client-filter global-operator case: the client-level
// switch doesn't apply when aggregating across every client, and
// listMailreachConnectedMailboxes already only returns mailreach_status =
// 'connected' rows — a mailbox can't be connected while its owning client's
// switch is off, since disabling the switch disconnects it.
const now = new Date()
const warmup = summarizeMailboxWarmup(warmupMailboxes, client?.mailreach_enabled ?? true, now)
```

- [ ] **Step 3: Render the section**

In the JSX, insert a new `Section` right after the existing `sectionMailboxes` `Section` block and before `sectionAgentActivity`:

```tsx
{warmup.length > 0 ? (
  <Section title={t('sectionMailboxWarmup')}>
    <div className="border-hairline overflow-x-auto rounded-lg border">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('mailboxWarmupTable.mailbox')}</TableHead>
            <TableHead scope="col">{t('mailboxWarmupTable.status')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.reputation')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.sent')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.received')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.spam')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.activeConversations')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {warmup.map((m) => (
            <TableRow key={m.mailboxId}>
              <TableCell className="font-medium">{m.emailAddress}</TableCell>
              <TableCell>
                {m.isGated
                  ? t('mailboxWarmupTable.statusWarming', { elapsed: m.elapsedDays, gate: m.gateDays })
                  : t('mailboxWarmupTable.statusWarm')}
              </TableCell>
              <TableCell className="tnum text-right">{m.reputationScore ?? '—'}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.totalMessagesSent ?? 0)}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.totalMessagesReceived ?? 0)}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.totalSpam ?? 0)}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.currentConversations ?? 0)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </Section>
) : null}
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/analytics/analytics-view.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(analytics): Mailbox Warmup section with reputation and message-volume stats

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Reports — frozen warmup snapshot in `types/reports.ts` and `metrics.ts`

**Files:**
- Modify: `src/types/reports.ts`
- Test: `src/types/reports.test.ts`
- Modify: `src/lib/reports/metrics.ts`
- Test: `src/lib/reports/metrics.test.ts`

**Interfaces:**
- Consumes: `MailboxWarmupInfo` (Task 4), `getClientById` (`@/lib/db/clients`), `listMailreachConnectedMailboxes` (Task 2)
- Produces: `ReportMetricsSnapshot` gains `warmup?: MailboxWarmupInfo[]`
- Produces: `BuildReportMetricsInput` gains `now: Date`

- [ ] **Step 1: Write the failing schema tests**

Append to `src/types/reports.test.ts`, inside the `describe('reportMetricsSnapshotSchema', ...)` block:

```ts
  it('should accept a snapshot with a warmup array', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [],
      warmup: [
        {
          mailboxId: '11111111-1111-4111-8111-111111111111',
          emailAddress: 'sales@acme.com',
          elapsedDays: 6,
          gateDays: 14,
          isGated: true,
          reputationScore: 70,
          totalMessagesSent: 10,
          totalMessagesReceived: 8,
          totalSpam: 0,
          currentConversations: 2,
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('should accept a snapshot with no warmup key at all', () => {
    const result = reportMetricsSnapshotSchema.safeParse({ overview: validOverview, daily: [] })
    expect(result.success).toBe(true)
  })

  it('should reject a warmup entry missing a required field', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [],
      warmup: [{ mailboxId: '11111111-1111-4111-8111-111111111111', emailAddress: 'sales@acme.com' }],
    })
    expect(result.success).toBe(false)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/types/reports.test.ts`
Expected: FAIL — `warmup` is rejected as an unrecognized key (Zod object schemas reject unknown keys by default unless `.passthrough()`; here it fails because the schema doesn't define `warmup` yet, so the "accept" tests fail while the "reject" test may pass vacuously — either way the suite doesn't reflect the intended behavior yet).

- [ ] **Step 3: Implement the schema change**

In `src/types/reports.ts`, add an import and a new schema, then extend `reportMetricsSnapshotSchema`:

```ts
import { z } from 'zod'
import type { OverviewMetrics, DailyMetric } from './analytics'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

// ...existing overviewMetricsSchema, dailyMetricSchema unchanged...

const mailboxWarmupSchema = z.object({
  mailboxId: z.string().uuid(),
  emailAddress: z.string(),
  elapsedDays: z.number().int().nonnegative(),
  gateDays: z.number().int().positive(),
  isGated: z.boolean(),
  reputationScore: z.number().nullable(),
  totalMessagesSent: z.number().int().nonnegative().nullable(),
  totalMessagesReceived: z.number().int().nonnegative().nullable(),
  totalSpam: z.number().int().nonnegative().nullable(),
  currentConversations: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<MailboxWarmupInfo>

export const reportMetricsSnapshotSchema = z.object({
  overview: overviewMetricsSchema,
  daily: z.array(dailyMetricSchema),
  weeklyBreakdown: z
    .array(
      z.object({
        reportId: z.string().uuid(),
        periodStart: z.string(),
        periodEnd: z.string(),
        overview: overviewMetricsSchema,
      }),
    )
    .optional(),
  // Present only when the client has ≥1 Mailreach-enrolled, connected
  // mailbox at generation time. Frozen like weeklyBreakdown — the report
  // stays historically accurate even after the gate later clears.
  warmup: z.array(mailboxWarmupSchema).optional(),
})

export type ReportMetricsSnapshot = z.infer<typeof reportMetricsSnapshotSchema>
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/types/reports.test.ts`
Expected: PASS

- [ ] **Step 5: Write the failing `metrics.ts` tests**

In `src/lib/reports/metrics.test.ts`, add two new mocks and a `now`, update `beforeEach`, and add two new test cases. Replace the file's mock setup and `beforeEach` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getOverviewMetricsMock = vi.fn()
const getDailyMetricsMock = vi.fn()
const listWeeklyReportsInRangeMock = vi.fn()
const getClientByIdMock = vi.fn()
const listMailreachConnectedMailboxesMock = vi.fn()

vi.mock('@/lib/db/analytics', () => ({
  getOverviewMetrics: (...a: unknown[]) => getOverviewMetricsMock(...a),
  getDailyMetrics: (...a: unknown[]) => getDailyMetricsMock(...a),
}))
vi.mock('@/lib/db/reports', () => ({
  listWeeklyReportsInRange: (...a: unknown[]) => listWeeklyReportsInRangeMock(...a),
}))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
}))
vi.mock('@/lib/db/mailboxes', () => ({
  listMailreachConnectedMailboxes: (...a: unknown[]) => listMailreachConnectedMailboxesMock(...a),
}))

import { buildReportMetrics } from './metrics'

const overview = { leadsDiscovered: 5 } as never
const daily = [{ day: '2026-08-04', leadsDiscovered: 1, emailsSent: 2, repliesReceived: 0 }]
const now = new Date('2026-08-11T00:00:00.000Z')

const fullWeeklyOverview = {
  leadsDiscovered: 3,
  leadsVerified: 3,
  casesCreated: 1,
  emailsSent: 6,
  firstTouchSent: 4,
  followupsSent: 2,
  emailsBounced: 0,
  emailsFailed: 0,
  repliesReceived: 1,
  leadsContacted: 6,
  leadsReplied: 1,
  suppressionsAdded: 0,
  activeSequences: 2,
}

beforeEach(() => {
  getOverviewMetricsMock.mockReset().mockResolvedValue(overview)
  getDailyMetricsMock.mockReset().mockResolvedValue(daily)
  listWeeklyReportsInRangeMock.mockReset().mockResolvedValue([])
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1', mailreach_enabled: true })
  listMailreachConnectedMailboxesMock.mockReset().mockResolvedValue([])
})

describe('buildReportMetrics', () => {
  it('should build a weekly snapshot with no weeklyBreakdown', async () => {
    const result = await buildReportMetrics({} as never, { clientId: 'c1', type: 'weekly', periodStart: 'a', periodEnd: 'b', now })
    expect(result).toEqual({ overview, daily })
    expect(listWeeklyReportsInRangeMock).not.toHaveBeenCalled()
  })

  it('should call the analytics RPCs with the client scoped and no campaign filter', async () => {
    await buildReportMetrics({} as never, { clientId: 'c1', type: 'weekly', periodStart: 'a', periodEnd: 'b', now })
    expect(getOverviewMetricsMock).toHaveBeenCalledWith({}, { from: 'a', to: 'b', campaignId: null, clientId: 'c1' })
    expect(getDailyMetricsMock).toHaveBeenCalledWith({}, { from: 'a', to: 'b', campaignId: null, clientId: 'c1' })
  })

  it('should include a warmup snapshot when the client has an enrolled, connected mailbox', async () => {
    listMailreachConnectedMailboxesMock.mockResolvedValue([
      {
        id: 'm1',
        email_address: 'sales@acme.com',
        mailreach_enabled: true,
        mailreach_started_at: '2026-08-04T00:00:00.000Z',
        mailreach_status: 'connected',
        mailreach_reputation_score: 70,
        mailreach_total_messages_sent: 10,
        mailreach_total_messages_received: 8,
        mailreach_total_spam: 0,
        mailreach_current_conversations: 2,
      },
    ])
    const result = await buildReportMetrics({} as never, { clientId: 'c1', type: 'weekly', periodStart: 'a', periodEnd: 'b', now })
    expect(result.warmup).toHaveLength(1)
    expect(result.warmup?.[0]).toMatchObject({ mailboxId: 'm1', isGated: true, elapsedDays: 7 })
  })

  it('should build a monthly snapshot with weeklyBreakdown from prior weekly reports', async () => {
    listWeeklyReportsInRangeMock.mockResolvedValue([
      {
        id: 'w1',
        period_start: '2026-07-07T00:00:00.000Z',
        period_end: '2026-07-14T00:00:00.000Z',
        metrics: { overview: fullWeeklyOverview, daily: [] },
      },
    ])
    const result = await buildReportMetrics({} as never, { clientId: 'c1', type: 'monthly', periodStart: 'a', periodEnd: 'b', now })
    expect(result.weeklyBreakdown).toEqual([
      { reportId: 'w1', periodStart: '2026-07-07T00:00:00.000Z', periodEnd: '2026-07-14T00:00:00.000Z', overview: fullWeeklyOverview },
    ])
  })
})
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/reports/metrics.test.ts`
Expected: FAIL — `buildReportMetrics` doesn't accept a `now` field yet and never calls `getClientById`/`listMailreachConnectedMailboxes`.

- [ ] **Step 7: Implement**

Replace `src/lib/reports/metrics.ts` in full:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getOverviewMetrics, getDailyMetrics } from '@/lib/db/analytics'
import { listWeeklyReportsInRange } from '@/lib/db/reports'
import { getClientById } from '@/lib/db/clients'
import { listMailreachConnectedMailboxes } from '@/lib/db/mailboxes'
import { summarizeMailboxWarmup } from '@/lib/mailbox/mailreach-gate'
import { reportMetricsSnapshotSchema, type ReportMetricsSnapshot } from '@/types/reports'

export interface BuildReportMetricsInput {
  clientId: string
  type: 'weekly' | 'monthly'
  periodStart: string
  periodEnd: string
  now: Date
}

// Aggregates across the client's whole account — campaignId: null — no
// per-campaign breakdown in v1 (spec §3, YAGNI: /analytics already owns
// that drill-down).
export async function buildReportMetrics(
  supabase: SupabaseClient<Database>,
  input: BuildReportMetricsInput,
): Promise<ReportMetricsSnapshot> {
  const range = { from: input.periodStart, to: input.periodEnd, campaignId: null, clientId: input.clientId }
  const [overview, daily, client, mailreachMailboxes] = await Promise.all([
    getOverviewMetrics(supabase, range),
    getDailyMetrics(supabase, range),
    getClientById(supabase, input.clientId),
    listMailreachConnectedMailboxes(supabase, input.clientId),
  ])
  const warmupSummary = summarizeMailboxWarmup(mailreachMailboxes, client?.mailreach_enabled ?? false, input.now)
  const warmup = warmupSummary.length > 0 ? warmupSummary : undefined

  if (input.type !== 'monthly') {
    return { overview, daily, warmup }
  }

  const weeklyReports = await listWeeklyReportsInRange(supabase, {
    clientId: input.clientId,
    from: input.periodStart,
    to: input.periodEnd,
  })
  return {
    overview,
    daily,
    warmup,
    // Copied from each weekly report's own frozen snapshot, not
    // recomputed — a monthly report must always agree exactly with the
    // weekly reports it recaps (spec §3).
    weeklyBreakdown: weeklyReports.map((report) => {
      const weeklyMetrics = reportMetricsSnapshotSchema.parse(report.metrics)
      return {
        reportId: report.id,
        periodStart: report.period_start,
        periodEnd: report.period_end,
        overview: weeklyMetrics.overview,
      }
    }),
  }
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/reports/metrics.test.ts src/types/reports.test.ts`
Expected: PASS

- [ ] **Step 9: Typecheck**

Run: `pnpm typecheck`
Expected: Errors only in `src/lib/reports/generate.ts` (still calling `buildReportMetrics` without `now`) — fixed in Task 10.

- [ ] **Step 10: Commit**

```bash
git add src/types/reports.ts src/types/reports.test.ts src/lib/reports/metrics.ts src/lib/reports/metrics.test.ts
git commit -m "feat(reports): freeze mailbox warmup state into the report metrics snapshot

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Reports — LLM commentary and deterministic fallback get warmup context

**Files:**
- Modify: `src/lib/reports/commentary.ts`
- Test: `src/lib/reports/commentary.test.ts`

**Interfaces:**
- Consumes: `MailboxWarmupInfo`, `closestToReady`, `totalMessagesExchanged` (Task 4)
- Produces: `GenerateReportCommentaryInput` gains required `warmup: MailboxWarmupInfo[]`
- Produces: `buildFallbackCommentary(periodLabel, overview, warmup: MailboxWarmupInfo[]): ReportCommentary` (new third parameter)

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/reports/commentary.test.ts` in full:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateJsonMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))

import { generateReportCommentary, buildFallbackCommentary } from './commentary'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

const overview = {
  leadsDiscovered: 12,
  leadsVerified: 11,
  casesCreated: 4,
  emailsSent: 40,
  firstTouchSent: 25,
  followupsSent: 15,
  emailsBounced: 1,
  emailsFailed: 0,
  repliesReceived: 3,
  leadsContacted: 40,
  leadsReplied: 3,
  suppressionsAdded: 0,
  activeSequences: 6,
}

const gatedMailbox: MailboxWarmupInfo = {
  mailboxId: 'm1',
  emailAddress: 'sales@acme.com',
  elapsedDays: 6,
  gateDays: 14,
  isGated: true,
  reputationScore: 70,
  totalMessagesSent: 10,
  totalMessagesReceived: 8,
  totalSpam: 0,
  currentConversations: 2,
}

beforeEach(() => {
  generateJsonMock.mockReset().mockResolvedValue({ headline: 'x', summary: 'y', highlights: ['a', 'b'] })
})

describe('generateReportCommentary', () => {
  it('should include both periods in the prompt when a previous period is given', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: overview, warmup: [] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).toContain('Current period')
    expect(call.prompt).toContain('Previous period')
  })

  it('should omit the previous-period comparison when none exists', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).not.toContain('Previous period')
    expect(call.prompt).toContain('first report')
  })

  it('should omit the warmup block from the prompt when warmup is empty', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).not.toContain('Mailbox warmup in progress')
  })

  it('should include the warmup block in the prompt when a mailbox is gated', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [gatedMailbox] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).toContain('Mailbox warmup in progress')
    expect(call.prompt).toContain('Day 6 of 14')
    expect(call.prompt).toContain('Reputation scores so far: 70')
  })

  it('should return the model output unchanged', async () => {
    const result = await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [] },
    )
    expect(result).toEqual({ headline: 'x', summary: 'y', highlights: ['a', 'b'] })
  })
})

describe('buildFallbackCommentary', () => {
  it('should build a deterministic summary from the raw numbers with 2+ highlights when no mailbox is gated', () => {
    const result = buildFallbackCommentary('this week', overview, [])
    expect(result.summary).toContain('12')
    expect(result.summary).toContain('40')
    expect(result.summary).toContain('3')
    expect(result.highlights.length).toBeGreaterThanOrEqual(2)
    expect(result.highlights.length).toBeLessThanOrEqual(4)
  })

  it('should lead with warmup progress when there were zero sends and a mailbox is gated', () => {
    const result = buildFallbackCommentary('this week', { ...overview, emailsSent: 0 }, [gatedMailbox])
    expect(result.headline).toBe('Building your sending reputation')
    expect(result.summary).toContain('day 6 of 14')
    expect(result.summary).not.toContain('0 leads')
  })

  it('should use the normal fallback when sends happened even with a mailbox gated', () => {
    const result = buildFallbackCommentary('this week', overview, [gatedMailbox])
    expect(result.headline).not.toBe('Building your sending reputation')
    expect(result.summary).toContain('12')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/reports/commentary.test.ts`
Expected: FAIL — `warmup` is missing from the input objects (TS error) and `buildFallbackCommentary` doesn't accept a third argument.

- [ ] **Step 3: Implement**

Replace `src/lib/reports/commentary.ts` in full:

```ts
import { z } from 'zod'
import type { OverviewMetrics } from '@/types/analytics'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { closestToReady, totalMessagesExchanged, type MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

const reportCommentarySchema = z.object({
  headline: z.string().min(1).max(80),
  summary: z.string().min(1).max(600),
  highlights: z.array(z.string().min(1).max(140)).min(2).max(4),
})

export type ReportCommentary = z.infer<typeof reportCommentarySchema>

export interface GenerateReportCommentaryInput {
  clientName: string
  type: 'weekly' | 'monthly'
  periodLabel: 'this week' | 'this month'
  current: OverviewMetrics
  previous: OverviewMetrics | null
  warmup: MailboxWarmupInfo[]
}

const MAX_OUTPUT_TOKENS = 500
// Grounded numeric summarization, not judgment-heavy research/reply
// triage — stays on the lighter thinking level those tasks earn 'medium'/
// 'high' for (see lib/llm/client.ts's ThinkingLevel doc comment).
const THINKING_LEVEL = 'low' as const

const INSTRUCTIONS =
  'You write a short, grounded performance summary for a B2B cold-outreach client dashboard. ' +
  'Use only the numbers given to you — never invent a trend, percentage, or fact not derivable from them. ' +
  'If no comparison period is given, describe the period on its own terms without inventing a delta. ' +
  'If the client has mailboxes still in Mailreach warmup and outreach numbers are low as a result, prioritize ' +
  'describing the warmup progress (days remaining, reputation trend) over dwelling on low lead/email counts — ' +
  'this is expected and positive, not a shortfall. If outreach numbers are healthy, mention warmup progress only ' +
  'briefly, as a secondary note. ' +
  'Tone: plain, confident, specific — like a knowledgeable colleague, not a marketing summary.'

function formatMetricsBlock(label: string, metrics: OverviewMetrics): string {
  return (
    `${label}:\n` +
    `- Leads discovered: ${metrics.leadsDiscovered}\n` +
    `- Emails sent: ${metrics.emailsSent} (first touch ${metrics.firstTouchSent}, follow-ups ${metrics.followupsSent})\n` +
    `- Replies received: ${metrics.repliesReceived}\n` +
    `- Bounced: ${metrics.emailsBounced}, failed: ${metrics.emailsFailed}\n` +
    `- Cases created: ${metrics.casesCreated}\n` +
    `- Active sequences: ${metrics.activeSequences}`
  )
}

function formatWarmupBlock(warmup: MailboxWarmupInfo[]): string {
  const gated = warmup.filter((w) => w.isGated)
  if (gated.length === 0) return ''
  const scores = gated.map((w) => w.reputationScore).filter((s): s is number => s !== null)
  return (
    `\n\nMailbox warmup in progress:\n` +
    `- ${gated.length} of ${warmup.length} connected mailboxes still building sending reputation\n` +
    gated.map((w) => `  - Day ${w.elapsedDays} of ${w.gateDays}`).join('\n') +
    (scores.length > 0 ? `\n- Reputation scores so far: ${scores.join(', ')}` : '') +
    `\n- Messages exchanged as part of warmup: ${totalMessagesExchanged(gated)}`
  )
}

function buildPrompt(input: GenerateReportCommentaryInput): string {
  const sections = [
    `Client: ${input.clientName}`,
    `Report type: ${input.type}, covering ${input.periodLabel}.`,
    formatMetricsBlock('Current period', input.current),
  ]
  if (input.previous) {
    sections.push(formatMetricsBlock('Previous period', input.previous))
  } else {
    sections.push('No previous period exists yet — this is the first report of this type for this client.')
  }
  return sections.join('\n\n') + formatWarmupBlock(input.warmup)
}

export async function generateReportCommentary(
  context: LlmCallContext,
  input: GenerateReportCommentaryInput,
): Promise<ReportCommentary> {
  return generateJson(context, {
    instructions: INSTRUCTIONS,
    prompt: buildPrompt(input),
    schema: reportCommentarySchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingLevel: THINKING_LEVEL,
  })
}

/**
 * Deterministic stand-in for a failed generateReportCommentary call — a
 * Gemini hiccup must never block a report from generating and sending
 * (spec §4). When there were zero sends this period and at least one
 * mailbox is still gated, leads with warmup progress instead of a flat "0
 * leads found" — the actual problem this feature exists to fix. Otherwise
 * falls back to 2 real highlights derived from the numbers, same as before.
 */
export function buildFallbackCommentary(
  periodLabel: 'this week' | 'this month',
  overview: OverviewMetrics,
  warmup: MailboxWarmupInfo[],
): ReportCommentary {
  const gated = warmup.filter((w) => w.isGated)
  if (overview.emailsSent === 0 && gated.length > 0) {
    const closest = closestToReady(gated)
    if (closest) {
      return {
        headline: 'Building your sending reputation',
        summary:
          `${gated.length} mailbox${gated.length === 1 ? '' : 'es'} still warming up with Mailreach — ` +
          `the closest is on day ${closest.elapsedDays} of ${closest.gateDays}. ` +
          `Outreach begins automatically once warmup clears.`,
        highlights: [
          `Day ${closest.elapsedDays} of ${closest.gateDays} for the closest mailbox`,
          closest.reputationScore !== null
            ? `Reputation score: ${closest.reputationScore}`
            : `${gated.length} mailbox${gated.length === 1 ? '' : 'es'} warming up`,
        ],
      }
    }
  }
  return {
    headline: `${periodLabel === 'this week' ? 'Weekly' : 'Monthly'} performance summary`,
    summary: `${overview.leadsDiscovered} leads found, ${overview.emailsSent} emails sent, ${overview.repliesReceived} replies received.`,
    highlights: [
      `${overview.leadsDiscovered} leads discovered`,
      `${overview.emailsSent} emails sent, ${overview.repliesReceived} replies received`,
    ],
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/reports/commentary.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: Errors only in `src/lib/reports/generate.ts` (still calling both functions with the old signatures) — fixed in Task 10.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/commentary.ts src/lib/reports/commentary.test.ts
git commit -m "feat(reports): commentary leads with warmup progress instead of 0 leads found

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: Reports — dedicated warmup email template

**Files:**
- Modify: `src/lib/reports/email-templates.ts`
- Test: `src/lib/reports/email-templates.test.ts`

**Interfaces:**
- Consumes: `MailboxWarmupInfo`, `closestToReady`, `totalMessagesExchanged` (Task 4)
- Produces: `interface WarmupTemplateContext { gatedCount, totalEnrolled, closestElapsedDays, closestGateDays, closestReputationScore, messagesExchanged }`
- Produces: `buildWarmupTemplateContext(warmup: MailboxWarmupInfo[]): WarmupTemplateContext | null`
- Produces: `ReportEmailTemplateInput` gains required `warmup: WarmupTemplateContext | null`
- Produces: `pickTemplate(priorReportCount: number, useWarmupTemplate: boolean): ReportEmailTemplate` (new second parameter)

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/reports/email-templates.test.ts` in full:

```ts
import { describe, it, expect } from 'vitest'
import { pickTemplate, renderTemplate, buildWarmupTemplateContext, FEEDBACK_CALL_URL, type ReportEmailTemplateInput } from './email-templates'
import { AppError } from '@/lib/errors/app-error'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

const input: ReportEmailTemplateInput = {
  clientName: 'Acme Co.',
  periodLabel: 'this week',
  leadsFound: 12,
  emailsSent: 40,
  repliesReceived: 3,
  reportUrl: 'https://app.example.com/reports/abc',
  warmup: null,
}

const gatedMailbox: MailboxWarmupInfo = {
  mailboxId: 'm1',
  emailAddress: 'sales@acme.com',
  elapsedDays: 6,
  gateDays: 14,
  isGated: true,
  reputationScore: 70,
  totalMessagesSent: 10,
  totalMessagesReceived: 8,
  totalSpam: 0,
  currentConversations: 2,
}
const warmMailbox: MailboxWarmupInfo = { ...gatedMailbox, mailboxId: 'm2', elapsedDays: 20, isGated: false }

describe('pickTemplate', () => {
  it('should return a different template for each of the 7 rotation indices', () => {
    const rendered = Array.from({ length: 7 }, (_, i) => renderTemplate(pickTemplate(i, false), input).subject)
    expect(new Set(rendered).size).toBe(7)
  })

  it('should wrap around after 7', () => {
    expect(renderTemplate(pickTemplate(0, false), input)).toEqual(renderTemplate(pickTemplate(7, false), input))
    expect(renderTemplate(pickTemplate(1, false), input)).toEqual(renderTemplate(pickTemplate(8, false), input))
  })

  it('should always return the warmup template when useWarmupTemplate is true, regardless of rotation index', () => {
    const first = renderTemplate(pickTemplate(0, true), { ...input, warmup: buildWarmupTemplateContext([gatedMailbox]) })
    const second = renderTemplate(pickTemplate(3, true), { ...input, warmup: buildWarmupTemplateContext([gatedMailbox]) })
    expect(first.subject).toBe(second.subject)
    expect(first.subject).toContain('building')
  })
})

describe('renderTemplate', () => {
  it('should include every dynamic value in every rotating template', () => {
    for (let i = 0; i < 7; i += 1) {
      const rendered = renderTemplate(pickTemplate(i, false), input)
      expect(rendered.text).toContain('Acme Co.')
      expect(rendered.text).toContain('12')
      expect(rendered.text).toContain(input.reportUrl)
      expect(rendered.text).toContain(FEEDBACK_CALL_URL)
      expect(rendered.text).toContain('Shengul Yavuz')
      expect(rendered.text).toContain('Founder of Shengul AI')
      expect(rendered.subject.length).toBeGreaterThan(0)
      expect(rendered.html).toContain('12')
    }
  })

  it('should reject a client name containing a line break', () => {
    expect(() => renderTemplate(pickTemplate(0, false), { ...input, clientName: 'Acme\nInjected' })).toThrow(AppError)
  })

  it('should render html and text with the same line content', () => {
    const rendered = renderTemplate(pickTemplate(0, false), input)
    expect(rendered.html).toContain(input.reportUrl)
  })

  it('should render the warmup template with day counter, reputation, and no lead-count wording', () => {
    const warmup = buildWarmupTemplateContext([gatedMailbox])
    const rendered = renderTemplate(pickTemplate(0, true), { ...input, warmup })
    expect(rendered.text).toContain('day 6 of 14')
    expect(rendered.text).toContain('reputation score 70')
    expect(rendered.text).not.toMatch(/0 (new )?leads?/i)
    expect(rendered.text).toContain(input.reportUrl)
  })

  it('should throw when the warmup template is rendered without warmup context', () => {
    expect(() => renderTemplate(pickTemplate(0, true), { ...input, warmup: null })).toThrow(AppError)
  })
})

describe('buildWarmupTemplateContext', () => {
  it('should return null when no mailbox is gated', () => {
    expect(buildWarmupTemplateContext([warmMailbox])).toBeNull()
  })

  it('should return null for an empty array', () => {
    expect(buildWarmupTemplateContext([])).toBeNull()
  })

  it('should aggregate the gated mailboxes, keeping only the closest-to-ready one for the day counter', () => {
    const almostReady: MailboxWarmupInfo = { ...gatedMailbox, mailboxId: 'm3', elapsedDays: 12, reputationScore: 88 }
    const result = buildWarmupTemplateContext([gatedMailbox, almostReady, warmMailbox])
    expect(result).toEqual({
      gatedCount: 2,
      totalEnrolled: 3,
      closestElapsedDays: 12,
      closestGateDays: 14,
      closestReputationScore: 88,
      messagesExchanged: (10 + 8) * 2, // gatedMailbox + almostReady share the same sent/received values
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/reports/email-templates.test.ts`
Expected: FAIL — `buildWarmupTemplateContext` is not exported, `pickTemplate` only takes one argument, and `warmup` is missing from `ReportEmailTemplateInput`.

- [ ] **Step 3: Implement**

In `src/lib/reports/email-templates.ts`, add an import at the top:

```ts
import { AppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from '@/lib/mailbox/headers'
import { closestToReady, totalMessagesExchanged, type MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'
```

Update `ReportEmailTemplateInput`:

```ts
export interface ReportEmailTemplateInput {
  clientName: string
  periodLabel: 'this week' | 'this month'
  leadsFound: number
  emailsSent: number
  repliesReceived: number
  reportUrl: string
  warmup: WarmupTemplateContext | null
}

export interface WarmupTemplateContext {
  gatedCount: number
  totalEnrolled: number
  closestElapsedDays: number
  closestGateDays: number
  closestReputationScore: number | null
  messagesExchanged: number
}

export function buildWarmupTemplateContext(warmup: MailboxWarmupInfo[]): WarmupTemplateContext | null {
  const gated = warmup.filter((w) => w.isGated)
  const closest = closestToReady(gated)
  if (!closest) return null
  return {
    gatedCount: gated.length,
    totalEnrolled: warmup.length,
    closestElapsedDays: closest.elapsedDays,
    closestGateDays: closest.gateDays,
    closestReputationScore: closest.reputationScore,
    messagesExchanged: totalMessagesExchanged(gated),
  }
}
```

Leave the existing `SIGNATURE`, `TEMPLATES` array (all 7 templates unchanged — they never reference `warmup`), and `toHtml` as-is. Add the dedicated warmup template right after the `TEMPLATES` array:

```ts
const WARMUP_TEMPLATE: ReportEmailTemplate = {
  subject: ({ clientName }) => `Shengul AI — building ${clientName}'s sending reputation`,
  body: ({ clientName, periodLabel, warmup, reportUrl }) => {
    if (!warmup) {
      throw new AppError('INVARIANT_VIOLATION', 'Warmup template rendered without warmup context', {})
    }
    const scoreLine = warmup.closestReputationScore !== null ? `, reputation score ${warmup.closestReputationScore}` : ''
    return (
      `Hey ${clientName} team,\n\n` +
      `No outreach numbers to report ${periodLabel} yet — ${warmup.gatedCount} of ${warmup.totalEnrolled} mailboxes ` +
      `are still building sending reputation with Mailreach. The closest is on day ${warmup.closestElapsedDays} of ` +
      `${warmup.closestGateDays}${scoreLine}. ${warmup.messagesExchanged} messages exchanged so far as part of warmup.\n\n` +
      `Once warmup clears, outreach starts automatically — full detail here: ${reportUrl}\n\n` +
      `Questions? Reply to this email, or grab 15 minutes: ${FEEDBACK_CALL_URL}\n\n` +
      `— Shengul\n\n${SIGNATURE}`
    )
  },
}
```

Replace `pickTemplate`:

```ts
// Deterministic, never repeats back-to-back across a client's reports —
// spec §6. The warmup template is deliberately not part of this rotation
// (YAGNI — a narrower, temporary state doesn't need 7 variants).
export function pickTemplate(priorReportCount: number, useWarmupTemplate: boolean): ReportEmailTemplate {
  if (useWarmupTemplate) return WARMUP_TEMPLATE
  return TEMPLATES[priorReportCount % TEMPLATES.length]!
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/reports/email-templates.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: Errors only in `src/lib/reports/generate.ts` — fixed in Task 10.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/email-templates.ts src/lib/reports/email-templates.test.ts
git commit -m "feat(reports): dedicated email template for zero-send warmup periods

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Reports — wire warmup through `generate.ts`

**Files:**
- Modify: `src/lib/reports/generate.ts`
- Test: `src/lib/reports/generate.test.ts`

**Interfaces:**
- Consumes: `buildReportMetrics` (Task 7, now needs `now`), `generateReportCommentary`/`buildFallbackCommentary` (Task 8, now need `warmup`), `pickTemplate`/`buildWarmupTemplateContext` (Task 9)

- [ ] **Step 1: Write the failing tests**

In `src/lib/reports/generate.test.ts`, add a new mock and register it in the `./email-templates` mock:

```ts
const buildWarmupTemplateContextMock = vi.fn()
```

```ts
vi.mock('./email-templates', () => ({
  pickTemplate: (...a: unknown[]) => pickTemplateMock(...a),
  renderTemplate: (...a: unknown[]) => renderTemplateMock(...a),
  buildWarmupTemplateContext: (...a: unknown[]) => buildWarmupTemplateContextMock(...a),
}))
```

Add it to `beforeEach`:

```ts
  buildWarmupTemplateContextMock.mockReset().mockReturnValue(null)
```

Append three new tests inside `describe('generateReport', ...)`:

```ts
  it('should pass an empty warmup array to the commentary call when no mailboxes are enrolled', async () => {
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(generateReportCommentaryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ warmup: [] }))
  })

  it('should use the warmup template when there were zero sends and a mailbox is still gated', async () => {
    const gatedMailbox = {
      mailboxId: 'm1',
      emailAddress: 'sales@acme.com',
      elapsedDays: 6,
      gateDays: 14,
      isGated: true,
      reputationScore: 70,
      totalMessagesSent: 10,
      totalMessagesReceived: 8,
      totalSpam: 0,
      currentConversations: 2,
    }
    buildReportMetricsMock.mockResolvedValue({ overview: { ...overview, emailsSent: 0 }, daily: [], warmup: [gatedMailbox] })
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(pickTemplateMock).toHaveBeenCalledWith(0, true)
  })

  it('should use the normal rotating template when sends happened even with a mailbox still gated', async () => {
    const gatedMailbox = {
      mailboxId: 'm1',
      emailAddress: 'sales@acme.com',
      elapsedDays: 6,
      gateDays: 14,
      isGated: true,
      reputationScore: 70,
      totalMessagesSent: 10,
      totalMessagesReceived: 8,
      totalSpam: 0,
      currentConversations: 2,
    }
    buildReportMetricsMock.mockResolvedValue({ overview, daily: [], warmup: [gatedMailbox] })
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(pickTemplateMock).toHaveBeenCalledWith(0, false)
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/reports/generate.test.ts`
Expected: FAIL — `pickTemplateMock` is currently called with one argument; the new assertions expect two.

- [ ] **Step 3: Implement**

In `src/lib/reports/generate.ts`:

Update the import line for `email-templates`:

```ts
import { pickTemplate, renderTemplate, buildWarmupTemplateContext, type ReportEmailTemplateInput } from './email-templates'
```

Add `now: input.now` to the `buildReportMetrics` call:

```ts
  const metrics = await buildReportMetrics(admin, {
    clientId: input.clientId,
    type: input.type,
    periodStart: period.periodStart,
    periodEnd: period.periodEnd,
    now: input.now,
  })
  const validatedMetrics = reportMetricsSnapshotSchema.parse(metrics)
  const warmup = validatedMetrics.warmup ?? []
```

Add `warmup` to the `generateReportCommentary` call's input object, and as a third argument to `buildFallbackCommentary`:

```ts
      {
        clientName: client.name,
        type: input.type,
        periodLabel: period.periodLabel,
        current: validatedMetrics.overview,
        previous: previousOverview,
        warmup,
      },
```

```ts
    commentary = buildFallbackCommentary(period.periodLabel, validatedMetrics.overview, warmup)
```

Replace the template-selection block:

```ts
  const priorCount = await countPriorReportsForClient(admin, input.clientId)
  const gatedMailboxes = warmup.filter((w) => w.isGated)
  const useWarmupTemplate = validatedMetrics.overview.emailsSent === 0 && gatedMailboxes.length > 0
  const template = pickTemplate(priorCount, useWarmupTemplate)
  const templateInput: ReportEmailTemplateInput = {
    clientName: client.name,
    periodLabel: period.periodLabel,
    leadsFound: validatedMetrics.overview.leadsDiscovered,
    emailsSent: validatedMetrics.overview.emailsSent,
    repliesReceived: validatedMetrics.overview.repliesReceived,
    reportUrl: reportUrlFor(report.id),
    warmup: useWarmupTemplate ? buildWarmupTemplateContext(warmup) : null,
  }
  const rendered = renderTemplate(template, templateInput)
```

Every other line in the file is unchanged.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/reports/generate.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: No errors anywhere in `src/lib/reports/`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/reports/generate.ts src/lib/reports/generate.test.ts
git commit -m "feat(reports): wire warmup snapshot through commentary and template selection

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Report detail page — warmup panel

**Files:**
- Create: `src/app/(app)/reports/[id]/warmup-panel.tsx`
- Modify: `src/app/(app)/reports/[id]/page.tsx`
- Modify: `src/messages/en.json`, `src/messages/tr.json` (`reports.warmupPanel`)

**Interfaces:**
- Consumes: `MailboxWarmupInfo` (Task 4), `metrics.warmup` (Task 7, via the parsed `ReportMetricsSnapshot`)

- [ ] **Step 1: Add the translation keys**

In `src/messages/en.json`, inside the `"reports"` object, add:

```json
"warmupPanel": {
  "title": "Warming up your mailboxes",
  "description": "{gated} of {total} mailboxes were still building sending reputation during this period.",
  "statusWarming": "Day {elapsed} of {gate}",
  "statusWarm": "Warm",
  "reputation": "Reputation"
}
```

In `src/messages/tr.json`, inside `"reports"`, add:

```json
"warmupPanel": {
  "title": "Kutularınız ısınıyor",
  "description": "Bu dönemde {total} kutudan {gated} tanesi hâlâ gönderim itibarı oluşturuyordu.",
  "statusWarming": "{gate} günün {elapsed}. günü",
  "statusWarm": "Isındı",
  "reputation": "İtibar"
}
```

- [ ] **Step 2: Create the panel component**

Create `src/app/(app)/reports/[id]/warmup-panel.tsx`:

```tsx
import { getTranslations } from 'next-intl/server'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

interface WarmupPanelProps {
  mailboxes: MailboxWarmupInfo[]
}

export async function WarmupPanel({ mailboxes }: WarmupPanelProps): Promise<React.ReactElement> {
  const t = await getTranslations('reports')
  const gated = mailboxes.filter((m) => m.isGated)
  return (
    <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
      <p className="text-sm font-medium">{t('warmupPanel.title')}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupPanel.description', { gated: gated.length, total: mailboxes.length })}
      </p>
      <div className="divide-hairline mt-3 flex flex-col divide-y">
        {mailboxes.map((mailbox) => (
          <div key={mailbox.mailboxId} className="flex items-center justify-between gap-3 py-2 text-sm">
            <span className="truncate">{mailbox.emailAddress}</span>
            <span className="text-muted-foreground tnum shrink-0">
              {mailbox.isGated
                ? t('warmupPanel.statusWarming', { elapsed: mailbox.elapsedDays, gate: mailbox.gateDays })
                : t('warmupPanel.statusWarm')}
              {mailbox.reputationScore !== null ? ` · ${t('warmupPanel.reputation')}: ${mailbox.reputationScore}` : null}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire it into the report detail page**

In `src/app/(app)/reports/[id]/page.tsx`, add the import:

```ts
import { WarmupPanel } from './warmup-panel'
```

Insert the panel right after `PageHeader` and before the stat-tile grid:

```tsx
      <PageHeader
        title={report.type === 'monthly' ? t('typeMonthly') : t('typeWeekly')}
        description={`${formatPeriodDate(report.period_start)} – ${formatPeriodDate(report.period_end)}`}
      />

      {metrics.warmup && metrics.warmup.length > 0 ? <WarmupPanel mailboxes={metrics.warmup} /> : null}

      <div className="grid gap-3 sm:grid-cols-3">
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: No errors.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/reports/\[id\]/warmup-panel.tsx src/app/\(app\)/reports/\[id\]/page.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(reports): warmup panel on the report detail page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 12: Full verification pass

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `pnpm test`
Expected: All tests pass, including every file touched in Tasks 1-11.

- [ ] **Step 2: Run the full typecheck**

Run: `pnpm typecheck`
Expected: No errors anywhere in the repo.

- [ ] **Step 3: Run the full lint**

Run: `pnpm lint`
Expected: No errors or warnings introduced by this plan's changes.

- [ ] **Step 4: Validate both message files are structurally valid and key-complete**

Run:
```bash
node -e "
const en = require('./src/messages/en.json')
const tr = require('./src/messages/tr.json')
function keys(o, prefix = '') {
  return Object.entries(o).flatMap(([k, v]) =>
    typeof v === 'object' && v !== null ? keys(v, prefix + k + '.') : [prefix + k],
  )
}
const enKeys = new Set(keys(en))
const trKeys = new Set(keys(tr))
const missingInTr = [...enKeys].filter((k) => !trKeys.has(k))
const missingInEn = [...trKeys].filter((k) => !enKeys.has(k))
if (missingInTr.length || missingInEn.length) {
  console.log('Missing in tr.json:', missingInTr)
  console.log('Missing in en.json:', missingInEn)
  process.exit(1)
}
console.log('OK: en.json and tr.json have identical key sets')
"
```
Expected: `OK: en.json and tr.json have identical key sets`

- [ ] **Step 5: Update the roadmap**

Add an entry to `.claude/roadmap.md` describing what shipped (per `CLAUDE.md`'s standing instruction to update it on every change): the `getAccountStats` fix, the new mailbox stats columns, and the three new warmup surfaces (Home banner, Analytics section, Reports panel/template/commentary).

- [ ] **Step 6: Manual deploy-time verification (not automatable in this environment)**

Note for whoever deploys this:
1. Apply `supabase/migrations/0042_mailreach_stats_fields.sql` to the live database.
2. Wait for (or manually trigger) the next `/api/pipeline/mailreach-sync` run and confirm, via the Supabase table editor, that a connected mailbox's `mailreach_reputation_score`, `mailreach_total_messages_sent`, `mailreach_total_messages_received`, `mailreach_total_spam`, and `mailreach_current_conversations` columns are populated with non-null values (this is the actual proof the Task 1 bug fix works end-to-end against the real Mailreach API, which cannot be verified by mocked unit tests alone).
3. As a client-role user whose mailboxes are mid-warmup, confirm the `/home` banner and the `/analytics` "Mailbox Warmup" section both render.
4. Trigger a report generation for that client and confirm the resulting email/report page uses the warmup framing when `emailsSent` is 0.

- [ ] **Step 7: Final commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: update roadmap for Mailreach warmup surfacing

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Self-Review Notes

- **Spec coverage:** §1 → Task 1. §2 → Task 2. §3 → Task 3. §4 → Task 4. §5 → Task 5. §6 → Task 6. §7a → Task 7. §7b → Task 8. §7c → Task 9. §7d → Task 10. §7e → Task 11. §8 (i18n) → folded into Tasks 5/6/11. §9 (out of scope) → nothing implements the realtime-publication change, per-provider score breakdown, reputation sparkline, or gate-logic change — confirmed absent from every task. §10 (testing) → every enumerated test case in the spec appears in Tasks 1-11's test steps.
- **Placeholder scan:** no `TBD`/`TODO`; every step shows real code, not "similar to Task N".
- **Type consistency:** `MailboxWarmupInfo` (Task 4) is the single type threaded unchanged through Tasks 5, 6, 7, 8, 9, 11 — field names (`mailboxId`, `emailAddress`, `elapsedDays`, `gateDays`, `isGated`, `reputationScore`, `totalMessagesSent`, `totalMessagesReceived`, `totalSpam`, `currentConversations`) match exactly everywhere they're referenced. `updateMailboxMailreachStats`'s field names (Task 2) match what Task 3's `runMailreachStatsSync` passes. `pickTemplate`'s new second parameter and `buildWarmupTemplateContext` (Task 9) match exactly how Task 10 calls them.
