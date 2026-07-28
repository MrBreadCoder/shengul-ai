# Client Notes + Client-Written Email — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client annotate companies and people in their CRM, and write and send email themselves from inside a case, without breaking the agent's cadence, suppression rules or deliverability guarantees.

**Architecture:** One additive migration (`0020`) adds a `notes` table, `emails.sent_by`, `sequences.skip_next_step` and a cap-free mailbox-claim RPC. Notes are written through the session-scoped Supabase client with RLS as the authorization boundary (mirroring `client_resources`); email writes go through the admin client with an explicit `canManageClient` check (mirroring `stopLead`), because RLS makes client-role users read-only on `emails`. A manual email claims the step-0 slot when it is free — becoming the first touch and starting the follow-up cadence — otherwise it is recorded as an interjection that sets a flag causing the next scheduled follow-up to be skipped.

**Tech Stack:** Next.js 16 (App Router, Server Actions), TypeScript strict, Supabase (Postgres + RLS), Zod, Vitest, pnpm.

**Spec:** `docs/superpowers/specs/2026-07-28-client-notes-and-manual-send-design.md`

## Global Constraints

- **pnpm only.** `npm install` corrupts this tree. Use `pnpm`.
- **Verification commands:** `pnpm test`, `pnpm typecheck`, `pnpm lint`. All three must pass before every commit.
- **DB columns are `snake_case`; TypeScript is `camelCase`.** Map explicitly at the DB layer; never assume they match.
- **All data access lives in `src/lib/db/`.** One function per operation. No inline Supabase queries in components, actions or pipeline code.
- **Every external/DB error maps to `AppError`** with a machine-readable `code`, a human `message`, and structured `context`. Never let a raw Supabase error escape.
- **No `any`, no non-null assertion without a comment proving it is safe, explicit return types on every function.**
- **Server Action order:** validate input → check auth → check limits → call lib functions → return. Side effects (logging) last.
- **`created_by` / `sent_by` always come from the server session**, never from form data.
- **No component tests exist in this repo** (no `.test.tsx` files, no DOM test setup). UI tasks are verified with `pnpm typecheck && pnpm lint && pnpm test` plus a manual check in `pnpm dev`. Do not add a component-testing framework.
- **Commit after every task.** Conventional commit prefixes (`feat:`, `test:`, `docs:`). Work on `master`; do not branch.

---

## File Structure

**Created:**

| File | Responsibility |
|---|---|
| `supabase/migrations/0020_client_notes_and_manual_send.sql` | `notes` table + RLS, `emails.sent_by`, `sequences.skip_next_step`, `claim_mailbox_send_uncapped` |
| `src/lib/db/notes.ts` | Every read/write against `notes` |
| `src/lib/db/notes.test.ts` | Tests for the above |
| `src/app/(app)/cases/[id]/note-actions.ts` | `createNote` / `editNote` / `removeNote` Server Actions |
| `src/app/(app)/cases/[id]/note-actions.test.ts` | Tests for the above |
| `src/app/(app)/cases/[id]/notes-panel.tsx` | Client component: composer + list + inline edit/delete |
| `src/app/(app)/cases/[id]/send-actions.ts` | `sendManualEmail` Server Action |
| `src/app/(app)/cases/[id]/send-actions.test.ts` | Tests for the above |
| `src/app/(app)/cases/[id]/compose-form.tsx` | Client component: the case Mail-tab composer |

**Modified:**

| File | Change |
|---|---|
| `src/types/database.ts` | `notes` table types, `emails.sent_by`, `sequences.skip_next_step`, `claim_mailbox_send_uncapped` |
| `src/lib/db/mailboxes.ts` | `claimMailboxSendUncapped` |
| `src/lib/db/mailboxes.test.ts` | Tests for the above |
| `src/lib/mailbox/sender.ts` | `bypassDailyCap` input flag |
| `src/lib/mailbox/sender.test.ts` | Tests for the above |
| `src/lib/db/sequences.ts` | `requestFollowupSkip`, `consumeFollowupSkip` |
| `src/lib/db/sequences.test.ts` | Tests for the above |
| `src/lib/pipeline/followup.ts` | The skip branch in `runFollowupStep` |
| `src/lib/pipeline/followup.test.ts` | Tests for the above |
| `src/lib/db/emails.ts` | `insertManualEmail` |
| `src/lib/db/emails.test.ts` | Tests for the above |
| `src/app/(app)/cases/[id]/page.tsx` | Notes panel above Contacts; note counts on contact cards; composer in the Mail tab; provenance |
| `src/components/email-message.tsx` | `sentByHuman` prop |
| `src/app/(app)/mail/page.tsx` | Pass provenance through |
| `.claude/roadmap.md` | Shipped entry |

---

## Task 1: Migration 0020 + database types

**Files:**
- Create: `supabase/migrations/0020_client_notes_and_manual_send.sql`
- Modify: `src/types/database.ts` (Tables at `:406` `emails`, `:466` `sequences`; `Functions` at `:727`)

**Interfaces:**
- Consumes: nothing.
- Produces: `Database['public']['Tables']['notes']['Row' | 'Insert']`; `emails.sent_by: string | null`; `sequences.skip_next_step: boolean`; `Functions.claim_mailbox_send_uncapped` with `Args: { p_mailbox_id: string }` and `Returns: Database['public']['Tables']['mailboxes']['Row'][]`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0020_client_notes_and_manual_send.sql`:

```sql
-- 0020 — client notes + client-written email.
--
-- Four additive changes. No backfill, no deploy ordering constraint: nothing
-- here needs a route to exist first (unlike 0019).
--   1. notes                       — human annotations on a case, optionally pinned to a lead
--   2. emails.sent_by              — who typed a message; null means the agent wrote it
--   3. sequences.skip_next_step    — consumed at fire time to skip exactly one follow-up
--   4. claim_mailbox_send_uncapped — cap-free mailbox claim, human-written mail only

-- ---------- notes ----------
create table notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  -- Always set, even for a note about one person: leads.case_id is nullable
  -- (on delete set null, 0001), so anchoring a note on the lead alone would
  -- leave notes attached to no visible surface.
  case_id    uuid not null references cases(id) on delete cascade,
  -- Null = the note is about the company. Set = about that person.
  lead_id    uuid references leads(id) on delete cascade,
  body       text not null,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_case_idx on notes (case_id, created_at desc);

alter table notes enable row level security;

-- Mirrors client_resources (0018): the whole client reads, only the author
-- writes. Unlike emails, notes are written through the session-scoped client,
-- so these policies are the authorization boundary rather than a second wall.
create policy notes_select on notes for select
  using (is_operator() or client_id = current_client_id());
create policy notes_insert on notes for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy notes_update on notes for update
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()))
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy notes_delete on notes for delete
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));

-- ---------- provenance ----------
-- Null means the agent wrote it. No default and no backfill: every existing row
-- is agent-written, which is exactly what null already says.
alter table emails add column sent_by uuid references app_users(id);

-- ---------- follow-up skip ----------
-- Set when a human interjects into an active cadence. Consumed by the next
-- runFollowupStep firing, which sends nothing and schedules the step after it.
alter table sequences add column skip_next_step boolean not null default false;

-- ---------- cap-free mailbox claim ----------
-- claim_mailbox_send (0012) clamps with least(daily_cap, ...), so no argument
-- value can lift a human-written email over the cap. A separate function rather
-- than a flag on that one, so the agent's path cannot accidentally become
-- uncapped. sent_today still increments, keeping real volume visible to the
-- health monitor; health <> 'blocked' still applies, because a blocked mailbox
-- has nothing safe to send from.
create or replace function public.claim_mailbox_send_uncapped(p_mailbox_id uuid)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
  returning *;
$$;
```

- [ ] **Step 2: Add the `notes` table types**

In `src/types/database.ts`, insert a `notes` entry immediately after the `client_resources` block (before `email_attachments`):

```ts
      notes: {
        Row: {
          id: string
          client_id: string
          case_id: string
          lead_id: string | null
          body: string
          created_by: string
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          client_id: string
          case_id: string
          lead_id?: string | null
          body: string
          created_by: string
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['notes']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'notes_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'notes_case_id_fkey'
            columns: ['case_id']
            isOneToOne: false
            referencedRelation: 'cases'
            referencedColumns: ['id']
          },
          {
            foreignKeyName: 'notes_lead_id_fkey'
            columns: ['lead_id']
            isOneToOne: false
            referencedRelation: 'leads'
            referencedColumns: ['id']
          },
        ]
      }
```

- [ ] **Step 3: Add the two new columns and the new function**

In the `emails` block, add `sent_by: string | null` to `Row` (after `in_reply_to_email_id`) and `sent_by?: string | null` to `Insert`.

In the `sequences` block, add `skip_next_step: boolean` to `Row` (after `qstash_message_id`) and `skip_next_step?: boolean` to `Insert`.

In `Functions`, directly after the `claim_mailbox_send` entry:

```ts
      claim_mailbox_send_uncapped: {
        Args: { p_mailbox_id: string }
        Returns: Database['public']['Tables']['mailboxes']['Row'][]
      }
```

- [ ] **Step 4: Verify the tree still compiles and the suite is green**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all pass. The new columns are optional on `Insert`, so no existing call site changes.

- [ ] **Step 5: Apply the migration locally**

Run the migration against your Supabase environment the same way `0019` was applied (Supabase SQL editor or `supabase db push`, per your setup). Confirm with:

```sql
select count(*) from notes;
select skip_next_step from sequences limit 1;
select sent_by from emails limit 1;
select proname from pg_proc where proname = 'claim_mailbox_send_uncapped';
```

Expected: `0`, a boolean column, a null column, and one row.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0020_client_notes_and_manual_send.sql src/types/database.ts
git commit -m "feat: add notes, email provenance, follow-up skip and an uncapped mailbox claim"
```

---

## Task 2: Notes data-access layer

**Files:**
- Create: `src/lib/db/notes.ts`
- Test: `src/lib/db/notes.test.ts`

