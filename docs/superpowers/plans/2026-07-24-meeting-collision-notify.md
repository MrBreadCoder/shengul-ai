# Meeting Collision Notice Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The first time a case reaches `hot_handoff` (a contact at that company replied with booking/price intent), automatically pause and notify any other contact at the same company whose sequence hasn't been touched yet, so they hear about the colleague's booking from us instead of getting a blind follow-up.

**Architecture:** `reply.ts`'s existing `price` branch, right after it flips the case to `hot_handoff`, calls a new `triggerCollisionNotice`. It atomically claims a new `cases.collision_notified_at` column (fires once per case, race-safe) and, if it wins the claim, fans out one QStash message per other untouched contact to a new route `/api/pipeline/collision-notify`. That route's handler (`runCollisionNotice`) re-checks the target's sequence is still untouched, claims the send slot on the existing `emails` unique-index machinery (reusing `claimOutboundEmail`, no new table), sends or drafts a deterministic templated notice per the campaign's `reply_mode`, and terminally stops that lead's sequence — mirroring exactly how the existing price-handoff and inbound-ingestion code already fans out and claims slots elsewhere in this pipeline.

**Tech Stack:** Next.js Route Handlers, Supabase (Postgres + supabase-js), QStash (Upstash) for fan-out, Vitest for tests. No new external dependency, no new table — one new nullable column and one new route.

## Global Constraints

- No Calendly/Cal.com webhook exists in this codebase. The trigger stays tied to the Reply Agent's existing `price` intent classification (`src/lib/pipeline/reply.ts`) — do not attempt to build or assume a calendar-booking integration.
- The notice fires **once per case**, not once per contact-pair — a second contact independently reaching `hot_handoff` later must not re-fire it.
- Only contacts whose sequence is still `active` (no reply of their own yet) get the notice. A contact already `paused`/`stopped` (mid their own conversation) is left alone.
- The notice message is a deterministic template — no LLM call. It names the triggering contact by first name and offers to consolidate to one call.
- Follow the campaign's existing `reply_mode` (`human_approve` → draft to `/inbox`, otherwise → send immediately) — do not invent a new send-mode concept for this feature.
- Every new DB function throws `AppError('DB_ERROR', ...)` on a Supabase error, matching every existing function in `src/lib/db/*.ts`.

---

### Task 1: `cases.collision_notified_at` column + atomic claim helper

**Files:**
- Create: `supabase/migrations/0016_collision_notice.sql`
- Modify: `src/types/database.ts:104-129` (cases table Row/Insert)
- Modify: `src/lib/db/cases.ts`
- Test: `src/lib/db/cases.test.ts`

**Interfaces:**
- Produces: `claimCollisionNotice(supabase: SupabaseClient<Database>, caseId: string): Promise<boolean>` exported from `src/lib/db/cases.ts`. Task 4 imports this.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0016_collision_notice.sql`:

```sql
-- Meeting collision notice: once a company's case reaches hot_handoff (a
-- contact there accepted a booking-intent reply), any other untouched
-- contact at that company gets paused + notified instead of continuing
-- blind. This column gates that notice to fire exactly once per case, even
-- if a second contact independently reaches hot_handoff moments later.
alter table cases add column collision_notified_at timestamptz;
```

- [ ] **Step 2: Hand-update the generated types**

In `src/types/database.ts`, in the `cases` table block (lines 104-129), add the new column to both `Row` and `Insert` right after `updated_at`:

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
          summary?: string | null
          created_at?: string
          updated_at?: string
          collision_notified_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['cases']['Insert']>
```

(`Update` is already `Partial<Insert>`, so no separate edit needed there.)

- [ ] **Step 3: Write the failing test**

In `src/lib/db/cases.test.ts`, add a new mock helper and describe block (near the existing `mockSupabase` helper at the top of the file):

```ts
function mockClaimUpdate(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      update: () => ({ eq: () => ({ is: () => ({ select: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}
```

Then add:

