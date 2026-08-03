# Knowledge-Base Ingestion & Hybrid Retrieval Upgrade

**Date:** 2026-08-04
**Status:** Approved design, not yet implemented

## Problem

An audit of a real client's exported `client_knowledge_chunks` data (Uniforms
Fashion, 100 chunks / 25 source pages) surfaced systemic quality problems in
the pipeline built in `docs/superpowers/specs/2026-07-23-client-knowledge-base-design.md`:

- **55% of chunks start mid-word or mid-sentence.** `chunk-text.ts`'s
  `chunkText()` is a raw fixed-size character sliding window
  (`CHUNK_SIZE_CHARS = 1000`, `CHUNK_OVERLAP_CHARS = 100`) with no paragraph
  or word-boundary awareness.
- **34% of chunks are polluted with repeated nav/header/footer boilerplate**
  (menu links, language switcher, phone/email) — diluting the embedding
  signal for the page's actual content. At least one exact-duplicate group
  was found (the same header block embedded twice).
- **Long pages are silently truncated.** `brightdataResearch.scrape()`
  (`src/lib/research/brightdata.ts`) hard-caps at `MAX_SCRAPE_CHARS = 6_000`
  chars — a limit sized for the research/dossier LLM-prompt use case, but
  reused as-is by the knowledge-base scrape worker, where it just throws away
  the rest of a long page before chunking ever happens.
- **Retrieval is pure vector cosine similarity** (`match_client_knowledge_chunks`
  RPC) with no keyword/full-text component, so exact terms — product names,
  prices, policy names like "KVKK" — can be outranked by semantically-similar
  but less-precise chunks.
- **The embedding query is an undifferentiated concatenation.** All four
  callers (`write.ts`, `reply.ts`, `followup.ts`, `knowledge-answer.ts`) join
  `dossierText + inbound.body/human_answer + valueProp` into one string. The
  dossier (many `case_knowledge` facts joined) can be far longer than the
  actual prospect question, pulling the embedding's semantic centroid away
  from the specific thing that should dominate the search.

Goal: fix ingestion (clean, boundary-respecting chunks; no silent truncation)
and add hybrid retrieval (vector + full-text, fused, deduplicated) — with no
new LLM calls, since this grounds an already-async background pipeline and
there's no evidence yet that LLM reranking is needed to hit acceptable
quality.

## Non-goals

- No backfill/reprocessing of existing clients' already-ingested sources —
  forward-looking only; operators can re-scrape a source manually via the
  existing per-source re-scrape action.
- No LLM reranking pass. Documented here as a possible future Phase 3 if
  hybrid search proves insufficient in practice — not built now, since there
  is no eval harness to justify the added cost/complexity yet.
- No multi-language stemming/dictionary handling for full-text search —
  Postgres `simple` config (no stemming) is used uniformly across all
  clients regardless of content language. This sacrifices some recall for
  non-English content but avoids picking a wrong per-client language config.
  Accepted limitation, not solved here.
- No chatbot UI, no citations shown to end users, no live-latency
  optimization. `retrieveClientKnowledge()` only grounds outbound AI-generated
  sales emails (write/reply/followup/knowledge-answer) — there is no chat
  widget or multi-turn conversation anywhere in this system.
- No change to `client_knowledge_sources` schema, RLS policies, or the
  PDF/file/resource ingestion paths — only website-page scraping, chunking,
  and retrieval change.

## Ingestion changes

### Scrape cap split (`src/lib/research/brightdata.ts`)

`scrape()` gains an optional `maxChars` parameter, defaulting to the current
`MAX_SCRAPE_CHARS = 6_000` so the research/dossier caller
(`src/lib/research/agent.ts`) is unaffected. The knowledge-scrape route
passes a new `KNOWLEDGE_SCRAPE_MAX_CHARS = 40_000` — still a hard cap
(protects against a pathological infinite-scroll page), just sized for
"store and chunk a whole marketing page" rather than "fit in one LLM prompt."

```ts
async scrape(url: string, maxChars: number = MAX_SCRAPE_CHARS): Promise<string> {
  // ...unchanged fetch...
  return body.slice(0, maxChars)
}
```

### Paragraph-aware chunker (`src/lib/knowledge/chunk-text.ts`)

Replaces the raw char-sliding-window with a paragraph packer, same exported
signature (`chunkText(text, chunkSize?, overlap?): TextChunk[]`, pure,
deterministic — existing callers unchanged):

1. Split the (already boilerplate-stripped) text on blank-line boundaries
   into paragraphs.
2. Greedily pack consecutive paragraphs into a chunk until adding the next
   one would exceed `chunkSize`.
3. Start the next chunk by carrying back the trailing paragraph(s) worth
   approximately `overlap` chars, so a fact split across a chunk boundary
   still appears whole in at least one chunk — same intent as today, now
   paragraph-snapped instead of a raw char offset.