**Interfaces:**
- Consumes: `Database['public']['Tables']['notes']` (Task 1).
- Produces:
  - `type NoteRow = Database['public']['Tables']['notes']['Row']`
  - `listNotesForCase(supabase, caseId: string): Promise<NoteRow[]>`
  - `insertNote(supabase, input: InsertNoteInput): Promise<NoteRow>` where `InsertNoteInput = { clientId: string; caseId: string; leadId: string | null; body: string; createdBy: string }`
  - `getNoteById(supabase, id: string): Promise<NoteRow | null>`
  - `updateNote(supabase, id: string, body: string): Promise<NoteRow | null>` — null means no row matched (RLS refused, or it is gone)
  - `deleteNote(supabase, id: string): Promise<boolean>` — false means nothing was deleted

- [ ] **Step 1: Write the failing tests**

Create `src/lib/db/notes.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { listNotesForCase, insertNote, getNoteById, updateNote, deleteNote } from './notes'

const row = {
  id: 'n1', client_id: 'c1', case_id: 'case1', lead_id: null, body: 'Met at a conference',
  created_by: 'u1', created_at: '2026-07-28T00:00:00Z', updated_at: '2026-07-28T00:00:00Z',
}

describe('listNotesForCase', () => {
  it('should return the case notes newest first', async () => {
    const order = vi.fn().mockResolvedValue({ data: [row], error: null })
    const eq = vi.fn().mockReturnValue({ order })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    const result = await listNotesForCase(supabase, 'case1')

    expect(result).toEqual([row])
    expect(eq).toHaveBeenCalledWith('case_id', 'case1')
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
  })

  it('should return an empty array when the table has no rows for the case', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(listNotesForCase(supabase, 'case1')).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(listNotesForCase(supabase, 'case1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('insertNote', () => {
  it('should map camelCase input onto snake_case columns', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    const result = await insertNote(supabase, {
      clientId: 'c1', caseId: 'case1', leadId: null, body: 'Met at a conference', createdBy: 'u1',
    })

    expect(result).toEqual(row)
    expect(insert).toHaveBeenCalledWith({
      client_id: 'c1', case_id: 'case1', lead_id: null, body: 'Met at a conference', created_by: 'u1',
    })
  })

  it('should throw DB_ERROR when RLS refuses the insert', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'denied' } }) }) }),
      }),
    } as never
    await expect(
      insertNote(supabase, { clientId: 'c1', caseId: 'case1', leadId: null, body: 'b', createdBy: 'u1' }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('getNoteById', () => {
  it('should return null when the note is out of scope or missing', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }),
      }),
    } as never
    await expect(getNoteById(supabase, 'n1')).resolves.toBeNull()
  })
})

describe('updateNote', () => {
  it('should write the new body and bump updated_at', async () => {
    const select = vi.fn().mockResolvedValue({ data: [row], error: null })
    const eq = vi.fn().mockReturnValue({ select })
    const update = vi.fn().mockReturnValue({ eq })
    const supabase = { from: () => ({ update }) } as never

    const result = await updateNote(supabase, 'n1', 'Corrected')

    expect(result).toEqual(row)
    expect(eq).toHaveBeenCalledWith('id', 'n1')
    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ body: 'Corrected', updated_at: expect.any(String) }),
    )
  })

  it('should return null when no row matched, so a caller can report FORBIDDEN', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
    } as never
    await expect(updateNote(supabase, 'n1', 'x')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(updateNote(supabase, 'n1', 'x')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deleteNote', () => {
  it('should report true when a row was removed', async () => {
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [{ id: 'n1' }], error: null }) }) }),
      }),
    } as never
    await expect(deleteNote(supabase, 'n1')).resolves.toBe(true)
  })

  it('should report false when RLS matched nothing', async () => {
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }),
      }),
    } as never
    await expect(deleteNote(supabase, 'n1')).resolves.toBe(false)
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    const supabase = {
      from: () => ({
        delete: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(deleteNote(supabase, 'n1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/db/notes.test.ts`
Expected: FAIL — `Failed to resolve import "./notes"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/notes.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type NoteRow = Database['public']['Tables']['notes']['Row']

export interface InsertNoteInput {
  clientId: string
  caseId: string
  /** Null = the note is about the company; set = about that person. */
  leadId: string | null
  body: string
  createdBy: string
}

/**
 * Every function here takes a session-bound `createServerClient`, never the
 * admin client. The notes policies (0020) are this table's authorization
 * boundary — bypassing RLS would remove it, unlike `emails`, where clients have
 * no write policy at all and an explicit app-side check does the work.
 */
export async function listNotesForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<NoteRow[]> {
  const { data, error } = await supabase
    .from('notes')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list notes for case', { caseId, cause: error.message })
  }
  return data ?? []
}

export async function insertNote(
  supabase: SupabaseClient<Database>,
  input: InsertNoteInput,
): Promise<NoteRow> {
  const { data, error } = await supabase
    .from('notes')
    .insert({
      client_id: input.clientId,
      case_id: input.caseId,
      lead_id: input.leadId,
      body: input.body,
      created_by: input.createdBy,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert note', {
      caseId: input.caseId,
      cause: error?.message ?? 'no row returned',
    })
  }
  return data
}

export async function getNoteById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<NoteRow | null> {
  const { data, error } = await supabase.from('notes').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load note', { id, cause: error.message })
  }
  return data
}

// updated_at is written explicitly: this schema has no updated_at triggers
// (see cases.ts, which does the same).
// Returns null when the update matched no row — under RLS that is a note
// belonging to someone else, or one deleted in the meantime. The caller decides
// which error that is.
export async function updateNote(
  supabase: SupabaseClient<Database>,
  id: string,
  body: string,
): Promise<NoteRow | null> {
  const { data, error } = await supabase
    .from('notes')
    .update({ body, updated_at: new Date().toISOString() })
    .eq('id', id)
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update note', { id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

// False means nothing was deleted — same two causes as updateNote returning null.
export async function deleteNote(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase.from('notes').delete().eq('id', id).select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to delete note', { id, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/db/notes.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/notes.ts src/lib/db/notes.test.ts
git commit -m "feat: add the notes data-access layer"
```

---

## Task 3: Note Server Actions

**Files:**
- Create: `src/app/(app)/cases/[id]/note-actions.ts`
- Test: `src/app/(app)/cases/[id]/note-actions.test.ts`

**Interfaces:**
- Consumes: `insertNote`, `getNoteById`, `updateNote`, `deleteNote` (Task 2); `getCaseById` from `@/lib/db/cases`; `getLeadById` from `@/lib/db/leads`; `canManageClient`, `canManageOwnRow` from `@/lib/auth/can-manage-client`.
- Produces: `createNote(formData: FormData): Promise<void>`, `editNote(formData: FormData): Promise<void>`, `removeNote(formData: FormData): Promise<void>`. Form fields: `createNote` → `caseId`, `leadId` (`''` for the company), `body`; `editNote` → `noteId`, `caseId`, `body`; `removeNote` → `noteId`, `caseId`.

- [ ] **Step 1: Write the failing tests**

Create `src/app/(app)/cases/[id]/note-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUser = vi.fn()
const getCaseById = vi.fn()
const getLeadById = vi.fn()
const insertNote = vi.fn()
const getNoteById = vi.fn()
const updateNote = vi.fn()
const deleteNote = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => Promise.resolve({}) }))
vi.mock('next/cache', () => ({ revalidatePath: (...args: unknown[]) => revalidatePath(...args) }))
vi.mock('@/lib/db/cases', () => ({ getCaseById: (...a: unknown[]) => getCaseById(...a) }))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadById(...a) }))
vi.mock('@/lib/db/notes', () => ({
  insertNote: (...a: unknown[]) => insertNote(...a),
  getNoteById: (...a: unknown[]) => getNoteById(...a),
  updateNote: (...a: unknown[]) => updateNote(...a),
  deleteNote: (...a: unknown[]) => deleteNote(...a),
}))

const { createNote, editNote, removeNote } = await import('./note-actions')

const CASE_ID = '22222222-2222-4222-8222-222222222222'
const LEAD_ID = '11111111-1111-4111-8111-111111111111'
const NOTE_ID = '33333333-3333-4333-8333-333333333333'

function createForm(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('caseId', CASE_ID)
  data.set('leadId', '')
  data.set('body', 'They are re-tendering in Q4')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1' })
  getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: CASE_ID })
  getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', created_by: 'u1' })
  updateNote.mockResolvedValue({ id: NOTE_ID })
  deleteNote.mockResolvedValue(true)
})

describe('createNote', () => {
  it('should store a company note with lead_id null and the session user as author', async () => {
    await createNote(createForm())
    expect(insertNote).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', caseId: CASE_ID, leadId: null, body: 'They are re-tendering in Q4', createdBy: 'u1',
    })
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should store a person note when a lead on this case is selected', async () => {
    await createNote(createForm({ leadId: LEAD_ID }))
    expect(insertNote).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ leadId: LEAD_ID }),
    )
  })

  it('should trim the body and reject one that is only whitespace', async () => {
    await expect(createNote(createForm({ body: '   ' }))).rejects.toThrow()
    expect(insertNote).not.toHaveBeenCalled()
  })

  it('should reject a case belonging to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })
    await expect(createNote(createForm())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(insertNote).not.toHaveBeenCalled()
  })

  it('should reject when the RLS-scoped read finds no such case', async () => {
    getCaseById.mockResolvedValue(null)
    await expect(createNote(createForm())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })

  it('should reject a lead that belongs to a different case', async () => {
    getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: 'another-case' })
    await expect(createNote(createForm({ leadId: LEAD_ID }))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
    expect(insertNote).not.toHaveBeenCalled()
  })
})

describe('editNote', () => {
  function editForm(): FormData {
    const data = new FormData()
    data.set('noteId', NOTE_ID)
    data.set('caseId', CASE_ID)
    data.set('body', 'Corrected')
    return data
  }

  it('should update the author\'s own note', async () => {
    await editNote(editForm())
    expect(updateNote).toHaveBeenCalledWith(expect.anything(), NOTE_ID, 'Corrected')
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should refuse to edit someone else\'s note', async () => {
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', created_by: 'someone-else' })
    await expect(editNote(editForm())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(updateNote).not.toHaveBeenCalled()
  })

  it('should let an operator edit any note in scope', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'op', role: 'operator', client_id: null } })
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', created_by: 'someone-else' })
    await editNote(editForm())
    expect(updateNote).toHaveBeenCalled()
  })

  it('should report NOT_FOUND when the note vanished between read and write', async () => {
    updateNote.mockResolvedValue(null)
    await expect(editNote(editForm())).rejects.toMatchObject({ code: 'NOT_FOUND' })
  })
})

describe('removeNote', () => {
  function removeForm(): FormData {
    const data = new FormData()
    data.set('noteId', NOTE_ID)
    data.set('caseId', CASE_ID)
    return data
  }

  it('should delete the author\'s own note', async () => {
    await removeNote(removeForm())
    expect(deleteNote).toHaveBeenCalledWith(expect.anything(), NOTE_ID)
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })

  it('should refuse to delete someone else\'s note', async () => {
    getNoteById.mockResolvedValue({ id: NOTE_ID, client_id: 'c1', created_by: 'someone-else' })
    await expect(removeNote(removeForm())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(deleteNote).not.toHaveBeenCalled()
  })

  it('should be a no-op when the note is already gone', async () => {
    getNoteById.mockResolvedValue(null)
    await removeNote(removeForm())
    expect(deleteNote).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith(`/cases/${CASE_ID}`)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test "src/app/(app)/cases/[id]/note-actions.test.ts"`
