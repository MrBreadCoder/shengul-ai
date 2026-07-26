# AI Resources — sendable client collateral

**Date:** 2026-07-26
**Status:** approved, ready for planning
**Companion to:** `.claude/architecture.md`, `docs/superpowers/specs/2026-07-23-client-knowledge-base-design.md`

---

## 1. Problem

The agent can answer a prospect's question but cannot show them anything. When a
lead asks "do you have example designs?", the only available move is prose or a
`knowledge_request` escalation — there is no way to put a portfolio PDF or a set
of mockups in front of them.

Separately, an operator answering a blocked `knowledge_request` in `/inbox` can
only type text. They cannot hand the agent a file, either as something to send
or as something to learn from.

## 2. Two distinct concepts

These are deliberately kept apart, and the separation is the core design
decision of this spec:

| | **Knowledge** | **Resource** |
|---|---|---|
| Purpose | helps the AI *answer* | something the AI *sends* |
| Storage | `client_knowledge_sources` + `_chunks` | `client_resources` |
| Pipeline | chunked, embedded, retrieved by `retrieveClientKnowledge()` | never embedded, never retrieved |
| Reaches the AI as | injected prompt context | a menu of `title — description` it may pick from |
| Reaches the lead as | never | a MIME attachment on a reply |

A resource is **not** knowledge. Its file content is never extracted, chunked or
embedded. The only thing the AI ever learns about a resource is its `title` and
its operator-written `description`. This keeps the two systems independently
comprehensible and avoids a portfolio PDF's text polluting answer retrieval.

## 3. Scope decisions

| Decision | Choice | Why |
|---|---|---|
| Delivery | real MIME attachments | direct; the lead gets the file in the thread they are already reading |
| Where allowed | replies only — `reply.ts` and `knowledge-answer.ts` | the lead asked, so the attachment is expected; a first-touch or cold-nudge attachment is a top-tier spam heuristic |
| AI selection | full menu of `title — description` in the prompt, AI returns ordinals | simple, no embeddings, no new RPC; adequate below ~40 resources |
| Resource → knowledge | none | resources are sendable artifacts only (see §2) |
| Size ceiling | 3 MB per email, 3 files max | keeps every provider on its simple send path; no Graph upload sessions |
| Ownership | clients manage their own uploads on `/knowledge`; operators manage everything | clients know their own collateral; operators stay in control of the rest |
| Draft review | AI's picks are shown and editable in `/inbox` before approval | the AI must not be able to silently mail the wrong file to a prospect |

### Known limits, accepted

- **Deliverability.** Any attachment raises spam scoring. Replies are the safest
  placement available, but the `mailboxes` warmup machinery exists because these
  domains are fragile — bounce rates want watching on the first campaign that
  uses this.
- **SVG.** Included in the allowlist as requested. It is an active-content
  format and Gmail/Outlook routinely quarantine or strip it from external
  senders, so it will be the least reliable type to actually land.
- **Menu scaling.** Past ~40 resources the prompt menu dilutes attention and
  eats token budget. The migration path at that point is a semantic shortlist
  (embed `description`, retrieve top-K by the lead's question, put only those in
  the menu). Not built now.

---

## 4. Data model

New migration `0018_client_resources.sql`.

### 4.1 `client_resources`

```sql
create table client_resources (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  title        text not null,
  description  text not null,
  file_name    text not null,
  mime_type    text not null,
  byte_size    integer not null,
  storage_path text not null,
  is_active    boolean not null default true,
  created_by   uuid not null references app_users(id),
  created_at   timestamptz not null default now()
);

create index client_resources_client_active_idx
  on client_resources (client_id, created_at desc) where is_active;
```

- `description` is `not null` on purpose. An undescribed resource is invisible to
  the AI's menu, so the schema forces the uploader to state what it is for.
- `file_name` is the sanitized, wire-safe name (see §5.3) and becomes the
  attachment filename.
- `byte_size` is denormalized from the upload so the menu can be budgeted
  without touching storage.

**Delete is a soft delete** (`is_active = false`). A sent email references the
resource it carried; hard-deleting would gut that audit trail. A deactivated
resource drops out of the AI menu and every picker immediately, and its storage
object is removed best-effort — only the metadata row survives, for history.

### 4.2 `email_attachments`

```sql
create table email_attachments (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  email_id    uuid not null references emails(id) on delete cascade,
  resource_id uuid not null references client_resources(id) on delete restrict,
  created_at  timestamptz not null default now(),
  unique (email_id, resource_id)
);

create index email_attachments_email_id_idx on email_attachments (email_id);
```

- `client_id` is denormalized so the table fits the flat RLS shape every other
  table in `0002_rls_policies.sql` uses.
- `on delete restrict` on `resource_id`, combined with the soft delete above, is
  what keeps history intact.
