# AI Resources Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the outreach agent attach client collateral (PDFs, images, SVGs, text files) to a reply when a lead asks to see something, and let operators hand the agent files — either to send or to learn from — when answering a blocked knowledge request.

**Architecture:** A new `client_resources` table holds sendable files in a private `client-resources` bucket. Resources are deliberately **not** knowledge: never chunked, never embedded, never retrieved. The AI sees only `title — description` as a numbered menu in the reply prompt and returns ordinals. A new `email_attachments` join table records what each email carries, so drafts are reviewable and sent mail keeps an audit trail. Attachments are plumbed through `SendEmailInput` into all three mailbox providers, capped at 3 MB / 3 files so every provider stays on its simple send path.

**Tech Stack:** Next.js 15 App Router (Server Components + Server Actions), Supabase (Postgres + RLS + Storage), Vitest, Zod, Gemini via the `ai` SDK, Gmail API / Microsoft Graph / nodemailer.

**Spec:** `docs/superpowers/specs/2026-07-26-ai-resources-design.md` — read it before starting.

## Global Constraints

- **`pnpm` only.** This repo is pnpm-only; `npm install` corrupts the tree. Run tests with `pnpm vitest run <path>`.
- **No new dependencies.** Everything here uses what is already installed.
- **Resources are never knowledge.** Do not chunk, embed, or feed resource file content to `retrieveClientKnowledge()`. The AI sees `title` and `description` only.
- **Attachments on replies only.** `src/lib/pipeline/write.ts` and `src/lib/pipeline/followup.ts` must never build a resource menu or pass attachments. Do not add the capability there "for symmetry".
- **`MAX_ATTACHMENTS_PER_EMAIL = 3`**, **`MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024`**, **`MAX_RESOURCE_MENU = 40`**. Defined once each, imported everywhere.
- **DB columns are `snake_case`; TypeScript is `camelCase`.** Map explicitly at the `src/lib/db/` boundary.
- **All data access lives in `src/lib/db/`.** No inline Supabase queries in routes, actions, or components.
- **Every external SDK error is caught and rethrown as `AppError`** with `code`, `message`, and structured `context`. Never let a raw Supabase/Graph/nodemailer error escape.
- **Test naming:** `it('should [expected behavior] when [condition]')`, Arrange-Act-Assert.
- **Every task ends green:** `pnpm vitest run`, `pnpm typecheck`, `pnpm lint` all clean before the commit.
- **Do not branch.** Commit directly to `master`, per `CLAUDE.md`.

## File Structure

**Create**

| File | Responsibility |
|---|---|
| `supabase/migrations/0018_client_resources.sql` | Both new tables, both new RLS policy sets, the knowledge RLS relaxation, the `'file'` enum value, both bucket changes |
| `src/lib/mailbox/attachments.ts` | Pure limits + filename sanitization. No I/O. |
| `src/lib/storage/client-resources.ts` | `client-resources` bucket: validate, upload, download, delete, sign |
| `src/lib/db/client-resources.ts` | `client_resources` CRUD |
| `src/lib/db/email-attachments.ts` | `email_attachments` CRUD |
| `src/lib/resources/menu.ts` | Build the prompt menu; resolve the model's ordinals into rows within budget. Pure. |
| `src/lib/resources/load-attachments.ts` | Resource ids → `EmailAttachment[]` (db + storage + limit assertion) |
| `src/app/api/clients/[clientId]/resources/route.ts` | `POST` upload |
| `src/app/api/clients/[clientId]/resources/[resourceId]/route.ts` | `DELETE` soft-delete |
| `src/app/api/clients/[clientId]/knowledge/file/route.ts` | Replaces `knowledge/pdf/`; accepts pdf/txt/md, owner-or-operator |
| `src/components/resource-upload.tsx` | Client component: title + description + file → POST |
| `src/components/resource-list.tsx` | Client component: list + per-row soft delete |
| `src/components/resource-picker.tsx` | Client component: checkbox multi-select with a running byte budget |
| `src/app/(app)/knowledge/knowledge-tabs.tsx` | Shared tab strip for the three knowledge routes |
| `src/app/(app)/knowledge/sources/{page,loading,error}.tsx` | Knowledge sources, client-visible |
| `src/app/(app)/knowledge/resources/{page,loading,error}.tsx` | Resources, client-visible |

**Modify**

| File | Change |
|---|---|
| `src/lib/mailbox/provider.ts` | `EmailAttachment` interface; `SendEmailInput.attachments` |
| `src/lib/mailbox/gmail-provider.ts` | `encodeMessage` grows a `multipart/mixed` branch |
| `src/lib/mailbox/outlook-provider.ts` | `sendMail` message gains `attachments[]` |
| `src/lib/mailbox/smtp-send.ts` | nodemailer `attachments[]` |
| `src/lib/mailbox/sender.ts` | `SendViaMailboxInput.attachments` passthrough |
| `src/lib/pipeline/reply.ts` | Menu in the prompt, `attachResourceIds` in the schema, `sendOrDraftReply` gains `resourceIds` |
| `src/lib/pipeline/knowledge-answer.ts` | `resourceIds` parameter, told to the prompt |
| `src/app/(app)/inbox/actions.ts` | `answerKnowledgeRequest` takes resource ids + a knowledge file; `approveDraft` loads attachments; new `updateDraftAttachments` |
| `src/app/(app)/inbox/knowledge-request-row.tsx` | Resource picker + knowledge file input |
| `src/app/(app)/inbox/draft-row.tsx` | Editable attachment list |
| `src/lib/storage/client-knowledge-pdfs.ts` → `client-knowledge-files.ts` | Mime allowlist; text files skip PDF extraction |
| `src/lib/db/client-knowledge.ts` | `insertPdfSourceReady` → `insertFileSourceReady` with a `sourceType` argument |
| `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts` | Owner-or-operator delete |
| `src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx` | Accepts pdf/txt/md, posts to `knowledge/file` |
| `src/app/(app)/clients/[id]/page.tsx` | Resources section |
| `src/app/(app)/knowledge/page.tsx` | Tab strip |
| `src/types/database.ts` | Both new tables, `'file'` enum value |
| `.claude/architecture.md` | §11 no longer says clients are read-only |
| `.claude/roadmap.md` | Mark implemented |

**Operator vs client on the `/knowledge` sub-routes.** `app_users.client_id` is `null` for operators, so an operator has no single client to scope an upload to. Therefore: on `/knowledge/sources` and `/knowledge/resources`, client-role users see and manage their own client's rows and can upload; operators see every client's rows read-only, with a client-name column, and upload from `/clients/[id]` as they do today. This is stated once here and assumed by Tasks 16–18.

---

### Task 1: Migration — tables, RLS, buckets

**Files:**
- Create: `supabase/migrations/0018_client_resources.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: tables `client_resources` and `email_attachments`; enum value `knowledge_source_type.'file'`; bucket `client-resources`; widened `allowed_mime_types` on `client-knowledge-pdfs`. Every later task depends on this.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0018_client_resources.sql`:

```sql
-- Resources: files the agent may ATTACH to a reply (portfolio PDFs, mockups,
-- one-pagers). Deliberately NOT knowledge — a resource is never chunked,
-- embedded, or retrieved by retrieveClientKnowledge(). The AI only ever sees a
-- resource's title + description, offered as a numbered menu it picks from.
-- See docs/superpowers/specs/2026-07-26-ai-resources-design.md.

create table client_resources (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  title        text not null,
  -- NOT NULL on purpose: an undescribed resource is invisible to the AI's menu,
  -- so the schema forces the uploader to state what it is for.
  description  text not null,
  -- Already sanitized to a wire-safe ASCII subset at upload time, because this
  -- lands verbatim in a MIME Content-Disposition header.
  file_name    text not null,
  mime_type    text not null,
  byte_size    integer not null,
  storage_path text not null,
  -- Soft delete. A sent email references the resource it carried; hard-deleting
  -- would gut that audit trail. Deactivated rows drop out of the AI menu and
  -- every picker immediately.
  is_active    boolean not null default true,
  created_by   uuid not null references app_users(id) on delete cascade,
  created_at   timestamptz not null default now()
);

create index client_resources_client_active_idx
  on client_resources (client_id, created_at desc) where is_active;

create table email_attachments (
  -- client_id is denormalized so this table fits the flat RLS shape every other
  -- table in 0002_rls_policies.sql uses.
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  email_id    uuid not null references emails(id) on delete cascade,
  -- RESTRICT + the soft delete above is what keeps history intact.
  resource_id uuid not null references client_resources(id) on delete restrict,
  created_at  timestamptz not null default now(),
  -- Makes attaching idempotent under a retried QStash delivery.
  unique (email_id, resource_id)
);

create index email_attachments_email_id_idx on email_attachments (email_id);

alter table client_resources enable row level security;
alter table email_attachments enable row level security;

-- Clients manage their OWN uploads; operators manage everything. This is the
-- first table in the codebase a client-role session can write to.
create policy client_resources_select on client_resources for select
  using (is_operator() or client_id = current_client_id());
create policy client_resources_insert on client_resources for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy client_resources_update on client_resources for update
  using (is_operator() or created_by = auth.uid())
  with check (is_operator() or created_by = auth.uid());
create policy client_resources_delete on client_resources for delete
  using (is_operator() or created_by = auth.uid());

-- Only the service-role pipeline writes attachments; clients read their own.
create policy email_attachments_select on email_attachments for select
  using (is_operator() or client_id = current_client_id());
create policy email_attachments_write on email_attachments for all
  using (is_operator()) with check (is_operator());

-- 0014 said this content "must never be visible to client-role sessions". That
-- decision is reversed: clients now curate their own knowledge alongside the
-- operator's. Chunks stay operator-write because only the pipeline writes them.
drop policy client_knowledge_sources_all on client_knowledge_sources;
drop policy client_knowledge_chunks_all on client_knowledge_chunks;

create policy client_knowledge_sources_select on client_knowledge_sources for select
  using (is_operator() or client_id = current_client_id());
create policy client_knowledge_sources_insert on client_knowledge_sources for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy client_knowledge_sources_update on client_knowledge_sources for update
  using (is_operator() or created_by = auth.uid())
  with check (is_operator() or created_by = auth.uid());
create policy client_knowledge_sources_delete on client_knowledge_sources for delete
  using (is_operator() or created_by = auth.uid());

create policy client_knowledge_chunks_select on client_knowledge_chunks for select
  using (is_operator() or client_id = current_client_id());
create policy client_knowledge_chunks_write on client_knowledge_chunks for all
  using (is_operator()) with check (is_operator());

-- Knowledge uploads widen from PDF-only to pdf/txt/md. Postgres allows ADD VALUE
-- inside a transaction (PG12+) as long as the new value is not USED in the same
-- transaction — it is not; runtime code starts writing 'file' rows after this
-- migration commits. Existing 'pdf' rows are left alone.
alter type knowledge_source_type add value if not exists 'file';

update storage.buckets
  set allowed_mime_types = array['application/pdf', 'text/plain', 'text/markdown']
  where id = 'client-knowledge-pdfs';

-- Private, same convention as client-knowledge-pdfs: no storage RLS policies,
-- writes go through the service-role client at the route layer, UI reads go
-- through a server-generated signed URL. 3145728 = 3MB, the per-email ceiling
-- that keeps Gmail, Graph and SMTP all on their simple send paths.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-resources',
  'client-resources',
  false,
  3145728,
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'image/gif',
    'image/webp', 'image/svg+xml', 'text/plain', 'text/markdown'
  ]
)
on conflict (id) do nothing;
```

- [ ] **Step 2: Verify the SQL parses**

Run: `pnpm supabase db lint --schema public` if the Supabase CLI is linked; otherwise open the file and re-read it against `supabase/migrations/0014_client_knowledge.sql` for convention drift (policy naming, comment density, `on conflict do nothing` on the bucket insert).

Expected: no syntax errors. If the CLI is not linked, this is a manual read — do not skip it.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/0018_client_resources.sql
git commit -m "feat(db): add client_resources and email_attachments, open knowledge RLS to clients"
```

---

### Task 2: Database types

**Files:**
- Modify: `src/types/database.ts`

**Interfaces:**
- Consumes: Task 1's schema.
- Produces: `Database['public']['Tables']['client_resources']['Row' | 'Insert']`, `Database['public']['Tables']['email_attachments']['Row' | 'Insert']`, and `'file'` in `Database['public']['Enums']['knowledge_source_type']`.

- [ ] **Step 1: Add both table types**

Insert after the `client_knowledge_chunks` block (which ends at the line before `emails: {`), matching the surrounding style exactly:

```ts
      client_resources: {
        Row: {
          id: string
          client_id: string
          title: string
          description: string
          file_name: string
          mime_type: string
          byte_size: number
          storage_path: string
          is_active: boolean
          created_by: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          title: string
          description: string
          file_name: string
          mime_type: string
          byte_size: number
          storage_path: string
          is_active?: boolean
          created_by: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['client_resources']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'client_resources_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      email_attachments: {
        Row: {
          id: string
          client_id: string
          email_id: string
          resource_id: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          email_id: string
          resource_id: string
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['email_attachments']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'email_attachments_resource_id_fkey'
            columns: ['resource_id']
            isOneToOne: false
            referencedRelation: 'client_resources'
            referencedColumns: ['id']
          },
        ]
      }
```

- [ ] **Step 2: Add the enum value**

Find the `knowledge_source_type` entry under `Enums` and add `'file'`:

```ts
      knowledge_source_type: 'website_page' | 'pdf' | 'file'
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: clean. Nothing consumes the new types yet, so a failure here means a syntax slip in the block above.

- [ ] **Step 4: Commit**

```bash
git add src/types/database.ts
git commit -m "feat(types): add client_resources and email_attachments row types"
```

---

### Task 3: Attachment limits and filename sanitization

**Files:**
- Create: `src/lib/mailbox/attachments.ts`
- Test: `src/lib/mailbox/attachments.test.ts`

**Interfaces:**
- Consumes: `EmailAttachment` from Task 4 — but Task 4 only moves the interface into `provider.ts`, so define and export it here first and have `provider.ts` re-export nothing; Task 4 imports it from here. Import path is `@/lib/mailbox/attachments`.
- Produces:
  - `MAX_ATTACHMENTS_PER_EMAIL: 3`
  - `MAX_TOTAL_ATTACHMENT_BYTES: 3145728`
  - `interface EmailAttachment { fileName: string; mimeType: string; content: Buffer }`
  - `sanitizeAttachmentFileName(name: string): string`
  - `assertWithinAttachmentLimits(attachments: readonly EmailAttachment[]): void`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/mailbox/attachments.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  MAX_ATTACHMENTS_PER_EMAIL,
  MAX_TOTAL_ATTACHMENT_BYTES,
  sanitizeAttachmentFileName,
  assertWithinAttachmentLimits,
  type EmailAttachment,
} from './attachments'

function attachment(fileName: string, bytes: number): EmailAttachment {
  return { fileName, mimeType: 'application/pdf', content: Buffer.alloc(bytes) }
}

describe('sanitizeAttachmentFileName', () => {
  it('should strip directory components when the name looks like a path', () => {
    expect(sanitizeAttachmentFileName('../../etc/passwd')).toBe('passwd')
    expect(sanitizeAttachmentFileName('C:\\Users\\me\\deck.pdf')).toBe('deck.pdf')
  })

  it('should remove characters that would break a Content-Disposition header', () => {
    expect(sanitizeAttachmentFileName('a"b;c\r\nd.pdf')).toBe('abcd.pdf')
  })

  it('should fold non-ascii characters away when the name has accents', () => {
    expect(sanitizeAttachmentFileName('résumé.pdf')).toBe('resume.pdf')
  })

  it('should fall back to a generic name when nothing safe survives', () => {
    expect(sanitizeAttachmentFileName('日本語')).toBe('attachment')
    expect(sanitizeAttachmentFileName('   ')).toBe('attachment')
  })

  it('should truncate when the name is absurdly long', () => {
    const result = sanitizeAttachmentFileName(`${'a'.repeat(500)}.pdf`)
    expect(result.length).toBe(120)
  })
})

describe('assertWithinAttachmentLimits', () => {
  it('should pass when there are no attachments', () => {
    expect(() => assertWithinAttachmentLimits([])).not.toThrow()
  })

  it('should pass when exactly at both limits', () => {
    const each = Math.floor(MAX_TOTAL_ATTACHMENT_BYTES / MAX_ATTACHMENTS_PER_EMAIL)
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL }, (_, i) =>
      attachment(`f${i}.pdf`, each),
    )
    expect(() => assertWithinAttachmentLimits(attachments)).not.toThrow()
  })

  it('should throw VALIDATION_ERROR when there are too many files', () => {
    const attachments = Array.from({ length: MAX_ATTACHMENTS_PER_EMAIL + 1 }, (_, i) =>
      attachment(`f${i}.pdf`, 10),
    )
    try {
      assertWithinAttachmentLimits(attachments)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({ count: MAX_ATTACHMENTS_PER_EMAIL + 1 })
    }
  })

  it('should throw VALIDATION_ERROR when the total exceeds the byte budget', () => {
    const attachments = [attachment('a.pdf', MAX_TOTAL_ATTACHMENT_BYTES), attachment('b.pdf', 1)]
    try {
      assertWithinAttachmentLimits(attachments)
      expect.unreachable('should have thrown')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({
        totalBytes: MAX_TOTAL_ATTACHMENT_BYTES + 1,
      })
    }
  })
})
```

Before running: open `src/lib/errors/app-error.ts` and confirm the property holding structured metadata is named `context`. If it is named something else, use that name in the assertions above and everywhere else in this plan.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/attachments.test.ts`
Expected: FAIL — `Failed to resolve import "./attachments"`.

- [ ] **Step 3: Implement**

Create `src/lib/mailbox/attachments.ts`:

```ts
import { AppError } from '@/lib/errors/app-error'

export interface EmailAttachment {
  fileName: string
  mimeType: string
  content: Buffer
}

// Ceiling chosen so every provider stays on its simple send path: Gmail raw
// MIME, a single Graph sendMail call, one nodemailer message. Going past ~3MB
// forces Graph into createUploadSession against a draft, which is a materially
// different send with its own retry semantics.
export const MAX_ATTACHMENTS_PER_EMAIL = 3
export const MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024

// Long enough for any real filename, short enough that a hostile upload cannot
// bloat a MIME header.
const MAX_FILE_NAME_LENGTH = 120

/**
 * Reduces an uploaded filename to something safe to interpolate into a MIME
 * `Content-Disposition` header. Run once at upload time so the stored
 * `client_resources.file_name` is already wire-safe and no send path has to
 * re-check. NFKD decomposes accented characters so 'é' degrades to 'e' rather
 * than vanishing.
 */
export function sanitizeAttachmentFileName(name: string): string {
  const base = name.split(/[/\\]/).pop() ?? ''
  const ascii = base.normalize('NFKD').replace(/[^\u0020-\u007E]/g, '')
  const safe = ascii.replace(/["';]/g, '').trim()
  const truncated = safe.slice(0, MAX_FILE_NAME_LENGTH)
  return truncated.length > 0 ? truncated : 'attachment'
}

export function assertWithinAttachmentLimits(attachments: readonly EmailAttachment[]): void {
  if (attachments.length > MAX_ATTACHMENTS_PER_EMAIL) {
    throw new AppError(
      'VALIDATION_ERROR',
      `An email may carry at most ${MAX_ATTACHMENTS_PER_EMAIL} attachments`,
      { count: attachments.length },
    )
  }
  const totalBytes = attachments.reduce((sum, a) => sum + a.content.byteLength, 0)
  if (totalBytes > MAX_TOTAL_ATTACHMENT_BYTES) {
    throw new AppError(
      'VALIDATION_ERROR',
      'Attachments exceed the 3MB per-email limit',
      { totalBytes, limitBytes: MAX_TOTAL_ATTACHMENT_BYTES },
    )
  }
}
```

