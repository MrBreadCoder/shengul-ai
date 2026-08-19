# Cap-Blocked Send Waiting System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a send with content that already exists (generated, or client-approved) hits `RATE_LIMITED`, park it as-is in a new `'waiting'` email status and retry it unmodified later — never regenerate — across `auto_send`, `hybrid`, and `human_approve`, and across both first-touch and follow-up sends.

**Architecture:** New `email_status` value `'waiting'` marks "content committed, blocked by a transient mailbox condition, will auto-retry verbatim." Every `RATE_LIMITED` catch across `write.ts`, `approveDraft`, and `followup.ts` marks the row `'waiting'` instead of `'failed'`. A widened drain sweep (`resend-failed.ts`, existing but currently first-touch-only) resends any `'waiting'` outbound row — first-touch or follow-up — as-is, running on write-fanout's own 5-minute cadence so it competes for cap slots on roughly the same schedule as new work. A new `case_wait_reason` value, `'awaiting_resend'`, keeps a case's status honest without making it eligible for write-fanout's regenerating auto-retry.

**Tech Stack:** Next.js Server Actions, Supabase/PostgreSQL (via `@supabase/supabase-js`), Vitest, QStash (cron + delayed publish), next-intl.

**Spec:** [docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md](../specs/2026-08-19-cap-blocked-send-waiting-design.md)

## Global Constraints

- Client-approved content must never be altered after approval — a `RATE_LIMITED` retry always resends the exact stored subject/body, never regenerates via the LLM.
- `strict: true` TypeScript, no `any`, no `!` non-null assertion without a comment proving it's safe (use an `AppError('INVARIANT_VIOLATION', ...)` throw instead where a `!` would otherwise be needed).
- Every DB write returns/throws `AppError` — never a raw Supabase error.
- Every catch block handles, rethrows, or escalates — never swallows silently.
- `ALTER TYPE ... ADD VALUE` must be the only statement in its migration transaction (PG12+ restriction) — one enum value per file.
- Client-facing UI strings (`/inbox`) need matching keys in both `src/messages/en.json` and `src/messages/tr.json` — operator-only surfaces don't need translation.
- TDD throughout: write the failing test, watch it fail, implement, watch it pass. Run the full suite + `tsc --noEmit` + `eslint` before each commit.

---

## Task 1: Migrations and generated types

**Files:**
- Create: `supabase/migrations/0051_email_waiting_status.sql`
- Create: `supabase/migrations/0052_case_awaiting_resend_reason.sql`
- Modify: `src/types/database.ts`

**Interfaces:**
- Produces: `email_status` enum gains `'waiting'`; `case_wait_reason` enum gains `'awaiting_resend'`. Every later task depends on both.

- [ ] **Step 1: Write the first migration**

```sql
-- supabase/migrations/0051_email_waiting_status.sql

-- New email_status value: content already exists on the row (generated, or
-- client-approved), a real send was attempted and hit RATE_LIMITED, and it
-- will be retried as-is by the drain sweep (src/lib/pipeline/resend-failed.ts)
-- rather than regenerated. Distinct from 'failed', which is now reserved for
-- a genuine, non-auto-retryable delivery error. See
-- docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md.
--
-- ALTER TYPE ... ADD VALUE cannot share a transaction with anything that
-- references the new value (PG12+) — this file does nothing else, same
-- lesson as migration 0049's split (see .claude/roadmap.md 2026-08-19).
alter type email_status add value if not exists 'waiting' after 'queued';
```

- [ ] **Step 2: Write the second migration**

```sql
-- supabase/migrations/0052_case_awaiting_resend_reason.sql

-- New case_wait_reason value: this case has at least one lead whose
-- first-touch content already exists and is parked at the email level in
-- 'waiting' (see 0051). It clears when the drain sweep sends it, never by
-- regenerating — deliberately excluded from AUTO_RETRY_WAIT_REASONS
-- (src/lib/db/cases.ts) so write-fanout's cron never reclaims a case for
-- fresh writing over this.
--
-- Separate file/transaction from 0051 for the same ADD VALUE restriction.
alter type case_wait_reason add value if not exists 'awaiting_resend';
```

- [ ] **Step 3: Apply both migrations locally**

Run: `npx supabase db push`
Expected: both migrations apply with no errors.

- [ ] **Step 4: Update generated types**

In `src/types/database.ts`, find the `Enums` block (`email_status: 'draft' | 'queued' | 'sent' | 'delivered' | 'bounced' | 'failed'`) and widen it:

```ts
email_status: 'draft' | 'queued' | 'sent' | 'waiting' | 'delivered' | 'bounced' | 'failed'
```

Find `case_wait_reason` and add the new value (matching the order used in the 2026-08-17 design's own migration — after the three auto-retry reasons, before or after the two manual ones is fine; keep it adjacent to `'awaiting_manual_approval'` since they're conceptually related):

```ts
case_wait_reason:
  | 'mailreach_gate'
  | 'daily_cap'
  | 'no_healthy_mailbox'
  | 'awaiting_manual_approval'
  | 'awaiting_resend'
  | 'no_viable_leads'
```

(If the project has a codegen command for this file instead of hand-editing — check for a `supabase gen types` script in `package.json` — run that instead and confirm the diff matches the above.)

- [ ] **Step 5: Verify the type change compiles**

Run: `npx tsc --noEmit`
Expected: no new errors (nothing references either new enum value yet).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0051_email_waiting_status.sql supabase/migrations/0052_case_awaiting_resend_reason.sql src/types/database.ts
git commit -m "feat(db): add email 'waiting' status and case 'awaiting_resend' wait reason"
```

---

## Task 2: `lib/db/emails.ts` primitives

**Files:**
- Modify: `src/lib/db/emails.ts`
- Modify: `src/lib/db/emails.test.ts`

**Interfaces:**
- Consumes: `email_status` enum with `'waiting'` (Task 1).
- Produces:
  - `markEmailWaiting(supabase, id): Promise<void>`
  - `listWaitingLeadIds(supabase, caseId): Promise<Set<string>>`
  - `listWaitingOutboundEmails(supabase, limit): Promise<EmailRow[]>` (replaces `listFailedFirstTouchEmails`)
  - `claimWaitingOutboundEmail(supabase, id): Promise<EmailRow | null>`
  These are consumed by Tasks 4, 5, 7, 8.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/db/emails.test.ts`. First, extend the import list at the top of the file:

```ts
import {
  claimOutboundEmail,
  insertManualEmail,
  claimDraftForSend,
  updateDraftContent,
  markEmailSent,
  markEmailFailed,
  markEmailWaiting,
  listThreadEmails,
  hasInboundReply,
  hasReplyForInbound,
  listDraftEmailsForClient,
  getEmailById,
  insertInboundEmail,
  claimReplyEmail,
  markLatestOutboundBounced,
  listWaitingOutboundEmails,
  listWaitingLeadIds,
  claimWaitingOutboundEmail,
} from './emails'
```

Replace the `describe('listFailedFirstTouchEmails', ...)` block with:

```ts
describe('listWaitingOutboundEmails', () => {
  it('should return rows when the query succeeds', async () => {
    const rows = [{ id: 'e1', status: 'waiting', sequence_step: 0 }]
    const result = await listWaitingOutboundEmails(mockFailedList({ data: rows, error: null }), 50)
    expect(result).toEqual(rows)
  })

  it('should return rows for a follow-up step too — no step filter', async () => {
    const rows = [{ id: 'e2', status: 'waiting', sequence_step: 2 }]
    const result = await listWaitingOutboundEmails(mockFailedList({ data: rows, error: null }), 50)
    expect(result).toEqual(rows)
  })

  it('should return an empty array when nothing is waiting', async () => {
    const result = await listWaitingOutboundEmails(mockFailedList({ data: [], error: null }), 50)
    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listWaitingOutboundEmails(mockFailedList({ data: null, error: { message: 'boom' } }), 50),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markEmailWaiting', () => {
  it('should resolve when the update succeeds', async () => {
    await expect(markEmailWaiting(mockUpdate({ error: null }), 'e1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      markEmailWaiting(mockUpdate({ error: { message: 'boom' } }), 'e1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

function mockLeadIdList(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('listWaitingLeadIds', () => {
  it('should return a set of distinct lead ids with a waiting step-0 row', async () => {
    const result = await listWaitingLeadIds(
      mockLeadIdList({ data: [{ lead_id: 'lead1' }, { lead_id: 'lead2' }], error: null }),
      'case1',
    )
    expect(result).toEqual(new Set(['lead1', 'lead2']))
  })

  it('should return an empty set when nothing is waiting', async () => {
    const result = await listWaitingLeadIds(mockLeadIdList({ data: [], error: null }), 'case1')
    expect(result).toEqual(new Set())
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listWaitingLeadIds(mockLeadIdList({ data: null, error: { message: 'boom' } }), 'case1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimWaitingOutboundEmail', () => {
  it('should return the claimed row when the update matches a waiting email', async () => {
    const row = { id: 'e1', status: 'queued' }
    const result = await claimWaitingOutboundEmail(mockClaimDraft({ data: [row], error: null }), 'e1')
    expect(result).toEqual(row)
  })

  it('should return null when no row matches (already claimed, or not waiting)', async () => {
    const result = await claimWaitingOutboundEmail(mockClaimDraft({ data: [], error: null }), 'e1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      claimWaitingOutboundEmail(mockClaimDraft({ data: null, error: { message: 'boom' } }), 'e1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

(`mockFailedList` and `mockClaimDraft` already exist in this file — `mockFailedList` backs the current `listFailedFirstTouchEmails` tests being replaced, `mockClaimDraft` backs `claimDraftForSend`'s tests just above. `mockUpdate` also already exists, used by `markEmailFailed`'s tests.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/db/emails.test.ts`
Expected: FAIL — `markEmailWaiting`, `listWaitingLeadIds`, `listWaitingOutboundEmails`, `claimWaitingOutboundEmail` are not exported from `./emails`.

- [ ] **Step 3: Implement**

In `src/lib/db/emails.ts`, replace `listFailedFirstTouchEmails` (currently querying `status='failed', sequence_step=0`) with:

```ts
// Every 'waiting' outbound row, oldest first — first-touch and follow-up
// steps alike (no sequence_step filter). Drives the drain sweep
// (lib/pipeline/resend-failed.ts): each row's content is resent verbatim,
// never regenerated. Oldest-first ordering is what gives already-committed
// content priority over the same day's brand-new work once the cap resets.
export async function listWaitingOutboundEmails(
  supabase: SupabaseClient<Database>,
  limit: number,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('status', 'waiting')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list waiting outbound emails', { cause: error.message })
  }
  return data ?? []
}
```

Add `markEmailWaiting` directly below `markEmailFailed`:

```ts
export async function markEmailWaiting(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('emails').update({ status: 'waiting' }).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email waiting', { id, cause: error.message })
  }
}
```

Add `listWaitingLeadIds` near `listWaitingOutboundEmails`:

```ts
// Distinct leads on a case whose first-touch already has real content
// parked 'waiting' — lets runWriteForCase (write.ts) skip calling the LLM
// again for a lead the drain sweep already owns, instead of generating a
// fresh draft that would just get discarded when the claim no-ops.
export async function listWaitingLeadIds(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('emails')
    .select('lead_id')
    .eq('case_id', caseId)
    .eq('sequence_step', 0)
    .eq('status', 'waiting')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list waiting lead ids', { caseId, cause: error.message })
  }
  return new Set((data ?? []).flatMap((row) => (row.lead_id ? [row.lead_id] : [])))
}
```

Add `claimWaitingOutboundEmail` near `claimDraftForSend` (same atomic-claim shape, different source status):

