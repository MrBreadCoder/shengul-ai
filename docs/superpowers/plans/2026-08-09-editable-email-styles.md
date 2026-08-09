# Editable & Addable Email Styles Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the fixed `concise`/`formal_intro` email-style enum with an operator-managed `email_styles` table, so operators can create, edit, delete, and set-default first-touch email voices from the client detail page with no engineer or migration involved.

**Architecture:** A new `email_styles` table holds `name` + `voice_instructions` (operator-editable) + `is_default`. `clients.email_style_id` (nullable FK) replaces `clients.email_style` (enum). `write.ts`'s `buildSystemPrompt(voiceInstructions)` concatenates a fixed, code-only guardrail block (subject-line rules, human-voice instruction, English-only, no bulk markers, dossier-grounded facts) with the resolved style's text — operators can never weaken those five rules through the text they control. A new `lib/db/email-styles.ts` holds all CRUD, and two new API routes (`/api/email-styles`, `/api/email-styles/[styleId]`) expose it to a redesigned `email-style-select.tsx` + new `email-style-manager-dialog.tsx` on `/clients/[id]`.

**Tech Stack:** Next.js App Router, Supabase (Postgres + PostgREST via `@supabase/supabase-js`), Zod, Vitest, shadcn/ui (`Dialog`, `Button`, `Input`, `Textarea`, `Label`), `@phosphor-icons/react`, `sonner` toasts.

**Plan-time refinement vs. the approved spec** (`docs/superpowers/specs/2026-08-09-editable-email-styles-design.md`): the spec's code sketch has `getClientById` return an embedded PostgREST join (`.select('*, email_style:email_styles(*)')`). This plan does **not** do that — `src/types/database.ts` is hand-authored (no live `supabase gen types` codegen, per its own header comment), and typing a PostgREST embed correctly by hand is fragile and inconsistent with every other query in this codebase, which always does one function = one table. Instead, `processLead` (write.ts) does a second, explicit lookup: `getEmailStyleById` if the client has an `email_style_id`, falling back to `getDefaultEmailStyle`. Same observable behavior (including the "missing client row never blocks generation" fallback), one extra indexed point-lookup per lead in a pipeline that already makes several sequential DB calls per lead — negligible. `getClientById` itself is untouched.

**Plan-time refinement, UI:** the spec describes an inline expand-in-place editor. This plan uses this codebase's existing `Dialog` pattern instead (see `edit-signature-dialog.tsx`, `rename-client-dialog.tsx`) — a "Manage styles" dialog triggered from the client page, which is still "inline on `/clients/[id]`, not a separate settings route" per the approved decision, and reuses an established, already-styled component instead of inventing a new inline-expand pattern.

## Global Constraints

- `strict: true` TypeScript, no `any` — use `unknown` and narrow, or a proper type (`.claude/QUALITY.md`).
- No `!` non-null assertion without a comment proving it safe.
- Every thrown/returned error carries `code`, `message`, `context` via `AppError` — never a bare `Error`, never swallowed.
- Zod validates every external input (API bodies).
- DB columns are `snake_case`; TypeScript fields are `camelCase` at the API/component boundary — map explicitly.
- Data access lives only in `src/lib/db/` — one function per DB operation, no multi-purpose query functions.
- Operator-only pages/components use plain English strings, **no** `useTranslations` — per `CLAUDE.md`: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES, TRANSLATE ONLY IN CLIENT FACING PLACES."
- No commented-out code, no `console.log`, no `TODO`/`FIXME`.
- Named exports everywhere except Next.js pages/layouts/components.
- Commit directly to `master` — no feature branch (per `CLAUDE.md`: "dont branch use main").
- Update `.claude/roadmap.md` when the feature is complete (per `CLAUDE.md`: "UPDATE THE `.claude/roadmap.md` EVERY TIME YOU MAKE PROGRESS").
- Test file colocated (`feature.test.ts` next to `feature.ts`), Vitest, Arrange-Act-Assert, `it('should ... when ...')` naming.
- Mock at the boundary (Supabase, not your own business logic); never hit real external services in unit tests.

---

### Task 1: Migration, generated types, and new `AppError` codes

**Files:**
- Create: `supabase/migrations/0035_email_styles_table.sql`
- Modify: `src/types/database.ts` (add `email_styles` table; change `clients.email_style` → `clients.email_style_id`; remove `email_style` from `Enums`; add `set_default_email_style` to `Functions`)
- Modify: `src/lib/errors/app-error.ts` (add three `AppErrorCode` values)

**Interfaces:**
- Produces: `Database['public']['Tables']['email_styles']['Row']` = `{ id: string; name: string; voice_instructions: string; is_default: boolean; created_at: string; updated_at: string }`
- Produces: `Database['public']['Tables']['clients']['Row']['email_style_id']: string | null`
- Produces: `AppErrorCode` gains `'EMAIL_STYLE_NAME_TAKEN' | 'EMAIL_STYLE_NOT_FOUND' | 'CANNOT_DELETE_DEFAULT_STYLE'`

- [x] **Step 1: Write the migration**

Create `supabase/migrations/0035_email_styles_table.sql`:

```sql
-- Operator-managed, fully dynamic first-touch email voices. Replaces the
-- fixed 'concise'/'formal_intro' enum from migration 0034 with a proper
-- table: operators can now create, edit, and delete styles from the client
-- detail page with no engineer/migration involved. See
-- docs/superpowers/specs/2026-08-09-editable-email-styles-design.md

create table email_styles (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  voice_instructions text not null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create unique index email_styles_name_key on email_styles (name);

-- Enforces "exactly one default" at the DB level: at most one row can have
-- is_default = true at any time.
create unique index email_styles_single_default_key on email_styles (is_default) where is_default;

-- Seed rows, ported from write.ts's CONCISE_SYSTEM_PROMPT / FORMAL_INTRO_SYSTEM_PROMPT
-- (migration 0034 era) with the now-fixed guardrail lines (English/translate,
-- no bulk markers, dossier-only facts, subject-line rules, human voice)
-- stripped out — those move into write.ts's FIXED_GUARDRAILS constant and
-- get appended to every style automatically, never stored per-row. Each
-- style keeps its own opening role sentence ("You write short..." /
-- "You write a formal B2B introduction email...") since that framing is
-- voice-specific, not a universal guardrail.
insert into email_styles (name, voice_instructions, is_default) values
  ('Concise (default)',
   'You write short, human-sounding B2B cold emails. One clear idea. 90 words or fewer. '
   || 'Lead with the specific dossier fact, not a greeting. '
   || 'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"), '
   || 'not the booking link. Only offer the booking link if it is clearly the natural next step — '
   || 'it is an optional extra, never the default ask.',
   true),
  ('Formal introduction',
   'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect. '
   || 'Structure the body as exactly five short paragraphs, in this order: '
   || '1. Greeting: "Dear [Recipient first name]," using the recipient''s first name from the Recipient '
   || 'line below; if no name is given, use "Dear," alone. '
   || '2. Self-introduction: one sentence giving the sender name and company name exactly as given in '
   || '"Sender name" / "Our company name" below, plus the company''s home base and years of experience — '
   || 'only the ones you have evidence for in "About our company"; drop whichever you don''t have '
   || 'rather than guessing. '
   || '3. Capabilities: one sentence on what the company manufactures or does, grounded in the value '
   || 'proposition and "About our company" below. '
   || '4. Hook: one sentence connecting to this specific recipient — cite a real fact about their '
   || 'company or industry from the dossier. Never use a generic line like "I came across your '
   || 'company" or "I wanted to introduce ourselves" — the hook must trace to a dossier fact. '
   || '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the '
   || 'kind of procurement or project relevant to their industry, followed by an offer to send the '
   || 'company profile, references, and product capabilities if so. Only mention the booking link '
   || 'here if it is clearly the natural next step; otherwise the offer to send materials is the '
   || 'entire ask. '
   || 'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any '
   || 'sign-off — a signature block is appended separately in code. '
   || '120 words or fewer, including the greeting.',
   false);

alter table clients add column email_style_id uuid references email_styles(id) on delete set null;

-- Explicit backfill (not left null) so every existing client's resolved
-- voice is pinned to its current wording — it can never silently change if
-- an operator later re-points is_default at a different style.
update clients set email_style_id = (select id from email_styles where name = 'Concise (default)')
  where email_style = 'concise';
update clients set email_style_id = (select id from email_styles where name = 'Formal introduction')
  where email_style = 'formal_intro';

alter table clients drop column email_style;
drop type email_style;

-- Atomically swaps which row is_default = true. Needed because the partial
-- unique index above forbids two rows being true at once, so "unset old,
-- set new" cannot safely be two independent supabase-js calls — a crash
-- between them would leave zero defaults. Wrapping both updates in one
-- function makes them atomic relative to the calling statement, matching
-- the security-definer RPC pattern already used by claim_mailbox_send
-- (migration 0012).
create or replace function public.set_default_email_style(p_id uuid)
returns setof public.email_styles
language plpgsql
security definer
set search_path = public
as $$
begin
  if not exists (select 1 from email_styles where id = p_id) then
    raise exception 'email_style % not found', p_id using errcode = 'P0002';
  end if;
  update email_styles set is_default = false where is_default = true and id <> p_id;
  update email_styles set is_default = true, updated_at = now() where id = p_id;
  return query select * from email_styles where id = p_id;
end;
$$;
```