Expected: FAIL — cannot resolve `./note-actions`.

- [ ] **Step 3: Write the implementation**

Create `src/app/(app)/cases/[id]/note-actions.ts`:

```ts
'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getCaseById } from '@/lib/db/cases'
import { getLeadById } from '@/lib/db/leads'
import { insertNote, getNoteById, updateNote, deleteNote } from '@/lib/db/notes'
import { canManageClient, canManageOwnRow } from '@/lib/auth/can-manage-client'
import { AppError } from '@/lib/errors/app-error'

// Generous: a note is a human's own writing, not machine output. The ceiling
// exists so a paste accident cannot push an unbounded string into Postgres.
const MAX_NOTE_CHARS = 4_000

// A <select> always submits a string; the Company option submits ''.
const optionalLeadId = z
  .union([z.string().uuid(), z.literal('')])
  .transform((value) => (value === '' ? null : value))

const createSchema = z.object({
  caseId: z.string().uuid(),
  leadId: optionalLeadId,
  body: z.string().trim().min(1).max(MAX_NOTE_CHARS),
})

const editSchema = z.object({
  noteId: z.string().uuid(),
  caseId: z.string().uuid(),
  body: z.string().trim().min(1).max(MAX_NOTE_CHARS),
})

const removeSchema = z.object({
  noteId: z.string().uuid(),
  caseId: z.string().uuid(),
})

/**
 * Notes are written through the session-scoped client, so the RLS policies in
 * 0020 are the wall. The checks here exist to turn a silent policy refusal into
 * a precise error the UI can show, not to replace the policy.
 */
export async function createNote(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { caseId, leadId, body } = createSchema.parse({
    caseId: formData.get('caseId'),
    leadId: formData.get('leadId'),
    body: formData.get('body'),
  })

  const supabase = await createServerClient()
  const kase = await getCaseById(supabase, caseId)
  // RLS makes an out-of-scope case indistinguishable from a missing one, which
  // is what we want: no existence leak across clients.
  if (!kase) throw new AppError('NOT_FOUND', 'Case not found', { caseId })
  if (!canManageClient(appUser, kase.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Case belongs to another client', { caseId, userId: appUser.id })
  }

  // A note pinned to a person must be pinned to a person on this case —
  // otherwise the note renders on a page its subject never appears on.
  if (leadId !== null) {
    const lead = await getLeadById(supabase, leadId)
    if (!lead || lead.case_id !== caseId) {
      throw new AppError('VALIDATION_ERROR', 'Contact does not belong to this case', { caseId, leadId })
    }
  }

  await insertNote(supabase, {
    clientId: kase.client_id,
    caseId,
    leadId,
    body,
    createdBy: appUser.id,
  })

  revalidatePath(`/cases/${caseId}`)
}

export async function editNote(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { noteId, caseId, body } = editSchema.parse({
    noteId: formData.get('noteId'),
    caseId: formData.get('caseId'),
    body: formData.get('body'),
  })

  const supabase = await createServerClient()
  const note = await getNoteById(supabase, noteId)
  if (!note) throw new AppError('NOT_FOUND', 'Note not found', { noteId })
  if (!canManageOwnRow(appUser, note)) {
    throw new AppError('FORBIDDEN', 'You can only edit your own notes', { noteId, userId: appUser.id })
  }

  const updated = await updateNote(supabase, noteId, body)
  // The read succeeded and authorization passed, so an empty update means the
  // row was deleted in between. Reporting it beats a silent no-op.
  if (!updated) throw new AppError('NOT_FOUND', 'Note no longer exists', { noteId })

  revalidatePath(`/cases/${caseId}`)
}

export async function removeNote(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { noteId, caseId } = removeSchema.parse({
    noteId: formData.get('noteId'),
    caseId: formData.get('caseId'),
  })

  const supabase = await createServerClient()
  const note = await getNoteById(supabase, noteId)
  // Already gone (or never visible): deleting is idempotent, so this is a
  // success, not an error to show the user.
  if (!note) {
    revalidatePath(`/cases/${caseId}`)
    return
  }
  if (!canManageOwnRow(appUser, note)) {
    throw new AppError('FORBIDDEN', 'You can only delete your own notes', { noteId, userId: appUser.id })
  }

  await deleteNote(supabase, noteId)
  revalidatePath(`/cases/${caseId}`)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test "src/app/(app)/cases/[id]/note-actions.test.ts" && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/cases/[id]/note-actions.ts" "src/app/(app)/cases/[id]/note-actions.test.ts"
git commit -m "feat: add note create, edit and delete server actions"
```

---

## Task 4: Notes panel UI

**Files:**
- Create: `src/app/(app)/cases/[id]/notes-panel.tsx`
- Modify: `src/app/(app)/cases/[id]/page.tsx`

**Interfaces:**
- Consumes: `createNote`, `editNote`, `removeNote` (Task 3); `listNotesForCase` (Task 2).
- Produces: `<NotesPanel caseId contacts notes currentUserId isOperator />` where `contacts: readonly { id: string; fullName: string }[]` and `notes: readonly NotePanelItem[]` with `NotePanelItem = { id: string; body: string; leadId: string | null; authorLabel: string; canManage: boolean; createdAt: string }`.

- [ ] **Step 1: Write the panel component**

Create `src/app/(app)/cases/[id]/notes-panel.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { NotePencil, Trash, X } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { formatAbsolute, formatRelative } from '@/lib/format'
import { createNote, editNote, removeNote } from './note-actions'

export interface NoteContact {
  id: string
  fullName: string
}

export interface NotePanelItem {
  id: string
  body: string
  /** Null = the note is about the company. */
  leadId: string | null
  authorLabel: string
  /** Whether the viewing user may edit or delete this note. */
  canManage: boolean
  createdAt: string
}

interface NotesPanelProps {
  caseId: string
  contacts: readonly NoteContact[]
  notes: readonly NotePanelItem[]
  /** Preselects the About field when a contact card asked for a note. */
  initialLeadId?: string | null
}

const COMPANY_VALUE = 'company'

export function NotesPanel({
  caseId,
  contacts,
  notes,
  initialLeadId = null,
}: NotesPanelProps): React.ReactElement {
  const [target, setTarget] = useState<string>(initialLeadId ?? COMPANY_VALUE)
  const [body, setBody] = useState('')
  const [editingId, setEditingId] = useState<string | null>(null)
  const [editingBody, setEditingBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  const nameByLeadId = new Map(contacts.map((contact) => [contact.id, contact.fullName]))
  const now = new Date()

  function submitNew(): void {
    setError(null)
    const data = new FormData()
    data.set('caseId', caseId)
    data.set('leadId', target === COMPANY_VALUE ? '' : target)
    data.set('body', body)
    startTransition(async () => {
      try {
        await createNote(data)
        setBody('')
      } catch {
        setError('Could not save that note. Try again.')
      }
    })
  }

  function submitEdit(noteId: string): void {
    setError(null)
    const data = new FormData()
    data.set('noteId', noteId)
    data.set('caseId', caseId)
    data.set('body', editingBody)
    startTransition(async () => {
      try {
        await editNote(data)
        setEditingId(null)
      } catch {
        setError('Could not update that note. Try again.')
      }
    })
  }

  function submitRemove(noteId: string): void {
    setError(null)
    const data = new FormData()
    data.set('noteId', noteId)
    data.set('caseId', caseId)
    startTransition(async () => {
      try {
        await removeNote(data)
      } catch {
        setError('Could not delete that note. Try again.')
      }
    })
  }

  return (
    <section aria-label="Notes" className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">
          Notes <span className="text-faint tnum font-normal">{notes.length}</span>
        </h2>
        <p className="text-faint ml-auto text-[11px]">Only your team sees these — the agent never reads them.</p>
      </div>

      <div className="flex flex-col gap-2">
        <Textarea
          value={body}
          onChange={(event) => setBody(event.target.value)}
          placeholder="Anything you know about this company that the agent doesn't."
          rows={3}
          maxLength={4000}
          aria-label="New note"
        />
        <div className="flex flex-wrap items-center gap-2">
          <Select value={target} onValueChange={setTarget}>
            <SelectTrigger className="w-56" aria-label="What this note is about">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={COMPANY_VALUE}>About the company</SelectItem>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  About {contact.fullName}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button
            type="button"
            size="sm"
            onClick={submitNew}
            disabled={isPending || body.trim().length === 0}
            className="ml-auto"
          >
            {isPending ? 'Saving…' : 'Add note'}
          </Button>
        </div>
      </div>

      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}

      {notes.length === 0 ? (
        <p className="border-hairline text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-sm">
          No notes yet.
        </p>
      ) : (
        <ul className="flex flex-col gap-2">
          {notes.map((note) => (
            <li key={note.id} className="border-hairline bg-surface-sunken rounded-lg border p-3">
              <div className="flex flex-wrap items-center gap-2">
                {note.leadId ? (
                  <span className="bg-accent text-muted-foreground rounded-full px-2 py-0.5 text-[11px]">
                    {nameByLeadId.get(note.leadId) ?? 'Contact'}
                  </span>
                ) : (
                  <span className="text-faint text-[11px]">Company</span>
                )}
                <span className="text-faint text-[11px]">{note.authorLabel}</span>
                <time
                  dateTime={note.createdAt}
                  title={formatAbsolute(note.createdAt)}
                  className="text-faint ml-auto text-[11px]"
                >
                  {formatRelative(note.createdAt, now)}
                </time>
                {note.canManage && editingId !== note.id ? (
                  <>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Edit note"
                      disabled={isPending}
                      onClick={() => {
                        setEditingId(note.id)
                        setEditingBody(note.body)
                      }}
                    >
                      <NotePencil size={13} weight="light" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label="Delete note"
                      disabled={isPending}
                      onClick={() => submitRemove(note.id)}
                    >
                      <Trash size={13} weight="light" />
                    </Button>
                  </>
                ) : null}
                {editingId === note.id ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    aria-label="Cancel editing"
                    onClick={() => setEditingId(null)}
                  >
                    <X size={13} weight="light" />
                  </Button>
                ) : null}
              </div>

              {editingId === note.id ? (
                <div className="mt-2 flex flex-col gap-2">
                  <Textarea
                    value={editingBody}
                    onChange={(event) => setEditingBody(event.target.value)}
                    rows={3}
                    maxLength={4000}
                    aria-label="Edit note"
                  />
                  <Button
                    type="button"
                    size="sm"
                    className="w-fit"
                    disabled={isPending || editingBody.trim().length === 0}
                    onClick={() => submitEdit(note.id)}
                  >
                    {isPending ? 'Saving…' : 'Save'}
                  </Button>
                </div>
              ) : (
                <p className="mt-2 text-sm leading-relaxed whitespace-pre-wrap">{note.body}</p>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
```