Note the CR/LF case in the test: `\r` and `\n` are outside `\u0020-\u007E`, so the ascii filter already removes them; the second `replace` handles quotes, backslashes and semicolons.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/attachments.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/mailbox/attachments.ts src/lib/mailbox/attachments.test.ts
git commit -m "feat(mailbox): add attachment limits and filename sanitization"
```

---

### Task 4: Gmail multipart attachments

**Files:**
- Modify: `src/lib/mailbox/provider.ts` (the `SendEmailInput` interface, around line 28)
- Modify: `src/lib/mailbox/gmail-provider.ts` (`encodeMessage`, lines 36–54)
- Test: `src/lib/mailbox/gmail-provider.test.ts`

**Interfaces:**
- Consumes: `EmailAttachment`, `assertWithinAttachmentLimits` from `@/lib/mailbox/attachments` (Task 3).
- Produces: `SendEmailInput.attachments?: readonly EmailAttachment[]`, consumed by Tasks 5, 6, 7.

- [ ] **Step 1: Extend `SendEmailInput`**

In `src/lib/mailbox/provider.ts`, add the import at the top and the field to `SendEmailInput`:

```ts
import type { EmailAttachment } from './attachments'
```

```ts
export interface SendEmailInput {
  to: string
  subject: string
  body: string
  // Threading (follow-ups only). threadId is the provider conversation id from
  // the first-touch send; inReplyToMessageId/references are RFC 2822 Message-IDs
  // used to build the In-Reply-To / References headers so the reply threads.
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
  // Replies only. Callers are responsible for having run
  // assertWithinAttachmentLimits before reaching a provider — providers do not
  // re-validate, they serialize.
  attachments?: readonly EmailAttachment[]
}
```

Also re-export the type so consumers have one import site:

```ts
export type { EmailAttachment } from './attachments'
```

- [ ] **Step 2: Write the failing tests**

Append to `src/lib/mailbox/gmail-provider.test.ts`. The file already tests `encodeMessage` indirectly through `sendEmail`; follow whatever mocking of `fetchJson` it already uses, and add:

```ts
describe('gmail sendEmail with attachments', () => {
  it('should still emit a flat text/plain message when there are no attachments', async () => {
    const raw = await captureRawMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
    expect(raw).toContain('Content-Type: text/plain; charset="UTF-8"')
    expect(raw).not.toContain('multipart/mixed')
    expect(raw).toContain('Hello')
  })

  it('should emit multipart/mixed with one part per attachment when attachments exist', async () => {
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [
        { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFBYTES') },
        { fileName: 'hero.png', mimeType: 'image/png', content: Buffer.from('PNGBYTES') },
      ],
    })

    const boundaryMatch = /boundary="([^"]+)"/.exec(raw)
    expect(boundaryMatch).not.toBeNull()
    const boundary = boundaryMatch![1]!

    expect(raw).toContain('MIME-Version: 1.0')
    expect(raw).toContain(`Content-Type: multipart/mixed; boundary="${boundary}"`)
    expect(raw).toContain('Content-Type: application/pdf; name="deck.pdf"')
    expect(raw).toContain('Content-Disposition: attachment; filename="deck.pdf"')
    expect(raw).toContain('Content-Type: image/png; name="hero.png"')
    expect(raw).toContain(Buffer.from('PDFBYTES').toString('base64'))
    expect(raw).toContain(Buffer.from('PNGBYTES').toString('base64'))
    // Terminal boundary closes the message.
    expect(raw.trimEnd().endsWith(`--${boundary}--`)).toBe(true)
    // The body survives as its own part.
    expect(raw).toContain('Hello')
  })

  it('should preserve threading headers when the message has attachments', async () => {
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Re: Hi',
      body: 'Hello',
      inReplyToMessageId: '<m1@x>',
      references: '<m1@x>',
      attachments: [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }],
    })
    expect(raw).toContain('In-Reply-To: <m1@x>')
    expect(raw).toContain('References: <m1@x>')
  })

  it('should reject a filename carrying a line break', async () => {
    await expect(
      captureRawMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Hello',
        attachments: [
          { fileName: 'a.pdf\r\nX-Evil: 1', mimeType: 'application/pdf', content: Buffer.from('X') },
        ],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should wrap base64 payload lines at 76 columns', async () => {
    const raw = await captureRawMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [
        { fileName: 'big.pdf', mimeType: 'application/pdf', content: Buffer.alloc(1000, 0x41) },
      ],
    })
    const longestLine = Math.max(...raw.split('\r\n').map((line) => line.length))
    expect(longestLine).toBeLessThanOrEqual(76)
  })
})
```

Add this helper near the top of the same describe block. It sends through the provider and decodes the `raw` field the provider posted:

```ts
async function captureRawMessage(input: SendEmailInput): Promise<string> {
  let captured = ''
  fetchJsonMock.mockImplementation((_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { raw?: string }
    if (payload.raw) captured = Buffer.from(payload.raw, 'base64url').toString('utf-8')
    return Promise.resolve({ id: 'm1', threadId: 't1' })
  })
  await gmailProvider.sendEmail(oauthCredentialsFixture, input)
  return captured
}
```

Reuse the existing `fetchJsonMock` and OAuth credentials fixture already present in the file rather than declaring new ones. If the existing test file mocks `ensureFresh` or the token refresh path, keep that mocking in place — these tests care only about the serialized message.

- [ ] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailbox/gmail-provider.test.ts`
Expected: FAIL — the multipart assertions fail because `encodeMessage` still emits flat `text/plain`.

- [ ] **Step 4: Implement the multipart branch**

In `src/lib/mailbox/gmail-provider.ts`, ensure `randomUUID` is imported:

```ts
import { randomUUID } from 'node:crypto'
```

Replace `encodeMessage` (lines 36–54) with:

```ts
// Base64 payload lines must not exceed 76 columns per RFC 2045.
function wrapBase64(value: string): string {
  return (value.match(/.{1,76}/g) ?? []).join('\r\n')
}

// RFC 2822 message, base64url-encoded per Gmail API. Flat text/plain when there
// is nothing to attach; multipart/mixed otherwise.
function encodeMessage(from: string, input: SendEmailInput): string {
  const to = assertNoHeaderInjection(input.to, 'to')
  const subject = assertNoHeaderInjection(input.subject, 'subject')
  const attachments = input.attachments ?? []
  const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`]
  if (input.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${assertNoHeaderInjection(input.inReplyToMessageId, 'inReplyToMessageId')}`)
  }
  if (input.references) {
    headers.push(`References: ${assertNoHeaderInjection(input.references, 'references')}`)
  }

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    const raw = [...headers, '', input.body].join('\r\n')
    return Buffer.from(raw, 'utf-8').toString('base64url')
  }

  const boundary = `b_${randomUUID()}`
  headers.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`)

  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: 7bit',
    '',
    input.body,
  ]
  for (const attachment of attachments) {
    // file_name is sanitized at upload time, but In-Reply-To/References already
    // taught us not to trust anything reaching a header — re-assert here so a
    // row written before the sanitizer existed cannot inject.
    const fileName = assertNoHeaderInjection(attachment.fileName, 'attachmentFileName')
    const mimeType = assertNoHeaderInjection(attachment.mimeType, 'attachmentMimeType')
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${fileName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${fileName}"`,
      '',
      wrapBase64(attachment.content.toString('base64')),
    )
  }
  parts.push(`--${boundary}--`)

  const raw = [...headers, '', ...parts].join('\r\n')
  return Buffer.from(raw, 'utf-8').toString('base64url')
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/gmail-provider.test.ts`
Expected: PASS, including every pre-existing test in the file.

- [ ] **Step 6: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/mailbox/provider.ts src/lib/mailbox/gmail-provider.ts src/lib/mailbox/gmail-provider.test.ts
git commit -m "feat(mailbox): send multipart attachments through the Gmail provider"
```

---

### Task 5: Outlook and SMTP attachments

**Files:**
- Modify: `src/lib/mailbox/outlook-provider.ts` (`sendEmail`, lines 210–245)
- Modify: `src/lib/mailbox/smtp-send.ts` (`sendSmtpEmail`)
- Test: `src/lib/mailbox/outlook-provider.test.ts`, `src/lib/mailbox/smtp-send.test.ts`

**Interfaces:**
- Consumes: `SendEmailInput.attachments` (Task 4).
- Produces: nothing new — completes the provider surface so `sender.ts` (Task 6) can pass attachments to any provider.

- [ ] **Step 1: Write the failing Outlook test**

Append to `src/lib/mailbox/outlook-provider.test.ts`, reusing the file's existing `fetchJson` mock and credentials fixture:

```ts
describe('outlook sendEmail with attachments', () => {
  it('should omit the attachments key entirely when there are none', async () => {
    const message = await captureSentMessage({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
    expect(message).not.toHaveProperty('attachments')
  })

  it('should serialize each attachment as a graph fileAttachment when attachments exist', async () => {
    const message = await captureSentMessage({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [
        { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('PDFBYTES') },
      ],
    })
    expect(message.attachments).toEqual([
      {
        '@odata.type': '#microsoft.graph.fileAttachment',
        name: 'deck.pdf',
        contentType: 'application/pdf',
        contentBytes: Buffer.from('PDFBYTES').toString('base64'),
      },
    ])
  })

  it('should reject a filename carrying a line break', async () => {
    await expect(
      captureSentMessage({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Hello',
        attachments: [{ fileName: 'a\r\nb.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
```

With this helper in the same block:

```ts
async function captureSentMessage(
  input: SendEmailInput,
): Promise<Record<string, unknown>> {
  let captured: Record<string, unknown> = {}
  fetchJsonMock.mockImplementation((_url: string, init: { body: string }) => {
    const payload = JSON.parse(init.body) as { message?: Record<string, unknown> }
    if (payload.message) captured = payload.message
    return Promise.resolve({})
  })
  await outlookProvider.sendEmail(oauthCredentialsFixture, input)
  return captured
}
```

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run src/lib/mailbox/outlook-provider.test.ts`
Expected: FAIL — `message.attachments` is `undefined`.

- [ ] **Step 3: Implement Outlook**

In `src/lib/mailbox/outlook-provider.ts`, inside `sendEmail`, build the array before the `fetchJson` call:

```ts
    // Under the 3MB per-email ceiling Graph accepts inline fileAttachments on
    // the sendMail call itself. Anything larger would need a draft plus
    // createUploadSession, which is deliberately out of scope.
    const attachments = (input.attachments ?? []).map((attachment) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: assertNoHeaderInjection(attachment.fileName, 'attachmentFileName'),
      contentType: assertNoHeaderInjection(attachment.mimeType, 'attachmentMimeType'),
      contentBytes: attachment.content.toString('base64'),
    }))
```

Then add it to the message object, alongside the existing `internetMessageHeaders` spread:

```ts
          message: {
            subject: assertNoHeaderInjection(input.subject, 'subject'),
            body: { contentType: 'Text', content: input.body },
            toRecipients: [{ emailAddress: { address: assertNoHeaderInjection(input.to, 'to') } }],
            ...(internetMessageHeaders.length > 0 ? { internetMessageHeaders } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
          },
```

- [ ] **Step 4: Write the failing SMTP test**

Append to `src/lib/mailbox/smtp-send.test.ts`, reusing the file's existing transport mock:

```ts
describe('sendSmtpEmail with attachments', () => {
  it('should omit the attachments key when there are none', async () => {
    const options = await captureMailOptions({ to: 'a@b.com', subject: 'Hi', body: 'Hello' })
    expect(options).not.toHaveProperty('attachments')
  })

  it('should pass each attachment through to nodemailer when attachments exist', async () => {
    const content = Buffer.from('PDFBYTES')
    const options = await captureMailOptions({
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      attachments: [{ fileName: 'deck.pdf', mimeType: 'application/pdf', content }],
    })
    expect(options.attachments).toEqual([
      { filename: 'deck.pdf', content, contentType: 'application/pdf' },
    ])
  })

  it('should reject a filename carrying a line break before opening a connection', async () => {
    await expect(
      captureMailOptions({
        to: 'a@b.com',
        subject: 'Hi',
        body: 'Hello',
        attachments: [{ fileName: 'a\nb.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }],
      }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(createSmtpTransportMock).not.toHaveBeenCalled()
  })
})
```

`captureMailOptions` reads the argument the mocked `transport.sendMail` received — follow the existing file's mock shape for it.

- [ ] **Step 5: Implement SMTP**

In `src/lib/mailbox/smtp-send.ts`, validate alongside the other header fields **before** `createSmtpTransport` (the file's comment already explains why validation precedes the connection), then spread into `sendMail`:

```ts
  const attachments = (input.attachments ?? []).map((attachment) => ({
    filename: assertNoHeaderInjection(attachment.fileName, 'attachmentFileName'),
    content: attachment.content,
    contentType: assertNoHeaderInjection(attachment.mimeType, 'attachmentMimeType'),
  }))
```

```ts
      transport.sendMail({
        from: credentials.emailAddress,
        to,
        subject,
        text: input.body,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
        ...(attachments.length > 0 ? { attachments } : {}),
      }),
```

- [ ] **Step 6: Run both suites to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/outlook-provider.test.ts src/lib/mailbox/smtp-send.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/mailbox/outlook-provider.ts src/lib/mailbox/outlook-provider.test.ts src/lib/mailbox/smtp-send.ts src/lib/mailbox/smtp-send.test.ts
git commit -m "feat(mailbox): send attachments through the Outlook and SMTP providers"
```

---

### Task 6: Sender passthrough

**Files:**
- Modify: `src/lib/mailbox/sender.ts` (`SendViaMailboxInput`, and the `provider.sendEmail` call inside the rotation loop)
- Test: `src/lib/mailbox/sender.test.ts`

**Interfaces:**
- Consumes: `EmailAttachment` (Task 3), `SendEmailInput.attachments` (Task 4).
- Produces: `SendViaMailboxInput.attachments?: readonly EmailAttachment[]`, used by Tasks 11, 12, 19.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/mailbox/sender.test.ts`:

```ts
describe('sendViaMailbox attachments', () => {
  it('should forward attachments to the provider unchanged', async () => {
    const attachments = [
      { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('X') },
    ]
    const sendEmail = vi.fn().mockResolvedValue({
      result: { providerMessageId: 'm1', threadId: 't1' },
      tokens: oauthTokensFixture,
    })
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail })

    await sendViaMailbox(supabaseFixture, {
      clientId: 'c1',
      mailboxIds: ['mb1'],
      to: 'a@b.com',
      subject: 'Hi',
      body: 'Hello',
      purpose: 'reply',
      attachments,
      maxJitterMs: 0,
    })

    expect(sendEmail).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ attachments }),
    )
  })
})
```

Reuse the file's existing supabase/mailbox/provider mocks and fixtures — `sender.test.ts` already builds all of them for its rotation tests.

- [ ] **Step 2: Run it and verify it fails**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: FAIL — `attachments` is not a known property of `SendViaMailboxInput`, so typecheck fails and the assertion does not see it.

- [ ] **Step 3: Implement**

Add the import and the field:

```ts
import type { EmailAttachment } from '@/lib/mailbox/attachments'
```

```ts
export interface SendViaMailboxInput {
  clientId: string
  mailboxIds: string[]
  to: string
  subject: string
  body: string
  purpose: SendPurpose
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
  // Replies only — see src/lib/pipeline/reply.ts. Rotation, cap-claiming and
  // jitter are unaffected; this is a pure passthrough to the provider.
  attachments?: readonly EmailAttachment[]
  maxJitterMs?: number
}
```

Then find the `provider.sendEmail(...)` call inside the rotation loop and add the field to the input object it builds, next to `threadId` / `inReplyToMessageId` / `references`:

```ts
      ...(input.attachments && input.attachments.length > 0 ? { attachments: input.attachments } : {}),
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: PASS, including the existing rotation, cap-fallthrough, and unhealthy-skip tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts
git commit -m "feat(mailbox): pass attachments through sendViaMailbox"
```

---

### Task 7: Resource storage layer

**Files:**
- Create: `src/lib/storage/client-resources.ts`
- Test: `src/lib/storage/client-resources.test.ts`

**Interfaces:**
- Consumes: `sanitizeAttachmentFileName` (Task 3).
- Produces:
  - `RESOURCE_BUCKET: 'client-resources'`, `RESOURCE_MAX_BYTES: 3145728`, `ALLOWED_RESOURCE_MIME_TYPES: readonly string[]`
  - `assertValidResourceFile(file: File): void`
  - `uploadClientResource(supabase, clientId: string, file: File): Promise<{ storagePath: string; fileName: string }>`
  - `downloadClientResource(supabase, storagePath: string): Promise<Buffer>`
  - `deleteClientResourceObject(supabase, storagePath: string): Promise<void>`
  - `getClientResourceSignedUrl(supabase, storagePath: string): Promise<string>`

Model this file on `src/lib/storage/client-knowledge-pdfs.ts` — same `AppError` codes, same best-effort delete convention, same signed-URL expiry.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/storage/client-resources.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  RESOURCE_MAX_BYTES,
  assertValidResourceFile,
  uploadClientResource,
  downloadClientResource,
  deleteClientResourceObject,
  getClientResourceSignedUrl,
} from './client-resources'

function fileOf(name: string, type: string, size: number): File {
  const file = new File([new Uint8Array(size)], name, { type })
  return file
}

describe('assertValidResourceFile', () => {
  it('should accept every allowed mime type', () => {
    for (const type of [
      'application/pdf', 'image/png', 'image/jpeg', 'image/gif',
      'image/webp', 'image/svg+xml', 'text/plain', 'text/markdown',
    ]) {
      expect(() => assertValidResourceFile(fileOf('f', type, 10))).not.toThrow()
    }
  })

  it('should throw VALIDATION_ERROR when the mime type is not allowed', () => {
    try {
      assertValidResourceFile(fileOf('evil.exe', 'application/x-msdownload', 10))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })

  it('should throw VALIDATION_ERROR when the file exceeds the 3MB cap', () => {
    try {
      assertValidResourceFile(fileOf('big.pdf', 'application/pdf', RESOURCE_MAX_BYTES + 1))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({ size: RESOURCE_MAX_BYTES + 1 })
    }
  })

  it('should throw VALIDATION_ERROR when the file is empty', () => {
    try {
      assertValidResourceFile(fileOf('empty.pdf', 'application/pdf', 0))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })
})

describe('uploadClientResource', () => {
  it('should store under a client-scoped path and return the sanitized filename', async () => {
    const upload = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload }) } } as never

    const result = await uploadClientResource(supabase, 'c1', fileOf('../résumé.pdf', 'application/pdf', 10))

    expect(result.fileName).toBe('resume.pdf')
    expect(result.storagePath.startsWith('c1/')).toBe(true)
    expect(upload).toHaveBeenCalledWith(
      result.storagePath,
      expect.anything(),
      expect.objectContaining({ contentType: 'application/pdf', upsert: false }),
    )
  })

  it('should throw EXTERNAL_ERROR when storage rejects the upload', async () => {
    const supabase = {
      storage: { from: () => ({ upload: () => Promise.resolve({ error: { message: 'boom' } }) }) },
    } as never
    await expect(
      uploadClientResource(supabase, 'c1', fileOf('a.pdf', 'application/pdf', 10)),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should reject an invalid file before touching storage', async () => {
    const upload = vi.fn()
    const supabase = { storage: { from: () => ({ upload }) } } as never
    await expect(
      uploadClientResource(supabase, 'c1', fileOf('a.exe', 'application/x-msdownload', 10)),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(upload).not.toHaveBeenCalled()
  })
})

describe('downloadClientResource', () => {
  it('should return the object bytes as a Buffer', async () => {
    const blob = new Blob([new Uint8Array([1, 2, 3])])
    const supabase = {
      storage: { from: () => ({ download: () => Promise.resolve({ data: blob, error: null }) }) },
    } as never
    const buffer = await downloadClientResource(supabase, 'c1/x.pdf')
    expect(Buffer.isBuffer(buffer)).toBe(true)
    expect([...buffer]).toEqual([1, 2, 3])
  })

  it('should throw EXTERNAL_ERROR when the object is missing', async () => {
    const supabase = {
      storage: { from: () => ({ download: () => Promise.resolve({ data: null, error: { message: 'not found' } }) }) },
    } as never
    await expect(downloadClientResource(supabase, 'c1/x.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('deleteClientResourceObject', () => {
  it('should swallow a storage failure so cleanup never fails the request', async () => {
    const supabase = {
      storage: { from: () => ({ remove: () => Promise.reject(new Error('boom')) }) },
    } as never
    await expect(deleteClientResourceObject(supabase, 'c1/x.pdf')).resolves.toBeUndefined()
  })
})

describe('getClientResourceSignedUrl', () => {
  it('should return the signed url when signing succeeds', async () => {
    const supabase = {
      storage: {
        from: () => ({
          createSignedUrl: () => Promise.resolve({ data: { signedUrl: 'https://s/x' }, error: null }),
        }),
      },
    } as never
    await expect(getClientResourceSignedUrl(supabase, 'c1/x.pdf')).resolves.toBe('https://s/x')
  })

  it('should throw EXTERNAL_ERROR when signing fails', async () => {
    const supabase = {
      storage: {
        from: () => ({ createSignedUrl: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }),
      },
    } as never
    await expect(getClientResourceSignedUrl(supabase, 'c1/x.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/storage/client-resources.test.ts`