- `unique (email_id, resource_id)` makes attaching idempotent under a retried
  QStash delivery.

### 4.3 Storage bucket

```sql
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('client-resources', 'client-resources', false, 3145728, array[
  'application/pdf', 'image/png', 'image/jpeg', 'image/gif',
  'image/webp', 'image/svg+xml', 'text/plain', 'text/markdown'
])
on conflict (id) do nothing;
```

Private, same convention as `client-knowledge-pdfs`: no storage RLS policies,
writes go through the service-role client at the route layer, reads for the UI
go through a server-generated signed URL.

---

## 5. Security

### 5.1 RLS — this reverses an existing decision

`0014_client_knowledge.sql` states explicitly:

> Deliberately NOT added to the shared client-or-operator RLS loop — this
> content must never be visible to client-role sessions, only to the operator
> who curates it.

That is reversed. Clients now manage their own uploads. `0018` loosens the two
knowledge tables and sets the same shape on the new ones:

| table | select | insert | update / delete |
|---|---|---|---|
| `client_resources` | `is_operator() or client_id = current_client_id()` | `is_operator() or (client_id = current_client_id() and created_by = auth.uid())` | `is_operator() or created_by = auth.uid()` |
| `client_knowledge_sources` | same | same | same |
| `client_knowledge_chunks` | `is_operator() or client_id = current_client_id()` | operator only | operator only |
| `email_attachments` | `is_operator() or client_id = current_client_id()` | operator only | operator only |

Chunks stay operator-write because only the service-role pipeline writes them.

Two consequences to accept:

1. A client-role login now sees the knowledge base operators curated for them,
   including any internal framing in a scraped page or uploaded PDF. Existing
   content wants a sweep before this ships.
2. `created_by = auth.uid()` scopes ownership to a *person*, not the client org.
   Removing a client user (shipped in `4792cce`) leaves their uploads
   operator-only-editable. That is the safe failure direction.

This is the first table in the codebase where a client-role session can write.
`0002_rls_policies.sql` asserts "clients are read-only per architecture §11", so
`.claude/architecture.md` §11 must be updated in the same change.

### 5.2 Route-level ownership is the real boundary

The existing knowledge routes use `createAdminClient()` — which bypasses RLS
entirely — plus a blunt `appUser.role !== 'operator'` gate. The new resource
routes must accept client-role callers, so **RLS no longer protects these
paths**. The routes enforce ownership themselves:

- `POST /api/clients/[clientId]/resources` — allow when
  `appUser.role === 'operator' || appUser.client_id === clientId`
- `DELETE /api/clients/[clientId]/resources/[resourceId]` — allow when
  `appUser.role === 'operator' || resource.created_by === appUser.id`, and the
  resource's `client_id` must match the route's `clientId`

The same relaxation applies to two **existing** routes, which today hard-reject
any non-operator and must now accept a client-role caller under the identical
ownership rule:

- `POST /api/clients/[clientId]/knowledge/pdf` — the `appUser.role !== 'operator'`
  gate becomes the ownership check above. It is also generalized beyond PDF (see
  §5.4), so it is renamed to `.../knowledge/file`.
- `DELETE /api/clients/[clientId]/knowledge/[sourceId]` — becomes
  `is_operator || source.created_by === appUser.id`. The sitemap-discovery,
  page-add and rescrape routes under `.../knowledge/` keep their existing
  operator-only gate untouched.

These checks are the whole boundary and are tested directly (§9).

### 5.4 Knowledge uploads widen from PDF to pdf/txt/md

`0014` created `client-knowledge-pdfs` with
`allowed_mime_types = array['application/pdf']`, and
`assertValidPdfFile` / `uploadClientKnowledgePdf` hard-code
`application/pdf`. Supporting `.txt` and `.md` requires:

- `0018` alters the bucket's `allowed_mime_types` to add `text/plain` and
  `text/markdown` (the 10 MB `file_size_limit` is unchanged)
- `src/lib/storage/client-knowledge-pdfs.ts` is renamed to
  `client-knowledge-files.ts`; `assertValidPdfFile` becomes
  `assertValidKnowledgeFile` with a mime allowlist, and text files skip
  `extractPdfText` entirely — their bytes decode straight to the `content`
  column

The `knowledge_source_type` enum gains a `'file'` value; existing `'pdf'` rows
are left as-is (Postgres enums cannot drop values, and rewriting history buys
nothing).

Answering a `knowledge_request` in `/inbox` stays operator-only. That is
existing behavior and this spec does not change it.

### 5.3 Filename safety

Filenames originate from an upload and end up in a MIME header.
`assertNoHeaderInjection` (already in `gmail-provider.ts`) applies to them, and
non-ASCII names are sanitized to a safe ASCII subset **at upload time**, so the
stored `file_name` is always wire-safe and nothing downstream has to re-check.

