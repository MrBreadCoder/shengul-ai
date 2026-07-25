# P3 — Reply Handling + Knowledge Gap + Price Handoff Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a prospect replies, detect the reply by polling each connected mailbox, pause the follow-up sequence, classify the reply with an LLM, and route it — answer it, escalate a genuine knowledge gap to a human answer box in `/inbox`, hand off on price intent, or suppress+stop on opt-out — never fabricating a missing fact.

**Architecture:** A QStash cron polls every mailbox on a short interval. A new provider read capability (`fetchInbound`) returns new inbound messages plus an opaque per-mailbox cursor. Ingestion matches each inbound to a contacted lead by sender address, stores it as an `inbound` email (deduped on `provider_message_id`), pauses the lead's sequence, and fans one QStash message per inbound to `/api/inbound/reply`. The Reply Agent (`src/lib/pipeline/reply.ts`) loads the full thread + `case_knowledge`, classifies intent + confidence, and routes deterministically. Knowledge gaps create a `knowledge_request`; a human answers it in `/inbox`, the answer is stored as `case_knowledge` (kind `answer`), and the AI writes+sends the reply in its own voice.

**Tech Stack:** Next.js (App Router, Server Actions, Route Handlers) · TypeScript (strict) · Supabase Postgres · Gemini via Vercel AI SDK (`src/lib/llm/client.ts`) · QStash (`src/lib/qstash/client.ts`) · Gmail API · Microsoft Graph · Vitest.

## Global Constraints

- **Complete code only** — no stubs, placeholders, `TODO`, or truncation (`.claude/ANTI_LAZY.md`).
- **TypeScript strict** — no `any` (use `unknown` + narrow), no `!` without a proof comment, explicit return types on exported functions.
- **DB columns are snake_case; TypeScript is camelCase** — map explicitly.
- **All data access lives in `src/lib/db/`** — never inline Supabase queries in routes, actions, or pipeline modules. One function per DB operation.
- **Every external SDK/HTTP call maps errors to `AppError`** — never let raw errors escape. Use the existing `fetchJson` (already maps + times out at 8s).
- **Every QStash route** verifies the signature via `verifyQstashSignature`, is idempotent, and returns 401 on `UNAUTHORIZED`, 400 on validation failure, 500 otherwise.
- **Every state change / agent action writes to `events`** via `logEvent` / `logEventSafe`.
- **Never send to a suppressed address; never fabricate facts** — a missing business fact is escalated to a human, never invented.
- **Sending live mail is operator-only** in Server Actions (`appUser.role === 'operator'`), matching `approveDraft`.
- Files: `kebab-case.ts`. Named exports only (default export only for Next.js pages/components). Tests colocated as `*.test.ts`, Arrange-Act-Assert, `it('should … when …')`.
- Verify commands: `pnpm test` (Vitest), `pnpm typecheck` (`tsc --noEmit`), `pnpm lint` (eslint). **pnpm only — never `npm install`.**

---

## File Structure

**Schema / types**
- `supabase/migrations/0007_p3_reply_handling.sql` (create) — inbound-read cursor column, reply/inbound/knowledge-request idempotency indexes.
- `src/types/database.ts` (modify) — add `emails.in_reply_to_email_id`, `mailboxes.inbound_cursor`.

**Data access (`src/lib/db/`)**
- `emails.ts` (modify) — `insertInboundEmail`, `claimReplyEmail`.
- `leads.ts` (modify) — `findContactedLeadByEmail`.
- `sequences.ts` (modify) — `pauseActiveSequenceForLead`, `stopSequenceForLead`.
- `mailboxes.ts` (modify) — `listAllMailboxes`, `updateInboundCursor`.
- `knowledge-requests.ts` (create) — `createKnowledgeRequest`, `getKnowledgeRequestById`, `listOpenKnowledgeRequestsForClient`, `claimKnowledgeRequestAnswer`.

**Mailbox providers (`src/lib/mailbox/`)**
- `provider.ts` (modify) — `InboundMessage`, `FetchInboundResult`, `fetchInbound` on the interface.
- `gmail-provider.ts` (modify) — `fetchInbound` (Gmail history API) + `gmail.readonly` scope.
- `outlook-provider.ts` (modify) — `fetchInbound` (Graph delta) + `Mail.Read` scope.
- `tokens.ts` (create) — shared `parseMailboxTokens` (extracted from `sender.ts`).
- `reader.ts` (create) — `readInboundForMailbox` (refresh + persist tokens around `fetchInbound`).
- `sender.ts` (modify) — use `parseMailboxTokens` from `tokens.ts`.

**Pipeline (`src/lib/pipeline/`)**
- `inbound.ts` (create) — `ingestInboundForMailbox`.
- `reply.ts` (create) — `classifyReply`, `replyDisposition`, `sendOrDraftReply`, `runReplyForInbound`.
- `knowledge-answer.ts` (create) — `runKnowledgeAnswer`.

**Routes (`src/app/api/inbound/`)**
- `poll-fanout/route.ts` (create) — cron entry; one QStash message per mailbox.
- `poll/route.ts` (create) — poll one mailbox, ingest.
- `reply/route.ts` (create) — run the Reply Agent for one inbound email.

**Cron script**
- `scripts/schedule-inbound-poll-cron.ts` (create) — registers the poll-fanout schedule.

**UI (`src/app/inbox/`)**
- `actions.ts` (modify) — `answerKnowledgeRequest` Server Action.
- `knowledge-request-row.tsx` (create) — client component with the answer box.
- `page.tsx` (modify) — render open knowledge requests alongside drafts.

**Docs**
- `.claude/roadmap.md`, `.claude/architecture.md` (modify).

---

## Interfaces (defined here, consumed across tasks)

```ts
// src/lib/mailbox/provider.ts
export interface InboundMessage {
  providerMessageId: string   // Gmail message id / Graph message id — inbound dedup key
  threadId: string            // Gmail threadId / Graph conversationId
  fromEmail: string           // lowercased sender address
  subject: string | null
  body: string                // plain text
  receivedAt: string          // ISO
}
export interface FetchInboundResult {
  messages: InboundMessage[]
  cursor: string              // opaque, persisted per-mailbox, passed back next poll
}
// MailboxProvider gains:
//   fetchInbound(tokens: MailboxTokens, cursor: string | null):
//     Promise<{ result: FetchInboundResult; tokens: MailboxTokens }>

// src/lib/mailbox/reader.ts
export function readInboundForMailbox(
  supabase: SupabaseClient<Database>, mailbox: MailboxRow,
): Promise<FetchInboundResult>

// src/lib/pipeline/inbound.ts
export interface IngestSummary { mailboxId: string; ingested: number; enqueued: number }
export function ingestInboundForMailbox(
  supabase: SupabaseClient<Database>, mailbox: MailboxRow,
): Promise<IngestSummary>

// src/lib/pipeline/reply.ts
export type ReplyIntent = 'question' | 'interested' | 'price' | 'not_interested' | 'other'
export interface ReplyClassification {
  intent: ReplyIntent; confidence: number; canAnswer: boolean
  missingQuestion: string | null; replyBody: string | null
}
export interface ReplySummary {
  emailId: string
  action: 'answered' | 'escalated' | 'handoff' | 'suppressed' | 'skipped'
}
export function runReplyForInbound(
  supabase: SupabaseClient<Database>, input: { emailId: string },
): Promise<ReplySummary>

// src/lib/pipeline/knowledge-answer.ts
export function runKnowledgeAnswer(
  supabase: SupabaseClient<Database>, input: { knowledgeRequestId: string },
): Promise<{ knowledgeRequestId: string; action: 'sent' | 'drafted' | 'skipped' }>
```

Reply routing rules (single source of truth):
- **price** → build one booking-link reply, send-or-draft per `reply_mode`, `addSuppression(price_handoff)`, `stopSequenceForLead('stopped')`, case → `hot_handoff`. Action `handoff`.
- **not_interested** → `addSuppression('manual')`, `stopSequenceForLead('stopped')`, case → `lost`. No reply sent. Action `suppressed`.
- **question / interested / other**, `canAnswer && replyBody` → send-or-draft per `replyDisposition(mode, confidence)`, case → `in_conversation`. Action `answered`.
- **question / interested / other**, NOT answerable → `createKnowledgeRequest`, case → `in_conversation`. Action `escalated`. Never fabricate.
- `replyDisposition`: `human_approve` → `draft`; `auto_send` → `send`; `hybrid` → `send` iff `confidence >= 0.75`, else `draft` (escalate to `/inbox` for human review).

---

### Task 1: Schema migration + generated types

**Files:**
- Create: `supabase/migrations/0007_p3_reply_handling.sql`
- Modify: `src/types/database.ts` (emails Row/Insert ~lines 249-280; mailboxes Row/Insert ~lines 416-443)

**Interfaces:**
- Produces: `emails.in_reply_to_email_id: string | null`, `mailboxes.inbound_cursor: string | null`, and three nullable-column unique indexes that later `upsert(..., { onConflict })` calls depend on.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0007_p3_reply_handling.sql`:

```sql
-- P3 reply handling: inbound polling cursor + idempotency keys for inbound
-- ingestion, reply sending, and knowledge-request escalation.

-- Opaque per-mailbox polling cursor. Gmail stores a historyId; Outlook stores a
-- Graph delta link. NULL means "not yet baselined" — the first poll captures the
-- current position and ingests nothing, so we never replay the whole mailbox.
alter table public.mailboxes add column if not exists inbound_cursor text;

-- A reply outbound points at the inbound email it answers.
alter table public.emails
  add column if not exists in_reply_to_email_id uuid references public.emails(id);

-- Nullable-column UNIQUE indexes (NOT partial): Postgres treats NULLs as
-- distinct, so the many rows with a NULL key never collide, while non-NULL keys
-- are forced unique. This shape — rather than a partial index — is what
-- supabase-js `upsert({ onConflict })` needs (it emits ON CONFLICT (col) with no
-- predicate, which a partial index would not satisfy).

-- Inbound dedup: the same provider message is ingested at most once, even if two
-- poll cycles overlap.
create unique index if not exists emails_provider_message_id_uniq
  on public.emails (provider_message_id);

-- Reply idempotency: at most one outbound reply per inbound email, so a retried
-- /api/inbound/reply delivery claims the slot exactly once.
create unique index if not exists emails_in_reply_to_uniq
  on public.emails (in_reply_to_email_id);

-- One knowledge request per inbound email — a retried reply run reuses it.
create unique index if not exists knowledge_requests_email_uniq
  on public.knowledge_requests (email_id);
```

- [ ] **Step 2: Add `in_reply_to_email_id` to the emails type**

In `src/types/database.ts`, in `emails.Row` add after `sent_at: string | null` (before `created_at`):

```ts
          in_reply_to_email_id: string | null
```

In `emails.Insert` add after `sent_at?: string | null`:

```ts
          in_reply_to_email_id?: string | null
```

- [ ] **Step 3: Add `inbound_cursor` to the mailboxes type**

In `src/types/database.ts`, in `mailboxes.Row` add after `health: Database['public']['Enums']['mailbox_health']`:

```ts
          inbound_cursor: string | null
```

In `mailboxes.Insert` add after `health?: Database['public']['Enums']['mailbox_health']`:

```ts
          inbound_cursor?: string | null
```

- [ ] **Step 4: Verify types compile**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0007_p3_reply_handling.sql src/types/database.ts
git commit -m "feat(p3): schema + types for inbound cursor and reply/inbound idempotency"
```

---

### Task 2: Email DB helpers — inbound insert + reply claim

**Files:**
- Modify: `src/lib/db/emails.ts`
- Modify: `src/lib/db/leads.ts`
- Test: `src/lib/db/emails.test.ts`, `src/lib/db/leads.test.ts`

