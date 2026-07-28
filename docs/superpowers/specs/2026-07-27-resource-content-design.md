# Resource content — letting the AI read the files it sends

**Date:** 2026-07-27
**Status:** approved, ready for planning
**Supersedes (in part):** `docs/superpowers/specs/2026-07-26-ai-resources-design.md` §2
**Companion to:** `.claude/architecture.md`, `docs/superpowers/specs/2026-07-23-client-knowledge-base-design.md`

---

## 1. Problem

A resource is opaque to the agent. `formatResourceMenu` emits
`ordinal — title — description`, and that string is the whole of what the model
knows about a file. The uploader's one-line description is doing all the work.

Two consequences:

1. **Selection is guesswork.** A lead asks "do you have fintech work?"; the agent
   sees `1 — 2026 portfolio deck — send when a lead asks for examples` and has no
   way to know whether the deck contains fintech work. It either attaches on a
   hunch or escalates.
2. **The answer and the attachment are disconnected.** The deck may answer the
   question outright, but its content is not retrievable, so the agent files a
   `knowledge_request` and a human answers a question the file already answered.

## 2. What changes — and what this reverses

`0018_client_resources.sql` and the 2026-07-26 spec state the separation
explicitly:

> A resource is **not** knowledge. Its file content is never extracted, chunked
> or embedded. The only thing the AI ever learns about a resource is its `title`
> and its operator-written `description`.

**That is reversed.** A resource's content is now derived at upload time,
embedded into the existing knowledge index, and retrievable at answer time. The
2026-07-26 spec keeps its §2 table for history; this document is the current
rule. The comment block at the top of `0018` is left as-is (migrations are
immutable history); `0019` states the reversal in its own header.

| | before | after |
|---|---|---|
| What the AI knows about a file | `title` + human `description` | `title`, optional `description`, a derived `content_summary`, and its full content via retrieval |
| Can the AI answer from a file? | no | yes, through `retrieveClientKnowledge` |
| Does the AI know a retrieved fact came from a sendable file? | n/a | yes — the line is labelled `(title, attachable #N)` |
| Is `description` required? | yes (`not null`) | no — narrowed to an optional "when to send" hint |

### 2.1 Design decisions

| Decision | Choice | Why |
|---|---|---|
| Purpose of content | better selection **and** answerable knowledge | the file usually *is* the answer; splitting the two forces a human escalation over a fact already on disk |
| Non-text files | vision on images and on PDFs with near-zero extractable text | half the allowlist is images, and portfolio PDFs are routinely image-only — text extraction alone would leave the original complaint unfixed for the common case |
| Where chunks live | companion `client_knowledge_sources` row + normal chunks | reuses retrieval, chunking, the HNSW index, and the tuned similarity floor; one index and one RPC to reason about |
| When derivation runs | deferred to a QStash worker | Gemini is a genuine network dependency, which is the exact condition `ingest-file.ts` cites for *not* deferring; deferring buys instant uploads and QStash's automatic retries |
| `description` | optional, narrowed to "when to send" | the AI now derives *what* a file holds; the *when* is the part it cannot infer. A forced description mostly yields filler |
| Failure handling | never blocks the upload | a resource's primary job is to be sendable; unreadable content degrades to today's title+description behaviour |

---

## 3. Reading a file

### 3.1 Strategy selection

A pure function decides the path from the mime type and, for PDFs, the length of
the extracted text:

| mime | strategy | notes |
|---|---|---|
| `text/plain`, `text/markdown` | `text` | bytes decoded as utf-8 |
| `image/svg+xml` | `text` | the markup *is* the content; Gemini does not accept SVG as an image |
| `application/pdf` | `text`, or `vision` when the extracted text trims to fewer than `RESOURCE_PDF_TEXT_FLOOR` (200) chars | catches scanned and design-heavy decks |
| `image/png`, `image/jpeg`, `image/webp` | `vision` | Gemini's supported image formats |
| `image/gif` | `unsupported` | Gemini image input does not accept GIF; converting would mean adding `sharp` |

`unsupported` is a terminal, non-error state: the resource stays fully sendable
and its menu line falls back to `title` + `description`.