```ts
// Reclaims a specific 'waiting' row for the drain sweep — resend-failed.ts
// only, never the generation paths. The `.eq('status', 'waiting')` guard
// makes this atomic (only one concurrent sweep tick can win a given row) and
// is also the reason this is a SEPARATE function from
// reclaimFailedOutboundEmail rather than a widened version of it:
// claimOutboundEmail's reclaim must keep matching 'failed' only, so a
// 'waiting' row stays invisible to the generation paths (processLead,
// runFollowupStep) — that's what stops a mistaken re-dispatch from
// overwriting already-committed content. See markEmailWaiting's callers.
export async function claimWaitingOutboundEmail(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .update({ status: 'queued' })
    .eq('id', id)
    .eq('status', 'waiting')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim waiting outbound email', { id, cause: error.message })
  }
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/db/emails.test.ts`
Expected: PASS, all tests including the four new/renamed describe blocks.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/db/emails.ts src/lib/db/emails.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts
git commit -m "feat(db): add waiting-email primitives, replace listFailedFirstTouchEmails"
```

---

## Task 3: `lib/db/sequences.ts` — `getSequenceByLeadId`

**Files:**
- Modify: `src/lib/db/sequences.ts`
- Modify: `src/lib/db/sequences.test.ts`

**Interfaces:**
- Produces: `getSequenceByLeadId(supabase, leadId): Promise<SequenceRow | null>`, consumed by Task 8.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db/sequences.test.ts` (follow the file's existing mock-builder pattern for a `.select().eq().eq().maybeSingle()` chain — check the top of the file for the helper already used by `getSequenceById`, e.g. a `mockSingle`-style function, and reuse/extend it):

```ts
describe('getSequenceByLeadId', () => {
  it('should return the active sequence for the lead when one exists', async () => {
    const row = { id: 'seq1', lead_id: 'lead1', state: 'active' }
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
      }),
    } as never
    const result = await getSequenceByLeadId(supabase, 'lead1')
    expect(result).toEqual(row)
  })

  it('should return null when the lead has no active sequence', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
      }),
    } as never
    const result = await getSequenceByLeadId(supabase, 'lead1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(getSequenceByLeadId(supabase, 'lead1')).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `getSequenceByLeadId` to the existing import list at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/sequences.test.ts`
Expected: FAIL — `getSequenceByLeadId` is not exported from `./sequences`.

- [ ] **Step 3: Implement**

In `src/lib/db/sequences.ts`, add below `getSequenceById`:

```ts
// The single active sequence for a lead — every other lookup in this file is
// id- or case-scoped. Used by the drain sweep (resend-failed.ts) to resume a
// follow-up step's cadence bookkeeping after resending its content as-is.
export async function getSequenceByLeadId(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<SequenceRow | null> {
  const { data, error } = await supabase
    .from('sequences')
    .select('*')
    .eq('lead_id', leadId)
    .eq('state', 'active')
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load sequence by lead', { leadId, cause: error.message })
  }
  return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/db/sequences.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/db/sequences.ts src/lib/db/sequences.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/sequences.ts src/lib/db/sequences.test.ts
git commit -m "feat(db): add getSequenceByLeadId"
```

---

## Task 4: `write.ts` — no regeneration on a same-tick cap race

**Files:**
- Modify: `src/lib/pipeline/write.ts`
- Modify: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `markEmailWaiting`, `listWaitingLeadIds` (Task 2).
- Produces: `processLead` return type `'sent' | 'drafted' | 'skipped' | 'waiting'` (was `'rate_limited'`); `runWriteForCase` sets case `wait_reason: 'awaiting_resend'` instead of re-checking eligibility on a `RATE_LIMITED` outcome.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pipeline/write.test.ts`, add `markEmailWaitingMock` and `listWaitingLeadIdsMock` to the mock declarations and the `@/lib/db/emails` mock:

```ts
const markEmailWaitingMock = vi.fn()
const listWaitingLeadIdsMock = vi.fn()
```

```ts
vi.mock('@/lib/db/emails', () => ({
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  markEmailWaiting: (...a: unknown[]) => markEmailWaitingMock(...a),
  listWaitingLeadIds: (...a: unknown[]) => listWaitingLeadIdsMock(...a),
}))
```

In the `beforeEach` that resets mocks, add both to the reset list, and default `listWaitingLeadIdsMock` to an empty set (so existing tests that don't care about this pre-filter are unaffected):

```ts
listWaitingLeadIdsMock.mockResolvedValue(new Set())
```

Replace the test `'should mark the email failed, skip, and mark the case waiting with an auto-retry reason when every mailbox is rate limited'` with:

```ts
it('should mark the email waiting (not failed) and flag the case awaiting_resend when the send is rate limited', async () => {
  const { AppError } = await import('@/lib/errors/app-error')
  listActiveLeadsMock.mockResolvedValue([lead])
  claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
  sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no mailbox available'))

  const result = await runWriteForCase({} as never, input)
  expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
  expect(markEmailWaitingMock).toHaveBeenCalledWith(expect.anything(), 'e1')
  expect(markEmailFailedMock).not.toHaveBeenCalled()
  expect(markEmailSentMock).not.toHaveBeenCalled()
  // Never regenerates: the content-preserving drain sweep owns the retry
  // from here, not another eligibility recheck + a fresh runWriteForCase pass.
  expect(getOutreachEligibilityMock).toHaveBeenCalledTimes(1)
  expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'awaiting_resend')
  expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'contacted')
})
```

Delete the test `'should send the same claimed email on a later eligible tick after being rate limited'` entirely — under the new design, a case flagged `awaiting_resend` is deliberately excluded from `AUTO_RETRY_WAIT_REASONS`, so write-fanout never re-dispatches it into `runWriteForCase` again; the equivalent retry now happens through the drain sweep, covered by `resend-failed.test.ts` (Task 8) instead.

Add a new test for the per-lead pre-filter, near the other `listActiveLeadsMock`-based tests:

```ts
it('should skip a lead that already has waiting content without calling the LLM', async () => {
  listActiveLeadsMock.mockResolvedValue([lead])
  listWaitingLeadIdsMock.mockResolvedValue(new Set(['lead1']))

  const result = await runWriteForCase({} as never, input)
  expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
  expect(generateJsonMock).not.toHaveBeenCalled()
  expect(claimOutboundEmailMock).not.toHaveBeenCalled()
  expect(updateCaseWaitingMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'awaiting_resend')
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/pipeline/write.test.ts`
Expected: FAIL — `markEmailWaiting`/`listWaitingLeadIds` not mocked/imported by production code yet, assertions on `awaiting_resend` fail against current `daily_cap` behavior.

- [ ] **Step 3: Implement**

In `src/lib/pipeline/write.ts`, update the import from `@/lib/db/emails`:

```ts
import { claimOutboundEmail, markEmailSent, markEmailFailed, markEmailWaiting, listWaitingLeadIds } from '@/lib/db/emails'
```

Change `processLead`'s return type and catch block:

```ts
async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  client: ClientRow | null,
): Promise<'sent' | 'drafted' | 'skipped' | 'waiting'> {
```

```ts
  } catch (error) {
    // A RATE_LIMITED failure means content already exists on this row but
    // couldn't send this instant — park it as-is for the drain sweep
    // (lib/pipeline/resend-failed.ts), never regenerate. Any other error
    // means the send is genuinely broken.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await markEmailWaiting(supabase, claimed.id)
      return 'waiting'
    }
    await markEmailFailed(supabase, claimed.id)
    throw error
  }
```

In `runWriteForCase`, add the pre-filter and update the counting/decision:

```ts
  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)
  const waitingLeadIds = await listWaitingLeadIds(supabase, input.caseId)

  let sent = 0
  let drafted = 0
  let waiting = 0
  for (const lead of leads) {
    // Content already exists and is parked for the drain sweep — skip the
    // LLM call entirely rather than generating a draft whose claim will
    // just no-op against the row the sweep owns.
    if (waitingLeadIds.has(lead.id)) {
      waiting += 1
      continue
    }
    const leadKnowledge = knowledge.filter((k) => (k.lead_id ?? null) === null || k.lead_id === lead.id)
    const outcome = await processLead(supabase, input, lead, leadKnowledge, client)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
    if (outcome === 'waiting') waiting += 1
  }

  if (sent > 0) {
    await updateCaseStatus(supabase, input.caseId, 'contacted')
    await enqueueCrmSync(input.caseId, 'contacted')
  } else if (drafted > 0) {
    await updateCaseWaiting(supabase, input.caseId, 'awaiting_manual_approval')
  } else if (waiting > 0) {
    // At least one lead's content is already committed and parked — the
    // drain sweep (not another write-fanout pass) is what sends it. Not in
    // AUTO_RETRY_WAIT_REASONS, so write-fanout never re-dispatches this case
    // over it.
    await updateCaseWaiting(supabase, input.caseId, 'awaiting_resend')
  } else {
    await updateCaseWaiting(supabase, input.caseId, 'no_viable_leads')
  }
```

Delete the now-unused post-loop `rateLimited` re-check block (the `else if (rateLimited > 0) { const recheck = await getOutreachEligibility(...); ... }` branch) entirely — replaced by the `waiting > 0` branch above.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/pipeline/write.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "fix(pipeline): never regenerate write content lost to a same-tick cap race"
```

---

## Task 5: `approveDraft` — no regeneration, honest return value

**Files:**
- Modify: `src/app/(app)/inbox/actions.ts`
- Modify: `src/app/(app)/inbox/actions.test.ts`

**Interfaces:**
- Consumes: `markEmailWaiting` (Task 2).
- Produces: `approveDraft(formData): Promise<{ status: 'sent' | 'waiting' }>` (was `Promise<void>`) — consumed by Task 6.