---

## 6. Attachment plumbing

### 6.1 Provider interface

`src/lib/mailbox/provider.ts`:

```ts
export interface EmailAttachment {
  fileName: string
  mimeType: string
  content: Buffer
}
```

`SendEmailInput` gains `attachments?: readonly EmailAttachment[]`.

### 6.2 `src/lib/mailbox/attachments.ts` (new)

Pure functions holding the ceiling:

- `MAX_ATTACHMENTS_PER_EMAIL = 3`
- `MAX_TOTAL_ATTACHMENT_BYTES = 3 * 1024 * 1024`
- `assertWithinAttachmentLimits(attachments): void` — throws
  `AppError('VALIDATION_ERROR', …)` on count or total-byte overflow
- `sanitizeAttachmentFileName(name): string`

### 6.3 Per-provider implementation

- **Gmail** (`gmail-provider.ts`) — `encodeMessage` currently emits a flat
  `Content-Type: text/plain` message. With attachments it switches to
  `multipart/mixed` with a `randomUUID` boundary: a `text/plain` body part, then
  one part per attachment carrying `Content-Type: <mime>`,
  `Content-Transfer-Encoding: base64`, and
  `Content-Disposition: attachment; filename="…"`, base64 wrapped at 76
  columns. Threading headers (`In-Reply-To`, `References`) are unchanged.
- **Outlook** (`outlook-provider.ts`) — the `sendMail` message body gains
  `attachments: [{ '@odata.type': '#microsoft.graph.fileAttachment', name,
  contentType, contentBytes }]`. Under the 3 MB total this rides the existing
  single `sendMail` call; no draft-plus-upload-session path is built.
- **SMTP** (`smtp-send.ts`) — nodemailer
  `attachments: [{ filename, content, contentType }]`.

### 6.4 Sender

`SendViaMailboxInput` gains `attachments?`. `sendViaMailbox` passes it straight
through — least-used-first rotation, the atomic `claim_mailbox_send` cap claim,
jitter and token persistence are untouched.

---

## 7. Pipeline

### 7.1 AI selection (`reply.ts`)

`classificationSchema` gains:

```ts
attachResourceIds: z.array(z.number().int()).default([])
```

The prompt gains a menu block built by `src/lib/resources/menu.ts`:

```
Resources you may attach (only if the prospect explicitly asked for
something one of these provides):
  1 — 2026 portfolio deck — 12 recent brand projects; send when a lead asks for examples
  2 — Pricing one-pager — headline rates; send only on a direct pricing request
Leave attachResourceIds empty if none genuinely fit.
```

**Ordinals, not uuids.** Models mangle uuids and 40 of them is pure token waste.
Ordinals map back to real ids server-side; anything out of range is dropped
rather than trusted.

`MAX_RESOURCE_MENU = 40`, active resources only, newest first.

A pure `resolveAttachments(menu, picked)` validates the model's output:

1. drop out-of-range and duplicate ordinals
2. cap to `MAX_ATTACHMENTS_PER_EMAIL`
3. greedily keep in menu order while the running total stays within
   `MAX_TOTAL_ATTACHMENT_BYTES`
4. return the resolved rows plus the dropped ones, which are logged

Attachments are additionally suppressed unless the classification produced a
non-null `replyBody` — a `not_interested` or `price` classification never
carries files.

**`write.ts` and `followup.ts` build no menu and pass no attachments.** There is
no code path by which a first-touch or follow-up email can carry one. The
constraint is structural, not a flag that can be flipped by accident.

### 7.2 `sendOrDraftReply`

Gains `resourceIds: string[]`. Order of operations:

1. `claimReplyEmail` — `null` means a prior delivery won the slot; return
   (existing idempotency, unchanged)
2. insert `email_attachments` for the claimed email — **before** the draft
   branch, so a draft carries the AI's picks and `/inbox` can render them
3. `disposition === 'draft'` → return; the row sits in `/inbox`
4. `disposition === 'send'` → load the resources **scoped to the email's
   `client_id`** (so a forged id from another client cannot resolve), download
   the bytes, `assertWithinAttachmentLimits`, then `sendViaMailbox`

If a storage download fails the send fails: `markEmailFailed` and the existing
retry path takes over. This deliberately does not degrade gracefully — an email
whose body says "attached are the examples" going out with nothing attached is
worse than a retry.

### 7.3 `knowledge-answer.ts`

`runKnowledgeAnswer` gains `resourceIds: string[]`, passed in directly by
`answerKnowledgeRequest` — which already calls it inline in the same request, so
no new column on `knowledge_requests` is needed. There is no LLM selection here;
the operator chose. The prompt *is* told which files are attached, so the body
reads "attached are the two concepts" rather than contradicting the envelope.

### 7.4 Observability