### 3.2 The derivation call

Exactly one LLM call per resource, whichever path is taken:

- **vision** — `generateJson` with the file attached as a `FilePart`, schema
  `{ summary: string; content: string }`. The model writes both: `content` is a
  thorough description (subjects, names, figures, what a reader would learn),
  `summary` is one line.
- **text** — `generateJson` on the extracted text, already truncated to
  `RESOURCE_CONTENT_MAX_CHARS`, schema `{ summary: string }`. `content` is that
  same truncated text; the model is not asked to echo it back.

Bounds:

| constant | value | why |
|---|---|---|
| `RESOURCE_CONTENT_MAX_CHARS` | 12_000 | matches `PDF_MAX_EXTRACTED_CHARS`, so a resource contributes no more to the chunk budget than a knowledge PDF |
| `RESOURCE_SUMMARY_MAX_CHARS` | 240 | 40 menu entries × ~240 chars ≈ +4k tokens on the reply prompt — the ceiling that keeps the menu affordable |
| `RESOURCE_READ_MAX_OUTPUT_TOKENS` | 1_600 | enough for a full-page description, bounded per `.claude/QUALITY.md` |
| `RESOURCE_READ_TIMEOUT_MS` | 45_000 | a 3MB PDF through vision is slower than a text generation; the worker has no user waiting on it |

Both caps are enforced at write time in the worker **and** re-applied at read
time in the menu formatter — defence in depth against a row written before a cap
changed.

### 3.3 The LLM client gains file input

`generateJson` grows one optional field:

```ts
export interface LlmFile {
  data: Buffer
  mediaType: string
}

export interface GenerateJsonArgs<T> {
  // …existing fields unchanged
  files?: readonly LlmFile[]
}
```

When `files` is present the call passes `messages` (a single user message whose
content is one `TextPart` plus one `FilePart` per file) instead of `prompt`. When
absent, the existing string-`prompt` path is used verbatim, so no current caller
changes behaviour. AI SDK v7 permits `instructions` alongside `messages`, so the
system prompt handling is identical on both paths.

---

## 4. Data model

New migration `0019_resource_content.sql`.

```sql
create type resource_content_status as enum ('pending', 'ready', 'failed', 'unsupported');

alter table client_resources
  -- The AI now derives what a file contains from the file. This column narrows
  -- to an optional steering hint ("only on a direct pricing request") — the one
  -- thing content cannot express.
  alter column description drop not null,
  add column content_status  resource_content_status not null default 'pending',
  -- Full derived content: extracted text, or the vision model's description.
  add column content         text,
  -- One line, <= RESOURCE_SUMMARY_MAX_CHARS, for the AI's attach menu.
  add column content_summary text,
  add column content_error   text,
  add column read_at         timestamptz;

-- PG12+ allows ADD VALUE inside a transaction as long as the new value is not
-- USED in the same transaction — it is not; runtime code writes 'resource' rows
-- only after this migration commits. Same reasoning as 0018's 'file' value.
alter type knowledge_source_type add value if not exists 'resource';

alter table client_knowledge_sources
  add column resource_id uuid references client_resources(id) on delete cascade;

-- At most one companion source per resource, which is what makes the worker's
-- select-then-insert-or-update idempotent under a QStash retry.
create unique index client_knowledge_sources_resource_id_key
  on client_knowledge_sources (resource_id) where resource_id is not null;

-- Retrieval must be able to trace a matched chunk back to an attachable file.
create or replace function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_limit integer
) returns table (
  source_id uuid,
  source_title text,
  resource_id uuid,
  content text,
  similarity float
) language sql stable security definer set search_path = public as $$
  select c.source_id, s.title as source_title, s.resource_id, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  where c.client_id = p_client_id
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;
```

### 4.1 The companion source row