**Interfaces:**
- Consumes: `EmailRow`, `EmailInsert`, `LeadRow` (existing).
- Produces:
  - `insertInboundEmail(supabase, row: EmailInsert): Promise<EmailRow | null>` — upsert on `provider_message_id`, `ignoreDuplicates`; `null` = already ingested.
  - `claimReplyEmail(supabase, row: EmailInsert): Promise<EmailRow | null>` — upsert on `in_reply_to_email_id`, `ignoreDuplicates`; `null` = a reply already exists for that inbound.
  - `findContactedLeadByEmail(supabase, clientId: string, email: string): Promise<LeadRow | null>` — most-recent case-attached lead with that address.

- [ ] **Step 1: Write failing tests for the email helpers**

Append to `src/lib/db/emails.test.ts` (mirror the existing mock style in that file — it builds a chainable Supabase stub; reuse its helpers). Add:

```ts
describe('insertInboundEmail', () => {
  it('should return the inserted row when the inbound message is new', async () => {
    const row = { id: 'in1' }
    const supabase = mockUpsertReturning([row]) // helper already in this file
    const result = await insertInboundEmail(supabase, {
      client_id: 'c1', direction: 'inbound', provider_message_id: 'g-abc', status: 'delivered',
    })
    expect(result).toEqual(row)
  })

  it('should return null when the provider message was already ingested', async () => {
    const supabase = mockUpsertReturning([]) // ignoreDuplicates => empty
    const result = await insertInboundEmail(supabase, {
      client_id: 'c1', direction: 'inbound', provider_message_id: 'g-abc', status: 'delivered',
    })
    expect(result).toBeNull()
  })
})

describe('claimReplyEmail', () => {
  it('should return null when a reply already exists for the inbound email', async () => {
    const supabase = mockUpsertReturning([])
    const result = await claimReplyEmail(supabase, {
      client_id: 'c1', direction: 'outbound', in_reply_to_email_id: 'in1', status: 'queued',
    })
    expect(result).toBeNull()
  })
})
```

If `emails.test.ts` does not already expose `mockUpsertReturning`, add this local helper near the top of the file:

```ts
function mockUpsertReturning(rows: unknown[]) {
  return {
    from: () => ({
      upsert: () => ({ select: () => Promise.resolve({ data: rows, error: null }) }),
    }),
  } as never
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/db/emails.test.ts`
Expected: FAIL — `insertInboundEmail` / `claimReplyEmail` are not exported.

- [ ] **Step 3: Implement the email helpers**

In `src/lib/db/emails.ts`, add after `claimOutboundEmail`:

```ts
// Inserts an inbound email, deduped on provider_message_id (unique index from
// migration 0007). ignoreDuplicates makes overlapping poll cycles idempotent:
// an already-ingested message returns no row, so the caller skips re-processing.
export async function insertInboundEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .upsert(row, { onConflict: 'provider_message_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert inbound email', {
      providerMessageId: row.provider_message_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// Claims the single "reply to this inbound" outbound slot (unique index on
// in_reply_to_email_id). A retried /api/inbound/reply delivery that finds the
// slot taken returns null and must not send a second reply.
export async function claimReplyEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .upsert(row, { onConflict: 'in_reply_to_email_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim reply email', {
      inReplyToEmailId: row.in_reply_to_email_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 4: Write a failing test for the lead lookup**

Append to `src/lib/db/leads.test.ts` (mirror its existing Supabase mock style):

```ts
describe('findContactedLeadByEmail', () => {
  it('should return the most recent case-attached lead for an address', async () => {
    const lead = { id: 'lead1', email: 'jane@acme.com', case_id: 'case1' }
    const supabase = {
      from: () => ({
        select: () => ({
          eq: () => ({
            eq: () => ({
              not: () => ({
                order: () => ({ limit: () => Promise.resolve({ data: [lead], error: null }) }),
              }),
            }),
          }),
        }),
      }),
    } as never
    const result = await findContactedLeadByEmail(supabase, 'c1', 'jane@acme.com')
    expect(result).toEqual(lead)
  })
})
```

- [ ] **Step 5: Implement the lead lookup**

In `src/lib/db/leads.ts`, add after `getLeadById`:

```ts
// The lead an inbound reply belongs to: the most recent case-attached lead for
// this client with that email address. Sender-address matching is provider-
// agnostic (Outlook synthesizes outbound thread ids, so thread matching is
// unreliable there).
export async function findContactedLeadByEmail(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
): Promise<LeadRow | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('client_id', clientId)
    .eq('email', email)
    .not('case_id', 'is', null)
    .order('created_at', { ascending: false })
    .limit(1)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to find contacted lead by email', { clientId, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/lib/db/emails.test.ts src/lib/db/leads.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat(p3): inbound-email + reply-claim + contacted-lead DB helpers"
```

---

### Task 3: Sequence + mailbox DB helpers

**Files:**
- Modify: `src/lib/db/sequences.ts`, `src/lib/db/mailboxes.ts`
- Test: `src/lib/db/sequences.test.ts`, `src/lib/db/mailboxes.test.ts`

**Interfaces:**
- Produces:
  - `pauseActiveSequenceForLead(supabase, leadId: string): Promise<void>` — active → paused (guarded).
  - `stopSequenceForLead(supabase, leadId: string, state: 'stopped' | 'completed'): Promise<void>` — active/paused → terminal.
  - `listAllMailboxes(supabase): Promise<MailboxRow[]>`
  - `updateInboundCursor(supabase, id: string, cursor: string): Promise<void>`

- [ ] **Step 1: Write failing tests for the sequence helpers**

Append to `src/lib/db/sequences.test.ts` (mirror its existing mock style):

```ts
describe('pauseActiveSequenceForLead', () => {
  it('should update only active sequences to paused', async () => {
    const update = vi.fn(() => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }))
    const supabase = { from: () => ({ update }) } as never
    await pauseActiveSequenceForLead(supabase, 'lead1')
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ state: 'paused' }))
  })
})