- [x] **Step 2: Update `src/types/database.ts` — `clients` table**

In the `clients.Row` block, replace:

```ts
          email_style: Database['public']['Enums']['email_style']
```

with:

```ts
          email_style_id: string | null
```

In the `clients.Insert` block, replace:

```ts
          email_style?: Database['public']['Enums']['email_style']
```

with:

```ts
          email_style_id?: string | null
```

Replace the `clients` table's `Relationships: []` with:

```ts
        Relationships: [
          {
            foreignKeyName: 'clients_email_style_id_fkey'
            columns: ['email_style_id']
            isOneToOne: false
            referencedRelation: 'email_styles'
            referencedColumns: ['id']
          },
        ]
```

- [x] **Step 3: Add the `email_styles` table type**

Immediately after the `clients` table block's closing `}` (before the `app_users:` block), insert:

```ts
      email_styles: {
        Row: {
          id: string
          name: string
          voice_instructions: string
          is_default: boolean
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          voice_instructions: string
          is_default?: boolean
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['email_styles']['Insert']>
        Relationships: []
      }
```

- [x] **Step 4: Remove the `email_style` enum, add the `set_default_email_style` function**

In the `Enums` block, delete the line:

```ts
      email_style: 'concise' | 'formal_intro'
```

In the `Functions` block, add (alongside the other RPC entries, e.g. next to `claim_mailbox_send`):

```ts
      set_default_email_style: {
        Args: { p_id: string }
        Returns: Database['public']['Tables']['email_styles']['Row'][]
      }
```

- [x] **Step 5: Add the new `AppErrorCode` values**

In `src/lib/errors/app-error.ts`, extend the union:

```ts
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'EXTERNAL_TIMEOUT'
  | 'EXTERNAL_ERROR'
  | 'DB_ERROR'
  | 'CONFIG_ERROR'
  | 'INVARIANT_VIOLATION'
  | 'EMAIL_STYLE_NAME_TAKEN'
  | 'EMAIL_STYLE_NOT_FOUND'
  | 'CANNOT_DELETE_DEFAULT_STYLE'
```

- [x] **Step 6: Type-check**

Run: `pnpm exec tsc --noEmit`
Expected: fails at this point — every file still referencing `email_style`/`selectSystemPrompt`/`EmailStyle`/`Database['public']['Enums']['email_style']` will now show a type error. That's expected; those call sites are fixed in Tasks 2–8. Confirm the errors are *only* in the files this plan's later tasks touch (`src/lib/db/clients.ts`, `src/lib/pipeline/write.ts`, `src/lib/pipeline/write.test.ts`, `src/app/(app)/clients/[id]/page.tsx`, `src/app/(app)/clients/[id]/email-style-select.tsx`, `src/app/api/clients/[clientId]/route.ts`, `src/app/api/clients/[clientId]/route.test.ts`, `scripts/regenerate-sample-emails.ts`, `scripts/rewrite-draft-emails.ts`) — no surprises elsewhere.

- [ ] **Step 7: Commit**

```bash
git add supabase/migrations/0035_email_styles_table.sql src/types/database.ts src/lib/errors/app-error.ts
git commit -m "feat(db): email_styles table replaces the fixed email_style enum

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `src/lib/db/email-styles.ts` — CRUD layer

**Files:**
- Create: `src/lib/db/email-styles.ts`
- Test: `src/lib/db/email-styles.test.ts`

**Interfaces:**
- Consumes: `SupabaseClient<Database>` from `@supabase/supabase-js`; `AppError` from `@/lib/errors/app-error`; `Database` from `@/types/database`.
- Produces: `EmailStyleRow` type; `listEmailStyles(supabase)`, `getEmailStyleById(supabase, id)`, `getDefaultEmailStyle(supabase)`, `createEmailStyle(supabase, { name, voiceInstructions })`, `updateEmailStyle(supabase, id, { name?, voiceInstructions? })`, `setDefaultEmailStyle(supabase, id)`, `deleteEmailStyle(supabase, id)` — all consumed by Tasks 4, 6, 7.

- [x] **Step 1: Write the failing tests**

Create `src/lib/db/email-styles.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  listEmailStyles,
  getEmailStyleById,
  getDefaultEmailStyle,
  createEmailStyle,
  updateEmailStyle,
  setDefaultEmailStyle,
  deleteEmailStyle,
} from './email-styles'
import { AppError } from '@/lib/errors/app-error'

describe('listEmailStyles', () => {
  it('should return every style ordered by name', async () => {
    const rows = [{ id: 's1', name: 'Concise (default)' }, { id: 's2', name: 'Formal introduction' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listEmailStyles(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listEmailStyles(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getEmailStyleById', () => {
  it('should return the style row when found', async () => {
    const row = { id: 's1', name: 'Concise (default)' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getEmailStyleById(supabase, 's1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    const result = await getEmailStyleById(supabase, 'missing')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getEmailStyleById(supabase, 's1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('getDefaultEmailStyle', () => {
  it('should return the row marked is_default', async () => {
    const row = { id: 's1', name: 'Concise (default)', is_default: true }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getDefaultEmailStyle(supabase)
    expect(result).toEqual(row)
  })

  it('should throw INVARIANT_VIOLATION when no row is marked default', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(getDefaultEmailStyle(supabase)).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' })
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getDefaultEmailStyle(supabase)).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('createEmailStyle', () => {
  it('should insert and return the new style row', async () => {
    const row = { id: 's3', name: 'Casual', voice_instructions: 'Keep it light.', is_default: false }
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const result = await createEmailStyle({ from: () => ({ insert }) } as never, {
      name: 'Casual',
      voiceInstructions: 'Keep it light.',
    })
    expect(insert).toHaveBeenCalledWith({ name: 'Casual', voice_instructions: 'Keep it light.' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_STYLE_NAME_TAKEN on a unique-constraint conflict', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }),
      }),
    } as never
    await expect(createEmailStyle(supabase, { name: 'Concise (default)', voiceInstructions: 'x' })).rejects.toMatchObject({
      code: 'EMAIL_STYLE_NAME_TAKEN',
    })
  })

  it('should throw DB_ERROR on any other insert failure', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }) }),
      }),
    } as never
    await expect(createEmailStyle(supabase, { name: 'Casual', voiceInstructions: 'x' })).rejects.toMatchObject({
      code: 'DB_ERROR',
    })
  })
})

describe('updateEmailStyle', () => {
  it('should update only the provided fields and return the row', async () => {
    const row = { id: 's1', name: 'Concise', voice_instructions: 'New text.' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateEmailStyle({ from: () => ({ update }) } as never, 's1', { voiceInstructions: 'New text.' })
    expect(update).toHaveBeenCalledWith({ voice_instructions: 'New text.' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_STYLE_NOT_FOUND when no row matches the id', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
    } as never
    await expect(updateEmailStyle(supabase, 'missing', { name: 'X' })).rejects.toMatchObject({ code: 'EMAIL_STYLE_NOT_FOUND' })
  })

  it('should throw EMAIL_STYLE_NAME_TAKEN on a unique-constraint conflict', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '23505', message: 'duplicate key' } }) }) }) }),
      }),
    } as never
    await expect(updateEmailStyle(supabase, 's1', { name: 'Formal introduction' })).rejects.toMatchObject({
      code: 'EMAIL_STYLE_NAME_TAKEN',
    })
  })

  it('should throw DB_ERROR on any other update failure', async () => {
    const supabase = {
      from: () => ({
        update: () => ({ eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) }) }) }),
      }),
    } as never
    await expect(updateEmailStyle(supabase, 's1', { name: 'X' })).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('setDefaultEmailStyle', () => {
  it('should call the set_default_email_style RPC and return the new default row', async () => {
    const row = { id: 's2', name: 'Formal introduction', is_default: true }
    const rpc = vi.fn().mockReturnValue(Promise.resolve({ data: [row], error: null }))
    const result = await setDefaultEmailStyle({ rpc } as never, 's2')
    expect(rpc).toHaveBeenCalledWith('set_default_email_style', { p_id: 's2' })
    expect(result).toEqual(row)
  })

  it('should throw EMAIL_STYLE_NOT_FOUND when the RPC raises P0002', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { code: 'P0002', message: 'not found' } }) } as never
    await expect(setDefaultEmailStyle(supabase, 'missing')).rejects.toMatchObject({ code: 'EMAIL_STYLE_NOT_FOUND' })
  })

  it('should throw DB_ERROR on any other RPC failure', async () => {
    const supabase = { rpc: () => Promise.resolve({ data: null, error: { code: '500', message: 'boom' } }) } as never
    await expect(setDefaultEmailStyle(supabase, 's1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('deleteEmailStyle', () => {
  it('should reassign referencing clients to null then delete the style', async () => {
    const style = { id: 's3', name: 'Casual', is_default: false }
    const getById = vi.fn(() => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: style, error: null }) }) }))
    const clientsUpdate = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const stylesDelete = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const from = vi.fn((table: string) => {
      if (table === 'email_styles') return { select: getById, delete: stylesDelete }
      if (table === 'clients') return { update: clientsUpdate }
      throw new Error(`unexpected table ${table}`)
    })
    await deleteEmailStyle({ from } as never, 's3')
    expect(clientsUpdate).toHaveBeenCalledWith({ email_style_id: null })
    expect(stylesDelete).toHaveBeenCalled()
  })

  it('should throw EMAIL_STYLE_NOT_FOUND when the style does not exist', async () => {
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }))
    await expect(deleteEmailStyle({ from } as never, 'missing')).rejects.toMatchObject({ code: 'EMAIL_STYLE_NOT_FOUND' })
  })

  it('should throw CANNOT_DELETE_DEFAULT_STYLE when the style is_default', async () => {
    const style = { id: 's1', name: 'Concise (default)', is_default: true }
    const from = vi.fn(() => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: style, error: null }) }) }) }))
    await expect(deleteEmailStyle({ from } as never, 's1')).rejects.toMatchObject({ code: 'CANNOT_DELETE_DEFAULT_STYLE' })
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/email-styles.test.ts`
Expected: FAIL — `Cannot find module './email-styles'` (the module doesn't exist yet).

- [x] **Step 3: Write the implementation**

Create `src/lib/db/email-styles.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EmailStyleRow = Database['public']['Tables']['email_styles']['Row']