| column | value | why |
|---|---|---|
| `source_type` | `'resource'` | distinguishes it without a join |
| `resource_id` | the resource | the link, and the idempotency key |
| `title` | the resource's `title` | retrieval formats lines as `- (title) content`, so provenance reads naturally |
| `content`, `char_count` | the derived content | same as any file source |
| `status` | `'ready'` | the row is created *only after* content is derived, so it never exists in a pending or failed state |
| `storage_path` | `null` | the object lives in the `client-resources` bucket, not `client-knowledge-pdfs`; anything that signs a URL from a source row assumes the knowledge bucket, so leaving this null keeps that assumption true |
| `created_by` | the resource's `created_by` | not-null FK to `app_users` |

`content_status` on `client_resources` is the single source of truth for
progress. There is deliberately no second status to keep in sync.

### 4.2 RLS

No policy changes. `client_knowledge_sources` already carries the
client-or-operator shape from `0018`, and the new column does not widen it. The
worker writes with the service-role client, which bypasses RLS; the read/re-read
route is the authorization boundary (§6.2).

### 4.3 Lifecycle coupling

| event | effect on the companion source |
|---|---|
| resource uploaded | none yet — the worker creates it on success |
| worker succeeds | insert-or-update the source, then delete-then-insert its chunks |
| worker fails | no source row; `content_status = 'failed'` |
| resource deactivated (soft delete) | **delete the companion source** (chunks cascade) — otherwise the agent keeps answering from a file it can no longer attach |
| resource re-read | same insert-or-update + delete-then-insert path, so no duplicate chunks |
| client deleted | cascades from `clients` as before |

---

## 5. Pipeline

### 5.1 The attach menu

`formatResourceMenu` becomes, still one line per entry:

```
1 — 2026 portfolio deck — when to send: a lead asks to see examples | contains: 12 brand identity projects — 3 fintech, 2 CPG packaging, logo systems and type scales; no web design
2 — Pricing one-pager — when to send: only on a direct pricing request | contains: three tiers, €2.5k–€12k monthly retainers, 20% annual prepay discount
```

- `— when to send: …` is omitted when `description` is null
- `| contains: …` is omitted when `content_summary` is null (pending, failed,
  unsupported)
- whitespace is collapsed and the summary re-truncated to
  `RESOURCE_SUMMARY_MAX_CHARS`, preserving the existing property that a resource's
  own text cannot forge a new menu row

### 5.2 Retrieval provenance

`MatchedChunk` gains `resourceId: string | null`.
`retrieveClientKnowledge` moves to an options object — the fourth positional
`limit` plus a fifth positional map would be unreadable, and both call sites are
being touched anyway:

```ts
export interface RetrieveClientKnowledgeArgs {
  clientId: string
  queryText: string
  limit?: number
  /** Resource id → menu ordinal, for the reply path that offers an attach menu. */
  resourceOrdinalById?: ReadonlyMap<string, number>
}
```

A matched chunk whose `resourceId` is in the map renders as:

```
- (2026 portfolio deck, attachable #1) Three fintech identities shipped in 2025: …
```

Unmapped resource chunks — a resource outside the 40-entry menu cap, or the
`knowledge-answer` path which builds no menu — render as plain
`- (title) content`. This is the safe direction: an unlabelled line is
indistinguishable from ordinary company knowledge, so the model answers from it
without claiming an attachment it has no ordinal to make. The function keeps its
never-throws contract: any failure still degrades to `''`.

### 5.3 `reply.ts`

The menu is already built before retrieval, so the ordinal map is available with
no reordering:

```ts
const resourceMenu = buildResourceMenu(resources)
const resourceOrdinalById = new Map(resourceMenu.map((e) => [e.resource.id, e.ordinal]))
```

The system prompt gains one instruction: a knowledge line marked
`attachable #N` came from a file that can be attached, so when the answer leans
on that line, put `N` in `attachResourceIds`. The existing rule — attach only
what the prospect actually asked for, never as a bonus — stands unchanged, as do
`resolveAttachments`, the byte budget, and the structural guarantee that
`write.ts` and `followup.ts` never attach anything.

### 5.4 `knowledge-answer.ts`

The prompt line "reference them naturally, do not describe their contents" was
written when the model could not know the contents. It becomes: reference them
naturally, and describe what they contain only from the knowledge above. No
other change — the operator still chooses the files, and this path builds no menu.

### 5.5 The worker