- [ ] **Step 1: Write the failing tests**

In `src/app/(app)/inbox/actions.test.ts`, add `markEmailWaitingMock` to the mock declarations and the `@/lib/db/emails` mock:

```ts
const markEmailWaitingMock = vi.fn()
```

```ts
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  claimDraftForSend: (...a: unknown[]) => claimDraftForSendMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  markEmailWaiting: (...a: unknown[]) => markEmailWaitingMock(...a),
  hasReplyForInbound: (...a: unknown[]) => hasReplyForInboundMock(...a),
  updateDraftContent: (...a: unknown[]) => updateDraftContentRowMock(...a),
}))
```

Add `markEmailWaitingMock` to the `beforeEach` reset list.

Replace the five RATE_LIMITED-focused tests (`'should flag the case with the real reason...'`, `'should flag the case with mailreach_gate...'`, `'should fall back to daily_cap...'`, `'should not touch the case wait_reason for a non-RATE_LIMITED send failure'`, `'should still rethrow the original RATE_LIMITED error when marking the case waiting itself throws'`) with:

```ts
// Regression test: a RATE_LIMITED approval used to mark the email failed and
// rethrow, then rely on write-fanout's regenerating auto-retry to pick the
// case back up — silently discarding the client's approved wording. Now it
// parks the approved content as-is and returns normally: the approval
// itself succeeded, only the send is delayed. See .claude/roadmap.md
// 2026-08-19 and docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md.
it('should mark the email waiting, flag the case awaiting_resend, and resolve (not throw) when approval hits the cap', async () => {
  getEmailByIdMock.mockResolvedValue(draftEmail())
  sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'All mailboxes at daily cap', {}))

  await expect(approveDraft(fd(EMAIL_ID))).resolves.toEqual({ status: 'waiting' })

  expect(markEmailWaitingMock).toHaveBeenCalledWith({}, EMAIL_ID)
  expect(markEmailFailedMock).not.toHaveBeenCalled()
  expect(updateCaseWaitingMock).toHaveBeenCalledWith({}, 'case1', 'awaiting_resend')
  expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
})

it('should not touch the case wait_reason for a non-RATE_LIMITED send failure', async () => {
  getEmailByIdMock.mockResolvedValue(draftEmail())
  sendViaMailboxMock.mockRejectedValue(new Error('smtp down'))

  await expect(approveDraft(fd(EMAIL_ID))).rejects.toBeTruthy()

  expect(updateCaseWaitingMock).not.toHaveBeenCalled()
  expect(markEmailWaitingMock).not.toHaveBeenCalled()
  expect(markEmailFailedMock).toHaveBeenCalledWith({}, EMAIL_ID)
})

it('should still resolve waiting when marking the case waiting itself throws', async () => {
  getEmailByIdMock.mockResolvedValue(draftEmail())
  sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'All mailboxes at daily cap', {}))
  updateCaseWaitingMock.mockRejectedValue(new Error('db down'))

  await expect(approveDraft(fd(EMAIL_ID))).resolves.toEqual({ status: 'waiting' })

  expect(logEventSafeMock).toHaveBeenCalledWith(
    expect.objectContaining({ type: 'inbox.mark_waiting_failed' }),
  )
  expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
})

it('should still resolve waiting when marking the email waiting itself throws', async () => {
  getEmailByIdMock.mockResolvedValue(draftEmail())
  sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'All mailboxes at daily cap', {}))
  markEmailWaitingMock.mockRejectedValue(new Error('db down'))

  await expect(approveDraft(fd(EMAIL_ID))).resolves.toEqual({ status: 'waiting' })
  expect(updateCaseWaitingMock).toHaveBeenCalledWith({}, 'case1', 'awaiting_resend')
})
```

`getClientByIdMock` and `getOutreachEligibilityMock` are no longer used by `approveDraft` after this change — leave their `vi.fn()` declarations and mocks in place only if other tests in the file still reference them; otherwise remove the now-dead mocks and their `vi.mock` entries to keep the file honest. (Check first: `grep -n "getClientByIdMock\|getOutreachEligibilityMock" src/app/\(app\)/inbox/actions.test.ts` — if no remaining references outside what you just deleted, remove them.)

Update the existing success-path test(s) that currently assert `approveDraft(...)` resolves to `undefined` — change to `.resolves.toEqual({ status: 'sent' })`. (Search the file for `.resolves.toBeUndefined()` on `approveDraft(...)` calls specifically — there is at least one in the concurrent-claim-loses-the-race test near the top of the RATE_LIMITED block, and the main happy-path test earlier in the file.)

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run "src/app/(app)/inbox/actions.test.ts"`
Expected: FAIL — `approveDraft` still throws on `RATE_LIMITED` and returns `undefined` on success.

- [ ] **Step 3: Implement**

In `src/app/(app)/inbox/actions.ts`, add `markEmailWaiting` to the `@/lib/db/emails` import, and remove the now-unused `getOutreachEligibility`/`getClientById` imports if `approveDraft` was their only caller in this file (check first — `getClientById` may still be used elsewhere in the file; if so keep it, only drop what's genuinely unused).

Change the function signature:

```ts
export async function approveDraft(formData: FormData): Promise<{ status: 'sent' | 'waiting' }> {
```

Update the early-return branch (concurrent claim already taken):

```ts
  const claimed = await claimDraftForSend(supabase, email.id)
  if (!claimed) {
    revalidatePath('/inbox')
    return { status: 'sent' }
  }
```

Replace the catch block:

```ts
  } catch (error) {
    if (isAppError(error) && error.code === 'RATE_LIMITED') {
      // Content already exists (this is an approved draft) — park it as-is
      // for the drain sweep, never regenerate. The approval itself
      // succeeded; only the send is delayed. See .claude/roadmap.md
      // 2026-08-19 and the 2026-08-19 cap-blocked-send-waiting-design spec.
      try {
        await markEmailWaiting(supabase, email.id)
      } catch {
        // Best-effort status write; the case flag below is still worth trying.
      }
      try {
        await updateCaseWaiting(supabase, email.case_id, 'awaiting_resend')
      } catch (waitError) {
        await logEventSafe({
          clientId: email.client_id,
          caseId: email.case_id,
          actor: 'inbox_approve_draft',
          type: 'inbox.mark_waiting_failed',
          payload: { emailId: email.id, cause: waitError instanceof Error ? waitError.message : String(waitError) },
        })
      }
      revalidatePath('/inbox')
      return { status: 'waiting' }
    }
    try {
      await markEmailFailed(supabase, email.id)
    } catch {
      // Best-effort status write; the send error below is the one that matters.
    }
    revalidatePath('/inbox')
    throw error
  }