describe('stopSequenceForLead', () => {
  it('should throw a DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ in: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(stopSequenceForLead(supabase, 'lead1', 'stopped')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/db/sequences.test.ts`
Expected: FAIL — helpers not exported.

- [ ] **Step 3: Implement the sequence helpers**

In `src/lib/db/sequences.ts`, add after `stopSequence`:

```ts
// Inbound reply arrived: pause the lead's active sequence so the pending QStash
// follow-up no-ops (runFollowupStep skips when state !== 'active'). Guarded on
// state = 'active' so a stopped/completed sequence is never reactivated.
export async function pauseActiveSequenceForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ state: 'paused', next_action_at: null })
    .eq('lead_id', leadId)
    .eq('state', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to pause sequence for lead', { leadId, cause: error.message })
  }
}

// Terminally stops the lead's sequence (price handoff / opt-out). Matches active
// or paused rows so a reply that already paused the sequence is still stopped.
export async function stopSequenceForLead(
  supabase: SupabaseClient<Database>,
  leadId: string,
  state: 'stopped' | 'completed',
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ state, next_action_at: null, qstash_message_id: null })
    .eq('lead_id', leadId)
    .in('state', ['active', 'paused'])
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to stop sequence for lead', { leadId, state, cause: error.message })
  }
}
```

- [ ] **Step 4: Write failing tests for the mailbox helpers**

Append to `src/lib/db/mailboxes.test.ts`:

```ts
describe('listAllMailboxes', () => {
  it('should return every mailbox row', async () => {
    const rows = [{ id: 'm1' }, { id: 'm2' }]
    const supabase = { from: () => ({ select: () => Promise.resolve({ data: rows, error: null }) }) } as never
    const result = await listAllMailboxes(supabase)
    expect(result).toEqual(rows)
  })
})

describe('updateInboundCursor', () => {
  it('should throw a DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(updateInboundCursor(supabase, 'm1', 'cur')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
```

- [ ] **Step 5: Implement the mailbox helpers**

In `src/lib/db/mailboxes.ts`, add after `resetDailyCounters`:

```ts
// Every connected mailbox across all clients — the poll-fanout entry point runs
// with the admin client, so RLS scoping is intentionally bypassed here.
export async function listAllMailboxes(
  supabase: SupabaseClient<Database>,
): Promise<MailboxRow[]> {
  const { data, error } = await supabase.from('mailboxes').select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list mailboxes', { cause: error.message })
  }
  return data ?? []
}

// Persists the opaque polling cursor (Gmail historyId / Graph delta link) after
// a poll cycle completes.
export async function updateInboundCursor(
  supabase: SupabaseClient<Database>,
  id: string,
  cursor: string,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ inbound_cursor: cursor }).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update inbound cursor', { id, cause: error.message })
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/lib/db/sequences.test.ts src/lib/db/mailboxes.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/sequences.ts src/lib/db/sequences.test.ts src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts
git commit -m "feat(p3): sequence pause/stop-by-lead + mailbox list/cursor helpers"
```

---

### Task 4: Knowledge-request DB helpers

**Files:**
- Create: `src/lib/db/knowledge-requests.ts`
- Test: `src/lib/db/knowledge-requests.test.ts`

**Interfaces:**
- Produces:
  - `KnowledgeRequestRow`, `KnowledgeRequestInsert` type exports.
  - `createKnowledgeRequest(supabase, row): Promise<KnowledgeRequestRow | null>` — upsert on `email_id`, `ignoreDuplicates`.
  - `getKnowledgeRequestById(supabase, id): Promise<KnowledgeRequestRow | null>`
  - `listOpenKnowledgeRequestsForClient(supabase): Promise<KnowledgeRequestRow[]>` — RLS-scoped (session client).
  - `claimKnowledgeRequestAnswer(supabase, { id, answer, answeredBy }): Promise<KnowledgeRequestRow | null>` — open → answered (atomic claim).

- [ ] **Step 1: Write failing tests**

Create `src/lib/db/knowledge-requests.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  createKnowledgeRequest,
  getKnowledgeRequestById,
  listOpenKnowledgeRequestsForClient,
  claimKnowledgeRequestAnswer,
} from './knowledge-requests'

describe('createKnowledgeRequest', () => {
  it('should return null when a request already exists for the email', async () => {
    const supabase = {
      from: () => ({ upsert: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }),
    } as never
    const result = await createKnowledgeRequest(supabase, {
      client_id: 'c1', case_id: 'case1', email_id: 'in1', question: 'What is X?',
    })
    expect(result).toBeNull()
  })
})

describe('getKnowledgeRequestById', () => {
  it('should return the row when found', async () => {
    const row = { id: 'kr1', status: 'open' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    expect(await getKnowledgeRequestById(supabase, 'kr1')).toEqual(row)
  })
})

describe('listOpenKnowledgeRequestsForClient', () => {
  it('should return open requests', async () => {
    const rows = [{ id: 'kr1' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as never
    expect(await listOpenKnowledgeRequestsForClient(supabase)).toEqual(rows)
  })
})

describe('claimKnowledgeRequestAnswer', () => {
  it('should return null when the request is no longer open', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
      }),
    } as never
    const result = await claimKnowledgeRequestAnswer(supabase, { id: 'kr1', answer: 'A', answeredBy: 'u1' })
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/db/knowledge-requests.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the helpers**

Create `src/lib/db/knowledge-requests.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type KnowledgeRequestRow = Database['public']['Tables']['knowledge_requests']['Row']
export type KnowledgeRequestInsert = Database['public']['Tables']['knowledge_requests']['Insert']

// One knowledge request per inbound email (unique index on email_id from
// migration 0007). ignoreDuplicates makes a retried reply run idempotent — an
// existing request returns null and no duplicate escalation is created.
export async function createKnowledgeRequest(
  supabase: SupabaseClient<Database>,
  row: KnowledgeRequestInsert,
): Promise<KnowledgeRequestRow | null> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .upsert(row, { onConflict: 'email_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to create knowledge request', {
      emailId: row.email_id, caseId: row.case_id, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

export async function getKnowledgeRequestById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<KnowledgeRequestRow | null> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load knowledge request', { id, cause: error.message })
  }
  return data
}

// RLS-scoped: pass a session-bound server client so a client role only sees its
// own open requests. Used by /inbox.
export async function listOpenKnowledgeRequestsForClient(
  supabase: SupabaseClient<Database>,
): Promise<KnowledgeRequestRow[]> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .select('*')
    .eq('status', 'open')
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list open knowledge requests', { cause: error.message })
  }
  return data ?? []
}

// Atomically claims an open request and records the human answer. The
// .eq('status','open') guard means only the first submitter wins; a retry or a
// second operator gets null and must not re-run the answer pipeline. Run with an
// admin client so RLS can't silently no-op the write.
export async function claimKnowledgeRequestAnswer(
  supabase: SupabaseClient<Database>,
  input: { id: string; answer: string; answeredBy: string },
): Promise<KnowledgeRequestRow | null> {
  const { data, error } = await supabase
    .from('knowledge_requests')
    .update({
      status: 'answered',
      human_answer: input.answer,
      answered_by: input.answeredBy,
      answered_at: new Date().toISOString(),
    })
    .eq('id', input.id)
    .eq('status', 'open')
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim knowledge request answer', { id: input.id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/db/knowledge-requests.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/knowledge-requests.ts src/lib/db/knowledge-requests.test.ts
git commit -m "feat(p3): knowledge-request DB helpers (create/get/list-open/claim-answer)"
```

---

### Task 5: Provider inbound-read capability (interface + Gmail + Outlook)

**Files:**
- Modify: `src/lib/mailbox/provider.ts`, `src/lib/mailbox/gmail-provider.ts`, `src/lib/mailbox/outlook-provider.ts`
- Test: `src/lib/mailbox/gmail-provider.test.ts`, `src/lib/mailbox/outlook-provider.test.ts`

> The interface change forces both providers to implement `fetchInbound`, so they ship together to keep the tree compiling.

**Interfaces:**
- Produces: `InboundMessage`, `FetchInboundResult`, and `MailboxProvider.fetchInbound` (see the Interfaces section above).

- [ ] **Step 1: Extend the provider interface**

In `src/lib/mailbox/provider.ts`, add before `MailboxProvider`:

```ts
export interface InboundMessage {
  providerMessageId: string
  threadId: string
  fromEmail: string
  subject: string | null
  body: string
  receivedAt: string // ISO timestamp
}

export interface FetchInboundResult {
  messages: InboundMessage[]
  // Opaque, provider-specific: Gmail historyId, Outlook delta link. Persisted
  // per-mailbox and passed back on the next poll. A null cursor means "baseline
  // now, ingest nothing".
  cursor: string
}
```

Add to the `MailboxProvider` interface, after `sendEmail`:

```ts
  // Returns new inbound messages since `cursor`, plus the next cursor and any
  // refreshed tokens to persist. A null cursor baselines (empty messages).
  fetchInbound(
    tokens: MailboxTokens,
    cursor: string | null,
  ): Promise<{ result: FetchInboundResult; tokens: MailboxTokens }>
```

- [ ] **Step 2: Write failing Gmail tests**

Append to `src/lib/mailbox/gmail-provider.test.ts`:

```ts
describe('gmailProvider.fetchInbound', () => {
  const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }

  it('should baseline (no messages) when cursor is null', async () => {
    mockFetchJson.mockResolvedValueOnce({ historyId: '1000' }) // profile
    const { result } = await gmailProvider.fetchInbound(tokens, null)
    expect(result).toEqual({ messages: [], cursor: '1000' })
  })

  it('should return inbound messages and the latest historyId', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ // history.list
        history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }],
        historyId: '1050',
      })
      .mockResolvedValueOnce({ // messages.get m1
        id: 'm1', threadId: 't1', labelIds: ['INBOX'], internalDate: '1700000000000',
        payload: {
          headers: [
            { name: 'From', value: 'Jane Doe <jane@acme.com>' },
            { name: 'Subject', value: 'Re: Quick idea' },
          ],
          mimeType: 'text/plain',
          body: { data: Buffer.from('Sounds interesting', 'utf-8').toString('base64url') },
        },
      })
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result.cursor).toBe('1050')
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      providerMessageId: 'm1', threadId: 't1', fromEmail: 'jane@acme.com',
      subject: 'Re: Quick idea', body: 'Sounds interesting',
    })
  })

  it('should skip messages we sent (SENT label)', async () => {
    mockFetchJson
      .mockResolvedValueOnce({ history: [{ messagesAdded: [{ message: { id: 'm1', threadId: 't1' } }] }], historyId: '1050' })
      .mockResolvedValueOnce({ id: 'm1', threadId: 't1', labelIds: ['SENT'], payload: { headers: [] } })
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result.messages).toHaveLength(0)
  })

  it('should re-baseline when the history cursor is too old (404)', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockFetchJson
      .mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'HTTP 404', { status: 404 }))
      .mockResolvedValueOnce({ historyId: '2000' }) // profile re-baseline
    const { result } = await gmailProvider.fetchInbound(tokens, '1000')
    expect(result).toEqual({ messages: [], cursor: '2000' })
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test src/lib/mailbox/gmail-provider.test.ts`
Expected: FAIL — `fetchInbound` not implemented.

- [ ] **Step 4: Implement Gmail `fetchInbound` + read scope**

In `src/lib/mailbox/gmail-provider.ts`:

Add the read scope to `SCOPES`:

```ts
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')
```

Update the imports line to include `isAppError` and the new types:

```ts
import { AppError, isAppError } from '@/lib/errors/app-error'
import type {
  ExchangeResult, FetchInboundResult, InboundMessage, MailboxProvider, MailboxTokens, SendEmailInput,
} from './provider'
```

Add these constants + schemas + helpers above `export const gmailProvider`:

```ts
const MAX_HISTORY_PAGES = 25 // safety cap on history pagination per poll

const gmailProfileSchema = z.object({ historyId: z.string() })
const gmailHistorySchema = z.object({
  history: z
    .array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional() }))
    .optional(),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
})
const gmailHeaderSchema = z.object({ name: z.string(), value: z.string() })

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }
const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(gmailPartSchema).optional(),
  }),
)
const gmailPayloadSchema = z.object({
  headers: z.array(gmailHeaderSchema).optional(),
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(gmailPartSchema).optional(),
})
const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  payload: gmailPayloadSchema.optional(),
})

function parseFromEmail(value: string): string | null {
  const match = value.match(/<([^>]+)>/)
  const raw = (match ? match[1]! : value).trim().toLowerCase()
  return raw.includes('@') ? raw : null
}

function extractPlainText(part: GmailPart): string | null {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8')
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child)
    if (found) return found
  }
  return null
}

async function fetchGmailHistoryId(authHeader: Record<string, string>): Promise<string> {
  const profile = await fetchJson(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { method: 'GET', headers: authHeader },
    gmailProfileSchema,
  )
  return profile.historyId
}
```

Add the `fetchInbound` method to the `gmailProvider` object (after `sendEmail`):

```ts
  async fetchInbound(tokens: MailboxTokens, cursor: string | null) {
    const fresh = await ensureFresh(tokens)
    const auth = { Authorization: `Bearer ${fresh.accessToken}` }

    if (!cursor) {
      const historyId = await fetchGmailHistoryId(auth)
      return { result: { messages: [], cursor: historyId }, tokens: fresh }
    }

    const ids: string[] = []
    let latestHistoryId = cursor
    let pageToken: string | undefined
    let pages = 0
    try {
      do {
        const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
        url.searchParams.set('startHistoryId', cursor)
        url.searchParams.set('historyTypes', 'messageAdded')
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const page = await fetchJson(url.toString(), { method: 'GET', headers: auth }, gmailHistorySchema)
        for (const entry of page.history ?? []) {
          for (const added of entry.messagesAdded ?? []) ids.push(added.message.id)
        }
        if (page.historyId) latestHistoryId = page.historyId
        pageToken = page.nextPageToken
        pages += 1
      } while (pageToken && pages < MAX_HISTORY_PAGES)
    } catch (error) {
      // 404 = startHistoryId expired; re-baseline to the current position and
      // skip this cycle rather than replaying the whole mailbox.
      if (isAppError(error) && (error.context as { status?: number }).status === 404) {
        const historyId = await fetchGmailHistoryId(auth)
        return { result: { messages: [], cursor: historyId }, tokens: fresh }
      }
      throw error
    }

    const messages: InboundMessage[] = []
    for (const id of Array.from(new Set(ids))) {
      const message = await fetchJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { method: 'GET', headers: auth },
        gmailMessageSchema,
      )
      const labels = message.labelIds ?? []
      if (labels.includes('SENT') || labels.includes('DRAFT')) continue
      const headers = message.payload?.headers ?? []
      const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? ''
      const fromEmail = parseFromEmail(fromHeader)
      if (!fromEmail) continue
      const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? null
      const body = (message.payload ? extractPlainText(message.payload) : null) ?? ''
      const receivedAt = message.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : new Date().toISOString()
      messages.push({ providerMessageId: message.id, threadId: message.threadId, fromEmail, subject, body, receivedAt })
    }

    const result: FetchInboundResult = { messages, cursor: latestHistoryId }
    return { result, tokens: fresh }
  },
```

- [ ] **Step 5: Run Gmail tests to verify they pass**

Run: `pnpm test src/lib/mailbox/gmail-provider.test.ts`
Expected: PASS.

- [ ] **Step 6: Write failing Outlook tests**

Append to `src/lib/mailbox/outlook-provider.test.ts`:

```ts
describe('outlookProvider.fetchInbound', () => {
  const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }

  it('should baseline (no messages) when cursor is null', async () => {
    mockFetchJson.mockResolvedValueOnce({ value: [], '@odata.deltaLink': 'https://graph/delta?token=xyz' })
    const { result } = await outlookProvider.fetchInbound(tokens, null)
    expect(result).toEqual({ messages: [], cursor: 'https://graph/delta?token=xyz' })
  })

  it('should map delta messages and return the next delta link', async () => {
    mockFetchJson.mockResolvedValueOnce({
      value: [
        {
          id: 'g1', conversationId: 'conv1', subject: 'Re: Quick idea',
          from: { emailAddress: { address: 'Jane@Acme.com' } },
          receivedDateTime: '2026-07-19T10:00:00Z',
          body: { content: 'Interested' }, isDraft: false,
        },
      ],
      '@odata.deltaLink': 'https://graph/delta?token=next',
    })
    const { result } = await outlookProvider.fetchInbound(tokens, 'https://graph/delta?token=prev')
    expect(result.cursor).toBe('https://graph/delta?token=next')
    expect(result.messages[0]).toMatchObject({
      providerMessageId: 'g1', threadId: 'conv1', fromEmail: 'jane@acme.com', body: 'Interested',
    })
  })

  it('should skip drafts and messages without a sender', async () => {
    mockFetchJson.mockResolvedValueOnce({
      value: [
        { id: 'd1', isDraft: true, from: { emailAddress: { address: 'x@y.com' } } },
        { id: 'n1', isDraft: false, from: null },
      ],
      '@odata.deltaLink': 'https://graph/delta?token=next',
    })
    const { result } = await outlookProvider.fetchInbound(tokens, 'https://graph/delta?token=prev')
    expect(result.messages).toHaveLength(0)
  })
})
```

- [ ] **Step 7: Implement Outlook `fetchInbound` + read scope**

In `src/lib/mailbox/outlook-provider.ts`:

Add `Mail.Read` to `SCOPES`:

```ts
const SCOPES = [
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
].join(' ')
```

Update imports to include the new types:

```ts
import type {
  ExchangeResult, FetchInboundResult, InboundMessage, MailboxProvider, MailboxTokens, SendEmailInput,
} from './provider'
```

Add constants + schema above `export const outlookProvider`:

```ts
const MAX_DELTA_PAGES = 25
const INBOX_DELTA_URL =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta' +
  '?$select=id,conversationId,subject,from,receivedDateTime,body,isDraft'

const graphMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  subject: z.string().nullable().optional(),
  from: z
    .object({ emailAddress: z.object({ address: z.string().optional() }).optional() })
    .nullable()
    .optional(),
  receivedDateTime: z.string().optional(),
  body: z.object({ content: z.string().optional() }).nullable().optional(),
  isDraft: z.boolean().optional(),
})
const graphDeltaSchema = z.object({
  value: z.array(graphMessageSchema),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
})

function toInboundMessage(m: z.infer<typeof graphMessageSchema>): InboundMessage | null {
  if (m.isDraft) return null
  const address = m.from?.emailAddress?.address
  if (!address) return null
  return {
    providerMessageId: m.id,
    threadId: m.conversationId ?? m.id,
    fromEmail: address.trim().toLowerCase(),
    subject: m.subject ?? null,
    body: m.body?.content ?? '',
    receivedAt: m.receivedDateTime ?? new Date().toISOString(),
  }
}
```

Add the `fetchInbound` method to the `outlookProvider` object (after `sendEmail`). It requests plain-text bodies via the `Prefer` header and walks `@odata.nextLink` pages until a `@odata.deltaLink` is returned:

```ts
  async fetchInbound(tokens: MailboxTokens, cursor: string | null) {
    const fresh = await ensureFresh(tokens)
    const headers = {
      Authorization: `Bearer ${fresh.accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    }

    const messages: InboundMessage[] = []
    let nextUrl: string | undefined = cursor ?? INBOX_DELTA_URL
    let deltaLink: string | undefined
    let pages = 0

    while (nextUrl && pages < MAX_DELTA_PAGES) {
      const page: z.infer<typeof graphDeltaSchema> = await fetchJson(
        nextUrl,
        { method: 'GET', headers },
        graphDeltaSchema,
      )
      // On a fresh baseline (cursor === null) we only want the delta link, not
      // the backlog — so skip mapping until we already had a cursor.
      if (cursor) {
        for (const raw of page.value) {
          const mapped = toInboundMessage(raw)
          if (mapped) messages.push(mapped)
        }
      }
      deltaLink = page['@odata.deltaLink']
      nextUrl = page['@odata.nextLink']
      pages += 1
    }

    // Graph always terminates a delta walk with a deltaLink; fall back to the
    // previous cursor (or the base URL) if a page cap cut us off mid-walk.
    const nextCursor = deltaLink ?? cursor ?? INBOX_DELTA_URL
    const result: FetchInboundResult = { messages, cursor: nextCursor }
    return { result, tokens: fresh }
  },
```

- [ ] **Step 8: Run Outlook tests to verify they pass**

Run: `pnpm test src/lib/mailbox/outlook-provider.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 10: Commit**

```bash
git add src/lib/mailbox/provider.ts src/lib/mailbox/gmail-provider.ts src/lib/mailbox/gmail-provider.test.ts src/lib/mailbox/outlook-provider.ts src/lib/mailbox/outlook-provider.test.ts
git commit -m "feat(p3): provider fetchInbound (Gmail history + Graph delta) with read scopes"
```

---

### Task 6: Shared token parser + mailbox reader

**Files:**
- Create: `src/lib/mailbox/tokens.ts`
- Modify: `src/lib/mailbox/sender.ts`
- Create: `src/lib/mailbox/reader.ts`
- Test: `src/lib/mailbox/reader.test.ts`

**Interfaces:**
- Consumes: `getMailboxProvider`, `updateMailboxOauth`, `logEventSafe`, `MailboxRow`, `MailboxProvider.fetchInbound`.
- Produces:
  - `parseMailboxTokens(oauth: Json, mailboxId: string): MailboxTokens`
  - `readInboundForMailbox(supabase, mailbox: MailboxRow): Promise<FetchInboundResult>`

- [ ] **Step 1: Extract the shared token parser**

Create `src/lib/mailbox/tokens.ts`:

```ts
import { z } from 'zod'
import type { Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { MailboxTokens } from './provider'

const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

// Validates the mailbox oauth jsonb into typed tokens. Throws on malformed
// tokens — a mailbox with unusable credentials is a programming/config error,
// not an operational one.
export function parseMailboxTokens(oauth: Json, mailboxId: string): MailboxTokens {
  const parsed = tokensSchema.safeParse(oauth)
  if (!parsed.success) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox oauth tokens malformed', { mailboxId })
  }
  return parsed.data
}
```

- [ ] **Step 2: Point sender.ts at the shared parser**

In `src/lib/mailbox/sender.ts`, remove the local `tokensSchema` const and the `parseTokens` function, and replace their usage. Update imports: add `import { parseMailboxTokens } from './tokens'`, and drop the now-unused `z` import and `Json` type import if they become unused (keep `Json` only if still referenced). Change the one call site:

```ts
    const tokens = parseMailboxTokens(claimed.oauth, claimed.id)
```

- [ ] **Step 3: Run sender tests to confirm no regression**

Run: `pnpm test src/lib/mailbox/sender.test.ts`
Expected: PASS (unchanged behavior).

- [ ] **Step 4: Write a failing reader test**

Create `src/lib/mailbox/reader.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getMailboxProviderMock = vi.fn()
const updateMailboxOauthMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/mailbox/registry', () => ({ getMailboxProvider: (...a: unknown[]) => getMailboxProviderMock(...a) }))
vi.mock('@/lib/db/mailboxes', () => ({ updateMailboxOauth: (...a: unknown[]) => updateMailboxOauthMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { readInboundForMailbox } from './reader'

const mailbox = {
  id: 'm1', client_id: 'c1', provider: 'gmail',
  oauth: { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() },
  inbound_cursor: '1000',
} as never

beforeEach(() => {
  getMailboxProviderMock.mockReset(); updateMailboxOauthMock.mockReset(); logEventMock.mockReset()
})

describe('readInboundForMailbox', () => {
  it('should fetch inbound, persist refreshed tokens, and return the result', async () => {
    const fetchInbound = vi.fn().mockResolvedValue({
      result: { messages: [{ providerMessageId: 'm1' }], cursor: '1050' },
      tokens: { accessToken: 'at2', refreshToken: 'rt', expiresAt: 'later' },
    })
    getMailboxProviderMock.mockReturnValue({ fetchInbound })
    const result = await readInboundForMailbox({} as never, mailbox)
    expect(fetchInbound).toHaveBeenCalledWith(expect.objectContaining({ accessToken: 'at' }), '1000')
    expect(updateMailboxOauthMock).toHaveBeenCalledWith({}, 'm1', expect.objectContaining({ accessToken: 'at2' }))
    expect(result.cursor).toBe('1050')
  })

  it('should not fail the read when persisting refreshed tokens fails', async () => {
    getMailboxProviderMock.mockReturnValue({
      fetchInbound: vi.fn().mockResolvedValue({ result: { messages: [], cursor: '1050' }, tokens: { accessToken: 'at2' } }),
    })
    updateMailboxOauthMock.mockRejectedValue(new Error('db down'))
    const result = await readInboundForMailbox({} as never, mailbox)
    expect(result.cursor).toBe('1050')
    expect(logEventMock).toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Run to verify failure**

Run: `pnpm test src/lib/mailbox/reader.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 6: Implement the reader**

Create `src/lib/mailbox/reader.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { updateMailboxOauth, type MailboxRow } from '@/lib/db/mailboxes'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { parseMailboxTokens } from '@/lib/mailbox/tokens'
import type { FetchInboundResult } from '@/lib/mailbox/provider'
import { logEventSafe } from '@/lib/events/log-event'

// Runs a mailbox's provider fetchInbound and persists any refreshed access
// token. Token persistence is best-effort: a persistence failure must not fail
// the read (the messages were already fetched), so it is logged, not thrown.
export async function readInboundForMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
): Promise<FetchInboundResult> {
  const tokens = parseMailboxTokens(mailbox.oauth, mailbox.id)
  const provider = getMailboxProvider(mailbox.provider)
  const { result, tokens: refreshed } = await provider.fetchInbound(tokens, mailbox.inbound_cursor)

  try {
    await updateMailboxOauth(supabase, mailbox.id, { ...refreshed })
  } catch (error) {
    await logEventSafe({
      clientId: mailbox.client_id,
      actor: 'mailbox_reader',
      type: 'mailbox.oauth_persist_failed',
      payload: { mailboxId: mailbox.id, cause: error instanceof Error ? error.message : String(error) },
    })
  }

  return result
}
```

- [ ] **Step 7: Run reader + sender tests**

Run: `pnpm test src/lib/mailbox/reader.test.ts src/lib/mailbox/sender.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/lib/mailbox/tokens.ts src/lib/mailbox/sender.ts src/lib/mailbox/reader.ts src/lib/mailbox/reader.test.ts
git commit -m "feat(p3): shared token parser + mailbox reader (refresh-token persistence)"
```

---

### Task 7: Inbound ingestion pipeline

**Files:**
- Create: `src/lib/pipeline/inbound.ts`
- Test: `src/lib/pipeline/inbound.test.ts`

**Interfaces:**
- Consumes: `readInboundForMailbox`, `findContactedLeadByEmail`, `insertInboundEmail`, `pauseActiveSequenceForLead`, `updateInboundCursor`, `publishJson`, `logEventSafe`, `MailboxRow`.
- Produces: `ingestInboundForMailbox(supabase, mailbox): Promise<IngestSummary>` (see Interfaces section).

- [ ] **Step 1: Write failing tests**

Create `src/lib/pipeline/inbound.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const readInboundMock = vi.fn()
const findLeadMock = vi.fn()
const insertInboundMock = vi.fn()
const pauseSequenceMock = vi.fn()
const updateCursorMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/mailbox/reader', () => ({ readInboundForMailbox: (...a: unknown[]) => readInboundMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ findContactedLeadByEmail: (...a: unknown[]) => findLeadMock(...a) }))
vi.mock('@/lib/db/emails', () => ({ insertInboundEmail: (...a: unknown[]) => insertInboundMock(...a) }))
vi.mock('@/lib/db/sequences', () => ({ pauseActiveSequenceForLead: (...a: unknown[]) => pauseSequenceMock(...a) }))
vi.mock('@/lib/db/mailboxes', () => ({ updateInboundCursor: (...a: unknown[]) => updateCursorMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { ingestInboundForMailbox } from './inbound'

const mailbox = { id: 'm1', client_id: 'c1' } as never
const message = {
  providerMessageId: 'g1', threadId: 't1', fromEmail: 'jane@acme.com',
  subject: 'Re: idea', body: 'Interested', receivedAt: '2026-07-19T10:00:00Z',
}

beforeEach(() => {
  for (const m of [readInboundMock, findLeadMock, insertInboundMock, pauseSequenceMock, updateCursorMock, publishJsonMock, logEventMock]) m.mockReset()
  readInboundMock.mockResolvedValue({ messages: [message], cursor: '1050' })
  findLeadMock.mockResolvedValue({ id: 'lead1', case_id: 'case1' })
  insertInboundMock.mockResolvedValue({ id: 'in1' })
})

describe('ingestInboundForMailbox', () => {
  it('should ingest a matched reply, pause the sequence, enqueue reply, and advance the cursor', async () => {
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(insertInboundMock).toHaveBeenCalledWith({}, expect.objectContaining({ direction: 'inbound', lead_id: 'lead1', case_id: 'case1' }))
    expect(pauseSequenceMock).toHaveBeenCalledWith({}, 'lead1')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/inbound/reply', { emailId: 'in1' })
    expect(updateCursorMock).toHaveBeenCalledWith({}, 'm1', '1050')
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 1, enqueued: 1 })
  })

  it('should skip a message with no matching contacted lead', async () => {
    findLeadMock.mockResolvedValue(null)
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(insertInboundMock).not.toHaveBeenCalled()
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 0, enqueued: 0 })
    expect(updateCursorMock).toHaveBeenCalledWith({}, 'm1', '1050')
  })

  it('should not re-pause or re-enqueue an already-ingested message', async () => {
    insertInboundMock.mockResolvedValue(null) // dedup: already ingested
    const summary = await ingestInboundForMailbox({} as never, mailbox)
    expect(pauseSequenceMock).not.toHaveBeenCalled()
    expect(publishJsonMock).not.toHaveBeenCalled()
    expect(summary).toEqual({ mailboxId: 'm1', ingested: 0, enqueued: 0 })
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/pipeline/inbound.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the ingestion pipeline**

Create `src/lib/pipeline/inbound.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { readInboundForMailbox } from '@/lib/mailbox/reader'
import type { MailboxRow } from '@/lib/db/mailboxes'
import { updateInboundCursor } from '@/lib/db/mailboxes'
import { findContactedLeadByEmail } from '@/lib/db/leads'
import { insertInboundEmail } from '@/lib/db/emails'
import { pauseActiveSequenceForLead } from '@/lib/db/sequences'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'inbound_ingest'

export interface IngestSummary {
  mailboxId: string
  ingested: number
  enqueued: number
}

// Polls one mailbox for new inbound mail, matches each message to a contacted
// lead by sender address, stores it (deduped), pauses that lead's sequence, and
// fans one QStash message per new inbound to the Reply Agent. The cursor is
// advanced only after the loop, so a mid-loop crash re-processes on retry —
// safe because insertInboundEmail is deduped on provider_message_id.
export async function ingestInboundForMailbox(
  supabase: SupabaseClient<Database>,
  mailbox: MailboxRow,
): Promise<IngestSummary> {
  const { messages, cursor } = await readInboundForMailbox(supabase, mailbox)

  let ingested = 0
  let enqueued = 0

  for (const message of messages) {
    const lead = await findContactedLeadByEmail(supabase, mailbox.client_id, message.fromEmail)
    if (!lead || !lead.case_id) continue // not a reply to our outreach

    const inbound = await insertInboundEmail(supabase, {
      client_id: mailbox.client_id,
      case_id: lead.case_id,
      lead_id: lead.id,
      thread_id: message.threadId,
      provider_message_id: message.providerMessageId,
      direction: 'inbound',
      subject: message.subject,
      body: message.body,
      status: 'delivered',
      mailbox_id: mailbox.id,
    })
    if (!inbound) continue // already ingested — don't re-pause / re-enqueue

    ingested += 1
    await pauseActiveSequenceForLead(supabase, lead.id)
    await publishJson('/api/inbound/reply', { emailId: inbound.id })
    enqueued += 1

    await logEventSafe({
      clientId: mailbox.client_id,
      caseId: lead.case_id,
      actor: ACTOR,
      type: 'inbound.received',
      payload: { emailId: inbound.id, leadId: lead.id, mailboxId: mailbox.id },
    })
  }

  await updateInboundCursor(supabase, mailbox.id, cursor)
  return { mailboxId: mailbox.id, ingested, enqueued }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/pipeline/inbound.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/inbound.ts src/lib/pipeline/inbound.test.ts
git commit -m "feat(p3): inbound ingestion pipeline (match, dedup, pause, fan-out)"
```

---

### Task 8: Reply Agent — classify + route

**Files:**
- Create: `src/lib/pipeline/reply.ts`
- Test: `src/lib/pipeline/reply.test.ts`

**Interfaces:**
- Consumes: `getEmailById`, `getLeadById`, `getCampaignForCase`, `listThreadEmails`, `listKnowledgeForCase`, `claimReplyEmail`, `markEmailSent`, `markEmailFailed`, `addSuppression`, `stopSequenceForLead`, `updateCaseStatus`, `createKnowledgeRequest`, `sendViaMailbox`, `generateJson`, `logEventSafe`.
- Produces: `ReplyIntent`, `ReplyClassification`, `ReplySummary`, `classifyReply`, `replyDisposition`, `sendOrDraftReply`, `runReplyForInbound` (see Interfaces section).

- [ ] **Step 1: Write failing tests**

Create `src/lib/pipeline/reply.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getEmailByIdMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const listKnowledgeMock = vi.fn()
const claimReplyEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const addSuppressionMock = vi.fn()
const stopSequenceForLeadMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const createKnowledgeRequestMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimReplyEmail: (...a: unknown[]) => claimReplyEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ addSuppression: (...a: unknown[]) => addSuppressionMock(...a) }))
vi.mock('@/lib/db/sequences', () => ({ stopSequenceForLead: (...a: unknown[]) => stopSequenceForLeadMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/db/knowledge-requests', () => ({ createKnowledgeRequest: (...a: unknown[]) => createKnowledgeRequestMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { runReplyForInbound, replyDisposition } from './reply'

const inbound = {
  id: 'in1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  direction: 'inbound', thread_id: 't1', provider_message_id: 'g1', body: 'Hi',
}
const lead = { id: 'lead1', email: 'jane@acme.com' }
const campaign = { mailbox_ids: ['m1'], value_prop: 'v', booking_link: 'https://cal.com/x', reply_mode: 'auto_send' }

beforeEach(() => {
  for (const m of [getEmailByIdMock, getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, listKnowledgeMock,
    claimReplyEmailMock, markEmailSentMock, markEmailFailedMock, addSuppressionMock, stopSequenceForLeadMock,
    updateCaseStatusMock, createKnowledgeRequestMock, sendViaMailboxMock, generateJsonMock, logEventMock]) m.mockReset()
  getEmailByIdMock.mockResolvedValue(inbound)
  getLeadByIdMock.mockResolvedValue(lead)
  getCampaignForCaseMock.mockResolvedValue(campaign)
  listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea', provider_message_id: 'out1' }])
  listKnowledgeMock.mockResolvedValue([])
  claimReplyEmailMock.mockResolvedValue({ id: 'reply1' })
  sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'p2', threadId: 't1' })
})

describe('replyDisposition', () => {
  it('should draft for human_approve regardless of confidence', () => {
    expect(replyDisposition('human_approve', 0.99)).toBe('draft')
  })
  it('should send for hybrid only when confident', () => {
    expect(replyDisposition('hybrid', 0.9)).toBe('send')
    expect(replyDisposition('hybrid', 0.5)).toBe('draft')
  })
})

describe('runReplyForInbound', () => {
  it('should answer and send when the reply is answerable (auto_send)', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Here is the answer.' })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'in_conversation')
    expect(result.action).toBe('answered')
  })

  it('should escalate a knowledge gap without sending', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: false, missingQuestion: 'What is our SLA?', replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(createKnowledgeRequestMock).toHaveBeenCalledWith({}, expect.objectContaining({ question: 'What is our SLA?', email_id: 'in1' }))
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(result.action).toBe('escalated')
  })

  it('should hand off on price intent: reply, suppress, stop, hot_handoff', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'price', confidence: 0.8, canAnswer: false, missingQuestion: null, replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).toHaveBeenCalled() // booking-link reply
    expect(addSuppressionMock).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'price_handoff' }))
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'lead1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'hot_handoff')
    expect(result.action).toBe('handoff')
  })

  it('should suppress and stop on not_interested without replying', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'not_interested', confidence: 0.9, canAnswer: false, missingQuestion: null, replyBody: null })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(addSuppressionMock).toHaveBeenCalledWith({}, expect.objectContaining({ reason: 'manual' }))
    expect(stopSequenceForLeadMock).toHaveBeenCalledWith({}, 'lead1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith({}, 'case1', 'lost')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(result.action).toBe('suppressed')
  })

  it('should draft (not send) when the reply slot is already claimed', async () => {
    generateJsonMock.mockResolvedValue({ intent: 'question', confidence: 0.9, canAnswer: true, missingQuestion: null, replyBody: 'Answer' })
    claimReplyEmailMock.mockResolvedValue(null) // already handled by a prior delivery
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
    expect(result.action).toBe('answered')
  })

  it('should skip when the email is not an inbound record', async () => {
    getEmailByIdMock.mockResolvedValue({ ...inbound, direction: 'outbound' })
    const result = await runReplyForInbound({} as never, { emailId: 'in1' })
    expect(result.action).toBe('skipped')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/pipeline/reply.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the Reply Agent**

Create `src/lib/pipeline/reply.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  getEmailById, listThreadEmails, claimReplyEmail, markEmailSent, markEmailFailed, type EmailRow,
} from '@/lib/db/emails'
import { getLeadById, type LeadRow } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { addSuppression } from '@/lib/db/suppressions'
import { stopSequenceForLead } from '@/lib/db/sequences'
import { updateCaseStatus } from '@/lib/db/cases'
import { createKnowledgeRequest } from '@/lib/db/knowledge-requests'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'reply_agent'
const MAX_OUTPUT_TOKENS = 600
// Below this the hybrid mode routes to a human draft instead of auto-sending.
const HYBRID_CONFIDENCE_THRESHOLD = 0.75

type ReplyMode = Database['public']['Enums']['reply_mode']
export type ReplyIntent = 'question' | 'interested' | 'price' | 'not_interested' | 'other'

const classificationSchema = z.object({
  intent: z.enum(['question', 'interested', 'price', 'not_interested', 'other']),
  confidence: z.number().min(0).max(1),
  canAnswer: z.boolean(),
  missingQuestion: z.string().nullable(),
  replyBody: z.string().nullable(),
})
export type ReplyClassification = z.infer<typeof classificationSchema>

export interface ReplySummary {
  emailId: string
  action: 'answered' | 'escalated' | 'handoff' | 'suppressed' | 'skipped'
}

const SYSTEM_PROMPT = [
  'You triage inbound replies to a B2B cold email and decide how to respond.',
  'Use ONLY the dossier facts and the prior thread. Never invent a business fact.',
  'Classify intent: question, interested, price (pricing/quote/buying signal),',
  'not_interested (opt-out / unsubscribe / "stop"), or other.',
  'Set canAnswer=true only if you can fully answer from the dossier/thread without',
  'inventing anything, and then put the ready-to-send reply body in replyBody.',
  'If a real business fact is missing, set canAnswer=false and put the exact',
  'question to ask a human in missingQuestion. For price/not_interested, leave',
  'replyBody null. confidence is your 0..1 certainty in the classification+answer.',
  'Replies are short, human, no bulk markers, no unsubscribe footer.',
].join(' ')

function buildClassifyPrompt(args: {
  thread: EmailRow[]; knowledge: KnowledgeRow[]; valueProp: string | null; inboundBody: string
}): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const transcript = args.thread
    .map((e) => `[${e.direction}] ${e.subject ?? ''}\n${e.body ?? ''}`)
    .join('\n---\n')
  return [
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    `Dossier:\n${dossier}`,
    `Thread so far:\n${transcript}`,
    `Latest inbound reply to triage:\n${args.inboundBody}`,
  ].join('\n\n')
}

export async function classifyReply(
  context: LlmCallContext,
  args: { thread: EmailRow[]; knowledge: KnowledgeRow[]; valueProp: string | null; inboundBody: string },
): Promise<ReplyClassification> {
  return generateJson(context, {
    system: SYSTEM_PROMPT,
    prompt: buildClassifyPrompt(args),
    schema: classificationSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
}

// human_approve always drafts; auto_send always sends; hybrid sends only when
// the agent is confident, otherwise drafts to /inbox for a human ("escalate").
export function replyDisposition(mode: ReplyMode, confidence: number): 'send' | 'draft' {
  if (mode === 'human_approve') return 'draft'
  if (mode === 'auto_send') return 'send'
  return confidence >= HYBRID_CONFIDENCE_THRESHOLD ? 'send' : 'draft'
}

function replySubject(thread: EmailRow[]): string {
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const base = firstOutbound?.subject ?? 'Re: your message'
  return base.startsWith('Re: ') ? base : `Re: ${base}`
}

interface SendOrDraftInput {
  inbound: EmailRow
  lead: LeadRow
  mailboxIds: string[]
  subject: string
  body: string
  disposition: 'send' | 'draft'
}

// Claims the one-reply-per-inbound slot, then sends or leaves a draft. Idempotent
// on retry: a claimed slot returns null and no second reply is sent.
export async function sendOrDraftReply(
  supabase: SupabaseClient<Database>,
  input: SendOrDraftInput,
): Promise<void> {
  if (!input.lead.email) return
  const claimed = await claimReplyEmail(supabase, {
    client_id: input.inbound.client_id,
    case_id: input.inbound.case_id,
    lead_id: input.inbound.lead_id,
    thread_id: input.inbound.thread_id,
    direction: 'outbound',
    subject: input.subject,
    body: input.body,
    status: input.disposition === 'send' ? 'queued' : 'draft',
    in_reply_to_email_id: input.inbound.id,
  })
  if (!claimed) return // already handled by a prior delivery
  if (input.disposition === 'draft') return // sits in /inbox for a human

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: input.inbound.client_id,
      mailboxIds: input.mailboxIds,
      to: input.lead.email,
      subject: input.subject,
      body: input.body,
      threadId: input.inbound.thread_id,
      inReplyToMessageId: input.inbound.provider_message_id,
      references: input.inbound.provider_message_id,
    })
  } catch (error) {
    await markEmailFailed(supabase, claimed.id)
    if (error instanceof AppError && error.code === 'RATE_LIMITED') return
    throw error
  }
  await markEmailSent(supabase, claimed.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })
}

function buildBookingReply(bookingLink: string | null): string {
  const link = bookingLink ?? '(booking link unavailable — a colleague will follow up)'
  return [
    'Thanks for the interest — happy to walk through pricing on a quick call.',
    `Grab whatever time works best here: ${link}`,
  ].join(' ')
}

export async function runReplyForInbound(
  supabase: SupabaseClient<Database>,
  input: { emailId: string },
): Promise<ReplySummary> {
  const inbound = await getEmailById(supabase, input.emailId)
  if (!inbound || inbound.direction !== 'inbound' || !inbound.lead_id || !inbound.case_id) {
    return { emailId: input.emailId, action: 'skipped' }
  }
  const lead = await getLeadById(supabase, inbound.lead_id)
  if (!lead?.email) return { emailId: input.emailId, action: 'skipped' }

  const campaign = await getCampaignForCase(supabase, inbound.case_id)
  if (!campaign) return { emailId: input.emailId, action: 'skipped' }

  const [thread, knowledge] = await Promise.all([
    listThreadEmails(supabase, inbound.lead_id),
    listKnowledgeForCase(supabase, inbound.case_id),
  ])

  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const classification = await classifyReply(context, {
    thread, knowledge, valueProp: campaign.value_prop, inboundBody: inbound.body ?? '',
  })

  // A reply always means we are in a conversation now.
  await updateCaseStatus(supabase, inbound.case_id, 'in_conversation')

  switch (classification.intent) {
    case 'price': {
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: buildBookingReply(campaign.booking_link),
        disposition: replyDisposition(campaign.reply_mode, 1),
      })
      await addSuppression(supabase, { clientId: inbound.client_id, email: lead.email, reason: 'price_handoff' })
      await stopSequenceForLead(supabase, inbound.lead_id, 'stopped')
      await updateCaseStatus(supabase, inbound.case_id, 'hot_handoff')
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.price_handoff', payload: { emailId: inbound.id, leadId: inbound.lead_id },
      })
      return { emailId: inbound.id, action: 'handoff' }
    }
    case 'not_interested': {
      await addSuppression(supabase, { clientId: inbound.client_id, email: lead.email, reason: 'manual' })
      await stopSequenceForLead(supabase, inbound.lead_id, 'stopped')
      await updateCaseStatus(supabase, inbound.case_id, 'lost')
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.opt_out', payload: { emailId: inbound.id, leadId: inbound.lead_id },
      })
      return { emailId: inbound.id, action: 'suppressed' }
    }
    case 'question':
    case 'interested':
    case 'other': {
      if (!classification.canAnswer || classification.replyBody === null) {
        const question = classification.missingQuestion
          ?? 'Cannot answer this reply automatically — please review the thread.'
        await createKnowledgeRequest(supabase, {
          client_id: inbound.client_id,
          case_id: inbound.case_id,
          lead_id: inbound.lead_id,
          email_id: inbound.id,
          question,
        })
        await logEventSafe({
          clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
          type: 'reply.knowledge_gap', payload: { emailId: inbound.id, question },
        })
        return { emailId: inbound.id, action: 'escalated' }
      }
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: classification.replyBody,
        disposition: replyDisposition(campaign.reply_mode, classification.confidence),
      })
      await logEventSafe({
        clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
        type: 'reply.answered', payload: { emailId: inbound.id, intent: classification.intent },
      })
      return { emailId: inbound.id, action: 'answered' }
    }
    default: {
      const exhaustive: never = classification.intent
      throw new AppError('INVARIANT_VIOLATION', 'Unhandled reply intent', { intent: String(exhaustive) })
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/pipeline/reply.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/reply.ts src/lib/pipeline/reply.test.ts
git commit -m "feat(p3): Reply Agent — classify intent + route (answer/escalate/handoff/opt-out)"
```

---

### Task 9: Knowledge-answer pipeline

**Files:**
- Create: `src/lib/pipeline/knowledge-answer.ts`
- Test: `src/lib/pipeline/knowledge-answer.test.ts`

**Interfaces:**
- Consumes: `getKnowledgeRequestById`, `getEmailById`, `getLeadById`, `getCampaignForCase`, `listThreadEmails`, `listKnowledgeForCase`, `generateText`, `sendOrDraftReply`, `replyDisposition`, `logEventSafe`.
- Produces: `runKnowledgeAnswer(supabase, { knowledgeRequestId }): Promise<{ knowledgeRequestId: string; action: 'sent' | 'drafted' | 'skipped' }>`.

- [ ] **Step 1: Write failing tests**

Create `src/lib/pipeline/knowledge-answer.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getKrMock = vi.fn()
const getEmailByIdMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const listKnowledgeMock = vi.fn()
const generateTextMock = vi.fn()
const sendOrDraftReplyMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/knowledge-requests', () => ({ getKnowledgeRequestById: (...a: unknown[]) => getKrMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }))
vi.mock('@/lib/pipeline/reply', () => ({
  sendOrDraftReply: (...a: unknown[]) => sendOrDraftReplyMock(...a),
  replyDisposition: () => 'send',
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { runKnowledgeAnswer } from './knowledge-answer'

beforeEach(() => {
  for (const m of [getKrMock, getEmailByIdMock, getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, listKnowledgeMock, generateTextMock, sendOrDraftReplyMock, logEventMock]) m.mockReset()
  getKrMock.mockResolvedValue({ id: 'kr1', status: 'answered', email_id: 'in1', human_answer: 'Our SLA is 99.9%', client_id: 'c1', case_id: 'case1' })
  getEmailByIdMock.mockResolvedValue({ id: 'in1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', direction: 'inbound', thread_id: 't1', provider_message_id: 'g1' })
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', email: 'jane@acme.com' })
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', reply_mode: 'auto_send' })
  listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea' }])
  listKnowledgeMock.mockResolvedValue([{ kind: 'answer', content: 'Our SLA is 99.9%' }])
  generateTextMock.mockResolvedValue('Great question — our SLA is 99.9%.')
})

describe('runKnowledgeAnswer', () => {
  it('should generate and send a reply grounded on the human answer', async () => {
    const result = await runKnowledgeAnswer({} as never, { knowledgeRequestId: 'kr1' })
    expect(generateTextMock).toHaveBeenCalled()
    expect(sendOrDraftReplyMock).toHaveBeenCalledWith({}, expect.objectContaining({ disposition: 'send', body: 'Great question — our SLA is 99.9%.' }))
    expect(result.action).toBe('sent')
  })

  it('should skip when the request is not answered yet', async () => {
    getKrMock.mockResolvedValue({ id: 'kr1', status: 'open', email_id: 'in1', human_answer: null })
    const result = await runKnowledgeAnswer({} as never, { knowledgeRequestId: 'kr1' })
    expect(sendOrDraftReplyMock).not.toHaveBeenCalled()
    expect(result.action).toBe('skipped')
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/lib/pipeline/knowledge-answer.test.ts`
Expected: FAIL — module does not exist.

- [ ] **Step 3: Implement the knowledge-answer pipeline**

Create `src/lib/pipeline/knowledge-answer.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getKnowledgeRequestById } from '@/lib/db/knowledge-requests'
import { getEmailById, listThreadEmails, type EmailRow } from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { generateText, type LlmCallContext } from '@/lib/llm/client'
import { sendOrDraftReply, replyDisposition } from '@/lib/pipeline/reply'
import { logEventSafe } from '@/lib/events/log-event'

const ACTOR = 'reply_agent'
const MAX_OUTPUT_TOKENS = 500

const SYSTEM_PROMPT = [
  'You write the reply to a prospect once a human colleague has supplied the',
  'previously-missing fact. Ground the reply in that fact and the dossier — never',
  'add anything beyond them. Short, human, no bulk markers, under 90 words.',
].join(' ')

function buildAnswerPrompt(args: {
  thread: EmailRow[]; knowledge: KnowledgeRow[]; humanAnswer: string; valueProp: string | null
}): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const lastInbound = [...args.thread].reverse().find((e) => e.direction === 'inbound')
  return [
    `The colleague's answer to use: ${args.humanAnswer}`,
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    `Dossier:\n${dossier}`,
    `The prospect's question:\n${lastInbound?.body ?? ''}`,
    'Write only the reply body (no subject line).',
  ].join('\n\n')
}

function replySubject(thread: EmailRow[]): string {
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const base = firstOutbound?.subject ?? 'Re: your message'
  return base.startsWith('Re: ') ? base : `Re: ${base}`
}

// Runs after a human answers a knowledge_request in /inbox: writes the reply in
// the AI's voice grounded on the human-supplied fact and sends per reply mode.
// Idempotent via sendOrDraftReply's one-reply-per-inbound claim.
export async function runKnowledgeAnswer(
  supabase: SupabaseClient<Database>,
  input: { knowledgeRequestId: string },
): Promise<{ knowledgeRequestId: string; action: 'sent' | 'drafted' | 'skipped' }> {
  const kr = await getKnowledgeRequestById(supabase, input.knowledgeRequestId)
  if (!kr || kr.status !== 'answered' || !kr.email_id || !kr.human_answer) {
    return { knowledgeRequestId: input.knowledgeRequestId, action: 'skipped' }
  }
  const inbound = await getEmailById(supabase, kr.email_id)
  if (!inbound || inbound.direction !== 'inbound' || !inbound.lead_id || !inbound.case_id) {
    return { knowledgeRequestId: kr.id, action: 'skipped' }
  }
  const lead = await getLeadById(supabase, inbound.lead_id)
  if (!lead?.email) return { knowledgeRequestId: kr.id, action: 'skipped' }

  const campaign = await getCampaignForCase(supabase, inbound.case_id)
  if (!campaign) return { knowledgeRequestId: kr.id, action: 'skipped' }

  const [thread, knowledge] = await Promise.all([
    listThreadEmails(supabase, inbound.lead_id),
    listKnowledgeForCase(supabase, inbound.case_id),
  ])

  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const body = await generateText(context, {
    system: SYSTEM_PROMPT,
    prompt: buildAnswerPrompt({ thread, knowledge, humanAnswer: kr.human_answer, valueProp: campaign.value_prop }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // A human confirmed the fact, so treat as fully confident.
  const disposition = replyDisposition(campaign.reply_mode, 1)
  await sendOrDraftReply(supabase, {
    inbound, lead, mailboxIds: campaign.mailbox_ids, subject: replySubject(thread), body, disposition,
  })

  await logEventSafe({
    clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
    type: 'reply.knowledge_answered', payload: { knowledgeRequestId: kr.id, emailId: inbound.id, disposition },
  })

  return { knowledgeRequestId: kr.id, action: disposition === 'send' ? 'sent' : 'drafted' }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/lib/pipeline/knowledge-answer.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/knowledge-answer.ts src/lib/pipeline/knowledge-answer.test.ts
git commit -m "feat(p3): knowledge-answer pipeline (human fact -> grounded AI reply)"
```

---

### Task 10: Poll routes (fan-out + per-mailbox)

**Files:**
- Create: `src/app/api/inbound/poll-fanout/route.ts`, `src/app/api/inbound/poll/route.ts`
- Test: `src/app/api/inbound/poll-fanout/route.test.ts`, `src/app/api/inbound/poll/route.test.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature`, `createAdminClient`, `listAllMailboxes`, `getMailboxById`, `publishJson`, `ingestInboundForMailbox`, `logEvent`, `isAppError`.

- [ ] **Step 1: Write failing tests for poll-fanout**

Create `src/app/api/inbound/poll-fanout/route.test.ts` (mirror `write-fanout` route test style):

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const listAllMailboxesMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ listAllMailboxes: (...a: unknown[]) => listAllMailboxesMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req() { return new Request('http://x/api/inbound/poll-fanout', { method: 'POST' }) }

beforeEach(() => {
  for (const m of [verifyMock, listAllMailboxesMock, publishJsonMock, logEventMock]) m.mockReset()
})

describe('POST /api/inbound/poll-fanout', () => {
  it('should publish one poll message per mailbox', async () => {
    verifyMock.mockResolvedValue('{}')
    listAllMailboxesMock.mockResolvedValue([{ id: 'm1' }, { id: 'm2' }])
    const res = await POST(req())
    expect(res.status).toBe(200)
    expect(publishJsonMock).toHaveBeenCalledTimes(2)
    expect(publishJsonMock).toHaveBeenCalledWith('/api/inbound/poll', { mailboxId: 'm1' })
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req())
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 2: Write failing tests for poll**

Create `src/app/api/inbound/poll/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const getMailboxByIdMock = vi.fn()
const ingestMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ getMailboxById: (...a: unknown[]) => getMailboxByIdMock(...a) }))
vi.mock('@/lib/pipeline/inbound', () => ({ ingestInboundForMailbox: (...a: unknown[]) => ingestMock(...a) }))

import { POST } from './route'

const MAILBOX_ID = '11111111-1111-4111-8111-111111111111'
function req(body: unknown) { return new Request('http://x/api/inbound/poll', { method: 'POST', body: JSON.stringify(body) }) }

beforeEach(() => { for (const m of [verifyMock, getMailboxByIdMock, ingestMock]) m.mockReset() })

describe('POST /api/inbound/poll', () => {
  it('should ingest inbound for the mailbox and return the summary', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ mailboxId: MAILBOX_ID }))
    getMailboxByIdMock.mockResolvedValue({ id: MAILBOX_ID })
    ingestMock.mockResolvedValue({ mailboxId: MAILBOX_ID, ingested: 1, enqueued: 1 })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.ingested).toBe(1)
  })

  it('should return 404 when the mailbox is gone', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ mailboxId: MAILBOX_ID }))
    getMailboxByIdMock.mockResolvedValue(null)
    const res = await POST(req({}))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the body is not valid JSON', async () => {
    verifyMock.mockResolvedValue('not json{')
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 3: Run to verify failure**

Run: `pnpm test src/app/api/inbound/poll-fanout/route.test.ts src/app/api/inbound/poll/route.test.ts`
Expected: FAIL — routes do not exist.

- [ ] **Step 4: Implement poll-fanout route**

Create `src/app/api/inbound/poll-fanout/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listAllMailboxes } from '@/lib/db/mailboxes'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const mailboxes = await listAllMailboxes(admin)
    const failedMailboxIds: string[] = []
    for (const mailbox of mailboxes) {
      try {
        await publishJson('/api/inbound/poll', { mailboxId: mailbox.id })
      } catch {
        failedMailboxIds.push(mailbox.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'inbound.poll_fanout.completed',
        payload: { mailboxCount: mailboxes.length, failedMailboxIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, mailboxCount: mailboxes.length, failedMailboxIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Implement poll route**

Create `src/app/api/inbound/poll/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById } from '@/lib/db/mailboxes'
import { ingestInboundForMailbox } from '@/lib/pipeline/inbound'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ mailboxId: z.string().uuid() })