Expected: FAIL — `Failed to resolve import "./client-resources"`.

- [ ] **Step 3: Implement**

Create `src/lib/storage/client-resources.ts`:

```ts
import { randomUUID } from 'node:crypto'
import path from 'node:path'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { sanitizeAttachmentFileName } from '@/lib/mailbox/attachments'

export const RESOURCE_BUCKET = 'client-resources'
// Matches MAX_TOTAL_ATTACHMENT_BYTES: a single resource can never be too big to
// send on its own, so an operator cannot upload something unsendable.
export const RESOURCE_MAX_BYTES = 3 * 1024 * 1024
export const ALLOWED_RESOURCE_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/svg+xml',
  'text/plain',
  'text/markdown',
]
// Private bucket — a resource may be unreleased client collateral, so reads go
// through a short-lived signed URL rather than a public URL.
const SIGNED_URL_EXPIRY_SECONDS = 3600

export function assertValidResourceFile(file: File): void {
  if (!ALLOWED_RESOURCE_MIME_TYPES.includes(file.type)) {
    throw new AppError('VALIDATION_ERROR', 'Unsupported file type', { contentType: file.type })
  }
  if (file.size === 0) {
    throw new AppError('VALIDATION_ERROR', 'File is empty', { size: file.size })
  }
  if (file.size > RESOURCE_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'File must be 3MB or smaller', { size: file.size })
  }
}

export async function uploadClientResource(
  supabase: SupabaseClient<Database>,
  clientId: string,
  file: File,
): Promise<{ storagePath: string; fileName: string }> {
  assertValidResourceFile(file)
  const fileName = sanitizeAttachmentFileName(file.name)
  // The stored object name is a uuid, not the display name: two clients
  // uploading 'portfolio.pdf' must not collide, and the display name is
  // already carried on the row.
  const storagePath = `${clientId}/${randomUUID()}${path.extname(fileName)}`
  const { error } = await supabase.storage.from(RESOURCE_BUCKET).upload(storagePath, file, {
    contentType: file.type,
    cacheControl: '3600',
    upsert: false,
  })
  if (error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to upload resource', { clientId, cause: error.message })
  }
  return { storagePath, fileName }
}

export async function downloadClientResource(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<Buffer> {
  const { data, error } = await supabase.storage.from(RESOURCE_BUCKET).download(storagePath)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to download resource', {
      storagePath, cause: error?.message,
    })
  }
  return Buffer.from(await data.arrayBuffer())
}

// Best-effort cleanup, same convention as deleteClientKnowledgePdfObject —
// called after the row is already deactivated, must never fail the request.
export async function deleteClientResourceObject(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<void> {
  try {
    await supabase.storage.from(RESOURCE_BUCKET).remove([storagePath])
  } catch {
    // Best-effort — see function comment.
  }
}

export async function getClientResourceSignedUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(RESOURCE_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to sign resource url', {
      storagePath, cause: error?.message,
    })
  }
  return data.signedUrl
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/storage/client-resources.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/storage/client-resources.ts src/lib/storage/client-resources.test.ts
git commit -m "feat(storage): add the client-resources bucket layer"
```

---

### Task 8: `client_resources` data access

**Files:**
- Create: `src/lib/db/client-resources.ts`
- Test: `src/lib/db/client-resources.test.ts`

**Interfaces:**
- Consumes: `Database` types (Task 2).
- Produces:
  - `type ClientResourceRow = Database['public']['Tables']['client_resources']['Row']`
  - `insertClientResource(supabase, input: InsertClientResourceInput): Promise<ClientResourceRow>` where `InsertClientResourceInput = { clientId; createdBy; title; description; fileName; mimeType; byteSize; storagePath }`
  - `listActiveResourcesForClient(supabase, clientId: string, limit: number): Promise<ClientResourceRow[]>`
  - `listActiveResourcesForVisibleClients(supabase, limit: number): Promise<ClientResourceRow[]>` — RLS-scoped, no client filter; used by the operator view on `/knowledge/resources`
  - `getResourceById(supabase, id: string): Promise<ClientResourceRow | null>`
  - `getActiveResourcesByIds(supabase, clientId: string, ids: readonly string[]): Promise<ClientResourceRow[]>`
  - `deactivateClientResource(supabase, id: string): Promise<ClientResourceRow | null>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/db/client-resources.test.ts`. Follow the mock style already used in `src/lib/db/client-knowledge.test.ts` — hand-rolled chain objects cast `as never`, no Supabase client library.

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  insertClientResource,
  listActiveResourcesForClient,
  getResourceById,
  getActiveResourcesByIds,
  deactivateClientResource,
} from './client-resources'

const row = {
  id: 'r1', client_id: 'c1', title: 'Deck', description: 'send on request',
  file_name: 'deck.pdf', mime_type: 'application/pdf', byte_size: 1000,
  storage_path: 'c1/x.pdf', is_active: true, created_by: 'u1', created_at: '2026-07-26T00:00:00Z',
}

describe('insertClientResource', () => {
  it('should map camelCase input onto snake_case columns', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    const result = await insertClientResource(supabase, {
      clientId: 'c1', createdBy: 'u1', title: 'Deck', description: 'send on request',
      fileName: 'deck.pdf', mimeType: 'application/pdf', byteSize: 1000, storagePath: 'c1/x.pdf',
    })

    expect(result).toEqual(row)
    expect(insert).toHaveBeenCalledWith({
      client_id: 'c1', created_by: 'u1', title: 'Deck', description: 'send on request',
      file_name: 'deck.pdf', mime_type: 'application/pdf', byte_size: 1000, storage_path: 'c1/x.pdf',
    })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = {
      from: () => ({
        insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
      }),
    } as never
    await expect(
      insertClientResource(supabase, {
        clientId: 'c1', createdBy: 'u1', title: 'Deck', description: 'd',
        fileName: 'a.pdf', mimeType: 'application/pdf', byteSize: 1, storagePath: 'p',
      }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('listActiveResourcesForClient', () => {
  it('should filter to active rows for the client, newest first, within the limit', async () => {
    const limit = vi.fn().mockResolvedValue({ data: [row], error: null })
    const order = vi.fn().mockReturnValue({ limit })
    const isActive = vi.fn().mockReturnValue({ order })
    const eq = vi.fn().mockReturnValue({ eq: isActive })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    const result = await listActiveResourcesForClient(supabase, 'c1', 40)

    expect(result).toEqual([row])
    expect(eq).toHaveBeenCalledWith('client_id', 'c1')
    expect(isActive).toHaveBeenCalledWith('is_active', true)
    expect(order).toHaveBeenCalledWith('created_at', { ascending: false })
    expect(limit).toHaveBeenCalledWith(40)
  })

  it('should return [] when the query yields no rows', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve({ data: null, error: null }) }) }) }) }),
      }),
    } as never
    await expect(listActiveResourcesForClient(supabase, 'c1', 40)).resolves.toEqual([])
  })
})

describe('getActiveResourcesByIds', () => {
  it('should return [] without querying when ids is empty', async () => {
    const from = vi.fn()
    const supabase = { from } as never
    await expect(getActiveResourcesByIds(supabase, 'c1', [])).resolves.toEqual([])
    expect(from).not.toHaveBeenCalled()
  })

  it('should scope the lookup to the client so a foreign id cannot resolve', async () => {
    const inFilter = vi.fn().mockResolvedValue({ data: [row], error: null })
    const isActive = vi.fn().mockReturnValue({ in: inFilter })
    const eq = vi.fn().mockReturnValue({ eq: isActive })
    const supabase = { from: () => ({ select: () => ({ eq }) }) } as never

    await getActiveResourcesByIds(supabase, 'c1', ['r1', 'r-other'])

    expect(eq).toHaveBeenCalledWith('client_id', 'c1')
    expect(isActive).toHaveBeenCalledWith('is_active', true)
    expect(inFilter).toHaveBeenCalledWith('id', ['r1', 'r-other'])
  })
})

describe('getResourceById', () => {
  it('should return null when no row matches', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    await expect(getResourceById(supabase, 'r1')).resolves.toBeNull()
  })
})

describe('deactivateClientResource', () => {
  it('should soft delete and return the row when it was still active', async () => {
    const select = vi.fn().mockResolvedValue({ data: [{ ...row, is_active: false }], error: null })
    const isActive = vi.fn().mockReturnValue({ select })
    const eq = vi.fn().mockReturnValue({ eq: isActive })
    const update = vi.fn().mockReturnValue({ eq })
    const supabase = { from: () => ({ update }) } as never

    const result = await deactivateClientResource(supabase, 'r1')

    expect(result?.is_active).toBe(false)
    expect(update).toHaveBeenCalledWith({ is_active: false })
    expect(eq).toHaveBeenCalledWith('id', 'r1')
    expect(isActive).toHaveBeenCalledWith('is_active', true)
  })

  it('should return null when the row was already deactivated', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => ({ select: () => Promise.resolve({ data: [], error: null }) }) }) }) }),
    } as never
    await expect(deactivateClientResource(supabase, 'r1')).resolves.toBeNull()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/client-resources.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/db/client-resources.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type ClientResourceRow = Database['public']['Tables']['client_resources']['Row']

export interface InsertClientResourceInput {
  clientId: string
  createdBy: string
  title: string
  description: string
  fileName: string
  mimeType: string
  byteSize: number
  storagePath: string
}

export async function insertClientResource(
  supabase: SupabaseClient<Database>,
  input: InsertClientResourceInput,
): Promise<ClientResourceRow> {
  const { data, error } = await supabase
    .from('client_resources')
    .insert({
      client_id: input.clientId,
      created_by: input.createdBy,
      title: input.title,
      description: input.description,
      file_name: input.fileName,
      mime_type: input.mimeType,
      byte_size: input.byteSize,
      storage_path: input.storagePath,
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert resource', {
      clientId: input.clientId, cause: error?.message,
    })
  }
  return data
}

// Newest first so the AI menu's ordinals are stable within a run and recent
// collateral surfaces before stale collateral once the menu is capped.
export async function listActiveResourcesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  limit: number,
): Promise<ClientResourceRow[]> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list resources', { clientId, cause: error.message })
  }
  return data ?? []
}

// No client filter: RLS decides what the caller sees. Pass a session-bound
// server client — an operator gets every client's resources, a client-role
// session only its own.
export async function listActiveResourcesForVisibleClients(
  supabase: SupabaseClient<Database>,
  limit: number,
): Promise<ClientResourceRow[]> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('is_active', true)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list resources', { cause: error.message })
  }
  return data ?? []
}

export async function getResourceById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ClientResourceRow | null> {
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('id', id)
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load resource', { id, cause: error.message })
  return data
}

// Client-scoped on purpose: this is the lookup that turns model-supplied or
// form-supplied ids into real files, so an id belonging to another client must
// not resolve even when the caller holds the service-role key.
export async function getActiveResourcesByIds(
  supabase: SupabaseClient<Database>,
  clientId: string,
  ids: readonly string[],
): Promise<ClientResourceRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase
    .from('client_resources')
    .select('*')
    .eq('client_id', clientId)
    .eq('is_active', true)
    .in('id', [...ids])
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load resources', { clientId, cause: error.message })
  }
  return data ?? []
}

// Soft delete. The `.eq('is_active', true)` guard makes it a claim: a second
// concurrent delete gets null and must not re-remove the storage object.
export async function deactivateClientResource(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ClientResourceRow | null> {
  const { data, error } = await supabase
    .from('client_resources')
    .update({ is_active: false })
    .eq('id', id)
    .eq('is_active', true)
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to deactivate resource', { id, cause: error.message })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/client-resources.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/db/client-resources.ts src/lib/db/client-resources.test.ts
git commit -m "feat(db): add client_resources data access"
```

---

### Task 9: `email_attachments` data access

**Files:**
- Create: `src/lib/db/email-attachments.ts`
- Test: `src/lib/db/email-attachments.test.ts`

**Interfaces:**
- Consumes: `Database` types (Task 2), `ClientResourceRow` (Task 8).
- Produces:
  - `interface EmailAttachmentRow { resourceId; title; fileName; mimeType; byteSize; storagePath }`
  - `insertEmailAttachments(supabase, input: { clientId: string; emailId: string; resourceIds: readonly string[] }): Promise<void>`
  - `listAttachmentsForEmail(supabase, emailId: string): Promise<EmailAttachmentRow[]>`
  - `replaceEmailAttachments(supabase, input: { clientId: string; emailId: string; resourceIds: readonly string[] }): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/db/email-attachments.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  insertEmailAttachments,
  listAttachmentsForEmail,
  replaceEmailAttachments,
} from './email-attachments'

describe('insertEmailAttachments', () => {
  it('should do nothing when there are no resource ids', async () => {
    const from = vi.fn()
    const supabase = { from } as never
    await insertEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: [] })
    expect(from).not.toHaveBeenCalled()
  })

  it('should upsert one row per resource, ignoring duplicates', async () => {
    const upsert = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ upsert }) } as never

    await insertEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r1', 'r2'] })

    expect(upsert).toHaveBeenCalledWith(
      [
        { client_id: 'c1', email_id: 'e1', resource_id: 'r1' },
        { client_id: 'c1', email_id: 'e1', resource_id: 'r2' },
      ],
      { onConflict: 'email_id,resource_id', ignoreDuplicates: true },
    )
  })

  it('should throw DB_ERROR when the upsert fails', async () => {
    const supabase = {
      from: () => ({ upsert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as never
    await expect(
      insertEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r1'] }),
    ).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('listAttachmentsForEmail', () => {
  it('should map the joined resource onto a flat camelCase shape', async () => {
    const joined = [
      {
        resource_id: 'r1',
        client_resources: {
          title: 'Deck', file_name: 'deck.pdf', mime_type: 'application/pdf',
          byte_size: 1000, storage_path: 'c1/x.pdf',
        },
      },
    ]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: joined, error: null }) }) }),
    } as never

    await expect(listAttachmentsForEmail(supabase, 'e1')).resolves.toEqual([
      {
        resourceId: 'r1', title: 'Deck', fileName: 'deck.pdf',
        mimeType: 'application/pdf', byteSize: 1000, storagePath: 'c1/x.pdf',
      },
    ])
  })

  it('should drop rows whose resource join came back empty', async () => {
    const supabase = {
      from: () => ({
        select: () => ({ eq: () => Promise.resolve({ data: [{ resource_id: 'r1', client_resources: null }], error: null }) }),
      }),
    } as never
    await expect(listAttachmentsForEmail(supabase, 'e1')).resolves.toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listAttachmentsForEmail(supabase, 'e1')).rejects.toMatchObject({ code: 'DB_ERROR' })
  })
})

describe('replaceEmailAttachments', () => {
  it('should delete the existing set before inserting the new one', async () => {
    const order: string[] = []
    const del = vi.fn().mockReturnValue({
      eq: () => {
        order.push('delete')
        return Promise.resolve({ error: null })
      },
    })
    const upsert = vi.fn().mockImplementation(() => {
      order.push('upsert')
      return Promise.resolve({ error: null })
    })
    const supabase = { from: () => ({ delete: del, upsert }) } as never

    await replaceEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: ['r2'] })

    expect(order).toEqual(['delete', 'upsert'])
  })

  it('should clear the set when the new list is empty', async () => {
    const upsert = vi.fn()
    const supabase = {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: null }) }), upsert }),
    } as never
    await replaceEmailAttachments(supabase, { clientId: 'c1', emailId: 'e1', resourceIds: [] })
    expect(upsert).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/email-attachments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/db/email-attachments.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export interface EmailAttachmentRow {
  resourceId: string
  title: string
  fileName: string
  mimeType: string
  byteSize: number
  storagePath: string
}

// The (email_id, resource_id) unique index plus ignoreDuplicates makes this
// idempotent: a retried QStash delivery re-attaching the same set is a no-op.
export async function insertEmailAttachments(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; emailId: string; resourceIds: readonly string[] },
): Promise<void> {
  if (input.resourceIds.length === 0) return
  const { error } = await supabase.from('email_attachments').upsert(
    input.resourceIds.map((resourceId) => ({
      client_id: input.clientId,
      email_id: input.emailId,
      resource_id: resourceId,
    })),
    { onConflict: 'email_id,resource_id', ignoreDuplicates: true },
  )
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to attach resources to email', {
      emailId: input.emailId, cause: error.message,
    })
  }
}

interface JoinedAttachment {
  resource_id: string
  client_resources: {
    title: string
    file_name: string
    mime_type: string
    byte_size: number
    storage_path: string
  } | null
}