```

At the very end of the function, after the existing `revalidatePath('/inbox')` that follows the `FIRST_TOUCH_STEP` bookkeeping block:

```ts
  revalidatePath('/inbox')
  return { status: 'sent' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run "src/app/(app)/inbox/actions.test.ts"`
Expected: PASS.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/inbox/actions.ts" "src/app/(app)/inbox/actions.test.ts"`
Expected: clean. (`tsc` will also surface the `draft-row.tsx` call site as a now-stale `await approveDraft(formData)` with an unused return value — that's expected until Task 6; it's not a type error since discarding a return value is legal, so this should not actually fail `tsc`. Confirm it doesn't before moving on.)

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/inbox/actions.ts" "src/app/(app)/inbox/actions.test.ts"
git commit -m "fix(inbox): never regenerate an approved draft lost to the daily cap"
```

---

## Task 6: `/inbox` client-facing UX — honest toast on a parked approval

**Files:**
- Modify: `src/app/(app)/inbox/draft-row.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/tr.json`

**Interfaces:**
- Consumes: `approveDraft(formData): Promise<{ status: 'sent' | 'waiting' }>` (Task 5).

- [ ] **Step 1: Add the new translation keys**

In `src/messages/en.json`, inside the `inbox.draftRow` object, alongside the existing `toastEmailSent`/`toastSendFailed` keys:

```json
"toastApprovedWaiting": "Approved — will send automatically once today's sending limit resets",
```

In `src/messages/tr.json`, same location:

```json
"toastApprovedWaiting": "Onaylandı — bugünkü gönderim sınırı sıfırlandığında otomatik olarak gönderilecek",
```

- [ ] **Step 2: Update `onApprove` in `draft-row.tsx`**

Replace:

```ts
  const onApprove = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    startTransition(async () => {
      try {
        await approveDraft(formData)
        setIsSent(true)
        toast.success(t('draftRow.toastEmailSent'), { description: t('draftRow.toastSentToPrefix', { companyName }) })
      } catch (error) {
        // The Server Action already logged the cause; the operator needs to
        // know the send did not happen and the draft is still theirs to retry.
        toast.error(t('draftRow.toastSendFailed'), {
          description: error instanceof Error ? error.message : t('draftRow.toastPleaseRetry'),
        })
      }
    })
  }
```

with:

```ts
  const onApprove = (): void => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    startTransition(async () => {
      try {
        const result = await approveDraft(formData)
        setIsSent(true)
        if (result.status === 'waiting') {
          // The approval succeeded — content is locked in and will be
          // resent as-is once today's cap resets. Not an error: no retry
          // needed from the client, nothing to redo.
          toast.success(t('draftRow.toastApprovedWaiting'))
        } else {
          toast.success(t('draftRow.toastEmailSent'), { description: t('draftRow.toastSentToPrefix', { companyName }) })
        }
      } catch (error) {
        // The Server Action already logged the cause; the operator needs to
        // know the send did not happen and the draft is still theirs to retry.
        toast.error(t('draftRow.toastSendFailed'), {
          description: error instanceof Error ? error.message : t('draftRow.toastPleaseRetry'),
        })
      }
    })
  }
```

- [ ] **Step 3: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint "src/app/(app)/inbox/draft-row.tsx"`
Expected: clean.

- [ ] **Step 4: Manual verification**