export async function POST(request: Request) {
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
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, parsed.data.mailboxId)
    if (!mailbox) return NextResponse.json({ error: 'mailbox_not_found' }, { status: 404 })

    const summary = await ingestInboundForMailbox(admin, mailbox)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `pnpm test src/app/api/inbound/poll-fanout/route.test.ts src/app/api/inbound/poll/route.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/inbound/poll-fanout src/app/api/inbound/poll
git commit -m "feat(p3): inbound poll-fanout + per-mailbox poll routes"
```

---

### Task 11: Reply route

**Files:**
- Create: `src/app/api/inbound/reply/route.ts`
- Test: `src/app/api/inbound/reply/route.test.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature`, `createAdminClient`, `runReplyForInbound`, `isAppError`.

- [ ] **Step 1: Write failing tests**

Create `src/app/api/inbound/reply/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const runReplyMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/reply', () => ({ runReplyForInbound: (...a: unknown[]) => runReplyMock(...a) }))

import { POST } from './route'

const EMAIL_ID = '11111111-1111-4111-8111-111111111111'
function req(body: unknown) { return new Request('http://x/api/inbound/reply', { method: 'POST', body: JSON.stringify(body) }) }

beforeEach(() => { verifyMock.mockReset(); runReplyMock.mockReset() })

describe('POST /api/inbound/reply', () => {
  it('should run the reply agent and return the summary', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ emailId: EMAIL_ID }))
    runReplyMock.mockResolvedValue({ emailId: EMAIL_ID, action: 'answered' })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.action).toBe('answered')
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req({}))
    expect(res.status).toBe(401)
  })

  it('should return 400 when emailId is missing', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({}))
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/app/api/inbound/reply/route.test.ts`
Expected: FAIL — route does not exist.