4. Fallback: if a single paragraph alone exceeds `chunkSize`, hard-split it
   snapped to the nearest whitespace — never mid-word (today's code has no
   such guard at all; this is the direct fix for the mid-word-cut chunks
   found in the audit).

### Cross-page boilerplate stripping (new `src/lib/knowledge/strip-boilerplate.ts`)

```ts
export function stripBoilerplateParagraphs(content: string, siblingContents: string[]): string
```

- Normalizes each paragraph (trim, collapse internal whitespace) as a
  comparison key.
- A paragraph is stripped if it appears near-identically in at least
  `min(3, ceil(siblingContents.length / 2))` sibling contents — scales down
  for small sites, requires at least 2 siblings before it can trigger at all
  (a client's first scraped page is left untouched — expected, not a bug,
  given the no-backfill scope).
- Called only for `source_type === 'website_page'`, from
  `/api/pipeline/knowledge-scrape/route.ts`, immediately before chunking:
  fetch the client's other `ready` website-page sources' `content` (already
  stored on `client_knowledge_sources`), strip, then `chunkText()` the
  cleaned copy.
- `client_knowledge_sources.content` and `char_count` continue to store the
  **raw, unstripped** scrape — the audit trail / re-derivation source of
  truth is unchanged. Only the text handed to the chunker is cleaned.
- File uploads (`pdf`/`file`/`resource` source types) are untouched — no nav
  chrome to strip there.

### Defensive minimum-chunk filter

After chunking, drop any chunk whose content is under 20 non-whitespace
characters. A backstop only — in practice the boilerplate stripper should
already remove things like a lone leftover copyright line before they'd
reach the chunker.

## Retrieval changes

### Migration (new `supabase/migrations/0020_knowledge_hybrid_search.sql`)

```sql
alter table client_knowledge_chunks
  add column content_tsv tsvector generated always as (to_tsvector('simple', content)) stored;

create index client_knowledge_chunks_content_tsv_idx
  on client_knowledge_chunks using gin (content_tsv);

-- Return shape is unchanged from 0019 (source_id, source_title, resource_id,
-- content, similarity) but the parameter list grows a p_query_text — Postgres
-- refuses to CREATE OR REPLACE a function whose signature changed, so this is
-- drop-then-create, same convention as 0019's own replacement of 0014's version.
drop function if exists match_client_knowledge_chunks(uuid, vector(768), integer);

create function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_limit integer
) returns table (
  source_id uuid, source_title text, resource_id uuid, content text, similarity float
) language sql stable security definer set search_path = public as $$
  with vec as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from client_knowledge_chunks c where c.client_id = p_client_id
  ),
  txt as (
    select c.id, row_number() over (
      order by ts_rank(c.content_tsv, websearch_to_tsquery('simple', p_query_text)) desc
    ) as rnk
    from client_knowledge_chunks c
    where c.client_id = p_client_id
      and c.content_tsv @@ websearch_to_tsquery('simple', p_query_text)
  )
  select c.source_id, s.title as source_title, s.resource_id, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  join vec on vec.id = c.id
  left join txt on txt.id = c.id
  where c.client_id = p_client_id
  order by (1.0 / (60 + vec.rnk)) + coalesce(1.0 / (60 + txt.rnk), 0) desc
  limit p_limit;
$$;
```

Reciprocal Rank Fusion with constant `60` (the standard default from the
original RRF paper) — no tuning knob exposed, not worth a config surface at
this corpus size (a few hundred chunks per client makes the full-table
ranking computation trivial; no candidate-pool/pagination complexity
needed). Empty or unparseable `p_query_text` (e.g. punctuation-only) yields
no `txt` matches — ranking degrades gracefully to vector-only ordering, same
behavior as today.

`similarity` remains plain cosine similarity (used for the existing
`MIN_SIMILARITY` floor downstream) — the RRF fused score is used only for
`ORDER BY`, not returned to the caller.

### `matchClientKnowledgeChunks` (`src/lib/db/client-knowledge.ts:240`)

Gains a `queryText: string` parameter, passed through as `p_query_text` to
the RPC.

### Near-duplicate suppression (`src/lib/knowledge/client-context.ts`)

After the RPC returns and the existing `MIN_SIMILARITY = 0.5` floor is
applied, walk the results in rank order and drop any chunk whose normalized
content is more than 90% token-overlap (Jaccard similarity on
whitespace-split tokens) with a chunk already kept. Pure TypeScript, no
extra DB round-trip, no embeddings needed — directly targets the
exact/near-duplicate chunks found in the audit.

### Smarter query construction (new `src/lib/knowledge/build-query.ts`)