- [ ] **Step 2: Wire the panel into the case page**

In `src/app/(app)/cases/[id]/page.tsx`:

Add the imports:

```ts
import { listNotesForCase } from '@/lib/db/notes'
import { NotesPanel, type NotePanelItem } from './notes-panel'
```

Add `listNotesForCase(supabase, caseId)` to the existing `Promise.all` (destructure it as `notes`), then build the view model after `const now = new Date()`:

```tsx
  const { appUser } = await requireUser()   // replaces the bare `await requireUser()` at the top
  ...
  // "You" or "Teammate", never a name: app_users carries only id/role/client_id
  // (no email — that lives in auth.users, reachable only through the admin
  // client). Resolving names would mean an auth-admin lookup on a page a
  // client-role user loads, to show one teammate another teammate's address.
  const noteItems: NotePanelItem[] = notes.map((note) => ({
    id: note.id,
    body: note.body,
    leadId: note.lead_id,
    authorLabel: note.created_by === appUser.id ? 'You' : 'Teammate',
    canManage: appUser.role === 'operator' || note.created_by === appUser.id,
    createdAt: note.created_at,
  }))
  const noteCountByLeadId = new Map<string, number>()
  for (const note of notes) {
    if (note.lead_id) noteCountByLeadId.set(note.lead_id, (noteCountByLeadId.get(note.lead_id) ?? 0) + 1)
  }
```

Accept the `note` search param so a contact card can preselect itself. Change the page props and read it before the `Promise.all`:

```tsx
interface CasePageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

// ...inside the component, after `const caseId = parsed.data.id`:
  // Untrusted: parsed as a uuid here and checked against this case's own leads
  // below, so a foreign or malformed id simply preselects nothing.
  const noteParam = z.string().uuid().safeParse((await searchParams).note)
```

Then, after `noteCountByLeadId` is built:

```tsx
  const initialNoteLeadId =
    noteParam.success && leads.some((lead) => lead.id === noteParam.data) ? noteParam.data : null
```

Render the panel directly after the closing `</header>` and before the `Contacts` section:

```tsx
      <NotesPanel
        // Remount when the target changes: the composer seeds its About selector
        // from initialLeadId in useState, which only reads on mount, so a second
        // "Add note" click would otherwise change the URL and nothing else.
        key={initialNoteLeadId ?? 'company'}
        caseId={kase.id}
        contacts={leads.map((lead) => ({ id: lead.id, fullName: lead.full_name }))}
        notes={noteItems}
        initialLeadId={initialNoteLeadId}
      />
```

In the contact card (inside the `leads.map`), under the existing `StatusPill` row, add the count and the entry point:

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
```

A contact with no notes still shows the control, so the first note on a person is as easy to write as the tenth. `Link` is already imported in this file.

Give the panel's `<section>` in `notes-panel.tsx` an `id="notes"` so the anchor lands on it:

```tsx
    <section id="notes" aria-label="Notes" className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-4">
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