- [ ] **Step 3: Implement the reply route**

Create `src/app/api/inbound/reply/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runReplyForInbound } from '@/lib/pipeline/reply'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ emailId: z.string().uuid() })

export async function POST(request: Request) {
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
    const admin = createAdminClient()
    const summary = await runReplyForInbound(admin, parsed.data)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm test src/app/api/inbound/reply/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/inbound/reply
git commit -m "feat(p3): /api/inbound/reply route (Reply Agent entry point)"
```

---

### Task 12: Poll cron registration script

**Files:**
- Create: `scripts/schedule-inbound-poll-cron.ts`

**Interfaces:**
- Consumes: `scheduleCron` (`src/lib/qstash/client.ts`).

- [ ] **Step 1: Implement the script** (mirror `scripts/schedule-write-cron.ts`)

Create `scripts/schedule-inbound-poll-cron.ts`:

```ts
// One-time setup: registers the QStash schedule that fans inbound polling out to
// every connected mailbox. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-inbound-poll-cron.ts [cron-expression]
// Default cron: "*/5 * * * *" (every 5 minutes). Reply latency for cold outreach
// tolerates minutes; push subscriptions (P4) can lower it further behind the
// same fetchInbound interface.
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '*/5 * * * *'
  const scheduleId = await scheduleCron('/api/inbound/poll-fanout', cron)
  process.stdout.write(`Scheduled inbound poll-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 2: Verify it typechecks**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add scripts/schedule-inbound-poll-cron.ts