```ts
describe('claimCollisionNotice', () => {
  it('should return true when this call wins the claim (row was null and got updated)', async () => {
    const supabase = mockClaimUpdate({ data: [{ id: 'case1' }], error: null })
    const result = await claimCollisionNotice(supabase, 'case1')
    expect(result).toBe(true)
  })

  it('should return false when the case was already claimed (no matching row)', async () => {
    const supabase = mockClaimUpdate({ data: [], error: null })
    const result = await claimCollisionNotice(supabase, 'case1')
    expect(result).toBe(false)
  })

  it('should throw DB_ERROR when the update errors', async () => {
    const supabase = mockClaimUpdate({ data: null, error: { message: 'boom' } })
    await expect(claimCollisionNotice(supabase, 'case1')).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `claimCollisionNotice` to the existing `import { ... } from './cases'` at the top of the test file.

- [ ] **Step 4: Run test to verify it fails**

Run: `pnpm test src/lib/db/cases.test.ts`
Expected: FAIL with "claimCollisionNotice is not a function" / not exported.

- [ ] **Step 5: Implement `claimCollisionNotice`**

In `src/lib/db/cases.ts`, add after `updateCaseStatus`:

```ts
// Atomic claim: only the first caller for a case gets true and should proceed
// to fan out notices to other contacts at that company. A concurrent or
// later call for the same case (e.g. a second contact also reaching
// hot_handoff) returns false and must no-op.
export async function claimCollisionNotice(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('cases')
    .update({ collision_notified_at: new Date().toISOString() })
    .eq('id', caseId)
    .is('collision_notified_at', null)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim collision notice for case', { caseId, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}
```

- [ ] **Step 6: Run test to verify it passes**

Run: `pnpm test src/lib/db/cases.test.ts`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0016_collision_notice.sql src/types/database.ts src/lib/db/cases.ts src/lib/db/cases.test.ts
git commit -m "feat: add cases.collision_notified_at claim for the meeting collision notice"
```

---

### Task 2: `isSequenceActiveForLead` freshness check

**Files:**
- Modify: `src/lib/db/sequences.ts`
- Test: `src/lib/db/sequences.test.ts`

**Interfaces:**
- Produces: `isSequenceActiveForLead(supabase: SupabaseClient<Database>, leadId: string): Promise<boolean>` exported from `src/lib/db/sequences.ts`. Task 4 imports this to re-check, at processing time, whether a target contact has replied for real since the fan-out snapshot was taken.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/sequences.test.ts`, add a mock helper alongside the existing ones:

```ts
function mockMaybeSingle(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }) }),
  } as never
}
```

Then add:

```ts
describe('isSequenceActiveForLead', () => {
  it('should return true when an active sequence row exists for the lead', async () => {
    const result = await isSequenceActiveForLead(mockMaybeSingle({ data: { id: 'seq1' }, error: null }), 'lead1')
    expect(result).toBe(true)
  })

  it('should return false when no active sequence row exists (paused, stopped, or replied)', async () => {
    const result = await isSequenceActiveForLead(mockMaybeSingle({ data: null, error: null }), 'lead1')
    expect(result).toBe(false)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      isSequenceActiveForLead(mockMaybeSingle({ data: null, error: { message: 'boom' } }), 'lead1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `isSequenceActiveForLead` to the existing `import { ... } from './sequences'` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/db/sequences.test.ts`
Expected: FAIL with "isSequenceActiveForLead is not a function" / not exported.

- [ ] **Step 3: Implement `isSequenceActiveForLead`**

In `src/lib/db/sequences.ts`, add after `stopSequenceForLead`:

```ts
// Fresh point-in-time check used by the collision-notice worker: the fan-out
// step (triggerCollisionNotice) takes a snapshot of "untouched" contacts, but
// time passes before each QStash message is processed, so a target may have
// replied for real in the interim (which already paused their sequence via
// pauseActiveSequenceForLead). A real conversation always wins over a canned
// notice.
export async function isSequenceActiveForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('sequences')
    .select('id')
    .eq('lead_id', leadId)
    .eq('state', 'active')
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check sequence state for lead', { leadId, cause: error.message })
  }
  return data !== null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/db/sequences.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/sequences.ts src/lib/db/sequences.test.ts
git commit -m "feat: add isSequenceActiveForLead freshness check for collision notice"
```

---

### Task 3: `listOtherActiveLeadsForCollisionNotice`

**Files:**
- Modify: `src/lib/db/leads.ts`
- Test: `src/lib/db/leads.test.ts`

**Interfaces:**
- Consumes: `LeadRow` (already exported from `src/lib/db/leads.ts`).
- Produces: `listOtherActiveLeadsForCollisionNotice(supabase: SupabaseClient<Database>, caseId: string, excludeLeadId: string): Promise<LeadRow[]>` exported from `src/lib/db/leads.ts`. Task 4's `triggerCollisionNotice` calls this to get the fan-out target list.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/leads.test.ts`, add a mock helper alongside the existing `mockContactedLead`:

```ts
function mockCollisionCandidates(
  leadsResult: { data: unknown; error: unknown },
  seqResult?: { data: unknown; error: unknown },
) {
  return {
    from: (table: string) => {
      if (table === 'leads') {
        return {
          select: () => ({
            eq: () => ({ eq: () => ({ neq: () => Promise.resolve(leadsResult) }) }),
          }),
        }
      }
      return {
        select: () => ({
          in: () => ({ eq: () => Promise.resolve(seqResult ?? { data: [], error: null }) }),
        }),
      }
    },
  } as never
}
```

Then add:

```ts
describe('listOtherActiveLeadsForCollisionNotice', () => {
  it('should return other active leads whose sequence is still active', async () => {
    const leadA = { id: 'leadA', case_id: 'case1', status: 'active' }
    const leadB = { id: 'leadB', case_id: 'case1', status: 'active' }
    const supabase = mockCollisionCandidates(
      { data: [leadA, leadB], error: null },
      { data: [{ lead_id: 'leadA' }, { lead_id: 'leadB' }], error: null },
    )
    const result = await listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead')
    expect(result).toEqual([leadA, leadB])
  })

  it('should exclude a candidate whose sequence is no longer active (already replied)', async () => {
    const leadA = { id: 'leadA', case_id: 'case1', status: 'active' }
    const leadB = { id: 'leadB', case_id: 'case1', status: 'active' }
    const supabase = mockCollisionCandidates(
      { data: [leadA, leadB], error: null },
      { data: [{ lead_id: 'leadA' }], error: null },
    )
    const result = await listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead')
    expect(result).toEqual([leadA])
  })

  it('should return an empty array without querying sequences when there are no other active leads', async () => {
    const supabase = mockCollisionCandidates({ data: [], error: null })
    const result = await listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead')
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the leads query errors', async () => {
    const supabase = mockCollisionCandidates({ data: null, error: { message: 'boom' } })
    await expect(
      listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead'),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should throw DB_ERROR when the sequences query errors', async () => {
    const leadA = { id: 'leadA', case_id: 'case1', status: 'active' }
    const supabase = mockCollisionCandidates(
      { data: [leadA], error: null },
      { data: null, error: { message: 'boom' } },
    )
    await expect(
      listOtherActiveLeadsForCollisionNotice(supabase, 'case1', 'triggeringLead'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `listOtherActiveLeadsForCollisionNotice` to the existing `import { ... } from './leads'` at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/db/leads.test.ts`
Expected: FAIL with "listOtherActiveLeadsForCollisionNotice is not a function" / not exported.

- [ ] **Step 3: Implement `listOtherActiveLeadsForCollisionNotice`**

In `src/lib/db/leads.ts`, add after `listLeadsForCase`:

```ts
// Fan-out target list for the meeting collision notice: every other contact
// at this case's company who is still on a fully untouched sequence. A lead
// whose own sequence is already paused/stopped has replied on their own
// thread and is deliberately excluded — only silent contacts get the notice.
export async function listOtherActiveLeadsForCollisionNotice(
  supabase: SupabaseClient<Database>,
  caseId: string,
  excludeLeadId: string,
): Promise<LeadRow[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('case_id', caseId)
    .eq('status', 'active')
    .neq('id', excludeLeadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list other active leads for collision notice', {
      caseId, excludeLeadId, cause: error.message,
    })
  }
  const candidates = data ?? []
  if (candidates.length === 0) return []

  const { data: activeSequences, error: seqError } = await supabase
    .from('sequences')
    .select('lead_id')
    .in('lead_id', candidates.map((c) => c.id))
    .eq('state', 'active')
  if (seqError) {
    throw new AppError('DB_ERROR', 'Failed to check sequence state for collision notice candidates', {
      caseId, cause: seqError.message,
    })
  }
  const untouchedIds = new Set((activeSequences ?? []).map((s) => s.lead_id))
  return candidates.filter((c) => untouchedIds.has(c.id))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/db/leads.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat: add listOtherActiveLeadsForCollisionNotice"
```

---

### Task 4: `src/lib/pipeline/collision-notify.ts` — trigger + worker

**Files:**
- Create: `src/lib/pipeline/collision-notify.ts`
- Test: `src/lib/pipeline/collision-notify.test.ts`

**Interfaces:**
- Consumes: `claimCollisionNotice(supabase, caseId): Promise<boolean>` (Task 1, `@/lib/db/cases`); `isSequenceActiveForLead(supabase, leadId): Promise<boolean>` (Task 2, `@/lib/db/sequences`); `listOtherActiveLeadsForCollisionNotice(supabase, caseId, excludeLeadId): Promise<LeadRow[]>` (Task 3, `@/lib/db/leads`); `getLeadById(supabase, leadId): Promise<LeadRow | null>` (existing, `@/lib/db/leads`); `getCampaignForCase(supabase, caseId): Promise<CampaignRow | null>` (existing, `@/lib/db/campaigns`); `listThreadEmails(supabase, leadId): Promise<EmailRow[]>`, `claimOutboundEmail(supabase, row: EmailInsert): Promise<EmailRow | null>`, `markEmailSent(supabase, id, patch): Promise<void>`, `markEmailFailed(supabase, id): Promise<void>` (all existing, `@/lib/db/emails`); `stopSequenceForLead(supabase, leadId, state): Promise<void>` (existing, `@/lib/db/sequences`); `sendViaMailbox(supabase, input): Promise<SendViaMailboxResult>` (existing, `@/lib/mailbox/sender`); `publishJson(path, body): Promise<string>` (existing, `@/lib/qstash/client`); `logEventSafe(input): Promise<void>` (existing, `@/lib/events/log-event`).
- Produces: `triggerCollisionNotice(supabase: SupabaseClient<Database>, caseId: string, triggeringLeadId: string): Promise<void>` and `runCollisionNotice(supabase: SupabaseClient<Database>, input: { caseId: string; leadId: string; triggeringLeadId: string }): Promise<CollisionNoticeSummary>` where `CollisionNoticeSummary = { leadId: string; action: 'notified' | 'skipped' }`. Task 5 imports `triggerCollisionNotice`. Task 6 imports `runCollisionNotice` and `CollisionNoticeSummary`.

Note on the reserved `sequence_step`: regular cadence steps are non-negative integers assigned by `followup.ts`/`write.ts`. This feature reuses the existing `(lead_id, sequence_step, direction)` unique-index claim on `emails` (`claimOutboundEmail`) for send-once idempotency instead of inventing a new mechanism — a negative sentinel step (`-1`) can never collide with a real cadence step.

Note on `reply_mode`: this notice is a deterministic template, not an AI classification, so there is no confidence score to weigh. `human_approve` drafts, `auto_send` and `hybrid` both send immediately (a `hybrid` campaign would send anyway once confidence reaches 1, which is what a fully deterministic message represents). This is intentionally a local 2-line helper rather than importing `reply.ts`'s `replyDisposition` — importing it would create a circular import (`reply.ts` will import `triggerCollisionNotice` from this file in Task 5).

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pipeline/collision-notify.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const claimCollisionNoticeMock = vi.fn()
const listOtherActiveLeadsMock = vi.fn()
const publishJsonMock = vi.fn()
const isSequenceActiveForLeadMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const stopSequenceForLeadMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/cases', () => ({ claimCollisionNotice: (...a: unknown[]) => claimCollisionNoticeMock(...a) }))
vi.mock('@/lib/db/leads', () => ({
  listOtherActiveLeadsForCollisionNotice: (...a: unknown[]) => listOtherActiveLeadsMock(...a),
  getLeadById: (...a: unknown[]) => getLeadByIdMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({
  isSequenceActiveForLead: (...a: unknown[]) => isSequenceActiveForLeadMock(...a),
  stopSequenceForLead: (...a: unknown[]) => stopSequenceForLeadMock(...a),
}))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { triggerCollisionNotice, runCollisionNotice } from './collision-notify'
import { AppError } from '@/lib/errors/app-error'

beforeEach(() => {
  for (const m of [
    claimCollisionNoticeMock, listOtherActiveLeadsMock, publishJsonMock, isSequenceActiveForLeadMock,
    getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, claimOutboundEmailMock,
    markEmailSentMock, markEmailFailedMock, stopSequenceForLeadMock, sendViaMailboxMock, logEventMock,
  ]) m.mockReset()
})

describe('triggerCollisionNotice', () => {
  it('should no-op without querying leads when the case claim is already taken', async () => {
    claimCollisionNoticeMock.mockResolvedValue(false)
    await triggerCollisionNotice({} as never, 'case1', 'leadTrigger')
    expect(listOtherActiveLeadsMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should publish one QStash message per other active lead when it wins the claim', async () => {
    claimCollisionNoticeMock.mockResolvedValue(true)
    listOtherActiveLeadsMock.mockResolvedValue([{ id: 'leadA' }, { id: 'leadB' }])
    await triggerCollisionNotice({} as never, 'case1', 'leadTrigger')
    expect(publishJsonMock).toHaveBeenCalledTimes(2)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/collision-notify', {
      caseId: 'case1', leadId: 'leadA', triggeringLeadId: 'leadTrigger',
    })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/collision-notify', {
      caseId: 'case1', leadId: 'leadB', triggeringLeadId: 'leadTrigger',
    })
  })

  it('should not publish anything when there are no other active leads', async () => {
    claimCollisionNoticeMock.mockResolvedValue(true)
    listOtherActiveLeadsMock.mockResolvedValue([])
    await triggerCollisionNotice({} as never, 'case1', 'leadTrigger')
    expect(publishJsonMock).not.toHaveBeenCalled()
  })
})

const target = { id: 'leadTarget', client_id: 'c1', full_name: 'Jane Doe', email: 'jane@acme.com' }
const triggering = { id: 'leadTrigger', client_id: 'c1', full_name: 'Bob Smith', email: 'bob@acme.com' }
const campaign = { mailbox_ids: ['m1'], reply_mode: 'auto_send' }

describe('runCollisionNotice', () => {
  const input = { caseId: 'case1', leadId: 'leadTarget', triggeringLeadId: 'leadTrigger' }

  beforeEach(() => {
    isSequenceActiveForLeadMock.mockResolvedValue(true)
    getLeadByIdMock.mockImplementation((_s: unknown, id: string) => Promise.resolve(id === 'leadTarget' ? target : triggering))
    getCampaignForCaseMock.mockResolvedValue(campaign)
    listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea' }])
    claimOutboundEmailMock.mockResolvedValue({ id: 'email1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'p1', threadId: 't1' })
  })

  it('should skip when the target lead already replied for real (sequence no longer active)', async () => {
    isSequenceActiveForLeadMock.mockResolvedValue(false)
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
  })

  it('should skip without sending when the email slot is already claimed (duplicate QStash delivery)', async () => {
    claimOutboundEmailMock.mockResolvedValue(null)
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should send the notice, mark it sent, and stop the sequence on auto_send', async () => {
    const result = await runCollisionNotice({} as never, input)
    expect(sendViaMailboxMock).toHaveBeenCalledWith({}, expect.objectContaining({
      to: 'jane@acme.com', purpose: 'reply',
    }))
    expect(markEmailSentMock).toHaveBeenCalledWith({}, 'email1', {
      providerMessageId: 'p1', threadId: 't1', mailboxId: 'm1',
    })
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'leadTarget', 'stopped')
    expect(result).toEqual({ leadId: 'leadTarget', action: 'notified' })
  })

  it('should name the triggering contact in the notice body', async () => {
    await runCollisionNotice({} as never, input)
    const body = (claimOutboundEmailMock.mock.calls[0]![1] as { body: string }).body
    expect(body).toContain('Bob')
    expect(body).toContain('Jane')
  })

  it('should draft (not send) on human_approve and still stop the sequence', async () => {
    getCampaignForCaseMock.mockResolvedValue({ ...campaign, reply_mode: 'human_approve' })
    const result = await runCollisionNotice({} as never, input)
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'leadTarget', 'stopped')
    expect(result).toEqual({ leadId: 'leadTarget', action: 'notified' })
  })

  it('should rethrow RATE_LIMITED without stopping the sequence, so QStash retries', async () => {
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no healthy mailbox'))
    await expect(runCollisionNotice({} as never, input)).rejects.toBeInstanceOf(AppError)
    expect(stopSequenceForLeadMock).not.toHaveBeenCalled()
  })

  it('should mark the email failed and skip (no throw) on FORBIDDEN (suppressed address)', async () => {
    sendViaMailboxMock.mockRejectedValue(new AppError('FORBIDDEN', 'recipient suppressed'))
    const result = await runCollisionNotice({} as never, input)
    expect(markEmailFailedMock).toHaveBeenCalledWith({}, 'email1')
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
  })

  it('should skip when the target lead has no email', async () => {
    getLeadByIdMock.mockImplementation((_s: unknown, id: string) =>
      Promise.resolve(id === 'leadTarget' ? { ...target, email: null } : triggering))
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
  })

  it('should skip when the campaign cannot be found', async () => {
    getCampaignForCaseMock.mockResolvedValue(null)
    const result = await runCollisionNotice({} as never, input)
    expect(result).toEqual({ leadId: 'leadTarget', action: 'skipped' })
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/lib/pipeline/collision-notify.test.ts`
Expected: FAIL — the module `./collision-notify` does not exist yet.

- [ ] **Step 3: Implement `src/lib/pipeline/collision-notify.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { claimCollisionNotice } from '@/lib/db/cases'
import { listOtherActiveLeadsForCollisionNotice, getLeadById } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import {
  listThreadEmails, claimOutboundEmail, markEmailSent, markEmailFailed, type EmailRow,
} from '@/lib/db/emails'
import { isSequenceActiveForLead, stopSequenceForLead } from '@/lib/db/sequences'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'collision_notify'
// Regular cadence steps (followup.ts/write.ts) are 0..MAX_FOLLOWUP_STEP.
// A negative sentinel can never collide with a real step, so this notice
// gets its own slot in the existing (lead_id, sequence_step, direction)
// unique-index claim on `emails` instead of a new dedup mechanism.
const COLLISION_NOTICE_SEQUENCE_STEP = -1

export interface CollisionNoticeSummary {
  leadId: string
  action: 'notified' | 'skipped'
}

type ReplyMode = Database['public']['Enums']['reply_mode']

function firstName(fullName: string): string {
  return fullName.trim().split(/\s+/)[0] || fullName
}

function replySubject(thread: EmailRow[]): string {
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const base = firstOutbound?.subject ?? 'Re: your message'
  return base.startsWith('Re: ') ? base : `Re: ${base}`
}

function buildCollisionNoticeBody(targetFirstName: string, triggeringFirstName: string): string {
  return `Hi ${targetFirstName} — looks like ${triggeringFirstName} already grabbed time with us. `
    + `Happy to keep it to one call, or loop you in too if that'd be useful — just let us know either way!`
}

// Deterministic content, so there is no classification confidence to weigh —
// only human_approve needs a human in the loop.
function collisionDisposition(mode: ReplyMode): 'send' | 'draft' {
  return mode === 'human_approve' ? 'draft' : 'send'
}

// Called from reply.ts right after a case flips to hot_handoff. Fans one
// QStash message per other untouched contact at the same company so a slow
// or failing send to one contact can't block or duplicate another's notice.
export async function triggerCollisionNotice(
  supabase: SupabaseClient<Database>,
  caseId: string,
  triggeringLeadId: string,
): Promise<void> {
  const claimed = await claimCollisionNotice(supabase, caseId)
  if (!claimed) return // another contact at this company already fired the notice

  const others = await listOtherActiveLeadsForCollisionNotice(supabase, caseId, triggeringLeadId)
  for (const lead of others) {
    await publishJson('/api/pipeline/collision-notify', { caseId, leadId: lead.id, triggeringLeadId })
  }
}

// Per-contact worker, invoked by /api/pipeline/collision-notify. The
// isSequenceActiveForLead check is the business-logic guard (skip if they
// replied for real); claimOutboundEmail is the retry-safety guard (skip if
// this exact notice was already sent on a prior delivery of this message).
export async function runCollisionNotice(
  supabase: SupabaseClient<Database>,
  input: { caseId: string; leadId: string; triggeringLeadId: string },
): Promise<CollisionNoticeSummary> {
  const stillUntouched = await isSequenceActiveForLead(supabase, input.leadId)
  if (!stillUntouched) return { leadId: input.leadId, action: 'skipped' }

  const [lead, triggeringLead, campaign] = await Promise.all([
    getLeadById(supabase, input.leadId),
    getLeadById(supabase, input.triggeringLeadId),
    getCampaignForCase(supabase, input.caseId),
  ])
  if (!lead?.email || !triggeringLead || !campaign) {
    return { leadId: input.leadId, action: 'skipped' }
  }

  const thread = await listThreadEmails(supabase, input.leadId)
  const subject = replySubject(thread)
  const body = buildCollisionNoticeBody(firstName(lead.full_name), firstName(triggeringLead.full_name))
  const disposition = collisionDisposition(campaign.reply_mode)

  const claimed = await claimOutboundEmail(supabase, {
    client_id: lead.client_id,
    case_id: input.caseId,
    lead_id: lead.id,
    direction: 'outbound',
    sequence_step: COLLISION_NOTICE_SEQUENCE_STEP,
    subject,
    body,
    status: disposition === 'send' ? 'queued' : 'draft',
  })
  if (!claimed) return { leadId: input.leadId, action: 'skipped' } // already handled by a prior delivery

  if (disposition === 'send') {
    try {
      const sent = await sendViaMailbox(supabase, {
        clientId: lead.client_id,
        mailboxIds: campaign.mailbox_ids,
        to: lead.email,
        subject,
        body,
        purpose: 'reply',
      })
      await markEmailSent(supabase, claimed.id, {
        providerMessageId: sent.providerMessageId, threadId: sent.threadId, mailboxId: sent.mailboxId,
      })
    } catch (error) {
      // RATE_LIMITED is transient: leave the claimed row 'queued' and rethrow
      // so QStash retries the whole delivery, matching sendOrDraftReply.
      if (isAppError(error) && error.code === 'RATE_LIMITED') throw error
      await markEmailFailed(supabase, claimed.id)
      // FORBIDDEN means the address is hard-bounced/suppressed. Retrying
      // cannot help; stop here (the sequence is still stopped below) instead
      // of rethrowing into a QStash retry loop.
      if (isAppError(error) && error.code === 'FORBIDDEN') {
        await logEventSafe({
          clientId: lead.client_id, caseId: input.caseId, actor: ACTOR,
          type: 'reply.send_suppressed', payload: { emailId: claimed.id, leadId: lead.id },
        })
        return { leadId: input.leadId, action: 'skipped' }
      }
      throw error
    }
  }

  await stopSequenceForLead(supabase, input.leadId, 'stopped')
  await logEventSafe({
    clientId: lead.client_id, caseId: input.caseId, actor: ACTOR,
    type: 'case.collision_notified', payload: { leadId: lead.id, triggeringLeadId: input.triggeringLeadId },
  })
  return { leadId: input.leadId, action: 'notified' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/pipeline/collision-notify.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/collision-notify.ts src/lib/pipeline/collision-notify.test.ts
git commit -m "feat: add collision-notify pipeline (trigger + per-contact worker)"
```

---

### Task 5: Wire `triggerCollisionNotice` into `reply.ts`'s price branch

**Files:**
- Modify: `src/lib/pipeline/reply.ts`
- Test: `src/lib/pipeline/reply.test.ts`

**Interfaces:**
- Consumes: `triggerCollisionNotice(supabase, caseId, triggeringLeadId): Promise<void>` (Task 4, `@/lib/pipeline/collision-notify`).

- [ ] **Step 1: Write the failing test**

In `src/lib/pipeline/reply.test.ts`, add a mock for the new import near the other `vi.mock` calls:

```ts
const triggerCollisionNoticeMock = vi.fn()
vi.mock('@/lib/pipeline/collision-notify', () => ({
  triggerCollisionNotice: (...a: unknown[]) => triggerCollisionNoticeMock(...a),
}))
```

Add `triggerCollisionNoticeMock` to the `beforeEach` reset list, and add a new assertion inside the existing `'should hand off on price intent...'` test (in the `describe('runReplyForInbound', ...)` block):

```ts
  it('should hand off on price intent: reply, suppress, stop, hot_handoff', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'price', confidence: 0.8, canAnswer: false, missingQuestion: null, replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).toHaveBeenCalled() // booking-link reply
    expect(addSuppressionMock).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'price_handoff' }))
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'lead1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'hot_handoff')
    expect(triggerCollisionNoticeMock).toHaveBeenCalledWith({}, 'case1', 'lead1')
    expect(result.action).toBe('handoff')
  })
```

(This edits the existing test in place — everything else in that test file is unchanged.)

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/lib/pipeline/reply.test.ts`
Expected: FAIL — `triggerCollisionNoticeMock` was never called (function not wired up yet).

- [ ] **Step 3: Wire the call into `reply.ts`**

In `src/lib/pipeline/reply.ts`, add the import at the top:

```ts
import { triggerCollisionNotice } from '@/lib/pipeline/collision-notify'
```

In the `price` case of `runReplyForInbound`'s switch statement, add the call right after `updateCaseStatus(supabase, inbound.case_id, 'hot_handoff')`:

```ts
    case 'price': {
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: buildBookingReply(campaign.booking_link),
        disposition: replyDisposition(campaign.reply_mode, 1),
      })
      await addSuppression(supabase, { clientId: inbound.client_id, email: lead.email, reason: 'price_handoff' })
      await stopSequenceForLead(supabase, inbound.lead_id, 'stopped')
      await updateCaseStatus(supabase, inbound.case_id, 'hot_handoff')
      await triggerCollisionNotice(supabase, inbound.case_id, inbound.lead_id)
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.price_handoff', payload: { emailId: inbound.id, leadId: inbound.lead_id },
      })
      return { emailId: inbound.id, action: 'handoff' }
    }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/lib/pipeline/reply.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/reply.ts src/lib/pipeline/reply.test.ts
git commit -m "feat: fire collision notice from the Reply Agent's price-handoff branch"
```

---

### Task 6: `/api/pipeline/collision-notify` route

**Files:**
- Create: `src/app/api/pipeline/collision-notify/route.ts`
- Test: `src/app/api/pipeline/collision-notify/route.test.ts`

**Interfaces:**
- Consumes: `runCollisionNotice(supabase, input): Promise<CollisionNoticeSummary>` (Task 4, `@/lib/pipeline/collision-notify`); `verifyQstashSignature(request): Promise<string>` (existing, `@/lib/qstash/verify`); `createAdminClient()` (existing, `@/lib/supabase/admin`); `logError(input): Promise<void>` (existing, `@/lib/events/log-event`).

- [ ] **Step 1: Write the failing tests**

Create `src/app/api/pipeline/collision-notify/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const runCollisionNoticeMock = vi.fn()
const logErrorMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/collision-notify', () => ({
  runCollisionNotice: (...a: unknown[]) => runCollisionNoticeMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/collision-notify', { method: 'POST', body: JSON.stringify(body) })
}

const payload = { caseId: 'case1', leadId: 'lead1', triggeringLeadId: 'lead2' }

beforeEach(() => {
  for (const m of [verifyMock, runCollisionNoticeMock, logErrorMock]) m.mockReset()
  verifyMock.mockResolvedValue(JSON.stringify(payload))
})

describe('POST /api/pipeline/collision-notify', () => {
  it('should run the collision notice worker with the parsed payload', async () => {
    runCollisionNoticeMock.mockResolvedValue({ leadId: 'lead1', action: 'notified' })
    const res = await POST(req(payload))
    expect(res.status).toBe(200)
    expect(runCollisionNoticeMock).toHaveBeenCalledWith({}, payload)
  })

  it('should return 401 on invalid QStash signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req(payload))
    expect(res.status).toBe(401)
  })

  it('should return 400 on a malformed body', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ caseId: 'case1' }))
    const res = await POST(req({ caseId: 'case1' }))
    expect(res.status).toBe(400)
  })

  it('should return 400 on unparseable JSON', async () => {
    verifyMock.mockResolvedValue('not json')
    const res = await POST(req(payload))
    expect(res.status).toBe(400)
  })

  it('should log and return 500 when the worker throws', async () => {
    runCollisionNoticeMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req(payload))
    expect(res.status).toBe(500)
    expect(logErrorMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm test src/app/api/pipeline/collision-notify/route.test.ts`
Expected: FAIL — the route module does not exist yet.

- [ ] **Step 3: Implement the route**

Create `src/app/api/pipeline/collision-notify/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runCollisionNotice } from '@/lib/pipeline/collision-notify'
import { isAppError } from '@/lib/errors/app-error'
import { logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const bodySchema = z.object({
  caseId: z.string().uuid(),
  leadId: z.string().uuid(),
  triggeringLeadId: z.string().uuid(),
})

export async function POST(request: Request) {
  let payload: z.infer<typeof bodySchema> | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    payload = parsed.data
    const admin = createAdminClient()
    const summary = await runCollisionNotice(admin, payload)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: null,
      caseId: payload?.caseId ?? null,
      actor: 'system',
      type: 'pipeline.collision_notify.route_failed',
      source: 'pipeline',
      error,
      payload: { ...payload },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

(Unlike `/api/inbound/reply`'s error path, there is no cheap secondary lookup here to resolve `clientId` for the failure log — `runCollisionNotice` already resolves and logs its own successful-path events with the correct `clientId`; the route's failure log intentionally logs `clientId: null` with `caseId` for cross-referencing, exactly the same trade-off already accepted by `resolveSequenceClientId`/`resolveEmailClientId`'s fallback-to-null behavior in the sibling routes.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/api/pipeline/collision-notify/route.test.ts`
Expected: PASS

- [ ] **Step 5: Full-suite and typecheck sanity pass**

Run: `pnpm typecheck`
Expected: no errors.

Run: `pnpm test`
Expected: all tests pass, including every file touched in Tasks 1-6.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/collision-notify/route.ts src/app/api/pipeline/collision-notify/route.test.ts
git commit -m "feat: add /api/pipeline/collision-notify route"
```

---

## Spec Coverage Check

- Trigger tied to existing `price`-intent → `hot_handoff` (no Calendly dependency): Task 5. ✅
- Once-per-case atomic claim: Task 1 (`claimCollisionNotice`). ✅
- Only untouched (`active` sequence) other contacts notified: Task 3 (fan-out snapshot) + Task 4 (`isSequenceActiveForLead` fresh recheck). ✅
- Fan-out via QStash, one message per contact: Task 4 (`triggerCollisionNotice`) + Task 6 (route). ✅
- Follows campaign `reply_mode`: Task 4 (`collisionDisposition`). ✅
- Deterministic template naming the triggering contact: Task 4 (`buildCollisionNoticeBody`). ✅
- Terminal sequence stop, consistent with `not_interested`/`price` precedent: Task 4 (`stopSequenceForLead(..., 'stopped')`). ✅
- `case.collision_notified` event: Task 4. ✅