export async function listAttachmentsForEmail(
  supabase: SupabaseClient<Database>,
  emailId: string,
): Promise<EmailAttachmentRow[]> {
  const { data, error } = await supabase
    .from('email_attachments')
    .select('resource_id, client_resources(title, file_name, mime_type, byte_size, storage_path)')
    .eq('email_id', emailId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list email attachments', { emailId, cause: error.message })
  }
  // A null join means the resource row is gone despite the RESTRICT FK, which
  // should be impossible — drop it rather than render a broken attachment.
  return ((data ?? []) as unknown as JoinedAttachment[])
    .filter((row): row is JoinedAttachment & { client_resources: NonNullable<JoinedAttachment['client_resources']> } =>
      row.client_resources !== null)
    .map((row) => ({
      resourceId: row.resource_id,
      title: row.client_resources.title,
      fileName: row.client_resources.file_name,
      mimeType: row.client_resources.mime_type,
      byteSize: row.client_resources.byte_size,
      storagePath: row.client_resources.storage_path,
    }))
}

// Used by the /inbox draft editor. Delete-then-insert rather than a diff: the
// set is at most MAX_ATTACHMENTS_PER_EMAIL rows and the email is still a draft,
// so nothing is reading it concurrently.
export async function replaceEmailAttachments(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; emailId: string; resourceIds: readonly string[] },
): Promise<void> {
  const { error } = await supabase.from('email_attachments').delete().eq('email_id', input.emailId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to clear email attachments', {
      emailId: input.emailId, cause: error.message,
    })
  }
  await insertEmailAttachments(supabase, input)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/email-attachments.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/db/email-attachments.ts src/lib/db/email-attachments.test.ts
git commit -m "feat(db): add email_attachments data access"
```

---

### Task 10: Resource menu and ordinal resolution

**Files:**
- Create: `src/lib/resources/menu.ts`
- Test: `src/lib/resources/menu.test.ts`

**Interfaces:**
- Consumes: `ClientResourceRow` (Task 8), `MAX_ATTACHMENTS_PER_EMAIL` / `MAX_TOTAL_ATTACHMENT_BYTES` (Task 3).
- Produces:
  - `MAX_RESOURCE_MENU: 40`
  - `interface ResourceMenuEntry { ordinal: number; resource: ClientResourceRow }`
  - `buildResourceMenu(resources: readonly ClientResourceRow[]): ResourceMenuEntry[]`
  - `formatResourceMenu(menu: readonly ResourceMenuEntry[]): string`
  - `interface ResolvedAttachments { resources: ClientResourceRow[]; droppedResourceIds: string[]; totalBytes: number }`
  - `resolveAttachments(menu: readonly ResourceMenuEntry[], picked: readonly number[]): ResolvedAttachments`

This is the whole of the AI-selection logic and it is pure — 100% coverage is required.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/resources/menu.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { ClientResourceRow } from '@/lib/db/client-resources'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'
import {
  MAX_RESOURCE_MENU,
  buildResourceMenu,
  formatResourceMenu,
  resolveAttachments,
} from './menu'

function resource(id: string, overrides: Partial<ClientResourceRow> = {}): ClientResourceRow {
  return {
    id,
    client_id: 'c1',
    title: `Title ${id}`,
    description: `Description ${id}`,
    file_name: `${id}.pdf`,
    mime_type: 'application/pdf',
    byte_size: 1000,
    storage_path: `c1/${id}.pdf`,
    is_active: true,
    created_by: 'u1',
    created_at: '2026-07-26T00:00:00Z',
    ...overrides,
  }
}

describe('buildResourceMenu', () => {
  it('should number entries from 1 in the order given', () => {
    const menu = buildResourceMenu([resource('a'), resource('b')])
    expect(menu.map((e) => e.ordinal)).toEqual([1, 2])
    expect(menu.map((e) => e.resource.id)).toEqual(['a', 'b'])
  })

  it('should cap the menu at MAX_RESOURCE_MENU entries', () => {
    const resources = Array.from({ length: MAX_RESOURCE_MENU + 10 }, (_, i) => resource(`r${i}`))
    expect(buildResourceMenu(resources)).toHaveLength(MAX_RESOURCE_MENU)
  })

  it('should return an empty menu when there are no resources', () => {
    expect(buildResourceMenu([])).toEqual([])
  })
})

describe('formatResourceMenu', () => {
  it('should return an empty string when the menu is empty', () => {
    expect(formatResourceMenu([])).toBe('')
  })

  it('should render one line per entry as ordinal, title and description', () => {
    const text = formatResourceMenu(buildResourceMenu([resource('a'), resource('b')]))
    expect(text).toContain('1 — Title a — Description a')
    expect(text).toContain('2 — Title b — Description b')
  })

  it('should collapse line breaks inside a description onto one line', () => {
    const text = formatResourceMenu(
      buildResourceMenu([resource('a', { description: 'first\nsecond' })]),
    )
    expect(text).toContain('1 — Title a — first second')
    expect(text.split('\n').filter((line) => line.startsWith('1 —'))).toHaveLength(1)
  })
})

describe('resolveAttachments', () => {
  const menu = buildResourceMenu([resource('a'), resource('b'), resource('c'), resource('d')])

  it('should resolve ordinals to their resources when all are valid', () => {
    const result = resolveAttachments(menu, [1, 3])
    expect(result.resources.map((r) => r.id)).toEqual(['a', 'c'])
    expect(result.droppedResourceIds).toEqual([])
    expect(result.totalBytes).toBe(2000)
  })

  it('should return nothing when the model picked nothing', () => {
    expect(resolveAttachments(menu, [])).toEqual({ resources: [], droppedResourceIds: [], totalBytes: 0 })
  })

  it('should return nothing when the menu is empty', () => {
    expect(resolveAttachments([], [1, 2])).toEqual({ resources: [], droppedResourceIds: [], totalBytes: 0 })
  })

  it('should ignore an ordinal the model hallucinated', () => {
    const result = resolveAttachments(menu, [1, 99, 0, -1])
    expect(result.resources.map((r) => r.id)).toEqual(['a'])
    expect(result.droppedResourceIds).toEqual([])
  })

  it('should ignore a repeated ordinal', () => {
    const result = resolveAttachments(menu, [2, 2, 2])
    expect(result.resources.map((r) => r.id)).toEqual(['b'])
  })

  it('should drop the overflow when more than MAX_ATTACHMENTS_PER_EMAIL are picked', () => {
    const result = resolveAttachments(menu, [1, 2, 3, 4])
    expect(result.resources).toHaveLength(MAX_ATTACHMENTS_PER_EMAIL)
    expect(result.resources.map((r) => r.id)).toEqual(['a', 'b', 'c'])
    expect(result.droppedResourceIds).toEqual(['d'])
  })

  it('should drop a resource that would breach the byte budget and keep going', () => {
    const big = buildResourceMenu([
      resource('big', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES - 100 }),
      resource('huge', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES }),
      resource('small', { byte_size: 50 }),
    ])
    const result = resolveAttachments(big, [1, 2, 3])
    expect(result.resources.map((r) => r.id)).toEqual(['big', 'small'])
    expect(result.droppedResourceIds).toEqual(['huge'])
    expect(result.totalBytes).toBe(MAX_TOTAL_ATTACHMENT_BYTES - 50)
  })

  it('should keep a resource sized exactly at the budget', () => {
    const exact = buildResourceMenu([resource('x', { byte_size: MAX_TOTAL_ATTACHMENT_BYTES })])
    const result = resolveAttachments(exact, [1])
    expect(result.resources.map((r) => r.id)).toEqual(['x'])
    expect(result.droppedResourceIds).toEqual([])
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/resources/menu.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/resources/menu.ts`:

```ts
import type { ClientResourceRow } from '@/lib/db/client-resources'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'

// The scaling ceiling for putting the whole library in the prompt. Past this,
// the menu dilutes the model's attention and eats the token budget; the
// migration at that point is a semantic shortlist (embed `description`,
// retrieve top-K by the lead's question, put only those in the menu).
export const MAX_RESOURCE_MENU = 40

export interface ResourceMenuEntry {
  ordinal: number
  resource: ClientResourceRow
}

export interface ResolvedAttachments {
  resources: ClientResourceRow[]
  droppedResourceIds: string[]
  totalBytes: number
}

export function buildResourceMenu(resources: readonly ClientResourceRow[]): ResourceMenuEntry[] {
  return resources
    .slice(0, MAX_RESOURCE_MENU)
    .map((resource, index) => ({ ordinal: index + 1, resource }))
}

// Ordinals rather than uuids: models mangle uuids, and 40 of them is pure token
// waste. One line per entry, because a line break inside a description would
// otherwise let a resource's text impersonate a new menu row.
export function formatResourceMenu(menu: readonly ResourceMenuEntry[]): string {
  if (menu.length === 0) return ''
  return menu
    .map(({ ordinal, resource }) => {
      const title = resource.title.replace(/\s+/g, ' ').trim()
      const description = resource.description.replace(/\s+/g, ' ').trim()
      return `${ordinal} — ${title} — ${description}`
    })
    .join('\n')
}

/**
 * Turns the model's picked ordinals into real rows the sender can attach.
 * Everything the model returns is treated as untrusted: out-of-range ordinals
 * are hallucinations, repeats are noise, and the count and byte budget are
 * enforced here rather than trusted to the prompt.
 */
export function resolveAttachments(
  menu: readonly ResourceMenuEntry[],
  picked: readonly number[],
): ResolvedAttachments {
  const byOrdinal = new Map(menu.map((entry) => [entry.ordinal, entry.resource]))
  const seen = new Set<number>()
  const candidates: ClientResourceRow[] = []
  for (const ordinal of picked) {
    if (seen.has(ordinal)) continue
    seen.add(ordinal)
    const resource = byOrdinal.get(ordinal)
    if (resource) candidates.push(resource)
  }

  const resources: ClientResourceRow[] = []
  const droppedResourceIds: string[] = []
  let totalBytes = 0
  for (const resource of candidates) {
    const overCount = resources.length >= MAX_ATTACHMENTS_PER_EMAIL
    const overBudget = totalBytes + resource.byte_size > MAX_TOTAL_ATTACHMENT_BYTES
    if (overCount || overBudget) {
      droppedResourceIds.push(resource.id)
      continue
    }
    resources.push(resource)
    totalBytes += resource.byte_size
  }
  return { resources, droppedResourceIds, totalBytes }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/resources/menu.test.ts`
Expected: PASS, 15 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/resources/menu.ts src/lib/resources/menu.test.ts
git commit -m "feat(resources): add the prompt menu and ordinal resolution"
```

---

### Task 11: Load resource attachments

**Files:**
- Create: `src/lib/resources/load-attachments.ts`
- Test: `src/lib/resources/load-attachments.test.ts`

**Interfaces:**
- Consumes: `getActiveResourcesByIds` (Task 8), `downloadClientResource` (Task 7), `assertWithinAttachmentLimits` / `EmailAttachment` (Task 3).
- Produces: `loadResourceAttachments(supabase, clientId: string, resourceIds: readonly string[]): Promise<EmailAttachment[]>` — used by Tasks 12, 13, 19.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/resources/load-attachments.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getActiveResourcesByIdsMock = vi.fn()
const downloadClientResourceMock = vi.fn()
vi.mock('@/lib/db/client-resources', () => ({
  getActiveResourcesByIds: (...a: unknown[]) => getActiveResourcesByIdsMock(...a),
}))
vi.mock('@/lib/storage/client-resources', () => ({
  downloadClientResource: (...a: unknown[]) => downloadClientResourceMock(...a),
}))

import { loadResourceAttachments } from './load-attachments'

const supabase = {} as never

beforeEach(() => {
  getActiveResourcesByIdsMock.mockReset()
  downloadClientResourceMock.mockReset()
})

describe('loadResourceAttachments', () => {
  it('should return [] without querying when there are no ids', async () => {
    await expect(loadResourceAttachments(supabase, 'c1', [])).resolves.toEqual([])
    expect(getActiveResourcesByIdsMock).not.toHaveBeenCalled()
  })

  it('should download each resource and shape it as an EmailAttachment', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', file_name: 'deck.pdf', mime_type: 'application/pdf', byte_size: 3, storage_path: 'c1/a.pdf' },
    ])
    downloadClientResourceMock.mockResolvedValue(Buffer.from('abc'))

    await expect(loadResourceAttachments(supabase, 'c1', ['r1'])).resolves.toEqual([
      { fileName: 'deck.pdf', mimeType: 'application/pdf', content: Buffer.from('abc') },
    ])
  })

  it('should preserve the caller ordering rather than the database ordering', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r2', file_name: 'b.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p2' },
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])
    downloadClientResourceMock.mockResolvedValue(Buffer.from('x'))

    const result = await loadResourceAttachments(supabase, 'c1', ['r1', 'r2'])
    expect(result.map((a) => a.fileName)).toEqual(['a.pdf', 'b.pdf'])
  })

  it('should skip an id that did not resolve for this client', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([])
    await expect(loadResourceAttachments(supabase, 'c1', ['r-foreign'])).resolves.toEqual([])
    expect(downloadClientResourceMock).not.toHaveBeenCalled()
  })

  it('should propagate a download failure rather than sending a partial set', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])
    downloadClientResourceMock.mockRejectedValue(new Error('gone'))
    await expect(loadResourceAttachments(supabase, 'c1', ['r1'])).rejects.toThrow('gone')
  })

  it('should throw VALIDATION_ERROR when the resolved set breaches the byte budget', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', file_name: 'a.pdf', mime_type: 'application/pdf', byte_size: 1, storage_path: 'p1' },
    ])
    downloadClientResourceMock.mockResolvedValue(Buffer.alloc(4 * 1024 * 1024))
    await expect(loadResourceAttachments(supabase, 'c1', ['r1'])).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/resources/load-attachments.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/resources/load-attachments.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getActiveResourcesByIds, type ClientResourceRow } from '@/lib/db/client-resources'
import { downloadClientResource } from '@/lib/storage/client-resources'
import { assertWithinAttachmentLimits, type EmailAttachment } from '@/lib/mailbox/attachments'

/**
 * Turns resource ids into wire-ready attachments. Deliberately fails loudly:
 * if a storage object is missing, the send fails and the existing retry path
 * takes over, because an email whose body promises "attached are the examples"
 * going out with nothing attached is worse than a retry.
 *
 * `clientId` scopes the lookup, so an id belonging to another client silently
 * resolves to nothing rather than leaking a file across tenants.
 */
export async function loadResourceAttachments(
  supabase: SupabaseClient<Database>,
  clientId: string,
  resourceIds: readonly string[],
): Promise<EmailAttachment[]> {
  if (resourceIds.length === 0) return []

  const rows = await getActiveResourcesByIds(supabase, clientId, resourceIds)
  const byId = new Map(rows.map((row) => [row.id, row]))
  // Caller ordering wins: the AI's menu order (or the operator's pick order) is
  // the order the recipient should see, and `.in()` gives no ordering guarantee.
  const ordered = resourceIds
    .map((id) => byId.get(id))
    .filter((row): row is ClientResourceRow => row !== undefined)

  const attachments = await Promise.all(
    ordered.map(async (row) => ({
      fileName: row.file_name,
      mimeType: row.mime_type,
      content: await downloadClientResource(supabase, row.storage_path),
    })),
  )

  assertWithinAttachmentLimits(attachments)
  return attachments
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/resources/load-attachments.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/resources/load-attachments.ts src/lib/resources/load-attachments.test.ts
git commit -m "feat(resources): load resource ids into wire-ready attachments"
```

---

### Task 12: Reply pipeline — menu in, attachments out

**Files:**
- Modify: `src/lib/pipeline/reply.ts`
- Modify: `src/lib/pipeline/knowledge-answer.ts` (one line — pass `resourceIds: []` so the repo stays green; Task 13 gives it a real value)
- Test: `src/lib/pipeline/reply.test.ts`

**Interfaces:**
- Consumes: `listActiveResourcesForClient` (Task 8), `insertEmailAttachments` (Task 9), `buildResourceMenu` / `formatResourceMenu` / `resolveAttachments` / `MAX_RESOURCE_MENU` (Task 10), `loadResourceAttachments` (Task 11), `SendViaMailboxInput.attachments` (Task 6).
- Produces:
  - `classificationSchema` gains `attachResourceIds: z.array(z.number().int()).default([])`
  - `SendOrDraftInput` gains `resourceIds: readonly string[]` (required — every call site must state its intent)
  - `classifyReply(context, args)` — `args` gains `resourceMenu: string`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/pipeline/reply.test.ts`, following the file's existing mock setup (it already mocks `@/lib/llm/client`, `@/lib/db/emails`, `@/lib/mailbox/sender`, and friends). Add mocks for the three new modules alongside them:

```ts
const listActiveResourcesForClientMock = vi.fn()
vi.mock('@/lib/db/client-resources', () => ({
  listActiveResourcesForClient: (...a: unknown[]) => listActiveResourcesForClientMock(...a),
}))
const insertEmailAttachmentsMock = vi.fn()
vi.mock('@/lib/db/email-attachments', () => ({
  insertEmailAttachments: (...a: unknown[]) => insertEmailAttachmentsMock(...a),
}))
const loadResourceAttachmentsMock = vi.fn()
vi.mock('@/lib/resources/load-attachments', () => ({
  loadResourceAttachments: (...a: unknown[]) => loadResourceAttachmentsMock(...a),
}))
```

Default them in the file's `beforeEach`: `listActiveResourcesForClientMock.mockResolvedValue([])`, `insertEmailAttachmentsMock.mockResolvedValue(undefined)`, `loadResourceAttachmentsMock.mockResolvedValue([])`.

```ts
describe('sendOrDraftReply attachments', () => {
  it('should record attachments on a draft without sending', async () => {
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })

    await sendOrDraftReply(supabaseFixture, {
      inbound: inboundFixture,
      lead: leadFixture,
      mailboxIds: ['mb1'],
      subject: 'Re: Hi',
      body: 'Here you go',
      disposition: 'draft',
      resourceIds: ['r1'],
    })

    expect(insertEmailAttachmentsMock).toHaveBeenCalledWith(supabaseFixture, {
      clientId: 'c1', emailId: 'e-new', resourceIds: ['r1'],
    })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should forward loaded attachments to the sender when sending', async () => {
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })
    const attachments = [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }]
    loadResourceAttachmentsMock.mockResolvedValue(attachments)

    await sendOrDraftReply(supabaseFixture, {
      inbound: inboundFixture,
      lead: leadFixture,
      mailboxIds: ['mb1'],
      subject: 'Re: Hi',
      body: 'Here you go',
      disposition: 'send',
      resourceIds: ['r1'],
    })

    expect(loadResourceAttachmentsMock).toHaveBeenCalledWith(supabaseFixture, 'c1', ['r1'])
    expect(sendViaMailboxMock).toHaveBeenCalledWith(
      supabaseFixture,
      expect.objectContaining({ attachments }),
    )
  })

  it('should mark the email failed when loading an attachment fails', async () => {
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })
    loadResourceAttachmentsMock.mockRejectedValue(new Error('storage gone'))

    await expect(
      sendOrDraftReply(supabaseFixture, {
        inbound: inboundFixture,
        lead: leadFixture,
        mailboxIds: ['mb1'],
        subject: 'Re: Hi',
        body: 'Here you go',
        disposition: 'send',
        resourceIds: ['r1'],
      }),
    ).rejects.toThrow('storage gone')

    expect(markEmailFailedMock).toHaveBeenCalledWith(supabaseFixture, 'e-new')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should not attach anything when the claim was lost to a prior delivery', async () => {
    claimReplyEmailMock.mockResolvedValue(null)

    await sendOrDraftReply(supabaseFixture, {
      inbound: inboundFixture,
      lead: leadFixture,
      mailboxIds: ['mb1'],
      subject: 'Re: Hi',
      body: 'Here you go',
      disposition: 'send',
      resourceIds: ['r1'],
    })

    expect(insertEmailAttachmentsMock).not.toHaveBeenCalled()
  })
})