git commit -m "feat(p3): inbound poll-fanout cron registration script (every 5 min)"
```

---

### Task 13: /inbox knowledge-request answer box

**Files:**
- Modify: `src/app/inbox/actions.ts`
- Create: `src/app/inbox/knowledge-request-row.tsx`
- Modify: `src/app/inbox/page.tsx`
- Test: `src/app/inbox/actions.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `createAdminClient`, `createServerClient`, `claimKnowledgeRequestAnswer`, `insertKnowledge`, `runKnowledgeAnswer`, `listOpenKnowledgeRequestsForClient`, `listCaseCompanyNames`, `revalidatePath`.
- Produces: `answerKnowledgeRequest(formData: FormData): Promise<void>` Server Action.

- [ ] **Step 1: Write a failing test for the action**

Create `src/app/inbox/actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const claimAnswerMock = vi.fn()
const insertKnowledgeMock = vi.fn()
const runKnowledgeAnswerMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/knowledge-requests', () => ({ claimKnowledgeRequestAnswer: (...a: unknown[]) => claimAnswerMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertKnowledge: (...a: unknown[]) => insertKnowledgeMock(...a) }))
vi.mock('@/lib/pipeline/knowledge-answer', () => ({ runKnowledgeAnswer: (...a: unknown[]) => runKnowledgeAnswerMock(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

import { answerKnowledgeRequest } from './actions'

const KR_ID = '11111111-1111-4111-8111-111111111111'
function form(fields: Record<string, string>) {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  for (const m of [requireUserMock, claimAnswerMock, insertKnowledgeMock, runKnowledgeAnswerMock]) m.mockReset()
  requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
  claimAnswerMock.mockResolvedValue({ id: KR_ID, client_id: 'c1', case_id: 'case1' })
})

describe('answerKnowledgeRequest', () => {
  it('should reject non-operators', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    await expect(answerKnowledgeRequest(form({ knowledgeRequestId: KR_ID, answer: 'A' }))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('should claim, store the fact, and run the answer pipeline', async () => {
    await answerKnowledgeRequest(form({ knowledgeRequestId: KR_ID, answer: 'Our SLA is 99.9%' }))
    expect(claimAnswerMock).toHaveBeenCalledWith({}, expect.objectContaining({ id: KR_ID, answeredBy: 'u1' }))
    expect(insertKnowledgeMock).toHaveBeenCalledWith({}, [expect.objectContaining({ kind: 'answer', created_by: 'human', case_id: 'case1' })])
    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith({}, { knowledgeRequestId: KR_ID })
  })

  it('should no-op when the request was already claimed', async () => {
    claimAnswerMock.mockResolvedValue(null)
    await answerKnowledgeRequest(form({ knowledgeRequestId: KR_ID, answer: 'A' }))
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(runKnowledgeAnswerMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run to verify failure**

Run: `pnpm test src/app/inbox/actions.test.ts`
Expected: FAIL — `answerKnowledgeRequest` not exported.

- [ ] **Step 3: Implement the Server Action**

In `src/app/inbox/actions.ts`, add these imports at the top (with the existing imports):

```ts
import { claimKnowledgeRequestAnswer } from '@/lib/db/knowledge-requests'
import { insertKnowledge } from '@/lib/db/case-knowledge'
import { runKnowledgeAnswer } from '@/lib/pipeline/knowledge-answer'
```

Append the action to `src/app/inbox/actions.ts`:

```ts
const answerSchema = z.object({
  knowledgeRequestId: z.string().uuid(),
  answer: z.string().min(1),
})