const POSTGRES_UNIQUE_VIOLATION = '23505'

export async function listEmailStyles(supabase: SupabaseClient<Database>): Promise<EmailStyleRow[]> {
  const { data, error } = await supabase.from('email_styles').select('*').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list email styles', { cause: error.message })
  return data ?? []
}

export async function getEmailStyleById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailStyleRow | null> {
  const { data, error } = await supabase.from('email_styles').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load email style', { id, cause: error.message })
  return data
}

// Always exists post-migration — the DB's partial unique index on is_default
// guarantees at most one row is ever marked default, and every migration
// that adds a style leaves exactly one. Throws loudly rather than silently
// falling back to hardcoded prompt text if that invariant is ever broken,
// per QUALITY.md's "fail loudly, fail explicitly" rule.
export async function getDefaultEmailStyle(supabase: SupabaseClient<Database>): Promise<EmailStyleRow> {
  const { data, error } = await supabase.from('email_styles').select('*').eq('is_default', true).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load default email style', { cause: error.message })
  if (!data) throw new AppError('INVARIANT_VIOLATION', 'No email style is marked default', {})
  return data
}

export interface CreateEmailStyleInput {
  name: string
  voiceInstructions: string
}

export async function createEmailStyle(
  supabase: SupabaseClient<Database>,
  input: CreateEmailStyleInput,
): Promise<EmailStyleRow> {
  const { data, error } = await supabase
    .from('email_styles')
    .insert({ name: input.name, voice_instructions: input.voiceInstructions })
    .select('*')
    .single()
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('EMAIL_STYLE_NAME_TAKEN', `An email style named "${input.name}" already exists`, {
        name: input.name,
      })
    }
    throw new AppError('DB_ERROR', 'Failed to create email style', { cause: error.message })
  }
  if (!data) throw new AppError('DB_ERROR', 'Failed to create email style', {})
  return data
}

export interface UpdateEmailStyleInput {
  name?: string
  voiceInstructions?: string
}

export async function updateEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
  input: UpdateEmailStyleInput,
): Promise<EmailStyleRow> {
  const patch: Database['public']['Tables']['email_styles']['Update'] = {}
  if (input.name !== undefined) patch.name = input.name
  if (input.voiceInstructions !== undefined) patch.voice_instructions = input.voiceInstructions

  const { data, error } = await supabase.from('email_styles').update(patch).eq('id', id).select('*').maybeSingle()
  if (error) {
    if (error.code === POSTGRES_UNIQUE_VIOLATION) {
      throw new AppError('EMAIL_STYLE_NAME_TAKEN', `An email style named "${input.name}" already exists`, {
        name: input.name,
      })
    }
    throw new AppError('DB_ERROR', 'Failed to update email style', { id, cause: error.message })
  }
  if (!data) throw new AppError('EMAIL_STYLE_NOT_FOUND', 'Email style not found', { id })
  return data
}

// Wraps the unset-old/set-new pair in the set_default_email_style Postgres
// function (migration 0035) so a crash between the two updates can never
// leave zero styles marked default — the DB's partial unique index on
// is_default forbids two rows being true at once, so this cannot safely be
// two independent supabase-js calls without a transaction.
export async function setDefaultEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailStyleRow> {
  const { data, error } = await supabase.rpc('set_default_email_style', { p_id: id })
  if (error) {
    if (error.code === 'P0002') {
      throw new AppError('EMAIL_STYLE_NOT_FOUND', 'Email style not found', { id })
    }
    throw new AppError('DB_ERROR', 'Failed to set default email style', { id, cause: error.message })
  }
  // length check guarantees index 0 exists — mirrors claimMailboxSend's
  // identical setof-RPC-to-single-row pattern (lib/db/mailboxes.ts).
  if (!data || data.length === 0) {
    throw new AppError('DB_ERROR', 'Failed to set default email style', { id })
  }
  return data[0]!
}

// Deleting an in-use, non-default style falls clients using it back to
// whichever style is default. Reassign-then-delete is safe even if the
// process crashes between the two steps: the row simply remains undeleted
// with zero clients pointing to it, never a dangling foreign key.
export async function deleteEmailStyle(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const style = await getEmailStyleById(supabase, id)
  if (!style) throw new AppError('EMAIL_STYLE_NOT_FOUND', 'Email style not found', { id })
  if (style.is_default) {
    throw new AppError('CANNOT_DELETE_DEFAULT_STYLE', 'Cannot delete the default email style', { id })
  }

  const { error: reassignError } = await supabase
    .from('clients')
    .update({ email_style_id: null })
    .eq('email_style_id', id)
  if (reassignError) {
    throw new AppError('DB_ERROR', 'Failed to reassign clients off the deleted email style', {
      id,
      cause: reassignError.message,
    })
  }

  const { error: deleteError } = await supabase.from('email_styles').delete().eq('id', id)
  if (deleteError) {
    throw new AppError('DB_ERROR', 'Failed to delete email style', { id, cause: deleteError.message })
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/email-styles.test.ts`
Expected: PASS — all cases green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/email-styles.ts src/lib/db/email-styles.test.ts
git commit -m "feat(db): add email-styles CRUD layer

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: `src/lib/db/clients.ts` — swap `updateClientEmailStyle` to the FK

**Files:**
- Modify: `src/lib/db/clients.ts:151-168`
- Modify (test): `src/lib/db/clients.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `updateClientEmailStyle(supabase, id, styleId: string | null): Promise<ClientRow>` — consumed by Task 8's API route.

- [x] **Step 1: Update the failing expectation in `clients.test.ts`**

There is no existing `describe('updateClientEmailStyle', ...)` block in `clients.test.ts` today (it was added for the enum version in the prior email-style feature but is not present in the current file — confirm with `grep -n "updateClientEmailStyle" src/lib/db/clients.test.ts` before writing; if a block already exists, replace it, otherwise add it). Add:

```ts
describe('updateClientEmailStyle', () => {
  it('should persist the style id and return the updated client', async () => {
    const row = { id: 'c1', email_style_id: 's2' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientEmailStyle({ from: () => ({ update }) } as never, 'c1', 's2')
    expect(update).toHaveBeenCalledWith({ email_style_id: 's2' })
    expect(result).toEqual(row)
  })

  it('should allow clearing the style id with null', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: { id: 'c1', email_style_id: null }, error: null }) }) }),
    })
    await updateClientEmailStyle({ from: () => ({ update }) } as never, 'c1', null)
    expect(update).toHaveBeenCalledWith({ email_style_id: null })
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientEmailStyle({ from: () => ({ update }) } as never, 'c1', 's2'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Also update the top-of-file `import { ... updateClientEmailStyle ... } from './clients'` list if not already present.

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: FAIL — `updateClientEmailStyle` still takes the old enum type, or the mocked `update` call assertion (`{ email_style_id: ... }`) doesn't match the current implementation's `{ email_style: ... }` call.

- [x] **Step 3: Update the implementation**

In `src/lib/db/clients.ts`, replace the `updateClientEmailStyle` function (currently lines 151-168):

```ts
// The client-level first-touch email voice. See selectSystemPrompt in
// write.ts for how this is consumed.
export async function updateClientEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
  style: Database['public']['Enums']['email_style'],
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ email_style: style })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client email style', { id, cause: error?.message })
  }
  return data
}
```

with:

```ts
// The client-level first-touch email voice — a reference into email_styles,
// resolved by write.ts's buildSystemPrompt via getEmailStyleById /
// getDefaultEmailStyle (see lib/db/email-styles.ts). `null` means "use
// whichever style is currently marked default."
export async function updateClientEmailStyle(
  supabase: SupabaseClient<Database>,
  id: string,
  styleId: string | null,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ email_style_id: styleId })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client email style', { id, cause: error?.message })
  }
  return data
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts
git commit -m "feat(db): updateClientEmailStyle now takes an email_styles id

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: `src/lib/pipeline/write.ts` — fixed guardrails + `buildSystemPrompt`