describe('runReplyForInbound resource selection', () => {
  it('should attach the resources the model picked when it answered', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([
      { id: 'r1', client_id: 'c1', title: 'Deck', description: 'examples', file_name: 'd.pdf',
        mime_type: 'application/pdf', byte_size: 100, storage_path: 'p', is_active: true,
        created_by: 'u1', created_at: '2026-07-26T00:00:00Z' },
    ])
    generateJsonMock.mockResolvedValue({
      intent: 'question', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'Attached are the examples.', attachResourceIds: [1],
    })
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })

    const result = await runReplyForInbound(supabaseFixture, { emailId: 'e1' })

    expect(result.action).toBe('answered')
    expect(insertEmailAttachmentsMock).toHaveBeenCalledWith(supabaseFixture, {
      clientId: 'c1', emailId: 'e-new', resourceIds: ['r1'],
    })
  })

  it('should attach nothing when the client has no resources', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([])
    generateJsonMock.mockResolvedValue({
      intent: 'question', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'Sure.', attachResourceIds: [1, 2],
    })
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })

    await runReplyForInbound(supabaseFixture, { emailId: 'e1' })

    expect(insertEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should attach nothing on a price handoff even if the model picked files', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([
      { id: 'r1', client_id: 'c1', title: 'Rates', description: 'pricing', file_name: 'r.pdf',
        mime_type: 'application/pdf', byte_size: 100, storage_path: 'p', is_active: true,
        created_by: 'u1', created_at: '2026-07-26T00:00:00Z' },
    ])
    generateJsonMock.mockResolvedValue({
      intent: 'price', confidence: 0.9, canAnswer: false,
      missingQuestion: null, replyBody: null, attachResourceIds: [1],
    })
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })

    const result = await runReplyForInbound(supabaseFixture, { emailId: 'e1' })

    expect(result.action).toBe('handoff')
    expect(insertEmailAttachmentsMock).not.toHaveBeenCalled()
  })

  it('should include the resource menu in the prompt when the client has resources', async () => {
    listActiveResourcesForClientMock.mockResolvedValue([
      { id: 'r1', client_id: 'c1', title: 'Deck', description: 'examples', file_name: 'd.pdf',
        mime_type: 'application/pdf', byte_size: 100, storage_path: 'p', is_active: true,
        created_by: 'u1', created_at: '2026-07-26T00:00:00Z' },
    ])
    generateJsonMock.mockResolvedValue({
      intent: 'other', confidence: 0.9, canAnswer: true,
      missingQuestion: null, replyBody: 'ok', attachResourceIds: [],
    })
    claimReplyEmailMock.mockResolvedValue({ id: 'e-new', client_id: 'c1' })

    await runReplyForInbound(supabaseFixture, { emailId: 'e1' })

    const promptArg = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(promptArg.prompt).toContain('1 — Deck — examples')
  })
})
```

Reuse whatever the file already names its fixtures and mocks (`supabaseFixture`, `inboundFixture`, `leadFixture`, `generateJsonMock`, `claimReplyEmailMock`, `markEmailFailedMock`, `sendViaMailboxMock`). If a fixture does not exist yet under that name, use the file's existing equivalent rather than adding a parallel one.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/reply.test.ts`
Expected: FAIL — `resourceIds` is not a known property of `SendOrDraftInput`, and `attachResourceIds` is stripped by the schema.

- [ ] **Step 3: Add the schema field and the prompt instruction**

In `src/lib/pipeline/reply.ts`, add the imports:

```ts
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
import { insertEmailAttachments } from '@/lib/db/email-attachments'
import {
  MAX_RESOURCE_MENU, buildResourceMenu, formatResourceMenu, resolveAttachments,
} from '@/lib/resources/menu'
import { loadResourceAttachments } from '@/lib/resources/load-attachments'
```

Extend the schema:

```ts
const classificationSchema = z.object({
  intent: z.enum(['question', 'interested', 'price', 'not_interested', 'other']),
  confidence: z.number().min(0).max(1),
  canAnswer: z.boolean(),
  missingQuestion: z.string().nullable(),
  replyBody: z.string().nullable(),
  // Ordinals from the resource menu, not ids. Everything here is untrusted —
  // resolveAttachments drops hallucinated ordinals and enforces the budget.
  attachResourceIds: z.array(z.number().int()).default([]),
})
```

Append to `SYSTEM_PROMPT` (inside the existing array, before the final `'Replies are short, …'` line):

```ts
  'You may be given a numbered list of resources (files) you can attach. Attach',
  'one only when the prospect explicitly asked for something that resource',
  'provides — never as a bonus. Put the numbers in attachResourceIds, or leave',
  'it empty. When you do attach, say so naturally in replyBody.',
```

- [ ] **Step 4: Thread the menu into the prompt**

Change `buildClassifyPrompt`'s argument type to include `resourceMenu: string` and add one entry to its array, after the dossier:

```ts
    args.resourceMenu ? `Resources you may attach:\n${args.resourceMenu}` : '',
```

Change `classifyReply`'s `args` type identically — it already spreads straight into `buildClassifyPrompt`, so no other change is needed there.

- [ ] **Step 5: Give `sendOrDraftReply` attachments**

Add the field to `SendOrDraftInput`:

```ts
interface SendOrDraftInput {
  inbound: EmailRow
  lead: LeadRow
  mailboxIds: string[]
  subject: string
  body: string
  disposition: 'send' | 'draft'
  // Resolved and budget-checked by the caller. Recorded against the email even
  // when drafting, so /inbox can show and edit what the AI picked.
  resourceIds: readonly string[]
}
```

Inside the function, after the `if (!claimed) return` line and before the draft branch:

```ts
  await insertEmailAttachments(supabase, {
    clientId: input.inbound.client_id,
    emailId: claimed.id,
    resourceIds: input.resourceIds,
  })
  if (input.disposition === 'draft') return // sits in /inbox for a human
```

Then load the bytes inside the existing `try` that wraps `sendViaMailbox`, so a storage failure lands in the same `markEmailFailed` path as a send failure:

```ts
  let sent: SendViaMailboxResult
  try {
    const attachments = await loadResourceAttachments(
      supabase, input.inbound.client_id, input.resourceIds,
    )
    sent = await sendViaMailbox(supabase, {
      clientId: input.inbound.client_id,
      mailboxIds: input.mailboxIds,
      to: input.lead.email,
      subject: input.subject,
      body: input.body,
      purpose: 'reply',
      threadId: input.inbound.thread_id,
      inReplyToMessageId: input.inbound.provider_message_id,
      references: input.inbound.provider_message_id,
      attachments,
    })
  } catch (error) {
```

The existing catch already handles `RATE_LIMITED` (rethrow, leave queued), `FORBIDDEN` (mark failed, log, return) and everything else (mark failed, rethrow) — a storage failure falls into the last branch, which is the intended behavior.

- [ ] **Step 6: Wire selection into `runReplyForInbound`**

Load the menu alongside the existing parallel fetch:

```ts
  const [thread, knowledge, resources] = await Promise.all([
    listThreadEmails(supabase, inbound.lead_id),
    listKnowledgeForCase(supabase, inbound.case_id),
    listActiveResourcesForClient(supabase, inbound.client_id, MAX_RESOURCE_MENU),
  ])
  const resourceMenu = buildResourceMenu(resources)
```

Pass it to the classifier:

```ts
  const classification = await classifyReply(context, {
    thread, knowledge, valueProp: campaign.value_prop, inboundBody: inbound.body ?? '',
    clientKnowledge, resourceMenu: formatResourceMenu(resourceMenu),
  })
```

In the `price` branch, pass `resourceIds: []` to `sendOrDraftReply` — a pricing handoff is a booking link, never a file.

In the `question | interested | other` branch, resolve after the escalation early-return:

```ts
      const { resources: attachResources, droppedResourceIds } = resolveAttachments(
        resourceMenu, classification.attachResourceIds,
      )
      await sendOrDraftReply(supabase, {
        inbound, lead, mailboxIds: campaign.mailbox_ids,
        subject: replySubject(thread), body: classification.replyBody,
        disposition: replyDisposition(campaign.reply_mode, classification.confidence),
        resourceIds: attachResources.map((r) => r.id),
      })
      if (attachResources.length > 0 || droppedResourceIds.length > 0) {
        await logEventSafe({
          clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR,
          type: 'reply.resources_attached',
          payload: {
            emailId: inbound.id,
            resourceIds: attachResources.map((r) => r.id),
            droppedResourceIds,
          },
        })
      }
```

- [ ] **Step 7: Keep `knowledge-answer.ts` compiling**

In `src/lib/pipeline/knowledge-answer.ts`, add `resourceIds: []` to its `sendOrDraftReply` call. Task 13 replaces this with the operator's real selection.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/reply.test.ts src/lib/pipeline/knowledge-answer.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 9: Confirm the outreach paths were not touched**

Run: `grep -n "attachments\|resourceIds\|resolveAttachments" src/lib/pipeline/write.ts src/lib/pipeline/followup.ts`
Expected: no output. First-touch and follow-up emails must have no way to carry an attachment.

- [ ] **Step 10: Verify and commit**

```bash
pnpm vitest run && pnpm typecheck && pnpm lint
git add src/lib/pipeline/reply.ts src/lib/pipeline/reply.test.ts src/lib/pipeline/knowledge-answer.ts
git commit -m "feat(reply): let the agent attach resources to a reply it answers"
```

---

### Task 13: Knowledge-answer attachments

**Files:**
- Modify: `src/lib/pipeline/knowledge-answer.ts`
- Test: `src/lib/pipeline/knowledge-answer.test.ts`

**Interfaces:**
- Consumes: `sendOrDraftReply` with `resourceIds` (Task 12), `getActiveResourcesByIds` (Task 8).
- Produces: `runKnowledgeAnswer(supabase, input: { knowledgeRequestId: string; resourceIds?: readonly string[] })` — the optional field keeps existing callers valid; Task 19 passes the operator's selection.

There is no LLM selection here: the operator already chose. The prompt is told *which* files are attached so the body reads "attached are the two concepts" instead of contradicting the envelope.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/pipeline/knowledge-answer.test.ts`, adding a mock for `@/lib/db/client-resources` in the same style as the file's existing mocks:

```ts
describe('runKnowledgeAnswer attachments', () => {
  it('should pass the operator-selected resources through to the reply', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', title: 'Concept A', description: 'homepage concept' },
      { id: 'r2', title: 'Concept B', description: 'homepage concept' },
    ])

    await runKnowledgeAnswer(supabaseFixture, {
      knowledgeRequestId: 'kr1',
      resourceIds: ['r1', 'r2'],
    })

    expect(sendOrDraftReplyMock).toHaveBeenCalledWith(
      supabaseFixture,
      expect.objectContaining({ resourceIds: ['r1', 'r2'] }),
    )
  })

  it('should tell the prompt which files are attached so the body can reference them', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([
      { id: 'r1', title: 'Concept A', description: 'homepage concept' },
    ])

    await runKnowledgeAnswer(supabaseFixture, { knowledgeRequestId: 'kr1', resourceIds: ['r1'] })

    const promptArg = generateTextMock.mock.calls[0]![1] as { prompt: string }
    expect(promptArg.prompt).toContain('Concept A')
    expect(promptArg.prompt).toContain('attached')
  })

  it('should send no attachments and mention none when the operator picked none', async () => {
    await runKnowledgeAnswer(supabaseFixture, { knowledgeRequestId: 'kr1' })

    expect(getActiveResourcesByIdsMock).not.toHaveBeenCalled()
    expect(sendOrDraftReplyMock).toHaveBeenCalledWith(
      supabaseFixture,
      expect.objectContaining({ resourceIds: [] }),
    )
    const promptArg = generateTextMock.mock.calls[0]![1] as { prompt: string }
    expect(promptArg.prompt).not.toContain('attached to this email')
  })

  it('should drop an id that does not belong to this client', async () => {
    getActiveResourcesByIdsMock.mockResolvedValue([])

    await runKnowledgeAnswer(supabaseFixture, {
      knowledgeRequestId: 'kr1',
      resourceIds: ['r-foreign'],
    })

    expect(sendOrDraftReplyMock).toHaveBeenCalledWith(
      supabaseFixture,
      expect.objectContaining({ resourceIds: [] }),
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/knowledge-answer.test.ts`
Expected: FAIL — `resourceIds` is not accepted and never reaches `sendOrDraftReply`.

- [ ] **Step 3: Implement**

Add the import:

```ts
import { getActiveResourcesByIds } from '@/lib/db/client-resources'
```

Widen the signature:

```ts
export async function runKnowledgeAnswer(
  supabase: SupabaseClient<Database>,
  input: { knowledgeRequestId: string; resourceIds?: readonly string[] },
): Promise<{ knowledgeRequestId: string; action: 'sent' | 'drafted' | 'skipped' }> {
```

After the campaign lookup, resolve the operator's picks (client-scoped, so a forged id cannot resolve):

```ts
  // The operator chose these in /inbox — no LLM selection here. Re-resolved
  // against the client so a tampered form value cannot attach another
  // client's file.
  const attachResources = await getActiveResourcesByIds(
    supabase, inbound.client_id, input.resourceIds ?? [],
  )
```

Add an `attachedFiles` line to `buildAnswerPrompt`'s argument type and array:

```ts
    args.attachedFiles.length > 0
      ? `These files are attached to this email — reference them naturally, do not describe their contents: ${args.attachedFiles.join(', ')}`
      : '',
```

Pass it at the call site:

```ts
    prompt: buildAnswerPrompt({
      thread, knowledge, humanAnswer: kr.human_answer, valueProp: campaign.value_prop,
      clientKnowledge, attachedFiles: attachResources.map((r) => r.title),
    }),
```

And pass the ids to the reply:

```ts
  await sendOrDraftReply(supabase, {
    inbound, lead, mailboxIds: campaign.mailbox_ids, subject: replySubject(thread), body,
    disposition, resourceIds: attachResources.map((r) => r.id),
  })
```

Finally add the ids to the existing `reply.knowledge_answered` event payload: `resourceIds: attachResources.map((r) => r.id)`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/knowledge-answer.test.ts`
Expected: PASS, including every pre-existing test.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/pipeline/knowledge-answer.ts src/lib/pipeline/knowledge-answer.test.ts
git commit -m "feat(knowledge-answer): attach operator-selected resources to the reply"
```

---

### Task 14: Shared ownership guard

**Files:**
- Create: `src/lib/auth/can-manage-client.ts`
- Test: `src/lib/auth/can-manage-client.test.ts`

**Interfaces:**
- Consumes: `AppUser` from `@/lib/db/app-users`.
- Produces:
  - `canManageClient(appUser: AppUser, clientId: string): boolean`
  - `canManageOwnRow(appUser: AppUser, row: { client_id: string; created_by: string }): boolean`

Both new resource routes and both relaxed knowledge routes use the admin client, which bypasses RLS. **These two functions are the entire authorization boundary for client-role writes.** They live in one tested file rather than being re-typed at four call sites.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/auth/can-manage-client.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import type { AppUser } from '@/lib/db/app-users'
import { canManageClient, canManageOwnRow } from './can-manage-client'

const operator: AppUser = { id: 'op1', role: 'operator', client_id: null, created_at: '2026-01-01T00:00:00Z' }
const client: AppUser = { id: 'u1', role: 'client', client_id: 'c1', created_at: '2026-01-01T00:00:00Z' }
const otherClient: AppUser = { id: 'u2', role: 'client', client_id: 'c2', created_at: '2026-01-01T00:00:00Z' }

describe('canManageClient', () => {
  it('should allow an operator for any client', () => {
    expect(canManageClient(operator, 'c1')).toBe(true)
    expect(canManageClient(operator, 'c2')).toBe(true)
  })

  it('should allow a client user for its own client', () => {
    expect(canManageClient(client, 'c1')).toBe(true)
  })

  it('should reject a client user for another client', () => {
    expect(canManageClient(otherClient, 'c1')).toBe(false)
  })

  it('should reject a client user whose client_id is null', () => {
    expect(canManageClient({ ...client, client_id: null }, 'c1')).toBe(false)
  })
})

describe('canManageOwnRow', () => {
  const row = { client_id: 'c1', created_by: 'u1' }

  it('should allow an operator regardless of who created the row', () => {
    expect(canManageOwnRow(operator, row)).toBe(true)
  })

  it('should allow the client user who created the row', () => {
    expect(canManageOwnRow(client, row)).toBe(true)
  })

  it('should reject a client user who did not create the row', () => {
    expect(canManageOwnRow({ ...client, id: 'u9' }, row)).toBe(false)
  })

  it('should reject a client user from another client even if ids collide', () => {
    expect(canManageOwnRow({ ...otherClient, id: 'u1' }, row)).toBe(false)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/auth/can-manage-client.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

Create `src/lib/auth/can-manage-client.ts`:

```ts
import type { AppUser } from '@/lib/db/app-users'

/**
 * Whether `appUser` may create content under `clientId`.
 *
 * Routes that touch client-writable tables use createAdminClient(), which
 * bypasses RLS entirely — so this check, not the policy, is what stops a client
 * user writing into another tenant. Never skip it on such a route.
 */
export function canManageClient(appUser: AppUser, clientId: string): boolean {
  if (appUser.role === 'operator') return true
  return appUser.client_id !== null && appUser.client_id === clientId
}

/**
 * Whether `appUser` may modify or remove an existing row. Operators may touch
 * anything; a client user may only touch rows they themselves created, within
 * their own client.
 */
export function canManageOwnRow(
  appUser: AppUser,
  row: { client_id: string; created_by: string },
): boolean {
  if (appUser.role === 'operator') return true
  return canManageClient(appUser, row.client_id) && row.created_by === appUser.id
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/auth/can-manage-client.test.ts`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add src/lib/auth/can-manage-client.ts src/lib/auth/can-manage-client.test.ts
git commit -m "feat(auth): add the client-write ownership guard"
```

---

### Task 15: Widen knowledge uploads to pdf/txt/md

**Files:**
- Rename: `src/lib/storage/client-knowledge-pdfs.ts` → `src/lib/storage/client-knowledge-files.ts` (and its test)
- Modify: `src/lib/db/client-knowledge.ts` (`insertPdfSourceReady` → `insertFileSourceReady`)
- Rename: `src/app/api/clients/[clientId]/knowledge/pdf/` → `src/app/api/clients/[clientId]/knowledge/file/` (and its test)
- Modify: `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts`
- Modify: `src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx`

**Interfaces:**
- Consumes: `canManageClient` / `canManageOwnRow` (Task 14), the `'file'` enum value (Task 2), widened bucket mime types (Task 1).
- Produces:
  - `KNOWLEDGE_FILE_BUCKET`, `KNOWLEDGE_FILE_MAX_BYTES`, `ALLOWED_KNOWLEDGE_MIME_TYPES`
  - `assertValidKnowledgeFile(file: File): void`
  - `uploadClientKnowledgeFile(supabase, clientId, file): Promise<string>`
  - `extractKnowledgeText(file: File): Promise<string>`
  - `deleteClientKnowledgeFileObject`, `getClientKnowledgeFileSignedUrl` (renamed, behavior unchanged)
  - `insertFileSourceReady(supabase, input: InsertFileSourceInput)` where `InsertFileSourceInput` is the old `InsertPdfSourceInput` plus `sourceType: 'pdf' | 'file'`

- [ ] **Step 1: Write the failing tests**

Rename `src/lib/storage/client-knowledge-pdfs.test.ts` to `client-knowledge-files.test.ts`, update its imports to the new names, and add:

```ts
describe('assertValidKnowledgeFile', () => {
  it('should accept pdf, plain text and markdown', () => {
    for (const type of ['application/pdf', 'text/plain', 'text/markdown']) {
      expect(() => assertValidKnowledgeFile(new File(['x'], 'f', { type }))).not.toThrow()
    }
  })

  it('should reject an image, which belongs in resources not knowledge', () => {
    try {
      assertValidKnowledgeFile(new File(['x'], 'a.png', { type: 'image/png' }))
      expect.unreachable('should have thrown')
    } catch (error) {
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
    }
  })
})

describe('extractKnowledgeText', () => {
  it('should decode a text file directly without invoking the pdf extractor', async () => {
    const file = new File(['hello world'], 'a.txt', { type: 'text/plain' })
    await expect(extractKnowledgeText(file)).resolves.toBe('hello world')
    expect(extractPdfTextMock).not.toHaveBeenCalled()
  })

  it('should decode a markdown file directly', async () => {
    const file = new File(['# Title'], 'a.md', { type: 'text/markdown' })
    await expect(extractKnowledgeText(file)).resolves.toBe('# Title')
  })

  it('should route a pdf through the pdf extractor', async () => {
    extractPdfTextMock.mockResolvedValue('pdf text')
    const file = new File(['%PDF'], 'a.pdf', { type: 'application/pdf' })
    await expect(extractKnowledgeText(file)).resolves.toBe('pdf text')
    expect(extractPdfTextMock).toHaveBeenCalled()
  })
})
```

Mock the extractor at the top of the file:

```ts
const extractPdfTextMock = vi.fn()
vi.mock('@/lib/knowledge/pdf-extract', () => ({
  extractPdfText: (...a: unknown[]) => extractPdfTextMock(...a),
}))
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm vitest run src/lib/storage/client-knowledge-files.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Rename and widen the storage module**

```bash
git mv src/lib/storage/client-knowledge-pdfs.ts src/lib/storage/client-knowledge-files.ts
git mv src/lib/storage/client-knowledge-pdfs.test.ts src/lib/storage/client-knowledge-files.test.ts
```

In `client-knowledge-files.ts`, rename the exports and replace the PDF-only validation:

```ts
export const KNOWLEDGE_FILE_BUCKET = 'client-knowledge-pdfs'
export const KNOWLEDGE_FILE_MAX_BYTES = 10 * 1024 * 1024 // 10MB
// Text-bearing formats only. Images belong in client_resources — a resource is
// something to send, not something to answer from.
export const ALLOWED_KNOWLEDGE_MIME_TYPES: readonly string[] = [
  'application/pdf',
  'text/plain',
  'text/markdown',
]

export function assertValidKnowledgeFile(file: File): void {
  if (!ALLOWED_KNOWLEDGE_MIME_TYPES.includes(file.type)) {
    throw new AppError('VALIDATION_ERROR', 'File must be a PDF, .txt or .md', {
      contentType: file.type,
    })
  }
  if (file.size === 0) {
    throw new AppError('VALIDATION_ERROR', 'File is empty', { size: file.size })
  }
  if (file.size > KNOWLEDGE_FILE_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'File must be 10MB or smaller', { size: file.size })
  }
}

// A .txt/.md file is already text — running it through the PDF extractor would
// fail. Branching here keeps the route a single code path.
export async function extractKnowledgeText(file: File): Promise<string> {
  if (file.type === 'application/pdf') {
    return extractPdfText(await file.arrayBuffer())
  }
  return file.text()
}
```

The bucket id stays `client-knowledge-pdfs` — renaming a Supabase storage bucket means migrating every existing object, which buys nothing. The comment above the constant should say so.

Rename `uploadClientKnowledgePdf` → `uploadClientKnowledgeFile` and make the object extension follow the file rather than hard-coding `.pdf`; use `path.extname(file.name)`. Rename `deleteClientKnowledgePdfObject` → `deleteClientKnowledgeFileObject` and `getClientKnowledgePdfSignedUrl` → `getClientKnowledgeFileSignedUrl`, bodies unchanged. Delete `assertValidPdfFile`.

- [ ] **Step 4: Update the DB helper**

In `src/lib/db/client-knowledge.ts`, rename `InsertPdfSourceInput` → `InsertFileSourceInput`, add `sourceType: 'pdf' | 'file'`, and rename `insertPdfSourceReady` → `insertFileSourceReady`, replacing the hard-coded `source_type: 'pdf'` with `source_type: input.sourceType`. Update the existing tests in `client-knowledge.test.ts` for the new names, and add:

```ts
  it('should write source_type file when the upload is a text file', async () => {
    const insert = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 's1' }, error: null }) }),
    })
    const supabase = { from: () => ({ insert }) } as never

    await insertFileSourceReady(supabase, {
      clientId: 'c1', createdBy: 'u1', title: 'notes.md', storagePath: 'p',
      content: 'x', charCount: 1, sourceType: 'file',
    })

    expect(insert).toHaveBeenCalledWith(expect.objectContaining({ source_type: 'file' }))
  })