// Operator supplies the previously-missing fact. We atomically claim the open
// request (open -> answered), store the fact as case_knowledge (kind 'answer',
// human-authored), then let the AI write + send the reply grounded on it.
export async function answerKnowledgeRequest(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can answer knowledge requests', { userId: appUser.id })
  }
  const { knowledgeRequestId, answer } = answerSchema.parse({
    knowledgeRequestId: formData.get('knowledgeRequestId'),
    answer: formData.get('answer'),
  })

  const supabase = createAdminClient()

  const kr = await claimKnowledgeRequestAnswer(supabase, {
    id: knowledgeRequestId,
    answer,
    answeredBy: appUser.id,
  })
  if (!kr) {
    revalidatePath('/inbox')
    return
  }

  await insertKnowledge(supabase, [
    {
      client_id: kr.client_id,
      case_id: kr.case_id,
      kind: 'answer',
      content: answer,
      source_url: null,
      citation: null,
      created_by: 'human',
    },
  ])

  await runKnowledgeAnswer(supabase, { knowledgeRequestId: kr.id })
  revalidatePath('/inbox')
}
```

- [ ] **Step 4: Run the action test to verify it passes**

Run: `pnpm test src/app/inbox/actions.test.ts`
Expected: PASS.

- [ ] **Step 5: Create the knowledge-request row component**

Create `src/app/inbox/knowledge-request-row.tsx`:

```tsx
'use client'

import { useTransition } from 'react'
import { answerKnowledgeRequest } from './actions'

interface KnowledgeRequestRowProps {
  knowledgeRequestId: string
  question: string
  companyName: string
}

export function KnowledgeRequestRow({ knowledgeRequestId, question, companyName }: KnowledgeRequestRowProps) {
  const [isPending, startTransition] = useTransition()

  const onSubmit = (formData: FormData) => {
    startTransition(() => {
      void answerKnowledgeRequest(formData)
    })
  }

  return (
    <form action={onSubmit} style={{ border: '1px solid #e0b000', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#666' }}>{companyName}</div>
      <div style={{ fontWeight: 600, margin: '4px 0' }}>Knowledge needed</div>
      <p style={{ margin: '4px 0' }}>{question}</p>
      <input type="hidden" name="knowledgeRequestId" value={knowledgeRequestId} />
      <textarea
        name="answer"
        required
        rows={3}
        placeholder="Type the real answer — the AI will reply in its own voice."
        style={{ width: '100%', margin: '8px 0', fontFamily: 'inherit' }}
      />
      <button type="submit" disabled={isPending}>
        {isPending ? 'Sending…' : 'Answer & send'}
      </button>
    </form>
  )
}
```

- [ ] **Step 6: Surface knowledge requests on the inbox page**

Replace `src/app/inbox/page.tsx` with:

```tsx
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/require-user'
import { listDraftEmailsForClient } from '@/lib/db/emails'
import { listOpenKnowledgeRequestsForClient } from '@/lib/db/knowledge-requests'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { DraftRow } from './draft-row'
import { KnowledgeRequestRow } from './knowledge-request-row'

export const dynamic = 'force-dynamic'

export default async function InboxPage() {
  await requireUser()
  const supabase = await createServerClient()
  const [drafts, knowledgeRequests, cases] = await Promise.all([
    listDraftEmailsForClient(supabase),
    listOpenKnowledgeRequestsForClient(supabase),
    listCaseCompanyNames(supabase),
  ])
  const companyByCaseId = new Map(cases.map((c) => [c.id, c.companyName]))

  if (drafts.length === 0 && knowledgeRequests.length === 0) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Inbox</h1>
        <p>Nothing needs your attention.</p>
      </main>
    )
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>Inbox</h1>

      {knowledgeRequests.length > 0 && (
        <section>
          <h2>Knowledge requests ({knowledgeRequests.length})</h2>
          {knowledgeRequests.map((kr) => (
            <KnowledgeRequestRow
              key={kr.id}
              knowledgeRequestId={kr.id}
              question={kr.question}
              companyName={companyByCaseId.get(kr.case_id) ?? 'Unknown company'}
            />
          ))}
        </section>
      )}

      {drafts.length > 0 && (
        <section>
          <h2>Drafts awaiting approval ({drafts.length})</h2>
          {drafts.map((d) => (
            <DraftRow
              key={d.id}
              emailId={d.id}
              subject={d.subject ?? '(no subject)'}
              body={d.body ?? ''}
              companyName={(d.case_id && companyByCaseId.get(d.case_id)) || 'Unknown company'}
            />
          ))}
        </section>
      )}
    </main>
  )
}
```

- [ ] **Step 7: Typecheck + lint + run inbox tests**

Run: `pnpm typecheck && pnpm lint && pnpm test src/app/inbox`
Expected: clean + PASS.

- [ ] **Step 8: Commit**

```bash
git add src/app/inbox/actions.ts src/app/inbox/actions.test.ts src/app/inbox/knowledge-request-row.tsx src/app/inbox/page.tsx
git commit -m "feat(p3): /inbox knowledge-request answer box + answerKnowledgeRequest action"
```

---

### Task 14: Docs + full verification

**Files:**
- Modify: `.claude/roadmap.md`, `.claude/architecture.md`

- [ ] **Step 1: Mark P3 done in the roadmap**

In `.claude/roadmap.md`, under `## P3 — Reply Handling + Knowledge Gap + Price Handoff`, replace the six unchecked bullets with checked bullets describing the shipped work. Use this block:

```markdown
## P3 — Reply Handling + Knowledge Gap + Price Handoff DONE

**Goal:** the system holds a real conversation and knows when to escalate or hand off.
**Implementation plan:** `docs/superpowers/plans/2026-07-19-p3-reply-handling.md`.

- [x] Reply detection via **polling** (Option A): `scripts/schedule-inbound-poll-cron.ts` (every 5 min) → `/api/inbound/poll-fanout` → one QStash message per mailbox → `/api/inbound/poll`. New provider `fetchInbound` (Gmail history API + `gmail.readonly`; Graph delta + `Mail.Read`) behind `MailboxProvider`, with a per-mailbox opaque `inbound_cursor`. Push subscriptions (Gmail watch / Graph webhooks) deferred to P4 behind the same interface. Inbound is matched to a contacted lead by sender address, deduped on `provider_message_id`, and **pauses the sequence** (`pauseActiveSequenceForLead`; the pending follow-up then no-ops).
- [x] **Reply Agent** (`src/lib/pipeline/reply.ts`): Gemini classifies intent (question / interested / price / not_interested / other) + confidence + `canAnswer` from the full thread + `case_knowledge`; `runReplyForInbound` routes deterministically and sets the case `in_conversation`.
- [x] Answerable → reply per reply-mode via `replyDisposition` (`auto_send` sends, `human_approve` drafts to `/inbox`, `hybrid` sends when confident ≥ 0.75 else drafts). Reply sends are idempotent via the one-reply-per-inbound claim (`emails.in_reply_to_email_id` unique index).
- [x] **Knowledge-gap escalation**: an unanswerable reply creates a `knowledge_request` (never fabricates), surfaced in `/inbox` with an answer box; `answerKnowledgeRequest` claims it open→answered, stores the human fact as `case_knowledge` (kind `answer`), and `runKnowledgeAnswer` writes + sends the reply in the AI's voice.
- [x] **Price handoff**: one booking-link reply, `suppressions` (`price_handoff`), sequence stopped, case `hot_handoff`, `reply.price_handoff` event.
- [x] Not-interested / opt-out → `suppressions` (`manual`), sequence stopped, case `lost`, no reply sent.
- [x] Migration `0007_p3_reply_handling.sql`: `mailboxes.inbound_cursor`, `emails.in_reply_to_email_id`, and nullable-column unique indexes (`emails_provider_message_id_uniq`, `emails_in_reply_to_uniq`, `knowledge_requests_email_uniq`) for inbound-dedup, reply, and escalation idempotency.
```

- [ ] **Step 2: Update the architecture integration table**

In `.claude/architecture.md` §10, update the two mailbox rows to note the read capability, e.g. append to the Gmail/Graph `Interface` cells: `MailboxProvider (send + fetchInbound)`. No other §10 changes needed.

- [ ] **Step 3: Run the full suite**

Run: `pnpm test`
Expected: all tests pass (the P2 baseline was 39 files / 248 tests; P3 adds the files created above).

- [ ] **Step 4: Typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean (1 pre-existing unrelated `env.test.ts` warning is acceptable, per the P2 close-out notes).

- [ ] **Step 5: Commit**

```bash
git add .claude/roadmap.md .claude/architecture.md
git commit -m "docs(p3): mark P3 reply handling done; note fetchInbound in architecture §10"
```

---

## Self-Review (performed against the P3 spec)

**Spec coverage** (roadmap P3 + architecture §7):
- Reply detection (polling + cursor + sequence pause) → Tasks 5–8, 10, 12. ✅ (Push subscriptions explicitly deferred per the user's Option A choice.)
- Reply Agent classify intent from thread + case_knowledge → Task 8. ✅
- Answerable → reply per reply-mode → Task 8 (`replyDisposition` / `sendOrDraftReply`). ✅
- Knowledge-gap escalation: create request → notify (in-app event + `/inbox`) → human answer box → AI ingests, writes, sends; never fabricates → Tasks 4, 8, 9, 13. ✅
- Price handoff: one booking reply → notify → `hot_handoff` → suppress + stop → Task 8. ✅
- Not-interested / opt-out → suppress + stop → Task 8. ✅
- Cross-cutting: idempotency on every QStash route (unique-index claims), provider behind interface, events on every action, RLS on new query (`listOpenKnowledgeRequestsForClient` uses the session client) → covered.

**Placeholder scan:** no `TODO`/`FIXME`/"implement later"/vague-handler placeholders; every code step shows complete code.

**Type consistency:** `InboundMessage` / `FetchInboundResult` used identically across `provider.ts`, both providers, `reader.ts`, `inbound.ts`. `ReplyClassification` / `replyDisposition` / `sendOrDraftReply` signatures match between `reply.ts` and `knowledge-answer.ts`. `claimReplyEmail` / `insertInboundEmail` / `createKnowledgeRequest` all return `Row | null` consistent with existing claim helpers. Enum values used (`in_conversation`, `hot_handoff`, `lost`, `price_handoff`, `manual`, `paused`, `answer`, `delivered`) all exist in `src/types/database.ts`.

**Known simplifications (intentional, in-scope):** reply threading reuses the codebase's existing thread-id + `provider_message_id` convention (same as `followup.ts`); answered/escalated cases are not auto-resumed onto the 3/7/14 cadence (the conversation supersedes it); in-app notification = `events` + `/inbox` surfacing (external notifications are backlog).

---

**Plan complete and saved to `docs/superpowers/plans/2026-07-19-p3-reply-handling.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