New event type `reply.resources_attached`, payload
`{ emailId, resourceIds, totalBytes, droppedResourceIds }`, logged via
`logEventSafe` after the send succeeds.

---

## 8. UI

### 8.1 `/knowledge` splits into three sub-routes

Behind a shared tab strip, so each gets its own `loading.tsx` and `error.tsx`:

| route | contents | client-role | operator |
|---|---|---|---|
| `/knowledge` | case-knowledge facts feed (unchanged) | read-only | read-only |
| `/knowledge/sources` | knowledge sources: list + file upload | delete own only | delete any |
| `/knowledge/resources` | resources: list + upload | delete own only | delete any |

Sitemap discovery and rescrape stay operator-only on `/clients/[id]` — they
spend Brightdata credits, so they are not a client-role affordance. Client-role
users get file upload only on `/knowledge/sources`.

`/clients/[id]` gains a Resources section reusing the same components with a
`canManageAll` prop.

Each list handles all four states: loading (`loading.tsx`), error
(`error.tsx`), empty (`EmptyState`), success.

### 8.2 `/inbox`

- **`KnowledgeRequestRow`** — two new optional slots below the answer box:
  - *Attach resources* — checkbox list of the client's active resources with a
    running `2.7 / 3.0 MB` counter that disables further picks at the cap
  - *Add knowledge* — file input (pdf/txt/md), routed to the existing
    extract → chunk → embed path
  The existing text-only path still works with both left empty.
- **`DraftRow`** — attachment list with per-item remove and an "Add from
  library" picker, backed by a new `updateDraftAttachments` server action
  (operator-only, re-validates the email is still `draft` + `outbound`, replaces
  the set). `approveDraft` re-reads `email_attachments` from the DB at send
  time, so the database is the source of truth, not form state.

---

## 9. Testing

| Target | Cases |
|---|---|
| `attachments.ts` | count overflow, byte overflow, exact-limit boundary, filename sanitization |
| `resolveAttachments` | hallucinated ordinal, duplicate ordinal, over-count, over-budget drop order, empty menu |
| `gmail-provider` | multipart structure and boundary, base64 body, threading headers preserved, filename header-injection attempt rejected, no-attachment path still emits flat text/plain |
| `outlook-provider` | `fileAttachment` payload shape, `contentBytes` encoding |
| `smtp-send` | attachment passthrough to nodemailer |
| `sendOrDraftReply` | attachments persisted on a draft, download failure marks the email failed, cross-client resource id does not resolve |
| `reply.ts` | empty menu ⇒ no attachments; null `replyBody` ⇒ no attachments |
| `write.ts` / `followup.ts` | never pass attachments |
| resource routes | cross-client POST rejected, non-owner DELETE rejected, oversized file rejected, disallowed mime rejected, operator can do both |
| knowledge file route | same four cases, plus `.txt`/`.md` bypass `extractPdfText` and still chunk+embed |
| `client-resources.ts` DB | soft delete removes from active list, `getResourcesByIds` is client-scoped |

Coverage floors per `.claude/QUALITY.md`: 100% on the pure functions, 90% on
server actions, 80% on the DB layer.

---

## 10. Footprint

**New**
- `supabase/migrations/0018_client_resources.sql`
- `src/lib/storage/client-resources.ts`
- `src/lib/db/client-resources.ts`
- `src/lib/db/email-attachments.ts`
- `src/lib/mailbox/attachments.ts`
- `src/lib/resources/menu.ts`
- `src/app/api/clients/[clientId]/resources/route.ts`
- `src/app/api/clients/[clientId]/resources/[resourceId]/route.ts`
- `src/app/api/clients/[clientId]/knowledge/file/route.ts` (renamed from `knowledge/pdf/`)
- `src/app/(app)/knowledge/sources/` and `src/app/(app)/knowledge/resources/` (page + loading + error each)
- `src/components/resource-list.tsx`, `src/components/resource-upload.tsx`, `src/components/resource-picker.tsx`
- colocated `*.test.ts` for each of the above

**Modified**
- `src/lib/mailbox/provider.ts`, `gmail-provider.ts`, `outlook-provider.ts`, `smtp-send.ts`, `sender.ts`
- `src/lib/pipeline/reply.ts`, `src/lib/pipeline/knowledge-answer.ts`
- `src/app/(app)/inbox/actions.ts`, `knowledge-request-row.tsx`, `draft-row.tsx`
- `src/app/(app)/knowledge/page.tsx` (tab strip), `src/app/(app)/clients/[id]/page.tsx`
- `src/lib/storage/client-knowledge-pdfs.ts` → `client-knowledge-files.ts` (mime allowlist, text passthrough)
- `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts` (owner-or-operator delete)
- `src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx` (accepts pdf/txt/md)
- `src/types/database.ts`
- `.claude/architecture.md` §11, `.claude/roadmap.md`