```

- [ ] **Step 5: Rename and relax the upload route**

```bash
git mv "src/app/api/clients/[clientId]/knowledge/pdf" "src/app/api/clients/[clientId]/knowledge/file"
```

In the moved `route.ts`, replace the operator gate with the ownership guard and use the new helpers:

```ts
  const { appUser } = await requireUser()
  const { clientId } = await context.params
  // Clients may curate their own knowledge; operators may curate anyone's. This
  // route uses the admin client, so RLS is not the boundary — this check is.
  if (!canManageClient(appUser, clientId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
```

Note the ordering change: `clientId` must be read from `context.params` *before* the authorization check, so move that line up. Then:

```ts
    assertValidKnowledgeFile(file)
    const storagePath = await uploadClientKnowledgeFile(admin, clientId, file)
    const content = await extractKnowledgeText(file)

    const source = await insertFileSourceReady(admin, {
      clientId, createdBy: appUser.id, title: file.name, storagePath, content,
      charCount: content.length,
      sourceType: file.type === 'application/pdf' ? 'pdf' : 'file',
    })
```

Change the event type from `knowledge.pdf_uploaded` to `knowledge.file_uploaded` and add `mimeType: file.type` to its payload.

Rename the route's test file alongside it and add:

```ts
  it('should reject a client user uploading to another client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c2' } })
    const response = await POST(requestWithFile(pdfFile), { params: Promise.resolve({ clientId: 'c1' }) })
    expect(response.status).toBe(403)
  })

  it('should accept a client user uploading to their own client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const response = await POST(requestWithFile(pdfFile), { params: Promise.resolve({ clientId: 'c1' }) })
    expect(response.status).toBe(200)
  })

  it('should reject an image, which is a resource not knowledge', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    const response = await POST(requestWithFile(pngFile), { params: Promise.resolve({ clientId: 'c1' }) })
    expect(response.status).toBe(400)
  })
```

- [ ] **Step 6: Relax the delete route**

In `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts`, delete the `appUser.role !== 'operator'` block. Move the params read above it, and after the existing `!source || source.client_id !== clientId` 404 check, add:

```ts
  // Operators may remove anything; a client user may only remove what they
  // uploaded. Checked after the 404 so a non-owner learns nothing about
  // existence beyond what the 404 already tells them.
  if (!canManageOwnRow(appUser, source)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
```

Update the storage cleanup to cover both source types and the renamed helper:

```ts
    if (source.storage_path) {
      await deleteClientKnowledgeFileObject(admin, source.storage_path)
    }
```

Add to its test file:

```ts
  it('should reject a client user deleting a source they did not upload', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u9', role: 'client', client_id: 'c1' } })
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', created_by: 'u1', source_type: 'pdf', storage_path: 'p', title: 't' })
    const response = await DELETE(new Request('http://x'), { params: Promise.resolve({ clientId: 'c1', sourceId: 's1' }) })
    expect(response.status).toBe(403)
    expect(deleteSourceMock).not.toHaveBeenCalled()
  })

  it('should allow a client user to delete their own source', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', created_by: 'u1', source_type: 'file', storage_path: 'p', title: 't' })
    const response = await DELETE(new Request('http://x'), { params: Promise.resolve({ clientId: 'c1', sourceId: 's1' }) })
    expect(response.status).toBe(200)
  })
```

- [ ] **Step 7: Update the upload component**

In `src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx`: change `accept` to `application/pdf,text/plain,text/markdown,.md`, the fetch URL to `/api/clients/${clientId}/knowledge/file`, the button label to `Upload file`, the aria-label to `Upload knowledge file`, and the success toast to `File added to the knowledge base`. Rename the file and the component to `knowledge-file-upload.tsx` / `KnowledgeFileUpload` with `git mv`, and update the import in `src/app/(app)/clients/[id]/page.tsx`.

- [ ] **Step 8: Find every remaining reference**

Run: `grep -rn "client-knowledge-pdfs\|insertPdfSourceReady\|assertValidPdfFile\|knowledge/pdf\|KnowledgePdfUpload" src/`
Expected: only the bucket-id string constant inside `client-knowledge-files.ts`. Fix anything else the grep finds.

- [ ] **Step 9: Run the full suite**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint`
Expected: all green.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat(knowledge): accept txt and md uploads, and let clients curate their own"
```

---

### Task 16: Resource API routes

**Files:**
- Create: `src/app/api/clients/[clientId]/resources/route.ts`
- Create: `src/app/api/clients/[clientId]/resources/route.test.ts`
- Create: `src/app/api/clients/[clientId]/resources/[resourceId]/route.ts`
- Create: `src/app/api/clients/[clientId]/resources/[resourceId]/route.test.ts`

**Interfaces:**
- Consumes: `canManageClient` / `canManageOwnRow` (Task 14), storage layer (Task 7), DB layer (Task 8).
- Produces: `POST /api/clients/:clientId/resources` → `{ ok: true, resource }`; `DELETE /api/clients/:clientId/resources/:resourceId` → `{ ok: true }`. Consumed by Tasks 17–18.

Model both on `src/app/api/clients/[clientId]/knowledge/file/route.ts` — same `logEventSafe` / `logError` split, same "validation errors are the uploader's problem, don't pollute the Logs tab" rule.

- [ ] **Step 1: Write the failing tests for POST**

Create `src/app/api/clients/[clientId]/resources/route.test.ts`, mocking `@/lib/auth/require-user`, `@/lib/supabase/admin`, `@/lib/db/clients`, `@/lib/storage/client-resources`, `@/lib/db/client-resources`, and `@/lib/events/log-event` in the same style the knowledge route test already uses:

```ts
function formRequest(fields: Record<string, string | File>): Request {
  const body = new FormData()
  for (const [key, value] of Object.entries(fields)) body.set(key, value)
  return new Request('http://x/api/clients/c1/resources', { method: 'POST', body })
}

const pdf = () => new File([new Uint8Array(10)], 'deck.pdf', { type: 'application/pdf' })
const params = { params: Promise.resolve({ clientId: 'c1' }) }
```

Give the mocks happy-path defaults in `beforeEach`, so each test only states the one thing it is varying:

```ts
beforeEach(() => {
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1', name: 'Acme' })
  uploadClientResourceMock.mockReset().mockResolvedValue({ storagePath: 'c1/x.pdf', fileName: 'deck.pdf' })
  insertClientResourceMock.mockReset().mockResolvedValue({ id: 'r1', title: 'Deck', byte_size: 10 })
  deleteClientResourceObjectMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/resources', () => {
  it('should create the resource when an operator uploads', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(200)
    expect(insertClientResourceMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'c1', createdBy: 'op1', title: 'Deck', description: 'examples' }),
    )
  })

  it('should create the resource when a client uploads to their own client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(200)
  })

  it('should reject a client uploading to another client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c2' } })
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(403)
    expect(uploadClientResourceMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getClientByIdMock.mockResolvedValue(null)
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(404)
  })

  it('should return 400 when the description is missing', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    const response = await POST(formRequest({ title: 'Deck', file: pdf() }), params)
    expect(response.status).toBe(400)
  })

  it('should return 400 when no file was sent', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    const response = await POST(formRequest({ title: 'Deck', description: 'examples' }), params)
    expect(response.status).toBe(400)
  })

  it('should return 400 when the file type is not allowed', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    uploadClientResourceMock.mockRejectedValue(
      new AppError('VALIDATION_ERROR', 'Unsupported file type', { contentType: 'application/x-msdownload' }),
    )
    const response = await POST(
      formRequest({ title: 'x', description: 'y', file: new File([new Uint8Array(1)], 'a.exe', { type: 'application/x-msdownload' }) }),
      params,
    )
    expect(response.status).toBe(400)
  })

  it('should remove the uploaded object when the row insert fails', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    uploadClientResourceMock.mockResolvedValue({ storagePath: 'c1/x.pdf', fileName: 'deck.pdf' })
    insertClientResourceMock.mockRejectedValue(new AppError('DB_ERROR', 'boom', {}))
    const response = await POST(formRequest({ title: 'Deck', description: 'examples', file: pdf() }), params)
    expect(response.status).toBe(500)
    expect(deleteClientResourceObjectMock).toHaveBeenCalledWith(expect.anything(), 'c1/x.pdf')
  })
})
```

- [ ] **Step 2: Run and verify it fails**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/resources/route.test.ts"`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement POST**

Create `src/app/api/clients/[clientId]/resources/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { canManageClient } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { uploadClientResource, deleteClientResourceObject } from '@/lib/storage/client-resources'
import { insertClientResource } from '@/lib/db/client-resources'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'
const ACTOR = 'resource_upload'

const bodySchema = z.object({
  title: z.string().trim().min(1).max(120),
  // Required: an undescribed resource never reaches the AI's menu, so an empty
  // description makes the upload pointless.
  description: z.string().trim().min(1).max(500),
})

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  const { clientId } = await context.params
  // This route writes with the service-role client, which bypasses RLS — this
  // check is the authorization boundary, not the policy.
  if (!canManageClient(appUser, clientId)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  let storagePath: string | null = null
  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'validation_error', issues: 'file is required' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse({
      title: formData.get('title'),
      description: formData.get('description'),
    })
    if (!parsed.success) {
      return NextResponse.json(
        { error: 'validation_error', issues: parsed.error.issues[0]?.message ?? 'invalid input' },
        { status: 400 },
      )
    }

    const uploaded = await uploadClientResource(admin, clientId, file)
    storagePath = uploaded.storagePath

    const resource = await insertClientResource(admin, {
      clientId,
      createdBy: appUser.id,
      title: parsed.data.title,
      description: parsed.data.description,
      fileName: uploaded.fileName,
      mimeType: file.type,
      byteSize: file.size,
      storagePath: uploaded.storagePath,
    })

    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'resource.uploaded',
      payload: { resourceId: resource.id, title: resource.title, byteSize: resource.byte_size },
    })

    return NextResponse.json({ ok: true, resource })
  } catch (error) {
    // The object is already in the bucket but has no row pointing at it, so
    // nothing will ever reference or clean it up. Remove it best-effort.
    if (storagePath) await deleteClientResourceObject(admin, storagePath)

    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    // Only the non-validation branch is logged — a rejected file is the
    // uploader's problem to fix, not a fault worth surfacing in the Logs tab.
    await logError({
      clientId, actor: `human:${appUser.id}`, type: 'resource.upload_route_failed',
      source: 'app', error,
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

Note `ACTOR` is declared for symmetry with the knowledge route but only used if you add a second event — if `pnpm lint` flags it as unused, delete the constant rather than silencing the rule.

- [ ] **Step 4: Write the failing tests for DELETE**

Create `src/app/api/clients/[clientId]/resources/[resourceId]/route.test.ts`:

```ts
const params = { params: Promise.resolve({ clientId: 'c1', resourceId: 'r1' }) }
const resource = { id: 'r1', client_id: 'c1', created_by: 'u1', storage_path: 'c1/x.pdf', title: 'Deck' }