**Files:**
- Modify: `src/lib/pipeline/write.ts:1-19` (imports), `:46-114` (prompt constants), `:144-167` (`processLead`)
- Modify (test): `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `getEmailStyleById`, `getDefaultEmailStyle` from `@/lib/db/email-styles` (Task 2).
- Produces: `buildSystemPrompt(voiceInstructions: string): string` — replaces `selectSystemPrompt`/`CONCISE_SYSTEM_PROMPT`/`FORMAL_INTRO_SYSTEM_PROMPT`/`EmailStyle`, all four removed. Consumed nowhere else in this plan except Task 5's scripts.

- [x] **Step 1: Update the failing tests in `write.test.ts`**

Replace the import line:

```ts
import { runWriteForCase, CONCISE_SYSTEM_PROMPT, FORMAL_INTRO_SYSTEM_PROMPT } from './write'
```

with:

```ts
import { runWriteForCase, buildSystemPrompt } from './write'
```

Add two new mocks alongside the existing ones at the top of the file:

```ts
const getEmailStyleByIdMock = vi.fn()
const getDefaultEmailStyleMock = vi.fn()
```

Add to the `vi.mock('@/lib/db/clients', ...)` block's neighbor — a new mock module:

```ts
vi.mock('@/lib/db/email-styles', () => ({
  getEmailStyleById: (...a: unknown[]) => getEmailStyleByIdMock(...a),
  getDefaultEmailStyle: (...a: unknown[]) => getDefaultEmailStyleMock(...a),
}))
```

In the `beforeEach` reset list, add `getEmailStyleByIdMock` and `getDefaultEmailStyleMock`, and set their default resolved values right after the existing `getClientByIdMock.mockResolvedValue(...)` line:

```ts
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null, email_style_id: null })
  getDefaultEmailStyleMock.mockResolvedValue({ id: 'default-style', name: 'Concise (default)', voice_instructions: 'Default voice text.', is_default: true })
```

Replace the two style-specific tests at the bottom of the `describe('runWriteForCase', ...)` block:

```ts
  it('should use the formal-intro system prompt when the client email_style is formal_intro', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Uniforms Fashion', domain: null, phone: null,
      address: null, signature_name: 'Cihat Bozkurt', signature_title: null, email_style: 'formal_intro',
    })

    await runWriteForCase({} as never, input)

    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: FORMAL_INTRO_SYSTEM_PROMPT }),
    )
  })

  it('should default to the concise system prompt when email_style is unset', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: CONCISE_SYSTEM_PROMPT }),
    )
  })
```

with:

```ts
  it('should look up the client\'s configured style and use its voice text when email_style_id is set', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Uniforms Fashion', domain: null, phone: null,
      address: null, signature_name: 'Cihat Bozkurt', signature_title: null, email_style_id: 'formal-style',
    })
    getEmailStyleByIdMock.mockResolvedValue({ id: 'formal-style', name: 'Formal introduction', voice_instructions: 'Five paragraphs, formal.', is_default: false })

    await runWriteForCase({} as never, input)

    expect(getEmailStyleByIdMock).toHaveBeenCalledWith(expect.anything(), 'formal-style')
    expect(getDefaultEmailStyleMock).not.toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Five paragraphs, formal.') }),
    )
  })

  it('should fall back to the default style when the client has no email_style_id', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(getEmailStyleByIdMock).not.toHaveBeenCalled()
    expect(getDefaultEmailStyleMock).toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Default voice text.') }),
    )
  })

  it('should fall back to the default style when the client has no row at all', async () => {
    getClientByIdMock.mockResolvedValue(null)
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(getDefaultEmailStyleMock).toHaveBeenCalled()
  })
