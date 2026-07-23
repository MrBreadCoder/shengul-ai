# Client Knowledge Base

**Date:** 2026-07-23
**Status:** Approved design, not yet implemented

## Problem

Every AI copy-generation call in the pipeline (`write.ts`, `followup.ts`,
`reply.ts`, `knowledge-answer.ts`) grounds itself in two things: the per-case
`case_knowledge` dossier (facts about the *prospect*) and a single freeform
`campaigns.value_prop` string (facts about *our client's own business*). The
value-prop string is whatever the operator typed once at campaign-creation
time — thin, easy to go stale, and gives the model nothing to cite when a
prospect asks a real question about the client's product, pricing tiers,
case studies, or positioning.

Goal: let the operator build a real knowledge base per client — scraped
website pages and uploaded PDFs — that the AI pipeline can draw on as
grounding, the same way `case_knowledge` grounds facts about the prospect.
Operator-only: only an operator can add, remove, or view this content; it
never appears to client-role sessions and never appears in `case_knowledge`
(the case-scoped, dossier-facing table stays untouched).

## Data model

Two new tables, both client-scoped, both **fully operator-only** in RLS (not
added to the existing shared `is_operator() or client_id = current_client_id()`
select policy used by every other client-scoped table — a deliberate
exception, since client-role sessions must never see this content).

```sql
create extension if not exists vector;

create type knowledge_source_type as enum ('website_page', 'pdf');
create type knowledge_source_status as enum ('pending', 'ready', 'failed');

create table client_knowledge_sources (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  source_type   knowledge_source_type not null,
  url           text,                    -- website_page only
  storage_path  text,                    -- pdf only (path in client-knowledge-pdfs bucket)
  title         text not null,           -- website_page: <title> or url. pdf: original filename
  content       text,                    -- full extracted text, null while pending
  char_count    integer,
  status        knowledge_source_status not null default 'pending',
  error_message text,
  created_by    uuid not null references app_users(id),
  created_at    timestamptz not null default now(),
  scraped_at    timestamptz
);
create unique index client_knowledge_sources_url_uniq
  on client_knowledge_sources (client_id, url) where url is not null;

create table client_knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  source_id    uuid not null references client_knowledge_sources(id) on delete cascade,
  chunk_index  integer not null,
  content      text not null,
  embedding    vector(768) not null,
  created_at   timestamptz not null default now()
);
create index client_knowledge_chunks_embedding_idx
  on client_knowledge_chunks using hnsw (embedding vector_cosine_ops);

alter table client_knowledge_sources enable row level security;
alter table client_knowledge_chunks enable row level security;
create policy client_knowledge_sources_all on client_knowledge_sources
  for all using (is_operator()) with check (is_operator());
create policy client_knowledge_chunks_all on client_knowledge_chunks
  for all using (is_operator()) with check (is_operator());
```

Retrieval function (SECURITY DEFINER, cosine distance, hard-scoped to
`client_id` so a bad caller can never cross-client leak):

```sql
create or replace function match_client_knowledge_chunks(
  p_client_id uuid, p_query_embedding vector(768), p_limit integer
) returns table (source_id uuid, source_title text, content text, similarity float)
language sql stable security definer as $$
  select c.source_id, s.title, c.content, 1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  where c.client_id = p_client_id
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;
```

**Storage**: new bucket `client-knowledge-pdfs`, mirroring
`src/lib/storage/logos.ts` (`assertValidPdfFile`, `uploadClientKnowledgePdf`,
`deleteClientKnowledgePdfObject`) — path `${clientId}/${randomUUID()}.pdf`,
10MB cap, MIME must be `application/pdf`.

**PDF text extraction**: `unpdf` (new dependency) — serverless-friendly, no
filesystem side effects at import time (unlike `pdf-parse`, which has a
known debug-mode footgun on first import). Extracted text capped at 12,000
chars per document.

**Website page content**: reuses the existing `brightdataResearch.scrape(url)`
(`src/lib/research/brightdata.ts`), already capped at 6,000 chars of markdown.

**Chunking + embedding**: once a source is `ready`, its `content` is split
into ~1000-char chunks with ~100-char overlap and embedded via a new
`embedTexts` wrapper in `src/lib/llm/client.ts` (Google `text-embedding-004`,
768 dims, via `@ai-sdk/google`'s `embedMany` — same timeout/error-mapping
pattern as `generateJson`).

## Discovery, selection, and scrape/embed execution

**Sitemap discovery** — `POST /api/clients/[clientId]/knowledge/discover-sitemap`,
Zod `{ websiteUrl: z.string().url() }`, operator-gated (403 otherwise):

1. Normalize to origin, fetch `${origin}/sitemap.xml` via the existing
   `fetchText` helper (8s timeout) — no Brightdata needed, sitemaps are
   almost never bot-blocked.
2. Extract `<loc>…</loc>` values with a regex (sitemap XML is a constrained,
   well-known format; a regex avoids pulling in a new XML-parser dependency
   for this). If the root looks like a `<sitemapindex>`, treat the locs as
   child sitemap URLs, fetch up to 20 of them (depth-2 max), merge their
   `<loc>` values.
3. Cap the combined list at 500 URLs (truncate, note "showing first 500").
   Returns `{ urls: string[] }` — nothing is written to the DB yet, this is
   only for the picker UI.
4. Fallback if the sitemap fetch/parse yields nothing: `brightdataResearch
   .scrape(origin)` on the homepage, extract same-domain links from the
   returned markdown, cap similarly. If that also yields nothing, return a
   `VALIDATION_ERROR`-shaped response the UI shows as "couldn't discover any
   pages for this site."

**Selection → pending rows → parallel scrape** —
`POST /api/clients/[clientId]/knowledge/pages`, Zod `{ urls: z.array(z.string().url()).max(50) }`,
operator-gated:

- Insert one `client_knowledge_sources` row per URL (`status: 'pending'`),
  skipping URLs already present for this client (the unique index above
  makes this a plain insert-or-skip, not a race-prone check-then-insert).
- Fan out one QStash message per newly-inserted row to
  `/api/pipeline/knowledge-scrape` — same fan-out shape as `research`/
  `write`. QStash delivers these concurrently, so scraping runs in parallel
  with no extra plumbing.

**`/api/pipeline/knowledge-scrape`** (QStash-signature verified, Zod
`{ sourceId: z.string().uuid() }`):

- Loads the source row, calls `brightdataResearch.scrape(url)`.
- On success: delete any existing `client_knowledge_chunks` for this
  `source_id` (a no-op the first time), chunk + embed the fresh content,
  insert the new chunks, update the source to `status: 'ready'` with
  `content`/`char_count`/`scraped_at`. The delete-then-insert (rather than
  append) is what keeps this idempotent — QStash's own automatic retries on
  a non-2xx response, and the explicit re-scrape action below, both funnel
  through this same route and must never leave duplicate chunks behind.
- On failure: `status: 'failed'`, `error_message` set to the `AppError`
  message (safe to render directly). Logs `knowledge.page_scraped` /
  `knowledge.page_scrape_failed` via `logEventSafe`.
- No claim-row dance needed here, unlike the case pipelines — the
  delete-then-insert makes re-running the whole route safe on its own.

**PDFs** — `POST /api/clients/[clientId]/knowledge/pdf` (FormData, mirrors
the logo route exactly): validates + uploads to the bucket, extracts text
with `unpdf` **inline** (local, fast, no network dependency — no QStash
needed), chunks + embeds inline, inserts the source row already `ready`.
`DELETE /api/clients/[clientId]/knowledge/[sourceId]` removes the chunks
(FK cascade), the source row, and best-effort removes the storage object
if it was a PDF.

**Re-scrape** — `POST /api/clients/[clientId]/knowledge/[sourceId]/rescrape`
(website pages only — 400 `VALIDATION_ERROR` for a `pdf` source): deletes
the source's existing chunks, resets `status: 'pending'`, republishes one
QStash message to `/api/pipeline/knowledge-scrape`.

**Live status in the UI**: a small Realtime subscriber (same pattern as
`analytics/realtime-refresher.tsx`) listens for `client_knowledge_sources`
changes scoped to this client and debounces `router.refresh()`, so
pending → ready/failed transitions show up without a manual refresh.

## AI pipeline integration

New `src/lib/knowledge/client-context.ts`:

```ts
export async function retrieveClientKnowledge(
  supabase: SupabaseClient<Database>,
  clientId: string,
  queryText: string,   // dossier facts + value prop, joined
  limit = 6,
): Promise<string>     // formatted "About our company" block, or '' if nothing found
```

Embeds `queryText`, calls `match_client_knowledge_chunks`, formats the top-K
chunks (each tagged with its source title) into a block. Called from the
same four sites that already build `Our value proposition: …`: `write.ts`,
`followup.ts`, `reply.ts`, `knowledge-answer.ts` — each appends
`About our company:\n${block}` immediately after the value-prop line
whenever the block is non-empty. A retrieval failure (embedding API error,
RPC error) is caught, logged, and falls back to `''` — a knowledge-base
hiccup must never block sending an email.

## Access control

`client_knowledge_sources`/`client_knowledge_chunks` RLS is fully
operator-only (see Data model above) — this is the one table pair in the
schema that departs from the shared client-or-operator select policy.
Every route under `/api/clients/[clientId]/knowledge/*` starts with the
same `appUser.role !== 'operator' → 403` check used by the logo/pause/
archive routes. The "Knowledge Base" tab on `/clients/[id]` is conditionally
rendered only for operator sessions — a client-role viewer never sees the
tab exists.

## UI

New `Tabs` entry "Knowledge Base" on `/clients/[id]` (alongside Campaigns/
Analytics/Users), operator-only:

- **Add website** — URL input → "Discover pages" → checklist of found URLs
  (search box, select-all) → "Add selected" (batches of ≤50).
- **Sources list** — table of every `client_knowledge_sources` row: title/
  URL, type icon (page/PDF), status badge (pending spinner / ready / failed
  with an error tooltip), added date, actions (re-scrape for pages, delete
  for both).
- **Add PDF** — single file input, same visual pattern as `LogoUpload`.
- Standard four states: loading (skeleton), error, empty ("No knowledge
  sources yet"), success.

## Testing

- Zod schemas: discover-sitemap input, pages-selection input (batch cap),
  PDF upload validation — happy path + rejection cases.
- `src/lib/knowledge/` unit tests: sitemap `<loc>` extraction (flat urlset,
  sitemap index, malformed XML), chunking (overlap boundaries, empty
  content), `retrieveClientKnowledge` (mocked embed + RPC, empty-result
  fallback to `''`, thrown error swallowed to `''`).
- Route tests (mirroring existing `route.test.ts` patterns): 403 for
  client-role, 404 for unknown client/source, dedup-on-existing-url,
  re-scrape rejects a `pdf` source with 400.
- `/api/pipeline/knowledge-scrape`: success path inserts chunks + flips
  `ready`; scrape failure flips `failed` with `error_message` and inserts
  no chunks; retry after failure overwrites cleanly (no duplicate chunks —
  delete-then-insert, not append).
- Integration test (client-knowledge RLS): a client-role session cannot
  `select` from either table even for its own `client_id` (the deliberate
  operator-only exception, so this must be explicitly proven, not assumed
  from the shared-policy tests).