describe('DELETE /api/clients/[clientId]/resources/[resourceId]', () => {
  it('should soft delete and remove the object when an operator deletes', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)

    const response = await DELETE(new Request('http://x'), params)

    expect(response.status).toBe(200)
    expect(deactivateClientResourceMock).toHaveBeenCalledWith(expect.anything(), 'r1')
    expect(deleteClientResourceObjectMock).toHaveBeenCalledWith(expect.anything(), 'c1/x.pdf')
  })

  it('should allow the client user who uploaded it', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(resource)
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(200)
  })

  it('should reject a client user who did not upload it', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u9', role: 'client', client_id: 'c1' } })
    getResourceByIdMock.mockResolvedValue(resource)
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(403)
    expect(deactivateClientResourceMock).not.toHaveBeenCalled()
  })

  it('should 404 when the resource belongs to another client', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getResourceByIdMock.mockResolvedValue({ ...resource, client_id: 'c2' })
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(404)
  })

  it('should not remove the object twice when the row was already deactivated', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getResourceByIdMock.mockResolvedValue(resource)
    deactivateClientResourceMock.mockResolvedValue(null)
    const response = await DELETE(new Request('http://x'), params)
    expect(response.status).toBe(200)
    expect(deleteClientResourceObjectMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 5: Implement DELETE**

Create `src/app/api/clients/[clientId]/resources/[resourceId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { canManageOwnRow } from '@/lib/auth/can-manage-client'
import { createAdminClient } from '@/lib/supabase/admin'
import { getResourceById, deactivateClientResource } from '@/lib/db/client-resources'
import { deleteClientResourceObject } from '@/lib/storage/client-resources'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ clientId: string; resourceId: string }> },
) {
  const { appUser } = await requireUser()
  const { clientId, resourceId } = await context.params

  const admin = createAdminClient()
  const resource = await getResourceById(admin, resourceId)
  // Cross-client mismatch returns the same 404 as "not found" — no existence leak.
  if (!resource || resource.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  // Operators may remove anything; a client user only what they uploaded.
  if (!canManageOwnRow(appUser, resource)) {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    // Soft delete: emails already sent still reference this row, and the
    // RESTRICT FK on email_attachments would reject a hard delete anyway.
    const deactivated = await deactivateClientResource(admin, resourceId)
    // null means a concurrent delete already won — do not remove the object a
    // second time.
    if (deactivated) {
      await deleteClientResourceObject(admin, resource.storage_path)
      await logEventSafe({
        clientId, actor: `human:${appUser.id}`, type: 'resource.deleted',
        payload: { resourceId, title: resource.title },
      })
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    await logError({
      clientId, actor: `human:${appUser.id}`, type: 'resource.delete_route_failed',
      source: 'app', error, payload: { resourceId },
    })
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 6: Run both route suites**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/resources"`
Expected: PASS, 13 tests.

- [ ] **Step 7: Verify and commit**

```bash
pnpm typecheck && pnpm lint
git add "src/app/api/clients/[clientId]/resources"
git commit -m "feat(api): add resource upload and soft-delete routes"
```

---

### Task 17: Resource UI components

**Files:**
- Create: `src/lib/format/bytes.ts`, `src/lib/format/bytes.test.ts`
- Create: `src/components/resource-upload.tsx`
- Create: `src/components/resource-list.tsx`
- Create: `src/components/resource-picker.tsx`

**Interfaces:**
- Consumes: the routes from Task 16, `MAX_ATTACHMENTS_PER_EMAIL` / `MAX_TOTAL_ATTACHMENT_BYTES` (Task 3).
- Produces:
  - `formatBytes(bytes: number): string`
  - `interface ResourceSummary { id: string; clientId: string; title: string; description: string; fileName: string; mimeType: string; byteSize: number; canManage: boolean }`
  - `<ResourceUpload clientId={string} />`
  - `<ResourceList resources={ResourceSummary[]} clientNameById?={Record<string, string>} />` — no `clientId` prop: each row carries its own `clientId`, which is what the operator's cross-client view needs and what the delete URL is built from
  - `<ResourcePicker resources={ResourceSummary[]} name={string} defaultSelectedIds?={readonly string[]} onSelectionChange?={(ids: string[]) => void} />` — renders hidden inputs named `name` carrying the selected ids, so it composes with a plain `<form action={serverAction}>`

`ResourceSummary` is declared in `src/components/resource-list.tsx` and imported by the other two. Full source for `ResourceList` and `ResourcePicker` is in **Appendix A** — write them from there, not from the prose.

- [ ] **Step 1: Write the failing byte-format tests**

Create `src/lib/format/bytes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { formatBytes } from './bytes'

describe('formatBytes', () => {
  it('should render bytes below a kilobyte as B', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
  })

  it('should render kilobytes without a decimal', () => {
    expect(formatBytes(1024)).toBe('1 KB')
    expect(formatBytes(1536)).toBe('2 KB')
  })

  it('should render megabytes with one decimal', () => {
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB')
    expect(formatBytes(2.7 * 1024 * 1024)).toBe('2.7 MB')
  })
})
```

- [ ] **Step 2: Run it, verify it fails, implement**

Run: `pnpm vitest run src/lib/format/bytes.test.ts` → FAIL (module not found).

Create `src/lib/format/bytes.ts`:

```ts
const KB = 1024
const MB = KB * 1024

// Sizes are shown next to a 3MB budget, so MB needs one decimal to make the
// running total legible; anything smaller reads better as a whole number.
export function formatBytes(bytes: number): string {
  if (bytes < KB) return `${bytes} B`
  if (bytes < MB) return `${Math.round(bytes / KB)} KB`
  return `${(bytes / MB).toFixed(1)} MB`
}
```

Run again → PASS, 3 tests.

- [ ] **Step 3: Build `ResourceUpload`**

Create `src/components/resource-upload.tsx`, modelled on `knowledge-file-upload.tsx` (its `extractErrorMessage` helper, its `UploadState` discriminated union, its toast + `router.refresh()` pattern) but with a small form rather than a bare file input, because title and description are required:

```tsx
'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Paperclip } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { ALLOWED_RESOURCE_MIME_TYPES } from '@/lib/storage/client-resources'

type UploadState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface ResourceUploadProps {
  clientId: string
}

async function extractErrorMessage(res: Response, fallback: string): Promise<string> {
  const json: unknown = await res.json().catch(() => ({}))
  if (typeof json === 'object' && json !== null && 'issues' in json) {
    const issues = (json as { issues: unknown }).issues
    if (typeof issues === 'string') return issues
  }
  if (typeof json === 'object' && json !== null && 'error' in json) return String((json as { error: unknown }).error)
  return fallback
}

export function ResourceUpload({ clientId }: ResourceUploadProps): React.ReactElement {
  const router = useRouter()
  const formRef = useRef<HTMLFormElement>(null)
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault()
    const formData = new FormData(event.currentTarget)
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/resources`, { method: 'POST', body: formData })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not upload the file.')
        setState({ status: 'error', message })
        toast.error('Upload failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      formRef.current?.reset()
      toast.success('Resource added', { description: 'The agent can now send this when a lead asks.' })
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Upload failed', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form
      ref={formRef}
      onSubmit={(event) => void onSubmit(event)}
      className="border-hairline flex flex-col gap-3 rounded-lg border p-4"
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="resource-title" className="text-xs">Title</Label>
        <Input id="resource-title" name="title" required maxLength={120} placeholder="2026 portfolio deck" />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="resource-description" className="text-xs">
          When should the agent send this?
        </Label>
        <Textarea
          id="resource-description"
          name="description"
          required
          maxLength={500}
          rows={2}
          placeholder="12 recent brand projects — send when a lead asks to see examples."
        />
        <p className="text-faint text-[11px]">
          This is the only thing the agent knows about the file. Be specific about when to send it.
        </p>
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="resource-file" className="text-xs">File (max 3MB)</Label>
        <Input
          id="resource-file"
          name="file"
          type="file"
          required
          accept={ALLOWED_RESOURCE_MIME_TYPES.join(',')}
        />
      </div>
      {state.status === 'error' ? (
        <p role="alert" className="text-[11px]" style={{ color: 'var(--status-lost)' }}>
          {state.message}
        </p>
      ) : null}
      <Button type="submit" size="sm" disabled={isSubmitting} className="self-start">
        <Paperclip size={14} weight="light" />
        {isSubmitting ? 'Uploading…' : 'Add resource'}
      </Button>
    </form>
  )
}
```

If `@/components/ui/input` does not exist in this repo, use whatever the existing forms use (check `src/app/(app)/campaigns/` for the established input component) rather than adding a new one.

- [ ] **Step 4: Build `ResourceList`**

Create `src/components/resource-list.tsx` from the source in **Appendix A.1**. It declares the shared `ResourceSummary` type and handles all four states: empty (`EmptyState`), success, per-row deleting (button disabled), and per-row error (toast, row restored).

- [ ] **Step 5: Build `ResourcePicker`**

Create `src/components/resource-picker.tsx` from the source in **Appendix A.2**. The budget logic there is the part worth reading closely: an unselected row is disabled when selecting it would breach either cap, a selected row is never disabled so a choice is always reversible, and the component returns `null` when there are no resources so a client with no library sees no dead control.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run && pnpm typecheck && pnpm lint
git add src/lib/format src/components/resource-upload.tsx src/components/resource-list.tsx src/components/resource-picker.tsx
git commit -m "feat(ui): add resource upload, list and picker components"
```

---

### Task 18: Knowledge tabs and the two new sub-routes

**Files:**
- Create: `src/app/(app)/knowledge/knowledge-tabs.tsx`
- Create: `src/app/(app)/knowledge/sources/page.tsx`, `loading.tsx`, `error.tsx`
- Create: `src/app/(app)/knowledge/resources/page.tsx`, `loading.tsx`, `error.tsx`
- Modify: `src/app/(app)/knowledge/page.tsx`

**Interfaces:**
- Consumes: `listSourcesForClient` / a new RLS-scoped list (Task 15's module), `listActiveResourcesForVisibleClients` (Task 8), the components from Task 17, `canManageOwnRow` (Task 14).
- Produces: three routes sharing one tab strip.

Copy `loading.tsx` and `error.tsx` from `src/app/(app)/knowledge/` — they already exist for the facts page and the new ones should match, only changing the copy.

- [ ] **Step 1: Build the tab strip**

Create `src/app/(app)/knowledge/knowledge-tabs.tsx` — a `'use client'` component using `usePathname()`, rendering three `next/link` tabs (`/knowledge` "Facts", `/knowledge/sources` "Sources", `/knowledge/resources` "Resources") with the same active/inactive treatment `src/components/shell/nav.tsx` uses. Exact-match `/knowledge`; prefix-match the other two.

Render it directly under `<PageHeader>` on all three pages.

- [ ] **Step 2: Add an RLS-scoped source list**

In `src/lib/db/client-knowledge.ts`, add alongside `listSourcesForClient`:

```ts
// No client filter: RLS decides what the caller sees. Pass a session-bound
// server client — an operator gets every client's sources, a client-role
// session only its own.
export async function listSourcesForVisibleClients(
  supabase: SupabaseClient<Database>,
): Promise<KnowledgeSourceRow[]> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new AppError('DB_ERROR', 'Failed to list knowledge sources', { cause: error.message })
  return data ?? []
}
```

Add a test for it in `client-knowledge.test.ts` covering the success shape and the `DB_ERROR` branch.

- [ ] **Step 3: Build `/knowledge/sources`**

`page.tsx` is a Server Component that calls `requireUser()` and `createServerClient()`, then `listSourcesForVisibleClients(supabase)` and `listClientNames(supabase)` (add that to `src/lib/db/clients.ts` if it does not exist — `select('id, name')`, RLS-scoped, same pattern as `listCaseCompanyNames`). It renders:

- `<PageHeader title="Knowledge sources" description="Pages and files the agent reads to answer better. These are never sent to a lead." />`
- `<KnowledgeTabs />`
- the upload control **only when** `appUser.role === 'client' && appUser.client_id !== null`, passing that `client_id` — an operator has no single client to scope an upload to and uploads from `/clients/[id]` instead
- the source list, each row showing title, type, char count, client name (operators only), and a delete button when `canManageOwnRow(appUser, source)` is true

Reuse `src/app/(app)/clients/[id]/knowledge-sources-list.tsx` if it can take a `canManage` predicate per row; otherwise write a sibling list component here rather than contorting the existing one.

- [ ] **Step 4: Build `/knowledge/resources`**

Same shape:

- `<PageHeader title="Resources" description="Files the agent can send to a lead who asks to see something. These are never used to answer questions." />`
- `<KnowledgeTabs />`
- `<ResourceUpload clientId={appUser.client_id} />` only for a client-role user with a non-null `client_id`
- `<ResourceList resources={…} clientNameById={…} />`, mapping each row to `ResourceSummary` with `canManage: canManageOwnRow(appUser, row)`

Data comes from `listActiveResourcesForVisibleClients(supabase, 200)`.

The two description strings above are the whole user-facing explanation of the knowledge/resource split. Keep them verbatim.

- [ ] **Step 5: Add the tab strip to the facts page**

In `src/app/(app)/knowledge/page.tsx`, render `<KnowledgeTabs />` directly below `<PageHeader>`, above the existing filter row. Nothing else on that page changes.

- [ ] **Step 6: Verify and commit**

```bash
pnpm vitest run && pnpm typecheck && pnpm lint && pnpm build
git add "src/app/(app)/knowledge" src/lib/db/client-knowledge.ts src/lib/db/client-knowledge.test.ts src/lib/db/clients.ts
git commit -m "feat(knowledge): add sources and resources tabs to /knowledge"
```

`pnpm build` is included here because this is the first task that adds new App Router routes — a missing `loading.tsx`/`error.tsx` or a Server/Client boundary mistake shows up at build time, not in Vitest.

---

### Task 19: Resources section on the client detail page

**Files:**
- Create: `src/app/(app)/clients/[id]/resources-section.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `listActiveResourcesForClient` (Task 8), `ResourceUpload` / `ResourceList` (Task 17).
- Produces: nothing consumed elsewhere.

- [ ] **Step 1: Build the section**

Create `src/app/(app)/clients/[id]/resources-section.tsx` — a Server Component taking `clientId`, calling `listActiveResourcesForClient(admin, clientId, 200)`, and rendering a section header ("Resources — files the agent can send to a lead who asks to see something"), `<ResourceUpload clientId={clientId} />`, and `<ResourceList resources={…} />` where every row is mapped to a `ResourceSummary` with `clientId` set and `canManage: true` (this page is operator-only, and operators manage everything). No `clientNameById` here — the page is already scoped to one client.

Match the surrounding sections in `page.tsx` for heading level, spacing and card treatment — read it first rather than inventing a new visual language.

- [ ] **Step 2: Mount it**

In `src/app/(app)/clients/[id]/page.tsx`, render `<ResourcesSection clientId={id} />` immediately after the existing knowledge-sources section.

- [ ] **Step 3: Verify and commit**

```bash
pnpm typecheck && pnpm lint && pnpm build
git add "src/app/(app)/clients/[id]"
git commit -m "feat(clients): add a Resources section to the client detail page"
```

---

### Task 20: Inbox — attach on answer, edit on draft

**Files:**
- Create: `src/lib/knowledge/ingest-file.ts`, `src/lib/knowledge/ingest-file.test.ts`
- Modify: `src/app/api/clients/[clientId]/knowledge/file/route.ts` (use the new helper)
- Modify: `src/app/(app)/inbox/actions.ts`
- Modify: `src/app/(app)/inbox/knowledge-request-row.tsx`
- Modify: `src/app/(app)/inbox/draft-row.tsx`
- Modify: `src/app/(app)/inbox/page.tsx`
- Test: `src/app/(app)/inbox/actions.test.ts`

**Interfaces:**
- Consumes: `runKnowledgeAnswer` with `resourceIds` (Task 13), `listAttachmentsForEmail` / `replaceEmailAttachments` (Task 9), `loadResourceAttachments` (Task 11), `listActiveResourcesForClient` (Task 8), `ResourcePicker` (Task 17), knowledge file helpers (Task 15).
- Produces:
  - `ingestKnowledgeFile(supabase, input: { clientId; createdBy; file: File; actor: string }): Promise<KnowledgeSourceRow>`
  - `updateDraftAttachments(formData: FormData): Promise<void>` — Server Action

- [ ] **Step 1: Extract the knowledge ingest helper**

The upload route and the knowledge-request answer both need "file → storage → text → source row → chunks". Write it once.

Create `src/lib/knowledge/ingest-file.test.ts` first:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const uploadClientKnowledgeFileMock = vi.fn()
const extractKnowledgeTextMock = vi.fn()
vi.mock('@/lib/storage/client-knowledge-files', () => ({
  uploadClientKnowledgeFile: (...a: unknown[]) => uploadClientKnowledgeFileMock(...a),
  extractKnowledgeText: (...a: unknown[]) => extractKnowledgeTextMock(...a),
  assertValidKnowledgeFile: vi.fn(),
}))
const insertFileSourceReadyMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
vi.mock('@/lib/db/client-knowledge', () => ({
  insertFileSourceReady: (...a: unknown[]) => insertFileSourceReadyMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
}))

import { ingestKnowledgeFile } from './ingest-file'

const supabase = {} as never

beforeEach(() => {
  uploadClientKnowledgeFileMock.mockReset().mockResolvedValue('c1/x.pdf')
  extractKnowledgeTextMock.mockReset().mockResolvedValue('extracted text')
  insertFileSourceReadyMock.mockReset().mockResolvedValue({ id: 's1' })
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
})

describe('ingestKnowledgeFile', () => {
  it('should upload, extract, insert and embed in that order', async () => {
    const file = new File(['x'], 'notes.md', { type: 'text/markdown' })
    const result = await ingestKnowledgeFile(supabase, {
      clientId: 'c1', createdBy: 'u1', file, actor: 'test',
    })

    expect(result).toEqual({ id: 's1' })
    expect(insertFileSourceReadyMock).toHaveBeenCalledWith(supabase, {
      clientId: 'c1', createdBy: 'u1', title: 'notes.md', storagePath: 'c1/x.pdf',
      content: 'extracted text', charCount: 'extracted text'.length, sourceType: 'file',
    })
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(supabase, {
      clientId: 'c1', sourceId: 's1', content: 'extracted text', actor: 'test',
    })
  })

  it('should record a pdf upload as source_type pdf', async () => {
    const file = new File(['x'], 'deck.pdf', { type: 'application/pdf' })
    await ingestKnowledgeFile(supabase, { clientId: 'c1', createdBy: 'u1', file, actor: 'test' })
    expect(insertFileSourceReadyMock).toHaveBeenCalledWith(
      supabase, expect.objectContaining({ sourceType: 'pdf' }),
    )
  })
})
```

Then create `src/lib/knowledge/ingest-file.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import {
  assertValidKnowledgeFile, uploadClientKnowledgeFile, extractKnowledgeText,
} from '@/lib/storage/client-knowledge-files'
import { insertFileSourceReady, embedAndStoreChunks, type KnowledgeSourceRow } from '@/lib/db/client-knowledge'

export interface IngestKnowledgeFileInput {
  clientId: string
  createdBy: string
  file: File
  actor: string
}

/**
 * file → storage → text → source row → embedded chunks.
 *
 * Everything happens inline: unlike a website page's Brightdata scrape there is
 * no network dependency to defer to QStash, so the row is created already
 * 'ready' and there is no pending window to show.
 */
export async function ingestKnowledgeFile(
  supabase: SupabaseClient<Database>,
  input: IngestKnowledgeFileInput,
): Promise<KnowledgeSourceRow> {
  assertValidKnowledgeFile(input.file)
  const storagePath = await uploadClientKnowledgeFile(supabase, input.clientId, input.file)
  const content = await extractKnowledgeText(input.file)

  const source = await insertFileSourceReady(supabase, {
    clientId: input.clientId,
    createdBy: input.createdBy,
    title: input.file.name,
    storagePath,
    content,
    charCount: content.length,
    sourceType: input.file.type === 'application/pdf' ? 'pdf' : 'file',
  })
  await embedAndStoreChunks(supabase, {
    clientId: input.clientId, sourceId: source.id, content, actor: input.actor,
  })
  return source
}
```

Then replace that block in `src/app/api/clients/[clientId]/knowledge/file/route.ts` with a single `ingestKnowledgeFile` call. Its tests from Task 15 must still pass unchanged.

- [ ] **Step 2: Write the failing Server Action tests**

Add to `src/app/(app)/inbox/actions.test.ts` (create it following the mocking style of the route tests if it does not exist):

```ts
describe('answerKnowledgeRequest with attachments', () => {
  it('should pass the selected resource ids to the answer pipeline', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    claimKnowledgeRequestAnswerMock.mockResolvedValue({ id: 'kr1', client_id: 'c1', case_id: 'case1' })

    const formData = new FormData()
    formData.set('knowledgeRequestId', KR_UUID)
    formData.set('answer', 'Yes, here they are.')
    formData.append('resourceIds', 'r1')
    formData.append('resourceIds', 'r2')

    await answerKnowledgeRequest(formData)

    expect(runKnowledgeAnswerMock).toHaveBeenCalledWith(expect.anything(), {
      knowledgeRequestId: 'kr1', resourceIds: ['r1', 'r2'],
    })
  })

  it('should ingest an attached knowledge file before writing the reply', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    claimKnowledgeRequestAnswerMock.mockResolvedValue({ id: 'kr1', client_id: 'c1', case_id: 'case1' })

    const formData = new FormData()
    formData.set('knowledgeRequestId', KR_UUID)
    formData.set('answer', 'See attached notes.')
    formData.set('knowledgeFile', new File(['notes'], 'notes.md', { type: 'text/markdown' }))

    await answerKnowledgeRequest(formData)

    expect(ingestKnowledgeFileMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ clientId: 'c1', createdBy: 'op1' }),
    )
    expect(ingestKnowledgeFileMock.mock.invocationCallOrder[0]!)
      .toBeLessThan(runKnowledgeAnswerMock.mock.invocationCallOrder[0]!)
  })

  it('should still send the answer when ingesting the knowledge file fails', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    claimKnowledgeRequestAnswerMock.mockResolvedValue({ id: 'kr1', client_id: 'c1', case_id: 'case1' })
    ingestKnowledgeFileMock.mockRejectedValue(new Error('embedding down'))

    const formData = new FormData()
    formData.set('knowledgeRequestId', KR_UUID)
    formData.set('answer', 'See attached notes.')
    formData.set('knowledgeFile', new File(['notes'], 'notes.md', { type: 'text/markdown' }))

    await answerKnowledgeRequest(formData)

    expect(runKnowledgeAnswerMock).toHaveBeenCalled()
  })

  it('should ignore an empty file input', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    claimKnowledgeRequestAnswerMock.mockResolvedValue({ id: 'kr1', client_id: 'c1', case_id: 'case1' })

    const formData = new FormData()
    formData.set('knowledgeRequestId', KR_UUID)
    formData.set('answer', 'No file today.')
    formData.set('knowledgeFile', new File([], '', { type: 'application/octet-stream' }))

    await answerKnowledgeRequest(formData)

    expect(ingestKnowledgeFileMock).not.toHaveBeenCalled()
  })
})

describe('updateDraftAttachments', () => {
  it('should replace the attachment set on a draft', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getEmailByIdMock.mockResolvedValue({ id: 'e1', client_id: 'c1', status: 'draft', direction: 'outbound' })

    const formData = new FormData()
    formData.set('emailId', EMAIL_UUID)
    formData.append('resourceIds', 'r1')

    await updateDraftAttachments(formData)

    expect(replaceEmailAttachmentsMock).toHaveBeenCalledWith(expect.anything(), {
      clientId: 'c1', emailId: 'e1', resourceIds: ['r1'],
    })
  })

  it('should reject a non-operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
    const formData = new FormData()
    formData.set('emailId', EMAIL_UUID)
    await expect(updateDraftAttachments(formData)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('should reject an email that is no longer a draft', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getEmailByIdMock.mockResolvedValue({ id: 'e1', client_id: 'c1', status: 'sent', direction: 'outbound' })
    const formData = new FormData()
    formData.set('emailId', EMAIL_UUID)
    await expect(updateDraftAttachments(formData)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})

describe('approveDraft attachments', () => {
  it('should send the attachment set recorded against the draft', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getEmailByIdMock.mockResolvedValue({
      id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'l1',
      subject: 'Re: Hi', body: 'Here you go', status: 'draft', direction: 'outbound',
      sequence_step: null, in_reply_to_email_id: 'inb1',
    })
    listAttachmentsForEmailMock.mockResolvedValue([{ resourceId: 'r1' }])
    const attachments = [{ fileName: 'a.pdf', mimeType: 'application/pdf', content: Buffer.from('X') }]
    loadResourceAttachmentsMock.mockResolvedValue(attachments)

    await approveDraft(formDataWith({ emailId: EMAIL_UUID }))

    expect(loadResourceAttachmentsMock).toHaveBeenCalledWith(expect.anything(), 'c1', ['r1'])
    expect(sendViaMailboxMock).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ attachments }),
    )
  })

  it('should mark the draft failed when an attachment cannot be loaded', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'op1', role: 'operator', client_id: null } })
    getEmailByIdMock.mockResolvedValue({
      id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'l1',
      subject: 'Re: Hi', body: 'Here you go', status: 'draft', direction: 'outbound',
      sequence_step: null, in_reply_to_email_id: 'inb1',
    })
    listAttachmentsForEmailMock.mockResolvedValue([{ resourceId: 'r1' }])
    loadResourceAttachmentsMock.mockRejectedValue(new Error('storage gone'))

    await expect(approveDraft(formDataWith({ emailId: EMAIL_UUID }))).rejects.toThrow('storage gone')
    expect(markEmailFailedMock).toHaveBeenCalledWith(expect.anything(), 'e1')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run and verify they fail**

Run: `pnpm vitest run "src/app/(app)/inbox/actions.test.ts"`
Expected: FAIL — `updateDraftAttachments` is not exported and the resource fields are ignored.

- [ ] **Step 4: Extend `answerKnowledgeRequest`**

Widen the schema and read the multi-valued field:

```ts
const answerSchema = z.object({
  knowledgeRequestId: z.string().uuid(),
  answer: z.string().min(1),
  resourceIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_EMAIL).default([]),
})
```

```ts
  const { knowledgeRequestId, answer, resourceIds } = answerSchema.parse({
    knowledgeRequestId: formData.get('knowledgeRequestId'),
    answer: formData.get('answer'),
    resourceIds: formData.getAll('resourceIds'),
  })