Then `pnpm dev`, open a case, and confirm: the panel renders above Contacts; adding a company note works; adding a note about a contact shows their name as a chip and turns that card's "Add note" into a note count; clicking a card's link scrolls to the panel with About preselected to that person; edit and delete appear only on your own notes; the empty state reads "No notes yet."

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/cases/[id]/notes-panel.tsx" "src/app/(app)/cases/[id]/page.tsx"
git commit -m "feat: show the notes panel at the top of the case page"
```

---

## Task 5: Cap-free mailbox claim

**Files:**
- Modify: `src/lib/db/mailboxes.ts` (after `claimMailboxSend`, `:65-79`)
- Modify: `src/lib/mailbox/sender.ts` (`SendViaMailboxInput` `:30-44`, the claim in the loop `:113-121`)
- Test: `src/lib/db/mailboxes.test.ts`, `src/lib/mailbox/sender.test.ts`

**Interfaces:**
- Consumes: `claim_mailbox_send_uncapped` (Task 1).
- Produces: `claimMailboxSendUncapped(supabase, mailboxId: string): Promise<MailboxRow | null>`; `SendViaMailboxInput.bypassDailyCap?: boolean`.

- [ ] **Step 1: Write the failing DB test**

Append to `src/lib/db/mailboxes.test.ts`:

```ts
describe('claimMailboxSendUncapped', () => {
  it('should claim through the uncapped RPC and return the updated row', async () => {
    const rpc = vi.fn().mockResolvedValue({ data: [{ id: 'm1', sent_today: 99 }], error: null })
    const supabase = { rpc } as never

    const result = await claimMailboxSendUncapped(supabase, 'm1')

    expect(result).toEqual({ id: 'm1', sent_today: 99 })
    expect(rpc).toHaveBeenCalledWith('claim_mailbox_send_uncapped', { p_mailbox_id: 'm1' })
  })

  it('should return null when the mailbox is blocked', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: [], error: null }) } as never
    await expect(claimMailboxSendUncapped(supabase, 'm1')).resolves.toBeNull()
  })

  it('should throw DB_ERROR when the RPC fails', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { message: 'boom' } }) } as never
    await expect(claimMailboxSendUncapped(supabase, 'm1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
```

Add `claimMailboxSendUncapped` to that file's import list.

- [ ] **Step 2: Write the failing sender tests**

Append inside the existing `describe('sendViaMailbox', ...)` in `src/lib/mailbox/sender.test.ts`, and add `const claimMailboxSendUncappedMock = vi.fn()` next to the other mocks, register it in the `vi.mock('@/lib/db/mailboxes', ...)` factory as `claimMailboxSendUncapped: (...a: unknown[]) => claimMailboxSendUncappedMock(...a)`, and add it to the `beforeEach` reset list:

```ts
  it('should claim through the uncapped RPC when bypassDailyCap is set', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailboxWith({ sent_today: 50, daily_cap: 50 })])
    claimMailboxSendUncappedMock.mockResolvedValue(mailboxWith({ sent_today: 51 }))
    const { sendEmail } = okProvider()
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail })

    const result = await sendViaMailbox({} as never, { ...baseInput, purpose: 'reply', bypassDailyCap: true })

    expect(result.providerMessageId).toBe('pm1')
    expect(claimMailboxSendUncappedMock).toHaveBeenCalledWith(expect.anything(), 'm1')
    expect(claimMailboxSendMock).not.toHaveBeenCalled()
  })

  it('should still refuse to send when every mailbox is blocked, even with bypassDailyCap', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailboxWith({ health: 'blocked' })])

    await expect(
      sendViaMailbox({} as never, { ...baseInput, purpose: 'reply', bypassDailyCap: true }),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' })
    expect(claimMailboxSendUncappedMock).not.toHaveBeenCalled()
  })

  it('should use the capped RPC when bypassDailyCap is absent', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue(mailboxWith({ sent_today: 1 }))
    const { sendEmail } = okProvider()
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail })

    await sendViaMailbox({} as never, baseInput)

    expect(claimMailboxSendMock).toHaveBeenCalled()
    expect(claimMailboxSendUncappedMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 3: Run both test files to verify they fail**

Run: `pnpm test src/lib/db/mailboxes.test.ts src/lib/mailbox/sender.test.ts`
Expected: FAIL — `claimMailboxSendUncapped` is not exported.

- [ ] **Step 4: Implement the DB helper**

In `src/lib/db/mailboxes.ts`, directly after `claimMailboxSend`:

```ts
// Cap-free counterpart to claimMailboxSend, for human-written mail only
// (migration 0020). A separate RPC rather than an argument, so the agent's
// capped path cannot accidentally become uncapped. sent_today still increments,
// so the health monitor keeps seeing real volume; a 'blocked' mailbox still
// returns null, because a blocked mailbox is not a cap problem.
export async function claimMailboxSendUncapped(
  supabase: SupabaseClient<Database>,
  mailboxId: string,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.rpc('claim_mailbox_send_uncapped', {
    p_mailbox_id: mailboxId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim uncapped mailbox send', {
      mailboxId, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 5: Implement the sender flag**

In `src/lib/mailbox/sender.ts`, import `claimMailboxSendUncapped` alongside `claimMailboxSend`, and add to `SendViaMailboxInput`:

```ts
  /**
   * Human-written mail only. Claims a mailbox regardless of sent_today, so a
   * client can always answer a prospect even when the agent used the day's
   * quota that morning. Health, rotation and suppression are unaffected.
   */
  bypassDailyCap?: boolean
```

Replace the cap computation and claim at the top of the `for (const candidate of ordered)` loop with:

```ts
    const claimed = input.bypassDailyCap
      ? await claimMailboxSendUncapped(supabase, candidate.id)
      : await claimMailboxSend(
          supabase,
          candidate.id,
          effectiveDailyCap({
            profile: candidate.warmup_profile,
            warmupStartedAt: candidate.warmup_started_at,
            dailyCap: candidate.daily_cap,
            now,
          }),
        )
    if (!claimed) continue // at cap for today, or turned unhealthy — try the next
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/lib/db/mailboxes.test.ts src/lib/mailbox/sender.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS, including every pre-existing sender test.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts
git commit -m "feat: let human-written mail claim a mailbox past its daily cap"
```

---

## Task 6: Follow-up skip helpers

**Files:**
- Modify: `src/lib/db/sequences.ts`
- Test: `src/lib/db/sequences.test.ts`

**Interfaces:**
- Consumes: `sequences.skip_next_step` (Task 1).
- Produces:
  - `requestFollowupSkip(supabase, leadId: string): Promise<void>`
  - `consumeFollowupSkip(supabase, id: string): Promise<boolean>` — true means this caller won the flag and owns scheduling the next step

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/db/sequences.test.ts` (add both names to the import list):

```ts
describe('requestFollowupSkip', () => {
  it('should set the flag only on the lead\'s active sequence', async () => {
    const stateEq = vi.fn().mockResolvedValue({ error: null })
    const leadEq = vi.fn().mockReturnValue({ eq: stateEq })
    const update = vi.fn().mockReturnValue({ eq: leadEq })
    const supabase = { from: () => ({ update }) } as never

    await requestFollowupSkip(supabase, 'lead1')

    expect(update).toHaveBeenCalledWith({ skip_next_step: true })
    expect(leadEq).toHaveBeenCalledWith('lead_id', 'lead1')
    expect(stateEq).toHaveBeenCalledWith('state', 'active')
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(requestFollowupSkip(supabase, 'lead1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('consumeFollowupSkip', () => {
  it('should clear the flag and report the win', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ id: 'seq1' }], error: null })
    const flagEq = vi.fn().mockReturnValue({ select })
    const stateEq = vi.fn().mockReturnValue({ eq: flagEq })
    const idEq = vi.fn().mockReturnValue({ eq: stateEq })
    const update = vi.fn().mockReturnValue({ eq: idEq })
    const supabase = { from: () => ({ update }) } as never

    await expect(consumeFollowupSkip(supabase, 'seq1')).resolves.toBe(true)

    expect(update).toHaveBeenCalledWith({ skip_next_step: false })
    expect(idEq).toHaveBeenCalledWith('id', 'seq1')
    expect(stateEq).toHaveBeenCalledWith('state', 'active')
    expect(flagEq).toHaveBeenCalledWith('skip_next_step', true)
  })

  it('should report false when another delivery already consumed the flag', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }),
        }),
      }),
    } as never
    await expect(consumeFollowupSkip(supabase, 'seq1')).resolves.toBe(false)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const supabase = {
      from: () => ({
        update: () => ({
          eq: () => ({
            eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
          }),
        }),
      }),
    } as never
    await expect(consumeFollowupSkip(supabase, 'seq1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/db/sequences.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/db/sequences.ts`:

```ts
// A human interjected into this lead's cadence: mark the next scheduled step to
// be skipped when its QStash message fires. Guarded on 'active' — a stopped or
// completed sequence has no next step to skip. Idempotent by construction: two
// manual sends before the next firing still skip exactly one step, which is the
// intended reading of "don't let the agent talk over me".
export async function requestFollowupSkip(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ skip_next_step: true })
    .eq('lead_id', leadId)
    .eq('state', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to request follow-up skip', { leadId, cause: error.message })
  }
}

// Claims the pending skip. The `.eq('skip_next_step', true)` guard is what makes
// this a claim rather than a write: a duplicate QStash delivery that arrives
// after the flag was consumed matches no row, gets false, and must not enqueue a
// second copy of the next step.
//
// Deliberately does NOT advance current_step. The caller advances only after the
// next step is successfully enqueued, so a publish failure leaves the sequence
// at step N-1 with the flag gone — the QStash retry then sends a real nudge
// instead of skipping. Losing a skip is strictly better than a cadence that
// silently ends.
export async function consumeFollowupSkip(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<boolean> {
  const { data, error } = await supabase
    .from('sequences')
    .update({ skip_next_step: false })
    .eq('id', id)
    .eq('state', 'active')
    .eq('skip_next_step', true)
    .select('id')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to consume follow-up skip', { id, cause: error.message })
  }
  return (data?.length ?? 0) > 0
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/db/sequences.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/sequences.ts src/lib/db/sequences.test.ts
git commit -m "feat: add request and consume helpers for the follow-up skip"
```

---

## Task 7: The skip branch in `runFollowupStep`

**Files:**
- Modify: `src/lib/pipeline/followup.ts` (`runFollowupStep`, after the campaign-active branch at `:147-162`)
- Test: `src/lib/pipeline/followup.test.ts`

**Interfaces:**
- Consumes: `consumeFollowupSkip` (Task 6).
- Produces: no new exports. `runFollowupStep` returns `action: 'skipped'` on a skip.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pipeline/followup.test.ts`, add `const consumeFollowupSkipMock = vi.fn()` with the other mocks, add `consumeFollowupSkip: (...a: unknown[]) => consumeFollowupSkipMock(...a)` to the `vi.mock('@/lib/db/sequences', ...)` factory, add it to the `beforeEach` reset list, and add `consumeFollowupSkipMock.mockResolvedValue(true)` plus `getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: false })` defaults. Then append:

```ts
describe('runFollowupStep — manual-send skip', () => {
  it('should send nothing, consume the flag and enqueue the next step', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: true })
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
      FOLLOWUP_DELAYS_SECONDS[1],
    )
    expect(advanceSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', {
      currentStep: 1, nextActionAt: null, qstashMessageId: 'qmsg-next',
    })
  })

  it('should not enqueue twice when another delivery already consumed the flag', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: true })
    consumeFollowupSkipMock.mockResolvedValue(false)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('skipped')
    expect(publishDelayMock).not.toHaveBeenCalled()
    expect(advanceSequenceMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence on a skipped final step without killing the case', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2, skip_next_step: true })

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })

    expect(result.action).toBe('skipped')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'stopped')
    expect(updateCaseStatusMock).not.toHaveBeenCalled()
    expect(publishDelayMock).not.toHaveBeenCalled()
  })

  it('should let an inbound reply win over a pending skip', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: true })
    hasInboundReplyMock.mockResolvedValue(true)

    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(result.action).toBe('completed')
    expect(consumeFollowupSkipMock).not.toHaveBeenCalled()
  })

  it('should postpone the skip while the campaign is paused', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, skip_next_step: true })
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
})
```

Import `FOLLOWUP_DELAYS_SECONDS` in the test file alongside `runFollowupStep` if it is not already imported.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/pipeline/followup.test.ts`
Expected: FAIL — the first test sends a nudge instead of skipping.

- [ ] **Step 3: Write the implementation**

In `src/lib/pipeline/followup.ts`, add `consumeFollowupSkip` to the `@/lib/db/sequences` import, and insert this block immediately after the campaign-active branch (the one that reschedules on a paused campaign) and before the `const context: LlmCallContext = ...` line:

```ts
  // A human interjected into this cadence — a client wrote to this lead
  // themselves from the case page. Skip exactly one step: send nothing, consume
  // the flag, and schedule the step after it so the cadence survives instead of
  // ending here.
  //
  // Placed below the campaign-active branch so a paused client still freezes
  // everything, and above the LLM call so a skipped step costs no tokens. The
  // reply and lead/suppression checks sit above too, deliberately: a prospect
  // who answered ends the sequence outright, and a dead address still stops it.
  if (sequence.skip_next_step) {
    const consumed = await consumeFollowupSkip(supabase, sequence.id)
    // Lost the race with a duplicate delivery that already consumed the flag.
    // That run owns enqueuing the next step; this one must not enqueue a second.
    if (!consumed) return { sequenceId: sequence.id, action: 'skipped' }

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

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm test src/lib/pipeline/followup.test.ts && pnpm typecheck && pnpm lint`
Expected: all PASS, including every pre-existing follow-up test.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts
git commit -m "feat: skip one follow-up after a human writes to the lead"
```

---

## Task 8: `sendManualEmail` Server Action

**Files:**
- Modify: `src/lib/db/emails.ts` (add `insertManualEmail` after `claimReplyEmail`)
- Test: `src/lib/db/emails.test.ts`
- Create: `src/app/(app)/cases/[id]/send-actions.ts`
- Test: `src/app/(app)/cases/[id]/send-actions.test.ts`

**Interfaces:**
- Consumes: `claimOutboundEmail`, `listThreadEmails`, `hasInboundReply`, `markEmailSent`, `markEmailFailed` (`@/lib/db/emails`); `insertEmailAttachments` (`@/lib/db/email-attachments`); `resolveSelectedResources`, `loadResourceAttachments`; `sendViaMailbox` with `bypassDailyCap` (Task 5); `requestFollowupSkip` (Task 6); `scheduleFirstFollowup`, `FIRST_TOUCH_STEP` (`@/lib/pipeline/followup`); `updateCaseStatus` (`@/lib/db/cases`).
- Produces: `insertManualEmail(supabase, row: EmailInsert): Promise<EmailRow>`; `sendManualEmail(formData: FormData): Promise<void>` with form fields `caseId`, `leadId`, `subject`, `body`, `resourceIds` (repeated).

- [ ] **Step 1: Write the failing DB test**

Append to `src/lib/db/emails.test.ts` (add `insertManualEmail` to the import list):

```ts
describe('insertManualEmail', () => {
  it('should insert the row and return it', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 'e9' }, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    const result = await insertManualEmail(supabase, {
      client_id: 'c1', case_id: 'case1', lead_id: 'lead1', direction: 'outbound',
      subject: 's', body: 'b', status: 'queued', sequence_step: null, sent_by: 'u1',
    })

    expect(result).toEqual({ id: 'e9' })
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ sequence_step: null, sent_by: 'u1' }))
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(
      insertManualEmail(supabase, {
        client_id: 'c1', direction: 'outbound', status: 'queued',
      }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})