```ts
export const MAX_SECONDARY_CHARS = 500

export function buildKnowledgeQueryText(args: { primary: string; secondary?: string[] }): string
```

- `primary` is the most specific available signal for that call site:
  - `reply.ts` → `inbound.body`
  - `knowledge-answer.ts` → `kr.human_answer`
  - `followup.ts` → `firstOutbound?.body`
  - `write.ts` → `dossierText` (no inbound exists yet at first-touch time)
- `secondary` (dossier text, value prop) is appended after `primary`, but
  **truncated to `MAX_SECONDARY_CHARS`** whenever a non-empty `primary`
  exists, so a long fact-dump can't dilute the embedding centroid away from
  the actual question. When `primary` itself is the dossier (the `write.ts`
  case, no more specific signal available), no truncation applies.
- Each of the four pipeline call sites replaces its inline template-string
  concatenation with a call to this helper.

## Data flow (website-page path, end to end)

1. Operator adds a URL → `insertPendingWebsiteSources` → new
   `client_knowledge_sources` row, `status = pending`.
2. QStash fans out to `/api/pipeline/knowledge-scrape` →
   `brightdataResearch.scrape(url, KNOWLEDGE_SCRAPE_MAX_CHARS)`.
3. Route fetches the client's other `ready` website-page sources' `content`,
   calls `stripBoilerplateParagraphs`, then `chunkText()` on the cleaned
   copy.
4. `deleteChunksForSource` (unchanged, idempotent on QStash retry / re-scrape)
   → `embedAndStoreChunks` (unchanged signature) → `markSourceReady` with the
   **raw** (unstripped) content and its true char count.
5. At query time, `retrieveClientKnowledge` builds the query via
   `buildKnowledgeQueryText`, embeds it (`RETRIEVAL_QUERY` task type,
   unchanged), calls `matchClientKnowledgeChunks` (now also passing
   `queryText` for the RPC's full-text half), applies the similarity floor,
   then near-duplicate suppression, then formats the block appended to the
   generation prompt.

## Error handling

- `stripBoilerplateParagraphs` is pure (no I/O) and cannot fail — worst case
  it strips nothing (empty `siblingContents`).
- If the sibling-content fetch for boilerplate comparison errors, treat it
  the same as "no siblings yet": log via `logEventSafe`, proceed with the
  unstripped content. Boilerplate cleanliness is a quality improvement, not
  a correctness requirement — it must never turn a working scrape into a
  `failed` source.
- `matchClientKnowledgeChunks` / RPC failure: unchanged behavior —
  `retrieveClientKnowledge`'s existing try/catch degrades to `''`, the same
  soft-fail contract as today (a retrieval hiccup must never block sending
  an email).
- The migration is additive (new column, new index, a function replace with
  a superset of the old parameter/return shape) — no data loss, no
  lock-heavy rewrite at this table's current size.

## Testing

Vitest, colocated, Arrange-Act-Assert per `.claude/QUALITY.md`:

- `chunk-text.test.ts` — paragraph packing respects the size budget, overlap
  carries the boundary paragraph forward, an oversized single paragraph
  falls back to a whitespace-snapped split (never mid-word), empty input
  returns `[]`.
- `strip-boilerplate.test.ts` — a paragraph repeated across ≥3 siblings is
  stripped, a unique paragraph is kept, the threshold scales down correctly
  for a 2–3-page client, zero siblings is a no-op.
- `build-query.test.ts` — a non-empty `primary` truncates `secondary` to
  `MAX_SECONDARY_CHARS`; an empty `primary` leaves `secondary` (the dossier)
  untruncated; empty/undefined inputs handled without throwing.
- `client-knowledge.test.ts` — `matchClientKnowledgeChunks` passes
  `queryText` through to the RPC call (mock assertion).
- `client-context.test.ts` — near-duplicate suppression drops a
  >90%-token-overlap second chunk but keeps two genuinely distinct chunks;
  existing `MIN_SIMILARITY` / soft-fail tests unchanged.
- `knowledge-scrape/route.test.ts` — asserts a sibling-fetch failure still
  reaches `markSourceReady` (does not fail the scrape).
- No new integration test against a real Postgres/pgvector instance — the
  RRF SQL itself isn't unit-testable outside a real DB in this codebase's
  existing pattern (neither is the `0014`/`0019` RPC). Correctness here
  relies on manual verification against a Supabase dev branch before merge,
  called out explicitly as a verification step in the implementation plan.

## Rollout

Ships as ordinary code + one additive migration — no feature flag needed
(mirrors this codebase's existing convention of shipping schema/behavior
changes directly rather than flagging them, per `CLAUDE.md`'s "no
backwards-compatibility shims" guidance). New scrapes benefit immediately;
existing clients' already-ingested chunks keep whatever quality they were
ingested with until an operator manually re-scrapes (per the no-backfill
non-goal above).