```

After the existing `insertKnowledge(...)` call and before `runKnowledgeAnswer`, ingest an attached knowledge file if one was sent:

```ts
  // Optional: the operator handed the agent a file to learn from. Best-effort —
  // a failed ingest must not block the reply the prospect is waiting on, and the
  // operator's typed answer already carries the fact.
  const knowledgeFile = formData.get('knowledgeFile')
  if (knowledgeFile instanceof File && knowledgeFile.size > 0) {
    try {
      await ingestKnowledgeFile(supabase, {
        clientId: kr.client_id, createdBy: appUser.id, file: knowledgeFile, actor: ACTOR,
      })
    } catch (error) {
      await logEventSafe({
        clientId: kr.client_id, caseId: kr.case_id, actor: ACTOR,
        type: 'inbox.knowledge_file_ingest_failed',
        payload: {
          knowledgeRequestId: kr.id,
          cause: error instanceof Error ? error.message : String(error),
        },
      })
    }
  }
```

Declare `const ACTOR = 'inbox_answer_knowledge_request'` at module scope. Then pass the ids through:

```ts
  await runKnowledgeAnswer(supabase, { knowledgeRequestId: kr.id, resourceIds })
```

- [ ] **Step 5: Add `updateDraftAttachments`**

```ts
const updateAttachmentsSchema = z.object({
  emailId: z.string().uuid(),
  resourceIds: z.array(z.string().uuid()).max(MAX_ATTACHMENTS_PER_EMAIL).default([]),
})

// Lets an operator correct what the agent chose before approving. Only ever
// touches a draft — once queued or sent, the set is history.
export async function updateDraftAttachments(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    throw new AppError('UNAUTHORIZED', 'Only operators can edit draft attachments', { userId: appUser.id })
  }
  const { emailId, resourceIds } = updateAttachmentsSchema.parse({
    emailId: formData.get('emailId'),
    resourceIds: formData.getAll('resourceIds'),
  })

  const supabase = createAdminClient()
  const email = await getEmailById(supabase, emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not an editable draft', { emailId })
  }

  await replaceEmailAttachments(supabase, {
    clientId: email.client_id, emailId: email.id, resourceIds,
  })
  revalidatePath('/inbox')
}
```

- [ ] **Step 6: Give `approveDraft` its attachments**

Inside the existing `try` that wraps `sendViaMailbox`, load from the DB rather than from any form state — the database is the source of truth for what goes out:

```ts
  try {
    const recorded = await listAttachmentsForEmail(supabase, email.id)
    const attachments = await loadResourceAttachments(
      supabase, email.client_id, recorded.map((a) => a.resourceId),
    )
    const sent = await sendViaMailbox(supabase, {
      clientId: email.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: email.subject,
      body: email.body,
      purpose: email.in_reply_to_email_id ? 'reply' : 'outreach',
      attachments,
    })
```

The existing catch already marks the email failed and rethrows, so a storage failure is handled without further change.

- [ ] **Step 7: Wire the two rows**

`src/app/(app)/inbox/page.tsx` already loads drafts and open knowledge requests. Add, in the same `Promise.all`:

- `listActiveResourcesForClient` per distinct `client_id` across the rows — or, simpler and adequate here, `listActiveResourcesForVisibleClients(supabase, 200)` once and group by `client_id` in the page. Pass each row only its own client's resources.
- `listAttachmentsForEmail` for each draft. Drafts on this page are few (they are the human-approval queue), so a `Promise.all` over them is fine; if the count is unbounded in practice, add `listAttachmentsForEmails(supabase, emailIds)` to `src/lib/db/email-attachments.ts` with an `.in('email_id', emailIds)` and group in memory. Prefer the batched version.

`knowledge-request-row.tsx`: below the answer `<Textarea>`, add
`<ResourcePicker resources={resources} name="resourceIds" />` under a "Attach resources — sent to the lead" label, and a `<input type="file" name="knowledgeFile" accept="application/pdf,text/plain,text/markdown,.md" />` under "Add knowledge — teaches the agent". Both optional. Give the file input `toolparamdescription="Optional. A file the agent should learn from. Not sent to the lead."` and the picker's hidden inputs no `toolparamdescription` — they are machine-set. The existing `toolname` / `tooldescription` on the form stay; extend `tooldescription` to mention that resources may be attached.

`draft-row.tsx`: add an `attachments: { resourceId: string; title: string; byteSize: number }[]` prop and a `resources: ResourceSummary[]` prop. Render the current set with a remove control per item and an "Add from library" disclosure wrapping `<ResourcePicker … defaultSelectedIds={attachments.map(a => a.resourceId)} />` inside its own `<form action={updateDraftAttachments}>` with a hidden `emailId`. Keep it a separate form from the approve button so editing attachments never submits the send. Show the running `2.7 / 3.0 MB` counter from the picker.

- [ ] **Step 8: Run everything**

Run: `pnpm vitest run && pnpm typecheck && pnpm lint && pnpm build`
Expected: all green.

- [ ] **Step 9: Commit**

```bash
git add src/lib/knowledge/ingest-file.ts src/lib/knowledge/ingest-file.test.ts "src/app/api/clients/[clientId]/knowledge/file" "src/app/(app)/inbox"
git commit -m "feat(inbox): attach resources and knowledge files when answering, edit draft attachments"
```

---

### Task 21: Documentation and final verification

**Files:**
- Modify: `.claude/architecture.md`
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: everything.
- Produces: nothing.

- [ ] **Step 1: Correct architecture §11**

`.claude/architecture.md` §11 states clients are read-only. That is no longer true. Rewrite the relevant lines to say: client-role sessions may insert `client_knowledge_sources` and `client_resources` for their own `client_id`, and may update or delete only rows where `created_by` matches their own user id; every other table remains read-only for clients. Add a sentence noting that the routes serving those writes use the service-role client, so `src/lib/auth/can-manage-client.ts` — not RLS — is the enforcement point.

Also add a row to the component table for `client_resources` pointing at `src/lib/db/client-resources.ts` and `src/lib/resources/menu.ts`, described as sendable collateral that is explicitly outside the knowledge/embedding path.

- [ ] **Step 2: Update the roadmap**

In `.claude/roadmap.md`, change the "AI Resources" section header from "(spec approved 2026-07-26)" to "(shipped 2026-07-26)", replace "Not yet implemented" with the plan path, and add a short "what landed" list: the two tables, the 3-provider attachment plumbing, ordinal-based selection in `reply.ts`, the widened knowledge uploads, and the client-writable RLS reversal.

- [ ] **Step 3: Full verification**

```bash
pnpm vitest run
pnpm typecheck
pnpm lint
pnpm build
```

All four must be clean. Record the test count in the commit message.

- [ ] **Step 4: Confirm the invariants hold**

```bash
grep -rn "attachments" src/lib/pipeline/write.ts src/lib/pipeline/followup.ts
grep -rn "client_resources" src/lib/knowledge/client-context.ts src/lib/db/client-knowledge.ts
```

Both must return nothing: outreach never attaches, and resources never enter the embedding path. If either prints a line, the core separation this feature is built on has been violated — fix it before committing.

- [ ] **Step 5: Commit**

```bash
git add .claude/architecture.md .claude/roadmap.md
git commit -m "docs: record AI resources and the client-writable RLS change"
```

---

## Verification Summary

| Gate | Command |
|---|---|
| Unit + integration tests | `pnpm vitest run` |
| Types | `pnpm typecheck` |
| Lint | `pnpm lint` |
| Route/boundary correctness | `pnpm build` |
| Outreach never attaches | `grep -rn "attachments" src/lib/pipeline/write.ts src/lib/pipeline/followup.ts` → empty |
| Resources never become knowledge | `grep -rn "client_resources" src/lib/knowledge/client-context.ts` → empty |

---

## Appendix A — Component source

There is no `checkbox` primitive in `src/components/ui/` (only avatar, badge, button, card, dialog, dropdown-menu, input, label, scroll-area, select, separator, skeleton, sonner, table, tabs, textarea, tooltip), so both components below use a native `<input type="checkbox">` styled with Tailwind rather than introducing a new primitive.

### A.1 `src/components/resource-list.tsx`

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Paperclip, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { formatBytes } from '@/lib/format/bytes'

export interface ResourceSummary {
  id: string
  clientId: string
  title: string
  description: string
  fileName: string
  mimeType: string
  byteSize: number
  /** Whether the viewing user may remove this row (operator, or its uploader). */
  canManage: boolean
}

interface ResourceListProps {
  resources: readonly ResourceSummary[]
  /** Supplied only on the cross-client operator view; omitted when the page is already scoped to one client. */
  clientNameById?: Record<string, string>
}

export function ResourceList({ resources, clientNameById }: ResourceListProps): React.ReactElement {
  const router = useRouter()
  const [deletingIds, setDeletingIds] = useState<readonly string[]>([])
  const [removedIds, setRemovedIds] = useState<readonly string[]>([])

  const visible = resources.filter((resource) => !removedIds.includes(resource.id))

  async function onDelete(resource: ResourceSummary): Promise<void> {
    setDeletingIds((ids) => [...ids, resource.id])
    try {
      const res = await fetch(`/api/clients/${resource.clientId}/resources/${resource.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        toast.error('Could not remove the resource', { description: 'Please try again.' })
        return
      }
      // Optimistic removal, then refresh so any other view of the same list
      // (the client detail page, the pickers in /inbox) catches up.
      setRemovedIds((ids) => [...ids, resource.id])
      toast.success('Resource removed', { description: `${resource.title} is no longer sendable.` })
      router.refresh()
    } catch {
      toast.error('Could not remove the resource', {
        description: 'Network request failed. Check your connection and retry.',
      })
    } finally {
      setDeletingIds((ids) => ids.filter((id) => id !== resource.id))
    }
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Paperclip}
        title="No resources yet"
        description="Add collateral the agent can send when a lead asks to see something — a portfolio deck, design concepts, a one-pager."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((resource) => {
        const isDeleting = deletingIds.includes(resource.id)
        const clientName = clientNameById?.[resource.clientId]
        return (
          <li
            key={resource.id}
            className="border-hairline bg-surface flex items-start gap-3 rounded-lg border px-4 py-3"
          >
            <span aria-hidden className="text-muted-foreground mt-0.5 shrink-0">
              <Paperclip size={15} weight="light" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{resource.title}</p>
              <p className="text-muted-foreground max-w-[70ch] text-xs leading-relaxed">
                {resource.description}
              </p>
              <p className="text-faint tnum mt-1 truncate text-[11px]">
                {resource.fileName} · {formatBytes(resource.byteSize)}
                {clientName ? ` · ${clientName}` : ''}
              </p>
            </div>
            {resource.canManage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isDeleting}
                onClick={() => void onDelete(resource)}
                aria-label={`Remove ${resource.title}`}
              >
                <Trash size={14} weight="light" />
                {isDeleting ? 'Removing…' : 'Remove'}
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
```

### A.2 `src/components/resource-picker.tsx`

```tsx
'use client'

import { useState } from 'react'
import { MAX_ATTACHMENTS_PER_EMAIL, MAX_TOTAL_ATTACHMENT_BYTES } from '@/lib/mailbox/attachments'
import { formatBytes } from '@/lib/format/bytes'
import type { ResourceSummary } from '@/components/resource-list'

interface ResourcePickerProps {
  resources: readonly ResourceSummary[]
  /** Form field name; one hidden input is emitted per selected id. */
  name: string
  defaultSelectedIds?: readonly string[]
  onSelectionChange?: (ids: string[]) => void
}

export function ResourcePicker({
  resources,
  name,
  defaultSelectedIds = [],
  onSelectionChange,
}: ResourcePickerProps): React.ReactElement | null {
  const [selectedIds, setSelectedIds] = useState<readonly string[]>(defaultSelectedIds)

  // A client with no library should see no dead control at all.
  if (resources.length === 0) return null

  const selected = resources.filter((resource) => selectedIds.includes(resource.id))
  const totalBytes = selected.reduce((sum, resource) => sum + resource.byteSize, 0)

  function toggle(resource: ResourceSummary): void {
    setSelectedIds((ids) => {
      const next = ids.includes(resource.id)
        ? ids.filter((id) => id !== resource.id)
        : [...ids, resource.id]
      onSelectionChange?.([...next])
      return next
    })
  }

  return (
    <fieldset className="border-hairline flex flex-col gap-2 rounded-lg border p-3">
      <legend className="text-faint px-1 text-[11px]">Attach resources — sent to the lead</legend>

      {resources.map((resource) => {
        const isSelected = selectedIds.includes(resource.id)
        // A selected row is never disabled, so a choice is always reversible.
        const wouldExceedCount = selected.length >= MAX_ATTACHMENTS_PER_EMAIL
        const wouldExceedBytes = totalBytes + resource.byteSize > MAX_TOTAL_ATTACHMENT_BYTES
        const isDisabled = !isSelected && (wouldExceedCount || wouldExceedBytes)

        return (
          <label
            key={resource.id}
            className={`flex items-start gap-2.5 rounded-md px-2 py-1.5 text-xs ${
              isDisabled ? 'opacity-45' : 'hover:bg-accent/50 cursor-pointer'
            }`}
          >
            <input
              type="checkbox"
              className="mt-0.5 size-3.5 shrink-0"
              checked={isSelected}
              disabled={isDisabled}
              onChange={() => toggle(resource)}
            />
            <span className="min-w-0 flex-1">
              <span className="block truncate font-medium">{resource.title}</span>
              <span className="text-muted-foreground block truncate">{resource.description}</span>
            </span>
            <span className="text-faint tnum shrink-0">{formatBytes(resource.byteSize)}</span>
          </label>
        )
      })}

      <p className="text-faint tnum px-2 text-[11px]" aria-live="polite">
        {formatBytes(totalBytes)} / {formatBytes(MAX_TOTAL_ATTACHMENT_BYTES)} ·{' '}
        {selected.length} / {MAX_ATTACHMENTS_PER_EMAIL} files
      </p>

      {/* Hidden inputs rather than component state alone, so this composes with
          a plain <form action={serverAction}> and needs no client-side submit. */}
      {selectedIds.map((id) => (
        <input key={id} type="hidden" name={name} value={id} />
      ))}
    </fieldset>
  )
}
```

Both components read `--status-*` custom properties and the `border-hairline` / `bg-surface` / `text-faint` utility classes already used across `src/components/` and `src/app/(app)/inbox/`. If any of those class names do not exist, match whatever the neighbouring components use rather than inventing new tokens.