```

- [ ] **Step 2: Implement `insertManualEmail`**

In `src/lib/db/emails.ts`, after `claimReplyEmail`:

```ts
// A human-written email that is not a cadence step. sequence_step is null, so
// the (lead_id, sequence_step, direction) unique index cannot claim it — and
// should not: many manual messages per lead are legitimate, and Postgres allows
// unlimited nulls in a unique index. Used only when claimOutboundEmail found the
// step-0 slot already taken.
export async function insertManualEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow> {
  const { data, error } = await supabase.from('emails').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert manual email', {
      leadId: row.lead_id, cause: error?.message ?? 'no row returned',
    })
  }
  return data
}
```

- [ ] **Step 3: Write the failing action tests**

Create `src/app/(app)/cases/[id]/send-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUser = vi.fn()
const getCaseById = vi.fn()
const getLeadById = vi.fn()
const getCampaignForCase = vi.fn()
const resolveSelectedResources = vi.fn()
const loadResourceAttachments = vi.fn()
const listThreadEmails = vi.fn()
const hasInboundReply = vi.fn()
const claimOutboundEmail = vi.fn()
const insertManualEmail = vi.fn()
const insertEmailAttachments = vi.fn()
const markEmailSent = vi.fn()
const markEmailFailed = vi.fn()
const sendViaMailbox = vi.fn()
const scheduleFirstFollowup = vi.fn()
const requestFollowupSkip = vi.fn()
const updateCaseStatus = vi.fn()
const revalidatePath = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: () => requireUser() }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: () => Promise.resolve({}) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePath(...a) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseById(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatus(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadById(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCase(...a) }))
vi.mock('@/lib/db/emails', () => ({
  listThreadEmails: (...a: unknown[]) => listThreadEmails(...a),
  hasInboundReply: (...a: unknown[]) => hasInboundReply(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmail(...a),
  insertManualEmail: (...a: unknown[]) => insertManualEmail(...a),
  markEmailSent: (...a: unknown[]) => markEmailSent(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailed(...a),
}))
vi.mock('@/lib/db/email-attachments', () => ({
  insertEmailAttachments: (...a: unknown[]) => insertEmailAttachments(...a),
}))
vi.mock('@/lib/resources/select', () => ({
  resolveSelectedResources: (...a: unknown[]) => resolveSelectedResources(...a),
}))
vi.mock('@/lib/resources/load-attachments', () => ({
  loadResourceAttachments: (...a: unknown[]) => loadResourceAttachments(...a),
}))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailbox(...a) }))
vi.mock('@/lib/pipeline/followup', () => ({
  FIRST_TOUCH_STEP: 0,
  scheduleFirstFollowup: (...a: unknown[]) => scheduleFirstFollowup(...a),
}))
vi.mock('@/lib/db/sequences', () => ({ requestFollowupSkip: (...a: unknown[]) => requestFollowupSkip(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: () => Promise.resolve() }))

const { sendManualEmail } = await import('./send-actions')

const CASE_ID = '22222222-2222-4222-8222-222222222222'
const LEAD_ID = '11111111-1111-4111-8111-111111111111'
const RESOURCE_ID = '44444444-4444-4444-8444-444444444444'

function form(overrides: Record<string, string> = {}): FormData {
  const data = new FormData()
  data.set('caseId', CASE_ID)
  data.set('leadId', LEAD_ID)
  data.set('subject', 'Following up on our call')
  data.set('body', 'Hi Jane — as promised, the pricing sheet.')
  for (const [key, value] of Object.entries(overrides)) data.set(key, value)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready' })
  getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: CASE_ID, email: 'jane@target.com' })
  getCampaignForCase.mockResolvedValue({ id: 'camp1', mailbox_ids: ['m1'] })
  resolveSelectedResources.mockResolvedValue([])
  loadResourceAttachments.mockResolvedValue([])
  listThreadEmails.mockResolvedValue([])
  hasInboundReply.mockResolvedValue(false)
  claimOutboundEmail.mockResolvedValue({ id: 'e1' })
  insertManualEmail.mockResolvedValue({ id: 'e2' })
  sendViaMailbox.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<pm@mail>', threadId: 'thr1' })
})

describe('sendManualEmail — authorization', () => {
  it('should reject when the RLS-scoped read finds no such case', async () => {
    getCaseById.mockResolvedValue(null)
    await expect(sendManualEmail(form())).rejects.toMatchObject({ code: 'NOT_FOUND' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject a case belonging to another client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'u2', role: 'client', client_id: 'other' } })
    await expect(sendManualEmail(form())).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject a lead that is not on this case', async () => {
    getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: 'other-case', email: 'x@y.com' })
    await expect(sendManualEmail(form())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should reject a lead with no address', async () => {
    getLeadById.mockResolvedValue({ id: LEAD_ID, client_id: 'c1', case_id: CASE_ID, email: null })
    await expect(sendManualEmail(form())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should reject a campaign with no mailbox connected', async () => {
    getCampaignForCase.mockResolvedValue({ id: 'camp1', mailbox_ids: [] })
    await expect(sendManualEmail(form())).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should let an operator send on any client', async () => {
    requireUser.mockResolvedValue({ appUser: { id: 'op', role: 'operator', client_id: null } })
    await sendManualEmail(form())
    expect(sendViaMailbox).toHaveBeenCalled()
  })
})

describe('sendManualEmail — first touch', () => {
  it('should claim step 0, send with the cap bypassed, and start the cadence', async () => {
    await sendManualEmail(form())

    expect(claimOutboundEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sequence_step: 0, sent_by: 'u1', status: 'queued', direction: 'outbound' }),
    )
    expect(insertManualEmail).not.toHaveBeenCalled()
    expect(sendViaMailbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ purpose: 'outreach', bypassDailyCap: true, to: 'jane@target.com' }),
    )
    expect(markEmailSent).toHaveBeenCalledWith(expect.anything(), 'e1', {
      providerMessageId: '<pm@mail>', threadId: 'thr1', mailboxId: 'm1',
    })
    expect(scheduleFirstFollowup).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', caseId: CASE_ID, leadId: LEAD_ID,
    })
    expect(updateCaseStatus).toHaveBeenCalledWith(expect.anything(), CASE_ID, 'contacted')
    expect(requestFollowupSkip).not.toHaveBeenCalled()
  })

  it('should leave the status alone on a case already past first contact', async () => {
    getCaseById.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'replied' })
    await sendManualEmail(form())
    expect(updateCaseStatus).not.toHaveBeenCalled()
  })
})

describe('sendManualEmail — interjection', () => {
  beforeEach(() => {
    claimOutboundEmail.mockResolvedValue(null) // step 0 already taken by the agent
  })

  it('should record a null-step email and request one follow-up skip', async () => {
    await sendManualEmail(form())

    expect(insertManualEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ sequence_step: null, sent_by: 'u1' }),
    )
    expect(requestFollowupSkip).toHaveBeenCalledWith(expect.anything(), LEAD_ID)
    expect(scheduleFirstFollowup).not.toHaveBeenCalled()
    expect(updateCaseStatus).not.toHaveBeenCalled()
    expect(markEmailSent).toHaveBeenCalledWith(expect.anything(), 'e2', expect.anything())
  })

  it('should thread onto the existing conversation and send as a reply once the lead has written back', async () => {
    listThreadEmails.mockResolvedValue([
      { direction: 'outbound', thread_id: 'thr1', provider_message_id: '<a@mail>' },
      { direction: 'inbound', thread_id: 'thr1', provider_message_id: '<b@mail>' },
    ])
    hasInboundReply.mockResolvedValue(true)

    await sendManualEmail(form())

    expect(sendViaMailbox).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        purpose: 'reply', threadId: 'thr1', inReplyToMessageId: '<b@mail>', references: '<b@mail>',
      }),
    )
  })
})