`POST /api/pipeline/resource-read`, mirroring `knowledge-scrape`:

1. `verifyQstashSignature`, parse `{ resourceId }`
2. load the resource with the admin client; 404 when missing; skip when
   `is_active` is false (deactivated mid-flight — nothing to read)
3. download the bytes from the `client-resources` bucket
4. `chooseReadStrategy` → `unsupported` marks the row and returns
5. derive `{ content, summary }`
6. insert-or-update the companion source, `deleteChunksForSource`,
   `embedAndStoreChunks` — delete-then-insert, not append, so QStash's automatic
   retries and the manual re-read cannot leave duplicate chunks
7. mark `content_status = 'ready'`, store `content`, `content_summary`, `read_at`
8. on any derivation failure: `content_status = 'failed'`, `content_error` =
   the message, and a `warn`-severity event. The route still returns 200 — a
   file we cannot read is not a fault to retry forever

Events: `resource.content_read` (info), `resource.content_read_failed` (warn),
`resource.content_unsupported` (info).

### 5.6 Enqueue points

- **Upload** — `POST /resources` publishes `{ resourceId }` after the insert. A
  publish failure marks the row `failed` with "Could not start reading this
  file" and still returns 200 with the resource: the file is uploaded and
  sendable, and the UI offers Re-read.
- **Re-read** — `POST /resources/[resourceId]/read` resets the row to `pending`
  and republishes. Serves both the failure retry and the backfill.
- **Backfill** — `scripts/backfill-resource-content.ts` enqueues every active
  resource still `pending`, following the existing `scripts/schedule-*.ts`
  conventions. Needed because `0019` defaults pre-existing rows to `pending`
  with no job behind them.

---

## 6. Security

### 6.1 What is new

A resource's own text now reaches the model, and reaches it as retrieved
knowledge. This is not a new class of exposure — scraped website pages and
uploaded knowledge PDFs already put third-party text into the same prompt block
— but it is a new source of it, and clients can now upload resources themselves.
The mitigations stay the ones already in place: the menu is whitespace-collapsed
one-line-per-entry so file text cannot forge a menu row, and every value the
model returns is treated as untrusted and re-resolved server-side by
`resolveAttachments`.

### 6.2 Authorization

The read/re-read route uses the service-role client, so RLS does not protect it
and the route is the whole boundary. It reuses the existing guards unchanged:
`canManageOwnRow(appUser, resource)` — operators may re-read anything, a client
user only what they uploaded — plus the `resource.client_id !== clientId`
mismatch returning the same 404 as not-found, so no existence leak.

The knowledge `DELETE /knowledge/[sourceId]` route must refuse a source with a
non-null `resource_id` (400). Deleting it directly would strand the resource
reporting `ready` with no chunks behind it; removal belongs to the resource's own
delete path.

---

## 7. UI

### 7.1 `resource-list.tsx` — four content states

`ResourceSummary` gains `description: string | null`, `contentStatus`, and
`contentSummary: string | null`.

| state | rendering |
|---|---|
| `pending` | "Reading this file…" in muted text |
| `ready` | the `contentSummary` line under the description |
| `failed` | "Couldn't read this file" + a **Re-read** button (shown when `canManage`) |
| `unsupported` | "This format can't be analysed — the agent will go on the title and description" |

The list already handles its own empty state via `EmptyState`, and the route
already has `loading.tsx` and `error.tsx`.

### 7.2 `resource-upload.tsx`

`description` loses `required`. The label already reads "When should the agent
send this?", so only the helper text changes — "This is the only thing the agent
knows about the file" is no longer true. It becomes: the agent reads the file
itself; use this to say *when* to send it.

### 7.3 Copy corrections

- `/knowledge/resources` page description currently ends "These are never used to
  answer questions." — now false, and the exact behaviour being added.
- `.claude/architecture.md`'s resources section states the same separation.

---

## 8. Risks, accepted

- **Retrieval dilution** — the concern that motivated the original separation.
  Mitigated by the existing `MIN_SIMILARITY = 0.5` floor, by vision-derived prose
  being markedly cleaner than raw PDF text, and by resource lines being labelled
  so their provenance is visible to the model. Worth watching on the first client
  with a large library; the escape hatch, if it bites, is a similarity floor
  specific to resource-backed chunks.