```

Also add a standalone unit-test block for the pure function, above or below `describe('runWriteForCase', ...)`:

```ts
describe('buildSystemPrompt', () => {
  it('should include every fixed guardrail plus the given voice text', () => {
    const result = buildSystemPrompt('Write like a friendly consultant.')
    expect(result).toContain('Always write in English')
    expect(result).toContain('No bulk markers, no unsubscribe footer, no tracking language.')
    expect(result).toContain('Use only facts present in the provided dossier')
    expect(result).toContain('Subject line: 2-5 words')
    expect(result).toContain('Voice: write like you are messaging a peer')
    expect(result).toContain('Write like a friendly consultant.')
  })

  it('should place the voice text after the fixed guardrails', () => {
    const result = buildSystemPrompt('UNIQUE_VOICE_MARKER')
    const guardrailIndex = result.indexOf('Always write in English')
    const voiceIndex = result.indexOf('UNIQUE_VOICE_MARKER')
    expect(guardrailIndex).toBeGreaterThanOrEqual(0)
    expect(voiceIndex).toBeGreaterThan(guardrailIndex)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/write.test.ts`
Expected: FAIL — `buildSystemPrompt` is not exported yet, `CONCISE_SYSTEM_PROMPT`/`FORMAL_INTRO_SYSTEM_PROMPT` no longer exist as imports the file references (compile error) — expected until Step 3.

- [x] **Step 3: Update `write.ts`**

Update the import block (lines 1-19) — add the new dependency:

```ts
import { getClientById, type ClientRow } from '@/lib/db/clients'
```

becomes:

```ts
import { getClientById, type ClientRow } from '@/lib/db/clients'
import { getEmailStyleById, getDefaultEmailStyle } from '@/lib/db/email-styles'
```

(insert the new line directly after the existing `getClientById` import line, keeping the rest of the import block unchanged).

Replace the entire block from `export type EmailStyle = ...` through the end of `selectSystemPrompt` (currently lines 46-114):

```ts
export type EmailStyle = Database['public']['Enums']['email_style']

// Shared between both system prompts below so subject-line formatting can
// never drift between styles.
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]

// Default voice — dossier-led, low-friction, no greeting. Used for every
// client unless email_style is explicitly set to 'formal_intro'.
export const CONCISE_SYSTEM_PROMPT = [
  'You write short, human-sounding B2B cold emails.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'One clear idea. 90 words or fewer.',
  'Use only facts present in the provided dossier. Never invent specifics.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
  'Lead with the specific dossier fact, not a greeting.',
  'Call to action: default to a low-friction reply question (e.g. "worth a quick reply?"),',
  'not the booking link. Only offer the booking link if it is clearly the natural next step —',
  'it is an optional extra, never the default ask.',
].join(' ')

// Formal introduction voice — a per-client opt-in (clients.email_style =
// 'formal_intro'), currently used only by Uniforms Fashion. See
// docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md
export const FORMAL_INTRO_SYSTEM_PROMPT = [
  'You write a formal B2B introduction email for a manufacturer reaching out cold to a new prospect.',
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any specific you were not given.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
  'Structure the body as exactly five short paragraphs, in this order:',
  '1. Greeting: "Dear [Recipient first name]," using the recipient\'s first name from the Recipient',
  'line below; if no name is given, use "Dear," alone.',
  '2. Self-introduction: one sentence giving the sender name and company name exactly as given in',
  '"Sender name" / "Our company name" below, plus the company\'s home base and years of experience —',
  'only the ones you have evidence for in "About our company"; drop whichever you don\'t have',
  'rather than guessing.',
  '3. Capabilities: one sentence on what the company manufactures or does, grounded in the value',
  'proposition and "About our company" below.',
  '4. Hook: one sentence connecting to this specific recipient — cite a real fact about their',
  'company or industry from the dossier. Never use a generic line like "I came across your',
  'company" or "I wanted to introduce ourselves" — the hook must trace to a dossier fact.',
  '5. Ask: a qualifying question asking whether the recipient is the right person to discuss the',
  'kind of procurement or project relevant to their industry, followed by an offer to send the',
  'company profile, references, and product capabilities if so. Only mention the booking link',
  'here if it is clearly the natural next step; otherwise the offer to send materials is the',
  'entire ask.',
  'End the body immediately after the offer sentence. Do not add "Best regards," a name, or any',
  'sign-off — a signature block is appended separately in code.',
  '120 words or fewer, including the greeting.',
].join(' ')

// Picks the system prompt for a client's configured voice. Falls back to
// CONCISE_SYSTEM_PROMPT for null/undefined so a missing client row never
// blocks first-touch generation.
export function selectSystemPrompt(emailStyle: EmailStyle | null | undefined): string {
  return emailStyle === 'formal_intro' ? FORMAL_INTRO_SYSTEM_PROMPT : CONCISE_SYSTEM_PROMPT
}
```

with:

```ts
// Shared across every style's system prompt so subject-line formatting can
// never drift between them.
const SUBJECT_LINE_RULES = [
  `Subject line: 2-5 words, under ${SUBJECT_TARGET_CHARS} characters so it never truncates`,
  'on mobile. Make it specific to the recipient\'s company, role, or a dossier fact —',
  'never generic filler like "Quick question" or "Following up". No ALL CAPS, no',
  'exclamation marks, no "Re:"/"Fwd:" prefixes, no spam-trigger words (free, guarantee,',
  'act now, urgent, limited time, buy now).',
]

// Always true regardless of which email_styles row a client is on — never
// something an operator-authored style's voice_instructions can opt out of.
// This is the entire trust boundary between "operator picks the voice and
// structure" and "operator can break compliance": subject formatting,
// English-only output, no bulk-sender markers, and dossier-grounded facts
// all live here, in code, never in a database row a non-engineer edits. See
// docs/superpowers/specs/2026-08-09-editable-email-styles-design.md
const FIXED_GUARDRAILS = [
  'Always write in English, even if the dossier or company knowledge below is in',
  'another language — translate any facts you use, never copy foreign-language text.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'Use only facts present in the provided dossier or company knowledge below. Never invent a name,',
  'a year, a location, or any other specific you were not given.',
  ...SUBJECT_LINE_RULES,
  HUMAN_VOICE_INSTRUCTION,
].join(' ')

// Combines the fixed guardrails above with a style's operator-authored
// voice text (email_styles.voice_instructions). The only place style text
// touches the system prompt — kept pure so it's trivial to unit test.
export function buildSystemPrompt(voiceInstructions: string): string {
  return `${FIXED_GUARDRAILS} ${voiceInstructions}`
}
```

Update `processLead` (currently starting at line 144). Replace:

```ts
  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: selectSystemPrompt(client?.email_style),
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

with:

```ts
  // Resolves the client's configured voice, falling back to the DB-wide
  // default whenever the client has none set (or has no row at all) — same
  // "missing client row never blocks generation" guarantee the old
  // selectSystemPrompt(undefined) fallback provided.
  const clientStyle = client?.email_style_id ? await getEmailStyleById(supabase, client.email_style_id) : null
  const style = clientStyle ?? (await getDefaultEmailStyle(supabase))

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: buildSystemPrompt(style.voice_instructions),
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/write.test.ts`
Expected: PASS — all cases green, including the new `buildSystemPrompt` and fallback tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "feat(pipeline): resolve email voice from email_styles, not a fixed enum

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Update `scripts/regenerate-sample-emails.ts` and `scripts/rewrite-draft-emails.ts`

**Files:**
- Modify: `scripts/regenerate-sample-emails.ts`
- Modify: `scripts/rewrite-draft-emails.ts`

**Interfaces:**
- Consumes: `buildSystemPrompt` (Task 4), `getEmailStyleById`/`getDefaultEmailStyle` (Task 2).
- Produces: nothing consumed elsewhere — these are standalone operator CLI tools.

No test files exist for these scripts today (confirmed: `find scripts -name "*.test.ts"` returns nothing) — consistent with the prior formal-intro-style feature, which updated these same two scripts with no new test coverage. Verification here is `tsc --noEmit` plus a manual dry run against a real client id, not a unit test.

- [x] **Step 1: Update `scripts/regenerate-sample-emails.ts`**

In the `AppDeps` interface, replace:

```ts
  selectSystemPrompt: typeof import('../src/lib/pipeline/write').selectSystemPrompt
```

with:

```ts
  buildSystemPrompt: typeof import('../src/lib/pipeline/write').buildSystemPrompt
  getEmailStyleById: typeof import('../src/lib/db/email-styles').getEmailStyleById
  getDefaultEmailStyle: typeof import('../src/lib/db/email-styles').getDefaultEmailStyle
```

In `loadAppDeps`, add `emailStylesMod` to the `Promise.all` array and its destructure:

```ts
  const [writeMod, llmMod, schemaMod, caseKnowledgeMod, leadsMod, casesMod, campaignsMod, clientsMod, clientContextMod, buildQueryMod] =
    await Promise.all([
      import('../src/lib/pipeline/write'),
      import('../src/lib/llm/client'),
      import('../src/lib/pipeline/draft-schema'),
      import('../src/lib/db/case-knowledge'),
      import('../src/lib/db/leads'),
      import('../src/lib/db/cases'),
      import('../src/lib/db/campaigns'),
      import('../src/lib/db/clients'),
      import('../src/lib/knowledge/client-context'),
      import('../src/lib/knowledge/build-query'),
    ])
```

becomes:

```ts
  const [writeMod, llmMod, schemaMod, caseKnowledgeMod, leadsMod, casesMod, campaignsMod, clientsMod, emailStylesMod, clientContextMod, buildQueryMod] =
    await Promise.all([
      import('../src/lib/pipeline/write'),
      import('../src/lib/llm/client'),
      import('../src/lib/pipeline/draft-schema'),
      import('../src/lib/db/case-knowledge'),
      import('../src/lib/db/leads'),
      import('../src/lib/db/cases'),
      import('../src/lib/db/campaigns'),
      import('../src/lib/db/clients'),
      import('../src/lib/db/email-styles'),
      import('../src/lib/knowledge/client-context'),
      import('../src/lib/knowledge/build-query'),
    ])
```

and its return object, replacing:

```ts
    selectSystemPrompt: writeMod.selectSystemPrompt,
```

with:

```ts
    buildSystemPrompt: writeMod.buildSystemPrompt,
    getEmailStyleById: emailStylesMod.getEmailStyleById,
    getDefaultEmailStyle: emailStylesMod.getDefaultEmailStyle,
```

In `regenerateOne`, replace:

```ts
  const draft = await deps.generateJson(
    { clientId: sample.clientId, caseId: sample.caseId, actor: ACTOR },
    {
      instructions: deps.selectSystemPrompt(client?.email_style),
      prompt: deps.buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

with:

```ts
  const clientStyle = client?.email_style_id ? await deps.getEmailStyleById(supabase, client.email_style_id) : null
  const style = clientStyle ?? (await deps.getDefaultEmailStyle(supabase))

  const draft = await deps.generateJson(
    { clientId: sample.clientId, caseId: sample.caseId, actor: ACTOR },
    {
      instructions: deps.buildSystemPrompt(style.voice_instructions),
      prompt: deps.buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

- [x] **Step 2: Update `scripts/rewrite-draft-emails.ts`**

Apply the identical pattern: in `AppDeps`, replace `selectSystemPrompt` with `buildSystemPrompt`, `getEmailStyleById`, `getDefaultEmailStyle`; in `loadAppDeps`, add `import('../src/lib/db/email-styles')` to the `Promise.all` array and destructure/return it the same way; in `regenerateAndMaybeApply`, replace:

```ts
  const generated = await deps.generateJson(
    { clientId: draft.clientId, caseId: draft.caseId, actor: ACTOR },
    {
      instructions: deps.selectSystemPrompt(client?.email_style),
      prompt: deps.buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

with:

```ts
  const clientStyle = client?.email_style_id ? await deps.getEmailStyleById(supabase, client.email_style_id) : null
  const style = clientStyle ?? (await deps.getDefaultEmailStyle(supabase))

  const generated = await deps.generateJson(
    { clientId: draft.clientId, caseId: draft.caseId, actor: ACTOR },
    {
      instructions: deps.buildSystemPrompt(style.voice_instructions),
      prompt: deps.buildPrompt(input, lead, knowledge, clientKnowledge, client),
```

- [x] **Step 3: Type-check both scripts**

Run: `pnpm exec tsc --noEmit`
Expected: no errors originating from `scripts/regenerate-sample-emails.ts` or `scripts/rewrite-draft-emails.ts`.

- [ ] **Step 4: Commit**

```bash
git add scripts/regenerate-sample-emails.ts scripts/rewrite-draft-emails.ts
git commit -m "chore(scripts): update sample-email tools for the email_styles table

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: API route `src/app/api/email-styles/route.ts` — list + create

**Files:**
- Create: `src/app/api/email-styles/route.ts`
- Test: `src/app/api/email-styles/route.test.ts`

**Interfaces:**
- Consumes: `requireUser` (`@/lib/auth/require-user`), `createAdminClient` (`@/lib/supabase/admin`), `listEmailStyles`/`createEmailStyle` (Task 2), `logEvent` (`@/lib/events/log-event`), `isAppError` (`@/lib/errors/app-error`).
- Produces: `GET` → `{ styles: EmailStyleRow[] }`; `POST` → `{ ok: true, style: EmailStyleRow }` (201). Consumed by Task 9's UI.

- [x] **Step 1: Write the failing tests**

Create `src/app/api/email-styles/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const listEmailStylesMock = vi.fn()
const createEmailStyleMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/email-styles', () => ({
  listEmailStyles: (...a: unknown[]) => listEmailStylesMock(...a),
  createEmailStyle: (...a: unknown[]) => createEmailStyleMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { GET, POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  listEmailStylesMock.mockReset()
  createEmailStyleMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('GET /api/email-styles', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await GET()
    expect(res.status).toBe(403)
    expect(listEmailStylesMock).not.toHaveBeenCalled()
  })

  it('should return the list of styles for an operator', async () => {
    const rows = [{ id: 's1', name: 'Concise (default)' }]
    listEmailStylesMock.mockResolvedValue(rows)
    const res = await GET()
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.styles).toEqual(rows)
  })
})

describe('POST /api/email-styles', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ name: 'Casual', voiceInstructions: 'Keep it light.' }))
    expect(res.status).toBe(403)
    expect(createEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should create the style, log the event, and return it', async () => {
    const style = { id: 's3', name: 'Casual', voice_instructions: 'Keep it light.' }
    createEmailStyleMock.mockResolvedValue(style)
    const res = await POST(req({ name: 'Casual', voiceInstructions: 'Keep it light.' }))
    const json = await res.json()
    expect(res.status).toBe(201)
    expect(json.style).toEqual(style)
    expect(createEmailStyleMock).toHaveBeenCalledWith(expect.anything(), { name: 'Casual', voiceInstructions: 'Keep it light.' })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.created' }))
  })

  it('should return 400 when name is empty', async () => {
    const res = await POST(req({ name: '', voiceInstructions: 'x' }))
    expect(res.status).toBe(400)
    expect(createEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should return 400 when voiceInstructions exceeds 4000 characters', async () => {
    const res = await POST(req({ name: 'Casual', voiceInstructions: 'x'.repeat(4001) }))
    expect(res.status).toBe(400)
    expect(createEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should return 409 when the name is already taken', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    createEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NAME_TAKEN', 'taken'))
    const res = await POST(req({ name: 'Concise (default)', voiceInstructions: 'x' }))
    expect(res.status).toBe(409)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/api/email-styles/route.test.ts`
Expected: FAIL — `Cannot find module './route'`.

- [x] **Step 3: Write the implementation**

Create `src/app/api/email-styles/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listEmailStyles, createEmailStyle } from '@/lib/db/email-styles'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const nameSchema = z.string().trim().min(1).max(80)
const voiceInstructionsSchema = z.string().trim().min(1).max(4000)

const createSchema = z.object({
  name: nameSchema,
  voiceInstructions: voiceInstructionsSchema,
})

export async function GET(): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const admin = createAdminClient()
  const styles = await listEmailStyles(admin)
  return NextResponse.json({ styles })
}

export async function POST(request: Request): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const admin = createAdminClient()

  try {
    const body = createSchema.parse(await request.json())
    const style = await createEmailStyle(admin, body)
    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: 'email_style.created',
        payload: { id: style.id, name: style.name },
      })
    } catch {
      // Audit logging is best-effort — the create already succeeded.
    }
    return NextResponse.json({ ok: true, style }, { status: 201 })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NAME_TAKEN') {
      return NextResponse.json({ error: 'name_taken' }, { status: 409 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/email-styles/route.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/email-styles/route.ts src/app/api/email-styles/route.test.ts
git commit -m "feat(api): add GET/POST /api/email-styles

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: API route `src/app/api/email-styles/[styleId]/route.ts` — update, set-default, delete

**Files:**
- Create: `src/app/api/email-styles/[styleId]/route.ts`
- Test: `src/app/api/email-styles/[styleId]/route.test.ts`

**Interfaces:**
- Consumes: `updateEmailStyle`, `setDefaultEmailStyle`, `deleteEmailStyle` (Task 2); same auth/error helpers as Task 6.
- Produces: `PATCH` → `{ ok: true, style }`; `DELETE` → `{ ok: true }`. Consumed by Task 9's UI.

- [x] **Step 1: Write the failing tests**

Create `src/app/api/email-styles/[styleId]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const updateEmailStyleMock = vi.fn()
const setDefaultEmailStyleMock = vi.fn()
const deleteEmailStyleMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/email-styles', () => ({
  updateEmailStyle: (...a: unknown[]) => updateEmailStyleMock(...a),
  setDefaultEmailStyle: (...a: unknown[]) => setDefaultEmailStyleMock(...a),
  deleteEmailStyle: (...a: unknown[]) => deleteEmailStyleMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { PATCH, DELETE } from './route'

function patchReq(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function ctx(styleId: string) {
  return { params: Promise.resolve({ styleId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  updateEmailStyleMock.mockReset()
  setDefaultEmailStyleMock.mockReset()
  deleteEmailStyleMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/email-styles/[styleId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(patchReq({ name: 'New name' }), ctx('s1'))
    expect(res.status).toBe(403)
  })

  it('should update the name/voiceInstructions and return the style', async () => {
    const style = { id: 's1', name: 'New name', voice_instructions: 'New text.' }
    updateEmailStyleMock.mockResolvedValue(style)
    const res = await PATCH(patchReq({ name: 'New name', voiceInstructions: 'New text.' }), ctx('s1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.style).toEqual(style)
    expect(updateEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 's1', { name: 'New name', voiceInstructions: 'New text.' })
    expect(setDefaultEmailStyleMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.updated' }))
  })

  it('should call setDefaultEmailStyle and not updateEmailStyle when isDefault is true', async () => {
    const style = { id: 's2', name: 'Formal introduction', is_default: true }
    setDefaultEmailStyleMock.mockResolvedValue(style)
    const res = await PATCH(patchReq({ isDefault: true }), ctx('s2'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.style).toEqual(style)
    expect(setDefaultEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 's2')
    expect(updateEmailStyleMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.default_changed' }))
  })

  it('should return 400 when isDefault is combined with name', async () => {
    const res = await PATCH(patchReq({ isDefault: true, name: 'X' }), ctx('s1'))
    expect(res.status).toBe(400)
    expect(setDefaultEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should return 400 when no field is provided', async () => {
    const res = await PATCH(patchReq({}), ctx('s1'))
    expect(res.status).toBe(400)
  })

  it('should return 404 when the style does not exist', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    updateEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NOT_FOUND', 'not found'))
    const res = await PATCH(patchReq({ name: 'X' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 409 when the new name is already taken', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    updateEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NAME_TAKEN', 'taken'))
    const res = await PATCH(patchReq({ name: 'Concise (default)' }), ctx('s2'))
    expect(res.status).toBe(409)
  })
})

describe('DELETE /api/email-styles/[styleId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('s3'))
    expect(res.status).toBe(403)
    expect(deleteEmailStyleMock).not.toHaveBeenCalled()
  })

  it('should delete the style and log the event', async () => {
    deleteEmailStyleMock.mockResolvedValue(undefined)
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('s3'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.ok).toBe(true)
    expect(deleteEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 's3')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'email_style.deleted' }))
  })

  it('should return 409 when deleting the default style', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    deleteEmailStyleMock.mockRejectedValue(new AppError('CANNOT_DELETE_DEFAULT_STYLE', 'cannot delete default'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('s1'))
    expect(res.status).toBe(409)
  })

  it('should return 404 when the style does not exist', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    deleteEmailStyleMock.mockRejectedValue(new AppError('EMAIL_STYLE_NOT_FOUND', 'not found'))
    const res = await DELETE(new Request('http://x', { method: 'DELETE' }), ctx('missing'))
    expect(res.status).toBe(404)
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run "src/app/api/email-styles/[styleId]/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`.

- [x] **Step 3: Write the implementation**

Create `src/app/api/email-styles/[styleId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateEmailStyle, setDefaultEmailStyle, deleteEmailStyle } from '@/lib/db/email-styles'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const nameSchema = z.string().trim().min(1).max(80)
const voiceInstructionsSchema = z.string().trim().min(1).max(4000)

const patchSchema = z
  .object({
    name: nameSchema.optional(),
    voiceInstructions: voiceInstructionsSchema.optional(),
    isDefault: z.literal(true).optional(),
  })
  .refine(
    (body) => body.name !== undefined || body.voiceInstructions !== undefined || body.isDefault !== undefined,
    { message: 'At least one field must be provided' },
  )
  .refine(
    (body) => !(body.isDefault !== undefined && (body.name !== undefined || body.voiceInstructions !== undefined)),
    { message: 'isDefault cannot be combined with name or voiceInstructions' },
  )

export async function PATCH(
  request: Request,
  context: { params: Promise<{ styleId: string }> },
): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { styleId } = await context.params
  const admin = createAdminClient()

  try {
    const body = patchSchema.parse(await request.json())
    const style = body.isDefault
      ? await setDefaultEmailStyle(admin, styleId)
      : await updateEmailStyle(admin, styleId, { name: body.name, voiceInstructions: body.voiceInstructions })

    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: body.isDefault ? 'email_style.default_changed' : 'email_style.updated',
        payload: { id: style.id, name: style.name },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
    return NextResponse.json({ ok: true, style })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NAME_TAKEN') {
      return NextResponse.json({ error: 'name_taken' }, { status: 409 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NOT_FOUND') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ styleId: string }> },
): Promise<NextResponse> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  const { styleId } = await context.params
  const admin = createAdminClient()

  try {
    await deleteEmailStyle(admin, styleId)
    try {
      await logEvent({
        clientId: null,
        actor: `human:${appUser.id}`,
        type: 'email_style.deleted',
        payload: { id: styleId },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded.
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'CANNOT_DELETE_DEFAULT_STYLE') {
      return NextResponse.json({ error: 'cannot_delete_default_style' }, { status: 409 })
    }
    if (isAppError(error) && error.code === 'EMAIL_STYLE_NOT_FOUND') {
      return NextResponse.json({ error: 'not_found' }, { status: 404 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run "src/app/api/email-styles/[styleId]/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/email-styles/[styleId]/route.ts" "src/app/api/email-styles/[styleId]/route.test.ts"
git commit -m "feat(api): add PATCH/DELETE /api/email-styles/[styleId]

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: `src/app/api/clients/[clientId]/route.ts` — `emailStyle` → `emailStyleId`

**Files:**
- Modify: `src/app/api/clients/[clientId]/route.ts:37-59` (schema), `:153-165` (PATCH block)
- Modify (test): `src/app/api/clients/[clientId]/route.test.ts:166-182`

**Interfaces:**
- Consumes: `updateClientEmailStyle(supabase, id, styleId: string | null)` (Task 3).
- Produces: nothing new consumed elsewhere.

- [x] **Step 1: Update the failing test**

In `src/app/api/clients/[clientId]/route.test.ts`, replace:

```ts
  it('should save the email style and log the event on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style: 'concise' })
    updateClientEmailStyleMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style: 'formal_intro' })
    const res = await PATCH(req({ emailStyle: 'formal_intro' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.email_style).toBe('formal_intro')
    expect(updateClientEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'formal_intro')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.email_style_changed' }))
  })

  it('should return 400 for an invalid email style', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style: 'concise' })
    const res = await PATCH(req({ emailStyle: 'shouty' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientEmailStyleMock).not.toHaveBeenCalled()
  })
```

with:

```ts
  it('should save the email style id and log the event on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style_id: null })
    updateClientEmailStyleMock.mockResolvedValue({ id: 'c1', name: 'Uniforms Fashion', email_style_id: 'style-2' })
    const res = await PATCH(req({ emailStyleId: 'style-2' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.email_style_id).toBe('style-2')
    expect(updateClientEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'style-2')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.email_style_changed' }))
  })

  it('should allow clearing the email style id back to null (use the default style)', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style_id: 'style-2' })
    updateClientEmailStyleMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style_id: null })
    const res = await PATCH(req({ emailStyleId: null }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(updateClientEmailStyleMock).toHaveBeenCalledWith(expect.anything(), 'c1', null)
  })

  it('should return 400 for a non-uuid email style id', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', email_style_id: null })
    const res = await PATCH(req({ emailStyleId: 'not-a-uuid' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientEmailStyleMock).not.toHaveBeenCalled()
  })
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/route.test.ts"`
Expected: FAIL — the route still parses `emailStyle` as an enum; `emailStyleId` is unrecognized so it's silently dropped by Zod, and `updateClientEmailStyleMock` is never called, so the "at least one field" refine also rejects the empty-looking body with 400 where 200 is expected.

- [x] **Step 3: Update `src/app/api/clients/[clientId]/route.ts`**

In `patchSchema`, replace:

```ts
    emailStyle: z.enum(['concise', 'formal_intro']).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.warmupProfile !== undefined ||
      body.domain !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined ||
      body.emailStyle !== undefined,
    { message: 'At least one field must be provided' },
  )
```

with:

```ts
    emailStyleId: z.string().uuid().nullable().optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.warmupProfile !== undefined ||
      body.domain !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined ||
      body.emailStyleId !== undefined,
    { message: 'At least one field must be provided' },
  )
```

Replace the PATCH handler's email-style block:

```ts
    if (body.emailStyle !== undefined) {
      updated = await updateClientEmailStyle(admin, clientId, body.emailStyle)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.email_style_changed',
          payload: { from: client.email_style, to: body.emailStyle },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }
```

with:

```ts
    if (body.emailStyleId !== undefined) {
      updated = await updateClientEmailStyle(admin, clientId, body.emailStyleId)
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.email_style_changed',
          payload: { from: client.email_style_id, to: body.emailStyleId },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/route.test.ts"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/route.ts" "src/app/api/clients/[clientId]/route.test.ts"
git commit -m "feat(api): clients PATCH accepts emailStyleId instead of a fixed enum

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 9: UI — `email-style-select.tsx` + new `email-style-manager-dialog.tsx`

**Files:**
- Modify: `src/app/(app)/clients/[id]/email-style-select.tsx` (full rewrite)
- Create: `src/app/(app)/clients/[id]/email-style-manager-dialog.tsx`

**Interfaces:**
- Consumes: `EmailStyleRow` type (Task 2, imported as `Database['public']['Tables']['email_styles']['Row']`), `PATCH /api/clients/[clientId]` (Task 8), `POST /api/email-styles`, `PATCH`/`DELETE /api/email-styles/[styleId]` (Tasks 6-7).
- Produces: `EmailStyleSelect({ clientId, styles, selectedStyleId }): React.ReactElement` — consumed by Task 10's `page.tsx`.

No dedicated test file — consistent with every other `*-select.tsx` / `*-dialog.tsx` on this page (`warmup-profile-select.tsx`, `edit-signature-dialog.tsx`, etc.), none of which have one.

- [x] **Step 1: Rewrite `email-style-select.tsx`**

Replace the entire file:

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { EmailStyleRow } from '@/lib/db/email-styles'
import { EmailStyleManagerDialog } from './email-style-manager-dialog'

interface EmailStyleSelectProps {
  clientId: string
  styles: EmailStyleRow[]
  selectedStyleId: string
}

// Operator-only control — plain English strings, no useTranslations. Per
// CLAUDE.md: "WE DONT NEED LANGUAGE TRANSLATION IN OPERATOR ONLY PAGES,
// TRANSLATE ONLY IN CLIENT FACING PLACES" — this page 404s for non-operators
// (see page.tsx's `if (appUser.role !== 'operator') notFound()`).
//
// `selectedStyleId` is always a real row id, resolved by page.tsx from
// `client.email_style_id ?? defaultStyle.id` — the dropdown never renders a
// synthetic "default" placeholder option.
export function EmailStyleSelect({ clientId, styles, selectedStyleId }: EmailStyleSelectProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(styleId: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ emailStyleId: styleId }),
    })
    if (!response.ok) {
      setError('Failed to save email style.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-center gap-1">
        <label htmlFor={`email-style-${clientId}`} className="text-faint text-[11px]">
          First-touch email style
        </label>
        <EmailStyleManagerDialog
          clientId={clientId}
          styles={styles}
          selectedStyleId={selectedStyleId}
          onChanged={() => router.refresh()}
        />
      </div>
      <select
        id={`email-style-${clientId}`}
        value={selectedStyleId}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {styles.map((style) => (
          <option key={style.id} value={style.id}>
            {style.name}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [x] **Step 2: Write `email-style-manager-dialog.tsx`**

Create `src/app/(app)/clients/[id]/email-style-manager-dialog.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { PencilSimple, Plus, Star, Trash } from '@phosphor-icons/react'
import type { EmailStyleRow } from '@/lib/db/email-styles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface EmailStyleManagerDialogProps {
  clientId: string
  styles: EmailStyleRow[]
  selectedStyleId: string
  /** Called after any mutation that should refresh the parent page's data. */
  onChanged: () => void
}

type FormState =
  | { mode: 'closed' }
  | { mode: 'create'; name: string; voiceInstructions: string }
  | { mode: 'edit'; styleId: string; name: string; voiceInstructions: string }

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

// Operator-only, plain English — same rule as email-style-select.tsx. Every
// style here is a GLOBAL row: editing or deleting one from this client's
// page changes it for every client currently on it, which is why the dialog
// says so explicitly rather than reading as a per-client copy edit.
export function EmailStyleManagerDialog({
  clientId,
  styles,
  selectedStyleId,
  onChanged,
}: EmailStyleManagerDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>({ mode: 'closed' })
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' })

  function startEdit(style: EmailStyleRow): void {
    setForm({ mode: 'edit', styleId: style.id, name: style.name, voiceInstructions: style.voice_instructions })
    setSubmit({ status: 'idle' })
  }

  function startCreate(): void {
    setForm({ mode: 'create', name: '', voiceInstructions: '' })
    setSubmit({ status: 'idle' })
  }

  function cancelForm(): void {
    setForm({ mode: 'closed' })
    setSubmit({ status: 'idle' })
  }

  async function submitForm(): Promise<void> {
    if (form.mode === 'closed') return
    setSubmit({ status: 'submitting' })
    const isCreate = form.mode === 'create'
    const url = isCreate ? '/api/email-styles' : `/api/email-styles/${form.styleId}`
    try {
      const response = await fetch(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, voiceInstructions: form.voiceInstructions }),
      })
      if (!response.ok) {
        const json: unknown = await response.json().catch(() => ({}))
        const errorCode =
          typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'unknown'
        const message = errorCode === 'name_taken' ? 'A style with that name already exists.' : 'Failed to save the style.'
        setSubmit({ status: 'error', message })
        toast.error(message)
        return
      }
      if (isCreate) {
        const json = (await response.json()) as { style: EmailStyleRow }
        // A new style is immediately selected for this client — otherwise
        // it would exist but no client would be using it yet.
        await fetch(`/api/clients/${clientId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailStyleId: json.style.id }),
        })
      }
      setForm({ mode: 'closed' })
      setSubmit({ status: 'idle' })
      toast.success(isCreate ? 'Style created.' : 'Style updated.')
      onChanged()
    } catch {
      setSubmit({ status: 'error', message: 'Network error — please try again.' })
    }
  }

  async function setDefault(style: EmailStyleRow): Promise<void> {
    setSubmit({ status: 'submitting' })
    try {
      const response = await fetch(`/api/email-styles/${style.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!response.ok) {
        toast.error('Failed to set as default.')
        setSubmit({ status: 'idle' })
        return
      }
      setSubmit({ status: 'idle' })
      toast.success(`"${style.name}" is now the default style.`)
      onChanged()
    } catch {
      toast.error('Network error — please try again.')
      setSubmit({ status: 'idle' })
    }
  }

  async function deleteStyle(style: EmailStyleRow): Promise<void> {
    if (style.is_default) return
    if (!window.confirm(`Delete "${style.name}"? Clients on this style fall back to the default style.`)) return
    setSubmit({ status: 'submitting' })
    try {
      const response = await fetch(`/api/email-styles/${style.id}`, { method: 'DELETE' })
      if (!response.ok) {
        toast.error('Failed to delete the style.')
        setSubmit({ status: 'idle' })
        return
      }
      setSubmit({ status: 'idle' })
      toast.success(`"${style.name}" deleted.`)
      onChanged()
    } catch {
      toast.error('Network error — please try again.')
      setSubmit({ status: 'idle' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) cancelForm()
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Manage email styles">
          <PencilSimple size={12} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage email styles</DialogTitle>
        </DialogHeader>

        {form.mode === 'closed' ? (
          <div className="flex flex-col gap-3">
            <p className="text-faint text-[11px]">
              Editing or deleting a style below changes it for every client currently using it, not just this one.
            </p>
            <ul className="flex flex-col gap-2">
              {styles.map((style) => (
                <li key={style.id} className="border-hairline flex items-center justify-between gap-2 rounded-md border p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{style.name}</span>
                    {style.is_default ? <span className="text-faint text-[10px]">(default)</span> : null}
                    {style.id === selectedStyleId ? <span className="text-faint text-[10px]">— in use here</span> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {!style.is_default ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Set "${style.name}" as default`}
                        disabled={submit.status === 'submitting'}
                        onClick={() => void setDefault(style)}
                      >
                        <Star size={12} weight="light" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit "${style.name}"`}
                      onClick={() => startEdit(style)}
                    >
                      <PencilSimple size={12} weight="light" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete "${style.name}"`}
                      disabled={style.is_default || submit.status === 'submitting'}
                      title={style.is_default ? "Can't delete the default style" : undefined}
                      onClick={() => void deleteStyle(style)}
                    >
                      <Trash size={12} weight="light" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" size="sm" onClick={startCreate}>
              <Plus size={14} weight="light" />
              New style
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {form.mode === 'edit' ? (
              <p className="text-faint text-[11px]">This updates the style for every client currently using it.</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-style-name" className="text-xs">
                Name
              </Label>
              <Input
                id="email-style-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="e.g. Casual referral intro"
                maxLength={80}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-style-voice" className="text-xs">
                Voice instructions
              </Label>
              <Textarea
                id="email-style-voice"
                value={form.voiceInstructions}
                onChange={(event) => setForm({ ...form, voiceInstructions: event.target.value })}
                placeholder="e.g. Open with the recipient's first name. Keep it under 80 words. End with a direct question."
                maxLength={4000}
                rows={8}
              />
              <p className="text-faint text-[11px]">
                Subject-line formatting, English-only output, and the human-voice/no-spam rules always apply on top of this —
                you're only writing the voice, structure, and word-count guidance.
              </p>
            </div>
            {submit.status === 'error' ? (
              <p role="alert" className="text-destructive text-xs">
                {submit.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={cancelForm}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={submit.status === 'submitting' || form.name.trim().length === 0 || form.voiceInstructions.trim().length === 0}
                onClick={() => void submitForm()}
              >
                {submit.status === 'submitting' ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [x] **Step 3: Type-check and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/app/\(app\)/clients/\[id\]/email-style-select.tsx src/app/\(app\)/clients/\[id\]/email-style-manager-dialog.tsx`
Expected: no errors. (`page.tsx` will still fail to type-check until Task 10 updates its `<EmailStyleSelect>` call — that's expected and resolved next.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/clients/[id]/email-style-select.tsx" "src/app/(app)/clients/[id]/email-style-manager-dialog.tsx"
git commit -m "feat(ui): editable/addable email styles manager on the client page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 10: Wire `page.tsx` to fetch styles and resolve the selected id

**Files:**
- Modify: `src/app/(app)/clients/[id]/page.tsx:8` (import), `:~90` (data fetch, exact line depends on final Task 1-9 diffs — locate via `grep -n "const client = await getClientById" src/app/\(app\)/clients/\[id\]/page.tsx`), `:180` (render)

**Interfaces:**
- Consumes: `listEmailStyles`, `getDefaultEmailStyle` (Task 2); `EmailStyleSelect` (Task 9).
- Produces: nothing consumed elsewhere — this is the page's own wiring.

- [x] **Step 1: Add the import**

In `src/app/(app)/clients/[id]/page.tsx`, alongside the other `lib/db` imports:

```ts
import { getClientById, listClientRoleAppUsers } from '@/lib/db/clients'
```

add directly after it:

```ts
import { listEmailStyles, getDefaultEmailStyle } from '@/lib/db/email-styles'
```

- [x] **Step 2: Fetch styles and resolve the selected id**

Locate:

```ts
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) notFound()
  const t = await getTranslations('clients')
```

Replace with:

```ts
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) notFound()
  const emailStyles = await listEmailStyles(admin)
  // A client's email_style_id can be null (never explicitly set, or reset
  // by a style deletion) — the dropdown always needs a real, resolved
  // selection to display, so fall back to whichever style is default.
  const selectedEmailStyle =
    emailStyles.find((style) => style.id === client.email_style_id) ?? (await getDefaultEmailStyle(admin))
  const t = await getTranslations('clients')
```

- [x] **Step 3: Update the render call**

Replace:

```tsx
            <EmailStyleSelect clientId={client.id} value={client.email_style} />
```

with:

```tsx
            <EmailStyleSelect clientId={client.id} styles={emailStyles} selectedStyleId={selectedEmailStyle.id} />
```

- [x] **Step 4: Type-check the whole project**

Run: `pnpm exec tsc --noEmit`
Expected: clean — this was the last file referencing the old `email_style`/`EmailStyleSelect` shape.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat(ui): wire client page to the dynamic email styles list

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 11: Full-suite verification and roadmap update

**Files:**
- Modify: `.claude/roadmap.md` (append entry)

**Interfaces:**
- Consumes: nothing new — this is the final verification pass.
- Produces: nothing consumed elsewhere.

- [x] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: every test file passes, including all files touched in Tasks 2-8. Record the exact "`N` files / `M` tests" summary line from the output for Step 3.

- [x] **Step 2: Type-check and lint the whole repo**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint .`
Expected: both clean. If either surfaces an issue, fix it before proceeding — do not append the roadmap entry or commit until this step is clean.

- [x] **Step 3: Append the roadmap entry**

Append to `.claude/roadmap.md` (after the existing final entry, keeping the same `## YYYY-MM-DD — Title` heading style):

```markdown

## 2026-08-09 — Editable & addable email styles

Replaced the fixed `concise`/`formal_intro` email_style enum with an
operator-managed `email_styles` table (migration
`0035_email_styles_table.sql`): `name`, `voice_instructions`, `is_default`
(DB-enforced, at most one row). `clients.email_style_id` is now a nullable
FK — `null` means "use whichever style is currently default." Deleting an
in-use, non-default style reassigns its clients to the default
automatically; deleting the default itself is blocked
(`CANNOT_DELETE_DEFAULT_STYLE`), and `set_default_email_style` (a Postgres
function) atomically swaps which row is default so a crash mid-swap can
never leave zero defaults.

`write.ts`'s `selectSystemPrompt`/`CONCISE_SYSTEM_PROMPT`/
`FORMAL_INTRO_SYSTEM_PROMPT` are gone, replaced by `buildSystemPrompt
(voiceInstructions)`: a fixed, code-only guardrail block (subject-line
rules, human-voice instruction, English-only/translate, no bulk markers,
dossier-grounded facts — broadened from just subject-line rules) is always
appended to whatever voice text an operator writes, so a new style can
never accidentally ship non-compliant or fact-inventing copy. New
`lib/db/email-styles.ts` holds all CRUD; new `/api/email-styles` (GET,
POST) and `/api/email-styles/[styleId]` (PATCH — edit or set-default,
DELETE) routes, operator-only. `scripts/regenerate-sample-emails.ts` and
`scripts/rewrite-draft-emails.ts` updated to the new lookup path.

UI: `/clients/[id]`'s email-style dropdown is now populated from the live
styles list; a new "Manage email styles" dialog
(`email-style-manager-dialog.tsx`) lets an operator edit any style's
name/text, create a new one (auto-selected for the current client), set a
different style as default, or delete a non-default style — all with an
explicit warning that edits are global, not per-client. Design:
`docs/superpowers/specs/2026-08-09-editable-email-styles-design.md`. Plan:
`docs/superpowers/plans/2026-08-09-editable-email-styles.md`.

Every existing client's resolved voice is unchanged after migration — the
backfill is explicit (matched by name), not a bare default, so Uniforms
Fashion keeps its `formal_intro` wording and every other client keeps
`concise`'s, byte-for-byte.

Full repo suite: <N> files / <M> tests green, `tsc --noEmit` and `eslint`
clean.
```

Replace `<N>` and `<M>` with the actual counts from Step 1's output before saving — do not leave the placeholders in the committed file.

- [ ] **Step 4: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: roadmap entry for editable/addable email styles

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