describe('sendManualEmail — attachments and failures', () => {
  it('should record the attachments it resolved', async () => {
    const data = form()
    data.append('resourceIds', RESOURCE_ID)

    await sendManualEmail(data)

    expect(resolveSelectedResources).toHaveBeenCalledWith(expect.anything(), 'c1', [RESOURCE_ID])
    expect(insertEmailAttachments).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', emailId: 'e1', resourceIds: [RESOURCE_ID],
    })
  })

  it('should claim no row when the attachment selection is invalid', async () => {
    resolveSelectedResources.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'One of the selected files is no longer available', {}),
    )
    const data = form()
    data.append('resourceIds', RESOURCE_ID)

    await expect(sendManualEmail(data)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(claimOutboundEmail).not.toHaveBeenCalled()
    expect(sendViaMailbox).not.toHaveBeenCalled()
  })

  it('should mark the email failed and rethrow when the send throws', async () => {
    sendViaMailbox.mockRejectedValue(new AppError('FORBIDDEN', 'Recipient is suppressed', {}))

    await expect(sendManualEmail(form())).rejects.toMatchObject({ code: 'FORBIDDEN' })
    expect(markEmailFailed).toHaveBeenCalledWith(expect.anything(), 'e1')
    expect(markEmailSent).not.toHaveBeenCalled()
    expect(scheduleFirstFollowup).not.toHaveBeenCalled()
  })

  it('should not report a failed send when only the bookkeeping throws', async () => {
    scheduleFirstFollowup.mockRejectedValue(new Error('qstash down'))
    await expect(sendManualEmail(form())).resolves.toBeUndefined()
    expect(markEmailSent).toHaveBeenCalled()
  })

  it('should reject an empty body before touching anything', async () => {
    await expect(sendManualEmail(form({ body: '   ' }))).rejects.toThrow()
    expect(claimOutboundEmail).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `pnpm test src/lib/db/emails.test.ts "src/app/(app)/cases/[id]/send-actions.test.ts"`
Expected: FAIL — `insertManualEmail` missing (until Step 2 lands) and `./send-actions` unresolvable.

- [ ] **Step 5: Write the action**

Create `src/app/(app)/cases/[id]/send-actions.ts`:

```ts
'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, updateCaseStatus } from '@/lib/db/cases'
import { getLeadById } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import {
  listThreadEmails,
  hasInboundReply,
  claimOutboundEmail,
  insertManualEmail,
  markEmailSent,
  markEmailFailed,
} from '@/lib/db/emails'
import { insertEmailAttachments } from '@/lib/db/email-attachments'
import { requestFollowupSkip } from '@/lib/db/sequences'
import { resolveSelectedResources } from '@/lib/resources/select'
import { loadResourceAttachments } from '@/lib/resources/load-attachments'
import { sendViaMailbox, type SendViaMailboxResult } from '@/lib/mailbox/sender'
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from '@/lib/pipeline/followup'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { MAX_ATTACHMENTS_PER_EMAIL } from '@/lib/mailbox/attachments'
import { AppError } from '@/lib/errors/app-error'
import { logEventSafe } from '@/lib/events/log-event'

const MAX_SUBJECT_CHARS = 200
const MAX_BODY_CHARS = 20_000

// Statuses a manual first touch advances to 'contacted'. A case already past
// this point keeps whatever the pipeline gave it — a manual email is not a
// reason to walk a 'replied' case backwards.
const PRE_CONTACT_STATUSES: readonly string[] = ['new', 'researching', 'ready']

const sendSchema = z.object({
  caseId: z.string().uuid(),
  leadId: z.string().uuid(),
  subject: z.string().trim().min(1).max(MAX_SUBJECT_CHARS),
  body: z.string().trim().min(1).max(MAX_BODY_CHARS),
  // Shape only — resolveSelectedResources proves they exist, belong to this
  // client and fit the per-email budget.
  resourceIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_EMAIL).default([]),
})

/**
 * Sends an email a human wrote, to a lead on one of their own cases.
 *
 * Unlike approveDraft this is open to client-role users: that guard exists
 * because approving means rubber-stamping AI copy, while here the human wrote
 * the words. The authorization boundary is the RLS-scoped read below —
 * a client-role session can only resolve cases and leads its own policies
 * expose, re-checked against the session afterwards. The writes then go through
 * the admin client because RLS makes client-role users read-only on `emails`
 * (migration 0002).
 */
export async function sendManualEmail(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  const { caseId, leadId, subject, body, resourceIds } = sendSchema.parse({
    caseId: formData.get('caseId'),
    leadId: formData.get('leadId'),
    subject: formData.get('subject'),
    body: formData.get('body'),
    resourceIds: formData.getAll('resourceIds'),
  })

  const scoped = await createServerClient()
  const kase = await getCaseById(scoped, caseId)
  if (!kase) throw new AppError('NOT_FOUND', 'Case not found', { caseId })
  if (!canManageClient(appUser, kase.client_id)) {
    throw new AppError('UNAUTHORIZED', 'Case belongs to another client', { caseId, userId: appUser.id })
  }
  const lead = await getLeadById(scoped, leadId)
  if (!lead || lead.case_id !== caseId) {
    throw new AppError('VALIDATION_ERROR', 'Contact does not belong to this case', { caseId, leadId })
  }
  if (!lead.email) {
    throw new AppError('VALIDATION_ERROR', 'This contact has no email address', { leadId })
  }

  const supabase = createAdminClient()
  const campaign = await getCampaignForCase(supabase, caseId)
  if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found for case', { caseId })
  if (campaign.mailbox_ids.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'No mailbox is connected to this campaign', { caseId })
  }

  // Resolved BEFORE anything is claimed or written, matching approveDraft: a
  // selection the client can still correct must fail while the form is on
  // screen, not after the point of no return where the only outcome left is a
  // failed email.
  await resolveSelectedResources(supabase, kase.client_id, resourceIds)

  const thread = await listThreadEmails(supabase, leadId)
  const firstOutbound = thread.find((email) => email.direction === 'outbound')
  const threadId = firstOutbound?.thread_id ?? null
  const inReplyTo = thread.at(-1)?.provider_message_id ?? null
  // A lead who has written to us can be answered even while suppressed for
  // outreach; sendViaMailbox enforces that distinction, and a hard bounce still
  // blocks both.
  const purpose = (await hasInboundReply(supabase, leadId)) ? 'reply' : 'outreach'

  // Claiming step 0 when it is free makes this email the first touch. That is
  // what stops the write cron cold-emailing the same person days later, and
  // what stops find_stuck_cases (0006) dragging the case back to 'ready'
  // precisely because it has no step-0 outbound. A taken slot means a cadence
  // already exists, so this is an interjection instead.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: kase.client_id,
    case_id: caseId,
    lead_id: leadId,
    thread_id: threadId,
    direction: 'outbound',
    subject,
    body,
    status: 'queued',
    sequence_step: FIRST_TOUCH_STEP,
    sent_by: appUser.id,
  })
  const isFirstTouch = claimed !== null
  const email =
    claimed ??
    (await insertManualEmail(supabase, {
      client_id: kase.client_id,
      case_id: caseId,
      lead_id: leadId,
      thread_id: threadId,
      direction: 'outbound',
      subject,
      body,
      status: 'queued',
      sequence_step: null,
      sent_by: appUser.id,
    }))

  if (resourceIds.length > 0) {
    await insertEmailAttachments(supabase, {
      clientId: kase.client_id, emailId: email.id, resourceIds,
    })
  }

  let sent: SendViaMailboxResult
  try {
    // Inside the try so a storage failure lands in the same markEmailFailed path
    // as a send failure: an email promising an attachment must not go out
    // without one.
    const attachments = await loadResourceAttachments(supabase, kase.client_id, resourceIds)
    sent = await sendViaMailbox(supabase, {
      clientId: kase.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject,
      body,
      purpose,
      threadId,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
      attachments,
      // A human answering a prospect is never blocked by the agent having used
      // the day's quota. Health and suppression still apply.
      bypassDailyCap: true,
    })
  } catch (error) {
    try {
      await markEmailFailed(supabase, email.id)
    } catch {
      // Best-effort status write; the send error below is the one that matters.
    }
    revalidatePath(`/cases/${caseId}`)
    throw error
  }

  await markEmailSent(supabase, email.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })

  // Best-effort: the mail is already out, so a bookkeeping failure must not
  // surface to the client as a failed send.
  try {
    if (isFirstTouch) {
      await scheduleFirstFollowup(supabase, { clientId: kase.client_id, caseId, leadId })
      if (PRE_CONTACT_STATUSES.includes(kase.status)) {
        await updateCaseStatus(supabase, caseId, 'contacted')
      }
    } else {
      await requestFollowupSkip(supabase, leadId)
    }
  } catch (error) {
    await logEventSafe({
      clientId: kase.client_id,
      caseId,
      actor: `human:${appUser.id}`,
      type: 'email.manual_bookkeeping_failed',
      payload: { emailId: email.id, leadId, cause: error instanceof Error ? error.message : String(error) },
    })
  }

  await logEventSafe({
    clientId: kase.client_id,
    caseId,
    actor: `human:${appUser.id}`,
    type: 'email.manual_sent',
    payload: { emailId: email.id, leadId, isFirstTouch, attachmentCount: resourceIds.length },
  })

  revalidatePath(`/cases/${caseId}`)
  revalidatePath('/mail')
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `pnpm test src/lib/db/emails.test.ts "src/app/(app)/cases/[id]/send-actions.test.ts" && pnpm typecheck && pnpm lint`
Expected: all PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts "src/app/(app)/cases/[id]/send-actions.ts" "src/app/(app)/cases/[id]/send-actions.test.ts"
git commit -m "feat: let a client send an email from inside a case"
```

---

## Task 9: Composer UI in the case Mail tab

**Files:**
- Create: `src/app/(app)/cases/[id]/compose-form.tsx`
- Modify: `src/app/(app)/cases/[id]/page.tsx`

**Interfaces:**
- Consumes: `sendManualEmail` (Task 8); `ResourcePicker` and `ResourceSummary` from `@/components/resource-picker` / `@/components/resource-list`; `listActiveResourcesForClient` from `@/lib/db/client-resources`.
- Produces: `<ComposeForm caseId contacts resources defaultSubject />` where `contacts: readonly { id: string; fullName: string; email: string }[]`.

- [ ] **Step 1: Write the composer component**

Create `src/app/(app)/cases/[id]/compose-form.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { PaperPlaneTilt } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ResourcePicker } from '@/components/resource-picker'
import type { ResourceSummary } from '@/components/resource-list'
import { sendManualEmail } from './send-actions'

export interface ComposeContact {
  id: string
  fullName: string
  email: string
}

interface ComposeFormProps {
  caseId: string
  /** Active leads on this case that have an address. */
  contacts: readonly ComposeContact[]
  resources: readonly ResourceSummary[]
  /** `Re: <last outbound subject>` when a thread exists, else ''. */
  defaultSubject: string
}

// Maps the codes sendManualEmail can throw onto something a client can act on.
// Anything else is a bug, not a state they can fix.
function messageForError(error: unknown): string {
  const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : ''
  if (code === 'FORBIDDEN') return 'That address is on your suppression list, so nothing was sent.'
  if (code === 'RATE_LIMITED') return 'No healthy mailbox is available right now. Check Settings.'
  if (code === 'VALIDATION_ERROR') return 'Check the recipient, the subject and the attachments, then try again.'
  return 'Could not send that email. Try again.'
}

export function ComposeForm({
  caseId,
  contacts,
  resources,
  defaultSubject,
}: ComposeFormProps): React.ReactElement {
  const [leadId, setLeadId] = useState<string>(contacts[0]?.id ?? '')
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (contacts.length === 0) {
    return (
      <p className="border-hairline text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-sm">
        No contact on this case has a verified address yet, so there is nobody to write to.
      </p>
    )
  }

  function submit(formData: FormData): void {
    setError(null)
    setSentTo(null)
    formData.set('caseId', caseId)
    formData.set('leadId', leadId)
    startTransition(async () => {
      try {
        await sendManualEmail(formData)
        const recipient = contacts.find((contact) => contact.id === leadId)
        setSentTo(recipient?.email ?? 'the contact')
        setBody('')
      } catch (caught) {
        setError(messageForError(caught))
      }
    })
  }

  return (
    <form action={submit} className="border-hairline bg-surface flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-col gap-1.5">
          <Label htmlFor="compose-recipient">To</Label>
          <Select value={leadId} onValueChange={setLeadId}>
            <SelectTrigger id="compose-recipient">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {contacts.map((contact) => (
                <SelectItem key={contact.id} value={contact.id}>
                  {contact.fullName} — {contact.email}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <Label htmlFor="compose-subject">Subject</Label>
          <Input
            id="compose-subject"
            name="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={200}
            required
          />
        </div>
      </div>

      <Textarea
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder="Write your message. It goes out from your own mailbox, in your own words."
        rows={8}
        maxLength={20000}
        required
        aria-label="Message body"
      />

      <ResourcePicker resources={resources} name="resourceIds" />

      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
      {sentTo ? (
        <p role="status" className="text-[12px] text-[var(--status-won)]">
          Sent to {sentTo}. The agent will skip its next scheduled follow-up to this contact.
        </p>
      ) : null}

      <Button
        type="submit"
        size="sm"
        className="w-fit"
        disabled={isPending || subject.trim().length === 0 || body.trim().length === 0}
      >
        <PaperPlaneTilt size={13} weight="light" />
        {isPending ? 'Sending…' : 'Send'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 2: Wire the composer into the Mail tab**

In `src/app/(app)/cases/[id]/page.tsx`, add the imports:

```ts
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
import { ComposeForm } from './compose-form'
```

Add `listActiveResourcesForClient(supabase, kase.client_id, RESOURCE_LIMIT)` to the existing `Promise.all` (destructured as `resources`), with a module-level `const RESOURCE_LIMIT = 50` next to `EVENT_LIMIT`.

Build the composer's inputs after `const now = new Date()`:

```tsx
  // Parked leads are excluded: outreach to them was deliberately stopped, and a
  // send would be refused by the suppression check anyway.
  const composeContacts = leads
    .filter((lead) => lead.status !== 'parked' && lead.email !== null)
    // safe: filtered on lead.email !== null immediately above
    .map((lead) => ({ id: lead.id, fullName: lead.full_name, email: lead.email! }))

  const lastOutboundSubject = [...emails]
    .reverse()
    .find((email) => email.direction === 'outbound')?.subject ?? null
  const defaultSubject = lastOutboundSubject
    ? (lastOutboundSubject.startsWith('Re: ') ? lastOutboundSubject : `Re: ${lastOutboundSubject}`)
    : ''

  // Mapped inline, matching /inbox, /knowledge/resources and the client detail
  // page. Extracting a shared mapper is a cross-cutting change those three
  // surfaces would have to adopt too — out of scope here.
  const composeResources = resources.map((resource) => ({
    id: resource.id,
    clientId: resource.client_id,
    title: resource.title,
    description: resource.description,
    fileName: resource.file_name,
    mimeType: resource.mime_type,
    byteSize: resource.byte_size,
    contentStatus: resource.content_status,
    contentSummary: resource.content_summary,
    canManage: false,
  }))
```

Render it at the end of the Mail `TabsContent`, after both branches of the existing `emails.length === 0` ternary — so the composer is present whether or not the thread is empty:

```tsx
        <TabsContent value="mail">
          <div className="flex max-w-[80ch] flex-col gap-4">
            {emails.length === 0 ? (
              <EmptyState
                icon={Envelope}
                title="No mail on this case"
                description="Outbound drafts appear here once the writer agent runs, and replies land automatically when the inbound poller picks them up."
              />
            ) : (
              <div className="flex flex-col gap-3">
                {emails.map((email) => (
                  <EmailMessage
                    key={email.id}
                    direction={email.direction}
                    status={email.status}
                    subject={email.subject}
                    body={email.body}
                    sequenceStep={email.sequence_step}
                    timestamp={email.sent_at ?? email.created_at}
                    now={now}
                  />
                ))}
              </div>
            )}
            <ComposeForm
              caseId={kase.id}
              contacts={composeContacts}
              resources={composeResources}
              defaultSubject={defaultSubject}
            />
          </div>
        </TabsContent>
```

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

Then `pnpm dev` and check, on a case with at least one addressable contact: the composer renders under the thread; the subject prefills `Re: …` when there is prior outbound; sending appends the message to the thread after revalidation; the success line names the recipient; a case where every contact is parked or address-less shows the explanatory line instead of a dead form.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/cases/[id]/compose-form.tsx" "src/app/(app)/cases/[id]/page.tsx"
git commit -m "feat: add the client email composer to the case mail tab"
```

---

## Task 10: Provenance in the UI + roadmap

**Files:**
- Modify: `src/components/email-message.tsx`
- Modify: `src/app/(app)/cases/[id]/page.tsx`
- Modify: `src/app/(app)/mail/page.tsx`
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: `emails.sent_by` (Task 1).
- Produces: `EmailMessageProps.sentByHuman?: boolean`.

- [ ] **Step 1: Add the prop to `EmailMessage`**

In `src/components/email-message.tsx`, add to `EmailMessageProps`:

```ts
  /** Outbound only: true when a person wrote it, false/absent when the agent did. */
  sentByHuman?: boolean
```

Destructure `sentByHuman = false` in the signature, and replace the byline expression:

```tsx
            {isInbound ? 'Reply received' : sentByHuman ? 'Sent by a person' : 'Sent by agent'}
```

- [ ] **Step 2: Pass it from both surfaces**

In `src/app/(app)/cases/[id]/page.tsx`, on the `EmailMessage` inside the Mail tab, add:

```tsx
                    sentByHuman={email.sent_by !== null}
```

In `src/app/(app)/mail/page.tsx`, on its `EmailMessage`, add the same line.

- [ ] **Step 3: Verify**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS.

Then `pnpm dev`: an agent-sent message still reads "Sent by agent"; a message sent from the composer reads "Sent by a person" on both the case page and `/mail`.

- [ ] **Step 4: Update the roadmap**

Replace the "designed" entry at the end of `.claude/roadmap.md` with a shipped entry:

```markdown
## Client notes + client-written email (shipped 2026-07-28)

Spec: `docs/superpowers/specs/2026-07-28-client-notes-and-manual-send-design.md`.
Plan: `docs/superpowers/plans/2026-07-28-client-notes-and-manual-send.md`.
Migration `0020` — additive, no backfill, no deploy ordering constraint.

- **Notes** (`notes` table, RLS mirroring `client_resources`): case-anchored,
  `lead_id` set when the note is about one person. The whole client reads; only
  the author edits. Written through the *session-scoped* client — the policies
  are the boundary, unlike `emails`, where clients have no write policy and an
  explicit `canManageClient` check does the work. No prompt reads a note, so a
  client can record something unflattering without it reaching outbound copy.
  Panel sits above Contacts on the case page; a person note can be started from
  the About selector or from that contact's card.
- **Manual send** (`sendManualEmail`): a client writes to a lead on their own
  case, through the campaign's mailboxes, with resource attachments. Three
  decisions carry the weight:
  - A manual email with no step-0 outbound **claims that slot**. Otherwise the
    write cron cold-emails the same person days later, and `find_stuck_cases`
    (0006) drags the case back to `ready` precisely because it has no step-0
    email. Claiming it also starts the 3/7/14 cadence off the client's own
    message and moves a pre-contact case to `contacted`.
  - An interjection sets `sequences.skip_next_step`, consumed at fire time by
    `runFollowupStep`, which sends nothing and enqueues the step after — the
    cadence continues rather than dying. A reply still beats a pending skip; a
    paused campaign postpones it; two manual sends consume one skip; skipping the
    final step stops the sequence without marking the case `dead`.
    `consumeFollowupSkip` deliberately does not advance `current_step` — on a
    publish failure the retry sends a real nudge, and losing a skip is strictly
    better than a silently dead cadence.
  - The cap bypass is a **separate** `claim_mailbox_send_uncapped` RPC, never a
    parameter on the capped one, so the agent's path cannot accidentally become
    uncapped. `sent_today` still increments and `health <> 'blocked'` still
    applies.
- `emails.sent_by` records who typed a message; the case thread and `/mail` show
  "Sent by a person" against it.
```

- [ ] **Step 5: Full verification and commit**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: the whole suite green (all pre-existing tests plus the new ones), no type errors, no new lint warnings.

```bash
git add src/components/email-message.tsx "src/app/(app)/cases/[id]/page.tsx" "src/app/(app)/mail/page.tsx" .claude/roadmap.md
git commit -m "feat: mark human-sent mail in the thread and record the work in the roadmap"
```

---

## Self-Review Notes

Checked against the spec:

- Notes schema, RLS, scoped-client rule, DB layer, actions, panel placement above Contacts, contact-card entry point → Tasks 1–4.
- Manual send scope, composer contents, action flow, step-0 rule, skip, cap bypass, provenance → Tasks 1, 5–10.
- Testing section of the spec → the test steps in Tasks 2, 3, 5, 6, 7, 8. The spec also lists RLS integration coverage for `notes` in `src/lib/supabase/rls.integration.test.ts`; that suite runs against live credentials via `pnpm test:integration` and is **not** part of the per-task cycle. Add the `notes` cases there when the integration suite is next run against a seeded environment.
- Out-of-scope list → nothing in this plan implements free-form recipients, draft-assist, save-as-draft, note-fed prompts, or CRM-board note counts.

Three things changed during the review pass:

1. **`consumeFollowupSkip` was split.** The spec sketched it as clearing the flag *and* advancing the step. The helper now only claims the flag; `advanceSequence` runs after the next step is successfully enqueued. Combining them puts a window between "flag consumed, step advanced" and "next step enqueued" in which a publish failure permanently ends the cadence, because the retried delivery would fail the `current_step === step - 1` guard. The spec has been updated to match.
2. **Note authors are labelled, not named.** An earlier draft looked up author emails through `app_users` — that table carries only `id`, `role` and `client_id`; emails live in `auth.users`, reachable only via the admin client. Labels are "You" / "Teammate", which needs no query and leaks no addresses between teammates.
3. **The contact-card entry point was missing.** Task 4 now implements it as a `?note=<leadId>#notes` link, with the panel keyed on the target so its `useState`-seeded About selector re-initialises on a second click.