- **Prompt growth** — roughly +4k tokens on the reply prompt at a full 40-entry
  menu. `MAX_RESOURCE_MENU` stays 40; the documented migration past that point is
  still a semantic shortlist.
- **Cost** — one Gemini call plus one embed batch per resource, once, at upload.
- **GIF is unreadable** — accepted rather than adding an image-conversion
  dependency.
- **A stale summary** — content is derived once. Replacing a file's bytes is not
  a supported operation today (a new version is a new resource), so there is no
  staleness path to handle.

---

## 9. Testing

| Target | Cases |
|---|---|
| `chooseReadStrategy` | every allowed mime; PDF at exactly the text floor, one under, one over; unknown mime |
| `derive-content` | vision path passes a `FilePart` and returns both fields; text path returns the extracted text as content; content and summary caps enforced; LLM failure surfaces as `AppError` |
| `generateJson` files support | `files` present builds `messages` with one `FilePart` per file; absent keeps the `prompt` path byte-identical |
| `resource-read` route | bad signature → 401; missing resource → 404; deactivated resource skipped; success writes chunks exactly once across two runs (retry idempotency); derivation failure marks `failed` with the message; GIF marks `unsupported` |
| `formatResourceMenu` | null description omits the when-to-send segment; null summary omits the contains segment; newline in a summary collapsed; over-cap summary truncated |
| `client-context` | attachable label applied only for mapped resource ids; unmapped resource chunk renders plain; retrieval failure still returns `''` |
| `client-knowledge` DB | companion rows excluded from both list queries; `MatchedChunk.resourceId` mapped from the RPC |
| resource DELETE route | deactivation also deletes the companion source; a concurrent second delete does not double-remove |
| knowledge DELETE route | resource-backed source rejected with 400 |
| read route | cross-client 404, non-owner 403, operator allowed, resets to `pending` |
| `reply.ts` | attachable-labelled knowledge reaches the prompt; existing no-menu and null-`replyBody` guarantees still hold |
| upload route | description omitted is accepted; publish failure marks `failed` but still returns the resource |

Coverage floors per `.claude/QUALITY.md`: 100% on the pure functions, 90% on
routes and actions, 80% on the DB layer.

---

## 10. Footprint

**New**
- `supabase/migrations/0019_resource_content.sql`
- `src/lib/resources/read-strategy.ts` — pure strategy choice, the floor and the caps
- `src/lib/resources/derive-content.ts` — download → strategy → LLM → `{ content, summary }`
- `src/lib/db/resource-content.ts` — status transitions and the companion-source upsert
- `src/app/api/pipeline/resource-read/route.ts`
- `src/app/api/clients/[clientId]/resources/[resourceId]/read/route.ts`
- `scripts/backfill-resource-content.ts`
- colocated `*.test.ts` for each of the above

**Modified**
- `src/lib/llm/client.ts` — optional `files` on `generateJson`
- `src/lib/resources/menu.ts` — summary in the menu line, nullable description
- `src/lib/db/client-knowledge.ts` — `.is('resource_id', null)` on both list queries, `resourceId` on `MatchedChunk`
- `src/lib/knowledge/client-context.ts` — options object, `resourceOrdinalById` labelling
- `src/lib/pipeline/reply.ts` — ordinal map into retrieval, one new prompt instruction
- `src/lib/pipeline/knowledge-answer.ts` — relaxed "do not describe their contents"
- `src/app/api/clients/[clientId]/resources/route.ts` — optional description, enqueue after insert
- `src/app/api/clients/[clientId]/resources/[resourceId]/route.ts` — delete the companion source
- `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts` — refuse resource-backed sources
- `src/components/resource-list.tsx`, `src/components/resource-upload.tsx`
- `src/app/(app)/knowledge/resources/page.tsx`, `src/app/(app)/clients/[id]/resources-section.tsx` — row mappers and copy
- `src/types/database.ts`
- `.claude/architecture.md`, `.claude/roadmap.md`