No existing test harness covers this component (no `@testing-library/react` usage anywhere in the repo — component tests are out of pattern here per `QUALITY.md`'s "React components: critical paths only" combined with no established tool for it). Verify manually: run the dev server, approve a draft against a mailbox already at its daily cap (or temporarily lower a test mailbox's `daily_cap` to 0), confirm the new toast text appears instead of an error toast, and confirm the row still visually marks itself approved (`isSent` state).

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/inbox/draft-row.tsx" src/messages/en.json src/messages/tr.json
git commit -m "feat(inbox): show an honest toast when an approval is parked, not failed"
```

---

## Task 7: `followup.ts` — close the worst-off gap

**Files:**
- Modify: `src/lib/pipeline/followup.ts`
- Modify: `src/lib/pipeline/followup.test.ts`

**Interfaces:**
- Consumes: `markEmailWaiting` (Task 2).
- Produces: `runFollowupStep`'s `RATE_LIMITED` catch marks the row `'waiting'` instead of `'failed'`, with no reschedule (the drain sweep owns the retry). `DAY_SECONDS` becomes an exported constant, consumed by Task 8.

- [ ] **Step 1: Write the failing test**

In `src/lib/pipeline/followup.test.ts`, add `markEmailWaitingMock` to the mock declarations and the `@/lib/db/emails` mock:

```ts
const markEmailWaitingMock = vi.fn()
```

```ts
vi.mock('@/lib/db/emails', () => ({
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  markEmailWaiting: (...a: unknown[]) => markEmailWaitingMock(...a),
}))
```

Add it to the `beforeEach` reset list, and replace the test `'should mark the email failed and return skipped when every mailbox is rate limited'` with:

```ts
it('should mark the email waiting (not failed), return skipped, and not reschedule when every mailbox is rate limited', async () => {
  const { AppError } = await import('@/lib/errors/app-error')
  claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
  sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no mailbox available'))
  const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
  expect(result.action).toBe('skipped')
  expect(markEmailWaitingMock).toHaveBeenCalledWith(expect.anything(), 'e2')
  expect(markEmailFailedMock).not.toHaveBeenCalled()
  expect(markEmailSentMock).not.toHaveBeenCalled()
  // Unlike the paused-campaign branch, a rate-limited step is never
  // rescheduled through QStash — the drain sweep (resend-failed.ts) is what
  // retries it, off the row's 'waiting' status, not a republished message.
  expect(publishDelayMock).not.toHaveBeenCalled()
  expect(advanceSequenceMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipeline/followup.test.ts`
Expected: FAIL — current code calls `markEmailFailed`, not `markEmailWaiting`.

- [ ] **Step 3: Implement**

In `src/lib/pipeline/followup.ts`:

1. Export `DAY_SECONDS` (currently a private `const`):

```ts
export const DAY_SECONDS = 86_400
```

2. Add `markEmailWaiting` to the `@/lib/db/emails` import:

```ts
import {
  hasInboundReply,
  listThreadEmails,
  claimOutboundEmail,
  markEmailSent,
  markEmailFailed,
  markEmailWaiting,
} from '@/lib/db/emails'
```

3. Replace the `RATE_LIMITED` catch:

```ts
  } catch (error) {
    // Content already exists on this row (the nudge was already written) —
    // park it as-is for the drain sweep, never regenerate, and never
    // reschedule through QStash: unlike the paused-campaign branch above,
    // there is no "try again in a day" here. The row's 'waiting' status is
    // what the drain sweep (lib/pipeline/resend-failed.ts) polls for.
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      await markEmailWaiting(supabase, claimed.id)
      return { sequenceId: sequence.id, action: 'skipped' }
    }
    await markEmailFailed(supabase, claimed.id)
    throw error
  }
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipeline/followup.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts
git commit -m "fix(pipeline): stop losing cap-blocked follow-up steps forever"
```

---

## Task 8: `resend-failed.ts` — widen the drain sweep to all waiting content

**Files:**
- Modify: `src/lib/pipeline/resend-failed.ts`
- Modify: `src/lib/pipeline/resend-failed.test.ts`

**Interfaces:**
- Consumes: `listWaitingOutboundEmails`, `claimWaitingOutboundEmail`, `markEmailWaiting`, `hasInboundReply`, `listThreadEmails` (Task 2); `getSequenceByLeadId` (Task 3); `FIRST_TOUCH_STEP`, `DAY_SECONDS`, `scheduleFirstFollowup` (Task 7, `followup.ts`); `advanceSequence`, `stopSequence` (`@/lib/db/sequences`, pre-existing).
- Produces: `sweepFailedFirstTouch(supabase, limit): Promise<ResendResult[]>` now resends every `'waiting'` outbound row, first-touch and follow-up alike — same exported name/shape as today (per the spec's decision not to rename the file/exports).

- [ ] **Step 1: Write the failing tests**

Rewrite `src/lib/pipeline/resend-failed.test.ts`'s mock setup and fixtures. Replace the whole top of the file (imports through the `failedEmail` helper) with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const listWaitingOutboundEmailsMock = vi.fn()
const claimWaitingOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const markEmailWaitingMock = vi.fn()
const hasInboundReplyMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const scheduleFirstFollowupMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const logEventSafeMock = vi.fn()
const getSequenceByLeadIdMock = vi.fn()
const advanceSequenceMock = vi.fn()
const stopSequenceMock = vi.fn()
const publishDelayMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  listWaitingOutboundEmails: (...a: unknown[]) => listWaitingOutboundEmailsMock(...a),
  claimWaitingOutboundEmail: (...a: unknown[]) => claimWaitingOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
  markEmailWaiting: (...a: unknown[]) => markEmailWaitingMock(...a),
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('./followup', () => ({
  FIRST_TOUCH_STEP: 0,
  DAY_SECONDS: 86_400,
  scheduleFirstFollowup: (...a: unknown[]) => scheduleFirstFollowupMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({
  getSequenceByLeadId: (...a: unknown[]) => getSequenceByLeadIdMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
  stopSequence: (...a: unknown[]) => stopSequenceMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { sweepFailedFirstTouch } from './resend-failed'

const SUPABASE = {} as never

function waitingEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', thread_id: null,
    subject: 'Hi there', body: 'Body text', status: 'waiting', direction: 'outbound', sequence_step: 0,
    ...overrides,
  }
}

beforeEach(() => {
  for (const m of [
    listWaitingOutboundEmailsMock, claimWaitingOutboundEmailMock, markEmailSentMock, markEmailFailedMock,
    markEmailWaitingMock, hasInboundReplyMock, listThreadEmailsMock, getLeadByIdMock, getCaseByIdMock,
    updateCaseStatusMock, getCampaignForCaseMock, sendViaMailboxMock, scheduleFirstFollowupMock,
    enqueueCrmSyncMock, logEventSafeMock, getSequenceByLeadIdMock, advanceSequenceMock, stopSequenceMock,
    publishDelayMock,
  ]) {
    m.mockReset()
  }
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: 'jane@acme.com' })
  getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'contacted' })
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], status: 'active' })
  claimWaitingOutboundEmailMock.mockResolvedValue({
    id: 'e1', subject: 'Hi there', body: 'Body text', thread_id: null,
  })
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
  hasInboundReplyMock.mockResolvedValue(false)
})
```

Then replace the rest of the file (the `beforeEach` through the end of `describe('sweepFailedFirstTouch', ...)`) with the updated first-touch tests below — same 13 scenarios as today, adapted to the new mocks (`claimWaitingOutboundEmail` is called with just the row's own `id`, not a row payload, and the RATE_LIMITED case now marks the row `waiting` again, not `failed`):

```ts
beforeEach(() => {
  for (const m of [
    listWaitingOutboundEmailsMock, claimWaitingOutboundEmailMock, markEmailSentMock, markEmailFailedMock,
    markEmailWaitingMock, hasInboundReplyMock, listThreadEmailsMock, getLeadByIdMock, getCaseByIdMock,
    updateCaseStatusMock, getCampaignForCaseMock, sendViaMailboxMock, scheduleFirstFollowupMock,
    enqueueCrmSyncMock, logEventSafeMock, getSequenceByLeadIdMock, advanceSequenceMock, stopSequenceMock,
    publishDelayMock,
  ]) {
    m.mockReset()
  }
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: 'jane@acme.com' })
  getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'contacted' })
  getCampaignForCaseMock.mockResolvedValue({ status: 'active', mailbox_ids: ['m1'] })
  claimWaitingOutboundEmailMock.mockResolvedValue(waitingEmail({ status: 'queued' }))
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
  hasInboundReplyMock.mockResolvedValue(false)
})

describe('sweepFailedFirstTouch — first touch', () => {
  it('should resend a stranded lead on an already-contacted case without re-flipping status', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(sendViaMailboxMock).toHaveBeenCalledWith(SUPABASE, expect.objectContaining({
      to: 'jane@acme.com', subject: 'Hi there', body: 'Body text', purpose: 'outreach',
    }))
    expect(markEmailSentMock).toHaveBeenCalledWith(SUPABASE, 'e1', {
      providerMessageId: 'pm1', threadId: 'thr1', mailboxId: 'm1',
    })
    expect(scheduleFirstFollowupMock).toHaveBeenCalledWith(SUPABASE, { clientId: 'c1', caseId: 'case1', leadId: 'lead1' })
    // Case is already 'contacted' — must not re-transition or re-fire CRM sync.
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'sent' }])
  })

  it('should advance a still-pre-contact case to contacted and fire the CRM sync on send', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'waiting' })

    await sweepFailedFirstTouch(SUPABASE, 50)

    expect(updateCaseStatusMock).toHaveBeenCalledWith(SUPABASE, 'case1', 'contacted')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'contacted')
  })

  it('should mark the email waiting again (not failed) and report rate_limited, without touching case status, on a cap/gate failure', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'All mailboxes at daily cap', {}))

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailWaitingMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(markEmailFailedMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'rate_limited' }])
  })

  it('should mark the email failed, log, and continue the batch on a genuine (non-RATE_LIMITED) send error', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e1', lead_id: 'lead1' }),
      waitingEmail({ id: 'e2', lead_id: 'lead2' }),
    ])
    getLeadByIdMock.mockImplementation((_s: unknown, leadId: string) =>
      Promise.resolve({ id: leadId, status: 'active', email: `${leadId}@acme.com` }),
    )
    claimWaitingOutboundEmailMock.mockImplementation((_s: unknown, id: string) =>
      Promise.resolve(waitingEmail({ id, lead_id: id === 'e1' ? 'lead1' : 'lead2', status: 'queued' })),
    )
    sendViaMailboxMock.mockRejectedValueOnce(new Error('smtp exploded')).mockResolvedValueOnce({
      mailboxId: 'm1', providerMessageId: 'pm2', threadId: 'thr2',
    })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(markEmailFailedMock).toHaveBeenCalledWith(SUPABASE, 'e1')
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.resend_failed.error', payload: expect.objectContaining({ emailId: 'e1' }),
    }))
    // The second email in the batch still gets processed after the first fails.
    expect(results).toEqual([
      { emailId: 'e1', outcome: 'failed' },
      { emailId: 'e2', outcome: 'sent' },
    ])
  })

  it('should skip without sending when the lead is no longer active', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'stopped', email: 'jane@acme.com' })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending when the lead has no email address', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', status: 'active', email: null })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it.each(['won', 'lost', 'dead'] as const)('should skip a case that is already closed out (%s)', async (status) => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip when the case no longer exists', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCaseByIdMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip when the campaign is missing or not active', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    getCampaignForCaseMock.mockResolvedValue({ status: 'paused', mailbox_ids: ['m1'] })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should skip without sending when the reclaim loses the race (already handled concurrently)', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail()])
    claimWaitingOutboundEmailMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(results).toEqual([{ emailId: 'e1', outcome: 'skipped' }])
  })

  it('should pass the limit through to the list query and return an empty array when nothing is waiting', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([])

    const results = await sweepFailedFirstTouch(SUPABASE, 25)

    expect(listWaitingOutboundEmailsMock).toHaveBeenCalledWith(SUPABASE, 25)
    expect(results).toEqual([])
  })
})
```

Add new tests for the follow-up-step branch directly below the block above:

```ts
describe('sweepFailedFirstTouch — follow-up steps', () => {
  it('should resend a follow-up step as-is, thread it onto the prior message, and advance the sequence', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e2', sequence_step: 1, subject: 'Re: Hi there', thread_id: 'thr1' }),
    ])
    claimWaitingOutboundEmailMock.mockResolvedValue({
      id: 'e2', subject: 'Re: Hi there', body: 'Body text', thread_id: 'thr1',
    })
    getSequenceByLeadIdMock.mockResolvedValue({
      id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14],
    })
    listThreadEmailsMock.mockResolvedValue([
      { id: 'e1', direction: 'outbound', provider_message_id: 'pm-orig', thread_id: 'thr1' },
    ])
    publishDelayMock.mockResolvedValue('qmsg-next')

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e2', outcome: 'sent' }])
    expect(sendViaMailboxMock).toHaveBeenCalledWith(SUPABASE, expect.objectContaining({
      threadId: 'thr1', inReplyToMessageId: 'pm-orig', references: 'pm-orig',
    }))
    expect(advanceSequenceMock).toHaveBeenCalledWith(SUPABASE, 'seq1', expect.objectContaining({ currentStep: 1 }))
    expect(publishDelayMock).toHaveBeenCalledWith('/api/pipeline/followup', { sequenceId: 'seq1', step: 2 }, 7 * 86_400)
    expect(scheduleFirstFollowupMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence and mark the case dead on the final follow-up step', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([
      waitingEmail({ id: 'e3', sequence_step: 3, thread_id: 'thr1' }),
    ])
    claimWaitingOutboundEmailMock.mockResolvedValue({ id: 'e3', subject: 'Re: Hi there', body: 'Body text', thread_id: 'thr1' })
    getSequenceByLeadIdMock.mockResolvedValue({ id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14] })
    listThreadEmailsMock.mockResolvedValue([{ id: 'e1', direction: 'outbound', provider_message_id: 'pm-orig', thread_id: 'thr1' }])

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e3', outcome: 'sent' }])
    expect(stopSequenceMock).toHaveBeenCalledWith(SUPABASE, 'seq1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith(SUPABASE, 'case1', 'dead')
    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'dead')
    expect(advanceSequenceMock).not.toHaveBeenCalled()
  })

  it('should skip and stop the sequence when a reply arrived while the step sat waiting', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail({ id: 'e4', sequence_step: 1 })])
    hasInboundReplyMock.mockResolvedValue(true)
    getSequenceByLeadIdMock.mockResolvedValue({ id: 'seq1', lead_id: 'lead1', followup_delays_days: [3, 7, 14] })

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e4', outcome: 'skipped' }])
    expect(stopSequenceMock).toHaveBeenCalledWith(SUPABASE, 'seq1', 'completed')
    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should skip a follow-up step whose sequence was already stopped', async () => {
    listWaitingOutboundEmailsMock.mockResolvedValue([waitingEmail({ id: 'e5', sequence_step: 1 })])
    getSequenceByLeadIdMock.mockResolvedValue(null)

    const results = await sweepFailedFirstTouch(SUPABASE, 50)

    expect(results).toEqual([{ emailId: 'e5', outcome: 'skipped' }])
    expect(claimWaitingOutboundEmailMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/pipeline/resend-failed.test.ts`
Expected: FAIL — production code still imports `listFailedFirstTouchEmails`/`claimOutboundEmail` and has no follow-up branch.

- [ ] **Step 3: Implement**

Replace `src/lib/pipeline/resend-failed.ts` in full:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { isAppError, AppError } from '@/lib/errors/app-error'
import {
  listWaitingOutboundEmails,
  claimWaitingOutboundEmail,
  markEmailSent,
  markEmailFailed,
  markEmailWaiting,
  hasInboundReply,
  listThreadEmails,
  type EmailRow,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getCaseById, updateCaseStatus, type CaseStatus } from '@/lib/db/cases'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { scheduleFirstFollowup, FIRST_TOUCH_STEP, DAY_SECONDS } from './followup'
import { getSequenceByLeadId, advanceSequence, stopSequence, type SequenceRow } from '@/lib/db/sequences'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'resend_failed_outbound'

// A case explicitly closed out — by a human, by the CRM sync, or by the
// follow-up sequence exhausting — must not get a resend resurrected under
// it, first-touch or follow-up alike.
const CASE_CLOSED_STATUSES: readonly CaseStatus[] = ['won', 'lost', 'dead']

export type ResendOutcome = 'sent' | 'rate_limited' | 'failed' | 'skipped'

export interface ResendResult {
  emailId: string
  outcome: ResendOutcome
}

// Resends exactly one stranded 'waiting' outbound email, reusing its stored
// subject/body verbatim — never regenerated. First-touch (sequence_step 0)
// mirrors processLead's send + bookkeeping (write.ts), minus draft
// generation. A follow-up step (sequence_step > 0) mirrors runFollowupStep's
// send + cadence bookkeeping (followup.ts), also minus generation. See
// docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md.
async function resendOne(supabase: SupabaseClient<Database>, email: EmailRow): Promise<ResendOutcome> {
  if (
    !email.lead_id || !email.case_id || !email.subject || !email.body || email.sequence_step === null
  ) return 'skipped'
  const caseId = email.case_id
  const leadId = email.lead_id
  const step = email.sequence_step

  const [lead, kase] = await Promise.all([getLeadById(supabase, leadId), getCaseById(supabase, caseId)])
  if (!lead || lead.status !== 'active' || !lead.email) return 'skipped'
  if (!kase || CASE_CLOSED_STATUSES.includes(kase.status)) return 'skipped'

  const campaign = await getCampaignForCase(supabase, caseId)
  if (!campaign || campaign.status !== 'active') return 'skipped'

  let sequence: SequenceRow | null = null
  let inReplyTo: string | null = null
  if (step > FIRST_TOUCH_STEP) {
    // A reply that arrived while this step sat 'waiting' never got the
    // chance to stop the sequence — runFollowupStep does that check on
    // every invocation, but a 'waiting' row is deliberately never
    // rescheduled through runFollowupStep again (see followup.ts). Check it
    // here instead of resending a nudge to someone who already answered.
    if (await hasInboundReply(supabase, leadId)) {
      const activeSequence = await getSequenceByLeadId(supabase, leadId)
      if (activeSequence) await stopSequence(supabase, activeSequence.id, 'completed')
      return 'skipped'
    }
    sequence = await getSequenceByLeadId(supabase, leadId)
    if (!sequence) return 'skipped' // already stopped/completed since this row was parked
    const thread = await listThreadEmails(supabase, leadId)
    inReplyTo = thread.filter((e) => e.id !== email.id).at(-1)?.provider_message_id ?? null
  }

  // Reclaims this specific 'waiting' row back to 'queued'. The
  // `.eq('status','waiting')` guard inside claimWaitingOutboundEmail
  // (lib/db/emails.ts) makes this safe to race against a concurrent sweep
  // tick — only one wins, the loser gets null and skips, never double-sends.
  const claimed = await claimWaitingOutboundEmail(supabase, email.id)
  if (!claimed) return 'skipped'

  try {
    const sent = await sendViaMailbox(supabase, {
      clientId: email.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: claimed.subject ?? email.subject,
      body: claimed.body ?? email.body,
      purpose: 'outreach',
      threadId: claimed.thread_id,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
    })
    await markEmailSent(supabase, claimed.id, {
      providerMessageId: sent.providerMessageId,
      threadId: sent.threadId,
      mailboxId: sent.mailboxId,
    })

    if (step === FIRST_TOUCH_STEP) {
      await scheduleFirstFollowup(supabase, { clientId: email.client_id, caseId, leadId })
      if (kase.status !== 'contacted') {
        await updateCaseStatus(supabase, caseId, 'contacted')
        await enqueueCrmSync(caseId, 'contacted')
      }
      return 'sent'
    }

    if (!sequence) {
      throw new AppError('INVARIANT_VIOLATION', 'Follow-up resend lost its sequence after sending', { leadId, caseId })
    }
    const maxStep = sequence.followup_delays_days.length
    if (step >= maxStep) {
      await stopSequence(supabase, sequence.id, 'stopped')
      await updateCaseStatus(supabase, caseId, 'dead')
      await enqueueCrmSync(caseId, 'dead')
    } else {
      const nextStep = step + 1
      // Index = current step → delay before nextStep; always in range for
      // step < maxStep — same indexing rule as runFollowupStep's own send path.
      const nextDelaySeconds = sequence.followup_delays_days[step]! * DAY_SECONDS
      const messageId = await publishJsonWithDelay(
        '/api/pipeline/followup',
        { sequenceId: sequence.id, step: nextStep },
        nextDelaySeconds,
      )
      await advanceSequence(supabase, sequence.id, {
        currentStep: step,
        nextActionAt: new Date(Date.now() + nextDelaySeconds * 1000).toISOString(),
        qstashMessageId: messageId,
      })
    }
    return 'sent'
  } catch (error) {
    // Only a delivery failure means the email was never sent — mark it
    // failed so a later drain sweep tick can reclaim it again. A failure in
    // the bookkeeping above means the message already went out and must not
    // be treated as a send failure. RATE_LIMITED stays 'waiting' (not
    // 'failed') so the next tick still finds it via listWaitingOutboundEmails.
    if (isAppError(error) && error.code === 'RATE_LIMITED') {
      await markEmailWaiting(supabase, claimed.id)
      return 'rate_limited'
    }
    await markEmailFailed(supabase, claimed.id)
    throw error
  }
}

// Sweeps a bounded batch of 'waiting' outbound emails — first-touch and
// follow-up steps alike — and retries each through the real send path
// (health/rotation/cap/warmup-gate/suppression all still apply via
// sendViaMailbox — no bypass). One email's genuine (non-RATE_LIMITED)
// failure is logged and does not abort the rest of the batch.
export async function sweepFailedFirstTouch(supabase: SupabaseClient<Database>, limit: number): Promise<ResendResult[]> {
  const emails = await listWaitingOutboundEmails(supabase, limit)
  const results: ResendResult[] = []
  for (const email of emails) {
    try {
      const outcome = await resendOne(supabase, email)
      results.push({ emailId: email.id, outcome })
    } catch (error) {
      results.push({ emailId: email.id, outcome: 'failed' })
      await logEventSafe({
        clientId: email.client_id,
        caseId: email.case_id,
        actor: ACTOR,
        type: 'pipeline.resend_failed.error',
        payload: { emailId: email.id, cause: error instanceof Error ? error.message : String(error) },
      })
    }
  }
  return results
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/pipeline/resend-failed.test.ts`
Expected: PASS, all tests including the four new follow-up-step tests.

- [ ] **Step 5: Type-check and lint**

Run: `npx tsc --noEmit && npx eslint src/lib/pipeline/resend-failed.ts src/lib/pipeline/resend-failed.test.ts`
Expected: clean.

- [ ] **Step 6: Run the full suite**

Run: `npx vitest run`
Expected: PASS across the whole repo — this task touches the shared `followup.ts` exports other tasks also depend on.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/resend-failed.ts src/lib/pipeline/resend-failed.test.ts
git commit -m "feat(pipeline): widen the drain sweep to follow-up steps, not just first-touch"
```

---

## Task 9: Cron cadence — tighten the priority window

**Files:**
- Modify: `scripts/schedule-resend-failed-cron.ts`

**Interfaces:**
- None — leaf change, no other task depends on this.

- [ ] **Step 1: Update the default cadence**

In `scripts/schedule-resend-failed-cron.ts`, change the header comment and default:

```ts
// One-time setup: registers the QStash schedule that sweeps stranded
// 'waiting' outbound emails system-wide (first-touch and follow-up steps
// alike). See lib/pipeline/resend-failed.ts and
// docs/superpowers/specs/2026-08-19-cap-blocked-send-waiting-design.md.
// Same shape as schedule-write-cron.ts, and now the same cadence: 'waiting'
// content should send before the same day's brand-new work once the cap
// resets, and running on write-fanout's own 5-minute cadence keeps that
// priority window tight (the two crons remain independent — no hard
// ordering guarantee — but a wide 59-minute gap after a UTC-midnight cap
// reset shrinks to about 5 minutes).
//   Usage: tsx scripts/schedule-resend-failed-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/pipeline/resend-failed', cron)
  process.stdout.write(`Scheduled resend-failed cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add scripts/schedule-resend-failed-cron.ts
git commit -m "chore(pipeline): default the resend-failed cron to a 5-minute cadence"
```

- [ ] **Step 4: Flag for explicit sign-off — do not run automatically**

This script registers (or, run again, re-registers at a new cadence) a recurring production QStash cron. Running it against production is a separate, explicit action from writing the code — surface this to the user rather than executing `npx tsx scripts/schedule-resend-failed-cron.ts` yourself, whether or not a schedule already exists from an earlier session.

---

## Final verification (after all tasks)

- [ ] Run: `npx vitest run` — full suite passes.
- [ ] Run: `npx tsc --noEmit` — no type errors anywhere in the repo.
- [ ] Run: `npx eslint src scripts` — clean.
- [ ] Update `.claude/roadmap.md` with a concise entry: what changed (cap-blocked sends across all reply modes and both first-touch/follow-up now park as `'waiting'` and resend verbatim instead of regenerating), current status (shipped, cron cadence change made but not yet applied to prod — pending sign-off per Task 9 Step 4), and the open decision (activate/re-point the `/api/pipeline/resend-failed` QStash schedule).
