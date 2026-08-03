# Knowledge-Base Ingestion & Hybrid Retrieval Upgrade Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix systemic quality problems in the client knowledge-base pipeline (mid-word chunk cuts, boilerplate pollution, silent scrape truncation) and add Postgres-native hybrid (vector + full-text) retrieval with query-construction and near-duplicate fixes — with zero new LLM calls.

**Architecture:** Ingestion side: a paragraph-aware chunker replaces the raw char-sliding-window (`chunk-text.ts`), a new cross-page boilerplate stripper removes repeated nav/footer content before chunking (`strip-boilerplate.ts`), and the knowledge-base scrape path gets its own, much higher character cap separate from the research/dossier scraper's tighter budget. Retrieval side: `match_client_knowledge_chunks` becomes a hybrid search combining vector-cosine rank and Postgres full-text rank via Reciprocal Rank Fusion in one SQL query (new generated `tsvector` column + GIN index), `retrieveClientKnowledge` gets a near-duplicate suppression pass, and a new `buildKnowledgeQueryText` helper stops a long dossier fact-dump from drowning out a prospect's actual question in the embedding query.

**Tech Stack:** Next.js Route Handlers, Supabase Postgres + pgvector + full-text search, `@ai-sdk/google` (`gemini-embedding-001`, unchanged), existing `brightdataResearch` scraper, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-knowledge-hybrid-search-design.md`

## Global Constraints

- `strict: true` TypeScript, no `any`, no `!` without a justifying comment (`.claude/QUALITY.md`).
- Every DB error mapped to `AppError` at the `lib/db/` layer — never a raw Supabase error escapes.
- No `console.log` anywhere. Named exports only.
- Test file colocated as `feature.test.ts`; Arrange-Act-Assert; mock at the boundary (Supabase client, RPC), never business logic.
- No backfill of existing clients' already-ingested chunks — this plan only changes behavior for new/re-scraped ingestion (per the approved design's non-goals).
- No LLM reranking pass — out of scope for this plan.
- Update `.claude/roadmap.md` with progress as you go (project-wide instruction in `CLAUDE.md`).
- Verify each task with `pnpm test`, `pnpm typecheck`, and `pnpm lint` before committing.

---

### Task 1: Migration — hybrid search schema + RPC + types

**Files:**
- Create: `supabase/migrations/0025_knowledge_hybrid_search.sql`
- Modify: `src/types/database.ts:944-953` (`match_client_knowledge_chunks` function type)

**Interfaces:**
- Produces: `client_knowledge_chunks.content_tsv` (generated `tsvector` column), GIN index on it, and `match_client_knowledge_chunks(p_client_id uuid, p_query_embedding vector(768), p_query_text text, p_limit integer)` returning the same shape as before (`source_id, source_title, resource_id, content, similarity`), now ranked by Reciprocal Rank Fusion of vector-cosine rank and full-text rank instead of vector-cosine alone.

- [ ] **Step 1: Write the migration**

```sql
-- Hybrid retrieval for the client knowledge base: combines vector-cosine
-- similarity with Postgres full-text search via Reciprocal Rank Fusion, so
-- exact terms (product names, prices, policy names) aren't outranked by a
-- merely semantically-similar chunk. See
-- docs/superpowers/specs/2026-08-04-knowledge-hybrid-search-design.md.
--
-- 'simple' text-search config deliberately used (no stemming) — this table
-- holds mixed-language client content and there is no per-client language
-- config to pick a dictionary from. Accepted recall trade-off, not solved
-- here.

alter table client_knowledge_chunks
  add column content_tsv tsvector generated always as (to_tsvector('simple', content)) stored;

create index client_knowledge_chunks_content_tsv_idx
  on client_knowledge_chunks using gin (content_tsv);

-- Postgres refuses to CREATE OR REPLACE a function whose parameter list
-- changed (42P13) — same reasoning 0019 used when it added resource_id to
-- this function's return shape. Drop-then-create, matching the exact 0019
-- signature so the drop resolves to the right overload.
drop function if exists match_client_knowledge_chunks(uuid, vector(768), integer);

create function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_limit integer
) returns table (
  source_id uuid,
  source_title text,
  resource_id uuid,
  content text,
  similarity float
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
  -- Reciprocal Rank Fusion, constant 60 (the standard default from the
  -- original RRF paper). No config surface — trivial to compute at this
  -- corpus size (a few hundred chunks per client).
  order by (1.0 / (60 + vec.rnk)) + coalesce(1.0 / (60 + txt.rnk), 0) desc
  limit p_limit;
$$;
```

- [ ] **Step 2: Update the TypeScript function type**

In `src/types/database.ts`, replace the `match_client_knowledge_chunks` entry (currently lines 944-953):

```ts
      match_client_knowledge_chunks: {
        Args: { p_client_id: string; p_query_embedding: number[]; p_query_text: string; p_limit: number }
        Returns: {
          source_id: string
          source_title: string
          resource_id: string | null
          content: string
          similarity: number
        }[]
      }
```

- [ ] **Step 3: Verify the migration applies cleanly**

Run: `pnpm supabase db reset` (or the project's equivalent local-migration-apply command — check `package.json` scripts / `supabase/config.toml` if this differs) against a local/dev Supabase instance, and confirm no errors. If no local Supabase CLI is configured in this environment, skip execution and note it as unverified in the task's commit message — this is expected per the design doc's testing section ("no new integration test against a real Postgres/pgvector instance").

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`
Expected: PASS (no other code references the old 3-arg signature yet — that changes in Task 2).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0025_knowledge_hybrid_search.sql src/types/database.ts
git commit -m "feat: add hybrid vector+full-text search to match_client_knowledge_chunks"
```

---

### Task 2: `matchClientKnowledgeChunks` — thread `queryText` through to the RPC

**Files:**
- Modify: `src/lib/db/client-knowledge.ts:240-258`
- Test: `src/lib/db/client-knowledge.test.ts:239-271`

**Interfaces:**
- Consumes: `match_client_knowledge_chunks` RPC signature from Task 1 (`p_query_text` param).
- Produces: `matchClientKnowledgeChunks(supabase, clientId: string, queryEmbedding: number[], queryText: string, limit: number): Promise<MatchedChunk[]>` — used by Task 3.

- [ ] **Step 1: Write the failing test updates**

In `src/lib/db/client-knowledge.test.ts`, replace the `matchClientKnowledgeChunks` describe block (lines 239-271):

```ts
describe('matchClientKnowledgeChunks', () => {
  it('should call the rpc with the query text and return its rows mapped to camelCase', async () => {
    const rows = [{ source_id: 's1', source_title: 'About', resource_id: null, content: 'x', similarity: 0.9 }]
    const rpc = vi.fn().mockResolvedValue({ data: rows, error: null })
    const supabase = { rpc } as never
    const result = await matchClientKnowledgeChunks(supabase, 'c1', [0.1, 0.2], 'pricing question', 6)
    expect(rpc).toHaveBeenCalledWith('match_client_knowledge_chunks', {
      p_client_id: 'c1', p_query_embedding: [0.1, 0.2], p_query_text: 'pricing question', p_limit: 6,
    })
    expect(result).toEqual([
      { sourceId: 's1', sourceTitle: 'About', resourceId: null, content: 'x', similarity: 0.9 },
    ])
  })

  it('should map the resource id through so a fact can be traced to an attachable file', async () => {
    const rpc = vi.fn().mockResolvedValue({
      data: [
        { source_id: 's1', source_title: 'Deck', resource_id: 'r1', content: 'Three fintech identities.', similarity: 0.8 },
        { source_id: 's2', source_title: 'About', resource_id: null, content: 'Founded 2019.', similarity: 0.7 },
      ],
      error: null,
    })
    const supabase = { rpc } as never

    const result = await matchClientKnowledgeChunks(supabase, 'c1', [0.1], 'q', 6)

    expect(result).toEqual([
      { sourceId: 's1', sourceTitle: 'Deck', resourceId: 'r1', content: 'Three fintech identities.', similarity: 0.8 },
      { sourceId: 's2', sourceTitle: 'About', resourceId: null, content: 'Founded 2019.', similarity: 0.7 },
    ])
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } as never
    await expect(matchClientKnowledgeChunks(supabase, 'c1', [0.1], 'q', 6)).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts -t matchClientKnowledgeChunks`
Expected: FAIL — the current implementation calls `rpc` without `p_query_text` and the function signature only takes 4 args (no `queryText`), so the first test's `toHaveBeenCalledWith` assertion fails and the other two calls are a type error at compile time (acceptable — `tsc` will also fail until Step 3).

- [ ] **Step 3: Update `matchClientKnowledgeChunks`**

In `src/lib/db/client-knowledge.ts`, replace lines 240-258:

```ts
export async function matchClientKnowledgeChunks(
  supabase: SupabaseClient<Database>,
  clientId: string,
  queryEmbedding: number[],
  queryText: string,
  limit: number,
): Promise<MatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_client_knowledge_chunks', {
    p_client_id: clientId,
    p_query_embedding: queryEmbedding,
    p_query_text: queryText,
    p_limit: limit,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to match knowledge chunks', { clientId, cause: error.message })
  }
  return (data ?? []).map((row) => ({
    sourceId: row.source_id, sourceTitle: row.source_title, resourceId: row.resource_id,
    content: row.content, similarity: row.similarity,
  }))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts`
Expected: PASS (the `matchClientKnowledgeChunks` describe block; the rest of the file's tests are untouched and stay green).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/client-knowledge.ts src/lib/db/client-knowledge.test.ts
git commit -m "feat: thread queryText through matchClientKnowledgeChunks for hybrid search"
```

---

### Task 3: Near-duplicate suppression + wire `retrieveClientKnowledge` to hybrid search

**Files:**
- Modify: `src/lib/knowledge/client-context.ts`
- Test: `src/lib/knowledge/client-context.test.ts`

**Interfaces:**
- Consumes: `matchClientKnowledgeChunks(supabase, clientId, queryEmbedding, queryText, limit)` from Task 2.
- Produces: `retrieveClientKnowledge` behavior unchanged from the caller's perspective (same exported signature), now internally passing `queryText` to the RPC and suppressing near-duplicate chunks from the result before formatting.

- [ ] **Step 1: Write the failing test updates**

In `src/lib/knowledge/client-context.test.ts`, update the existing call-shape assertion (around line 50) and add two new tests. Replace the `'should embed the query with RETRIEVAL_QUERY task type and pass the limit through'` test:

```ts
  it('should embed the query with RETRIEVAL_QUERY task type and pass query text + limit through', async () => {
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockResolvedValue([])
    await retrieveClientKnowledge({} as never, { clientId: 'c1', queryText: 'q', limit: 3 })
    expect(embedTextsMock).toHaveBeenCalledWith(
      { clientId: 'c1', actor: 'client_knowledge_retrieval' },
      { values: ['q'], taskType: 'RETRIEVAL_QUERY' },
    )
    expect(matchClientKnowledgeChunksMock).toHaveBeenCalledWith(expect.anything(), 'c1', [0.1], 'q', 3)
  })
```

Then add, after the existing `'should return an empty string when every matched chunk is below the floor'` test at the end of the file (before the closing `})`):

```ts
  it('should drop a near-duplicate chunk that repeats an already-kept chunk almost verbatim', async () => {
    const original = 'Contact us at info@acme.com or call +1 555 0100 for support during business hours'
    const nearDuplicate = `${original} today`
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockResolvedValue([
      chunk({ sourceId: 's1', content: original }),
      chunk({ sourceId: 's2', sourceTitle: 'Footer', content: nearDuplicate }),
    ])
    const result = await retrieveClientKnowledge({} as never, { clientId: 'c1', queryText: 'contact' })
    expect(result).toBe(`- (Pricing) ${original}`)
  })

  it('should keep two chunks whose content has low token overlap', async () => {
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockResolvedValue([
      chunk({ sourceId: 's1', content: 'Starts at $99/mo.' }),
      chunk({ sourceId: 's2', sourceTitle: 'About', content: 'Founded in 2019.' }),
    ])
    const result = await retrieveClientKnowledge({} as never, { clientId: 'c1', queryText: 'q' })
    expect(result).toBe('- (Pricing) Starts at $99/mo.\n- (About) Founded in 2019.')
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/knowledge/client-context.test.ts`
Expected: FAIL — `matchClientKnowledgeChunksMock` assertion is missing the `queryText` arg (compile error until Step 3), and the near-duplicate test fails because nothing dedupes yet.

- [ ] **Step 3: Implement near-duplicate suppression and wire the RPC call**

In `src/lib/knowledge/client-context.ts`, add below the existing `MIN_SIMILARITY` constant:

```ts
// A chunk whose content overlaps an already-kept chunk by more than this
// fraction of tokens is dropped — targets exact/near-duplicate boilerplate
// (e.g. the same footer surviving in two sources) occupying two of the
// limited top-K slots.
const DUPLICATE_TOKEN_OVERLAP = 0.9

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().trim().split(/\s+/).filter((token) => token.length > 0))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function dedupeNearDuplicates(matches: MatchedChunk[]): MatchedChunk[] {
  const kept: MatchedChunk[] = []
  const keptTokenSets: Set<string>[] = []
  for (const match of matches) {
    const tokens = tokenize(match.content)
    const isDuplicate = keptTokenSets.some(
      (existing) => jaccardSimilarity(existing, tokens) > DUPLICATE_TOKEN_OVERLAP,
    )
    if (!isDuplicate) {
      kept.push(match)
      keptTokenSets.push(tokens)
    }
  }
  return kept
}
```

Then replace the body of `retrieveClientKnowledge`:

```ts
export async function retrieveClientKnowledge(
  supabase: SupabaseClient<Database>,
  args: RetrieveClientKnowledgeArgs,
): Promise<string> {
  const { clientId, queryText, limit = DEFAULT_LIMIT, resourceOrdinalById } = args
  if (queryText.trim().length === 0) return ''
  try {
    const [queryEmbedding] = await embedTexts(
      { clientId, actor: ACTOR },
      { values: [queryText], taskType: 'RETRIEVAL_QUERY' },
    )
    if (!queryEmbedding) return ''
    const matches = await matchClientKnowledgeChunks(supabase, clientId, queryEmbedding, queryText, limit)
    const relevant = matches.filter((m) => m.similarity >= MIN_SIMILARITY)
    const deduped = dedupeNearDuplicates(relevant)
    if (deduped.length === 0) return ''
    return deduped.map((m) => `- (${labelFor(m, resourceOrdinalById)}) ${m.content}`).join('\n')
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/knowledge/client-context.test.ts`
Expected: PASS, all tests including the two new ones.

- [ ] **Step 5: Run the full suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/knowledge/client-context.ts src/lib/knowledge/client-context.test.ts
git commit -m "feat: suppress near-duplicate chunks and wire retrieval to hybrid search"
```

---

### Task 4: `buildKnowledgeQueryText` helper

**Files:**
- Create: `src/lib/knowledge/build-query.ts`
- Test: `src/lib/knowledge/build-query.test.ts`

**Interfaces:**
- Produces: `buildKnowledgeQueryText(args: { primary: string; secondary?: string[] }): string` and `MAX_SECONDARY_CHARS` — consumed by Task 5.

- [ ] **Step 1: Write the failing test**

Create `src/lib/knowledge/build-query.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildKnowledgeQueryText, MAX_SECONDARY_CHARS } from './build-query'

describe('buildKnowledgeQueryText', () => {
  it('should return just the primary text when there is no secondary text', () => {
    expect(buildKnowledgeQueryText({ primary: 'What are your prices?' })).toBe('What are your prices?')
  })

  it('should append secondary text after primary', () => {
    const result = buildKnowledgeQueryText({ primary: 'What are your prices?', secondary: ['We sell widgets.'] })
    expect(result).toBe('What are your prices? We sell widgets.')
  })

  it('should truncate secondary text to MAX_SECONDARY_CHARS when primary is present', () => {
    const longSecondary = 'x'.repeat(1000)
    const result = buildKnowledgeQueryText({ primary: 'question', secondary: [longSecondary] })
    expect(result).toBe(`question ${'x'.repeat(MAX_SECONDARY_CHARS)}`)
  })

  it('should not truncate secondary text when primary is empty (dossier-as-primary case)', () => {
    const longSecondary = 'x'.repeat(1000)
    const result = buildKnowledgeQueryText({ primary: '', secondary: [longSecondary] })
    expect(result).toBe(longSecondary)
  })

  it('should filter out empty secondary parts and join the rest with a space', () => {
    const result = buildKnowledgeQueryText({ primary: 'q', secondary: ['', '  ', 'fact one', 'fact two'] })
    expect(result).toBe('q fact one fact two')
  })

  it('should return an empty string when both primary and secondary are empty', () => {
    expect(buildKnowledgeQueryText({ primary: '  ', secondary: ['', '  '] })).toBe('')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/knowledge/build-query.test.ts`
Expected: FAIL with "Cannot find module './build-query'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/knowledge/build-query.ts`:

```ts
export const MAX_SECONDARY_CHARS = 500

export interface BuildKnowledgeQueryTextArgs {
  primary: string
  secondary?: string[]
}

// The most specific available signal (a prospect's actual question, when one
// exists) must dominate the embedding query — a long dossier fact-dump
// concatenated alongside it can pull the embedding's semantic centroid away
// from what the search should actually be about. `secondary` is capped so it
// adds context without drowning `primary`; when `primary` IS the dossier
// (the write.ts case, before any prospect signal exists), no cap applies.
export function buildKnowledgeQueryText(args: BuildKnowledgeQueryTextArgs): string {
  const primary = args.primary.trim()
  const secondaryText = (args.secondary ?? [])
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .join(' ')

  if (primary.length === 0) return secondaryText

  const cappedSecondary = secondaryText.slice(0, MAX_SECONDARY_CHARS)
  return cappedSecondary.length > 0 ? `${primary} ${cappedSecondary}` : primary
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/knowledge/build-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge/build-query.ts src/lib/knowledge/build-query.test.ts
git commit -m "feat: add buildKnowledgeQueryText to keep the embedding query signal-dominant"
```

---

### Task 5: Wire `buildKnowledgeQueryText` into the four pipeline call sites

**Files:**
- Modify: `src/lib/pipeline/write.ts:162-166`
- Modify: `src/lib/pipeline/reply.ts:261-267`
- Modify: `src/lib/pipeline/followup.ts:218-222`
- Modify: `src/lib/pipeline/knowledge-answer.ts:129-134`

**Interfaces:**
- Consumes: `buildKnowledgeQueryText` from Task 4.
- Produces: no change to any of these functions' exported signatures — this task only changes how `queryText` is constructed internally.

- [ ] **Step 1: `write.ts`**

Add the import near the other `@/lib/knowledge` import:

```ts
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
```

Replace lines 162-166:

```ts
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: input.clientId,
    queryText: buildKnowledgeQueryText({ primary: dossierText, secondary: [input.valueProp ?? ''] }),
  })
```

- [ ] **Step 2: `reply.ts`**

Add the import:

```ts
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
```

Replace lines 261-267:

```ts
  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const inboundBody = (inbound.body ?? '').trim()
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: inbound.client_id,
    queryText: buildKnowledgeQueryText(
      inboundBody.length > 0
        ? { primary: inboundBody, secondary: [dossierText, campaign.value_prop ?? ''] }
        : { primary: dossierText, secondary: [campaign.value_prop ?? ''] },
    ),
    resourceOrdinalById,
  })
```

- [ ] **Step 3: `followup.ts`**

Add the import:

```ts
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
```

Replace lines 218-222:

```ts
  const context: LlmCallContext = { clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR }
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: sequence.client_id,
    queryText: buildKnowledgeQueryText({
      primary: (firstOutbound?.body ?? '').trim(),
      secondary: [campaign.value_prop ?? ''],
    }),
  })
```

- [ ] **Step 4: `knowledge-answer.ts`**

Add the import:

```ts
import { buildKnowledgeQueryText } from '@/lib/knowledge/build-query'
```

Replace lines 129-134:

```ts
  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: inbound.client_id,
    queryText: buildKnowledgeQueryText({
      primary: kr.human_answer,
      secondary: [dossierText, campaign.value_prop ?? ''],
    }),
  })
```

- [ ] **Step 5: Run the full pipeline test suite**

Run: `pnpm vitest run src/lib/pipeline`
Expected: PASS — none of `write.test.ts`, `reply.test.ts`, `followup.test.ts`, `knowledge-answer.test.ts` assert the literal `queryText` string (they mock `retrieveClientKnowledge` wholesale or use `expect.objectContaining` without `queryText`), so no test changes are needed here. If any test unexpectedly asserts the old literal template string, update it to use `expect.objectContaining` on the fields it actually cares about instead of the full call shape.

- [ ] **Step 6: Run typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/reply.ts src/lib/pipeline/followup.ts src/lib/pipeline/knowledge-answer.ts
git commit -m "feat: prioritize the prospect's actual signal over the dossier in knowledge queries"
```

---

### Task 6: Paragraph-aware chunker (replaces the raw char-sliding-window)

**Files:**
- Modify: `src/lib/knowledge/chunk-text.ts`
- Test: `src/lib/knowledge/chunk-text.test.ts` (full rewrite — behavior changes)

**Interfaces:**
- Produces: `chunkText(text: string, chunkSize?: number, overlap?: number): TextChunk[]` — same exported signature and `TextChunk` shape as today (`{ index: number; content: string }`), `CHUNK_SIZE_CHARS = 1000`, `CHUNK_OVERLAP_CHARS = 100` (unchanged values), new `MIN_CHUNK_CHARS = 20`. Existing callers (`embedAndStoreChunks` in `src/lib/db/client-knowledge.ts`) need no changes — same call shape.

- [ ] **Step 1: Write the failing tests**

Replace `src/lib/knowledge/chunk-text.test.ts` entirely:

```ts
import { describe, it, expect } from 'vitest'
import { chunkText, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS, MIN_CHUNK_CHARS } from './chunk-text'

describe('chunkText', () => {
  it('should return an empty array for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  it('should keep a single paragraph that is long enough to clear the minimum chunk size', () => {
    const result = chunkText('This is a short paragraph.', 1000, 100)
    expect(result).toEqual([{ index: 0, content: 'This is a short paragraph.' }])
  })

  it('should pack multiple short paragraphs into one chunk when they fit together', () => {
    const text = 'First paragraph.\n\nSecond paragraph.\n\nThird paragraph.'
    const result = chunkText(text, 1000, 100)
    expect(result).toEqual([{ index: 0, content: text }])
  })

  it('should split paragraphs that do not fit together into separate chunks with a whitespace-snapped overlap prefix', () => {
    const paragraphA = Array.from({ length: 100 }, (_, i) => `alpha${i}`).join(' ')
    const paragraphB = Array.from({ length: 100 }, (_, i) => `beta${i}`).join(' ')
    const result = chunkText(`${paragraphA}\n\n${paragraphB}`, 1000, 100)

    expect(result.length).toBe(2)
    expect(result[0]!.content).toBe(paragraphA)
    expect(result[1]!.content.endsWith(paragraphB)).toBe(true)
    expect(result[1]!.content).not.toBe(paragraphB)

    const overlapPrefix = result[1]!.content.slice(0, result[1]!.content.length - paragraphB.length - 2)
    const boundaryIndex = paragraphA.indexOf(overlapPrefix)
    expect(boundaryIndex).toBeGreaterThanOrEqual(0)
    expect(boundaryIndex === 0 || paragraphA[boundaryIndex - 1] === ' ').toBe(true)
  })

  it('should split a single oversized paragraph at whitespace, never mid-word', () => {
    const words = Array.from({ length: 300 }, (_, i) => `token${i}`)
    const text = words.join(' ')
    const result = chunkText(text, 1000, 100)

    expect(result.length).toBeGreaterThan(1)
    for (const chunk of result) {
      for (const piece of chunk.content.split('\n\n')) {
        for (const word of piece.trim().split(/\s+/)) {
          if (word.length === 0) continue
          expect(words).toContain(word)
        }
      }
    }
  })

  it('should drop chunks shorter than MIN_CHUNK_CHARS non-whitespace characters', () => {
    expect(chunkText('ok', 1000, 100)).toEqual([])
    expect(MIN_CHUNK_CHARS).toBe(20)
  })

  it('should use the default chunk size and overlap constants when not provided', () => {
    expect(CHUNK_SIZE_CHARS).toBe(1000)
    expect(CHUNK_OVERLAP_CHARS).toBe(100)
    const paragraphA = Array.from({ length: 100 }, (_, i) => `alpha${i}`).join(' ')
    const paragraphB = Array.from({ length: 100 }, (_, i) => `beta${i}`).join(' ')
    const result = chunkText(`${paragraphA}\n\n${paragraphB}`)
    expect(result.length).toBe(2)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/knowledge/chunk-text.test.ts`
Expected: FAIL — the current sliding-window implementation doesn't respect paragraph/word boundaries and has no `MIN_CHUNK_CHARS` export.

- [ ] **Step 3: Write the implementation**

Replace `src/lib/knowledge/chunk-text.ts` entirely:

```ts
export const CHUNK_SIZE_CHARS = 1000
export const CHUNK_OVERLAP_CHARS = 100
// Defensive backstop against a leftover fragment (e.g. a lone heading) that
// survived chunking — in practice strip-boilerplate.ts should already have
// removed things like this before the chunker ever sees them.
export const MIN_CHUNK_CHARS = 20

export interface TextChunk {
  index: number
  content: string
}

function splitParagraphs(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)
}

// A paragraph alone larger than chunkSize is split at the nearest preceding
// space so a chunk boundary never lands mid-word. Falls back to a hard cut
// only when no space exists at all within the window (a single unbroken
// token longer than chunkSize) — pathological, but still makes progress.
function splitOversizedParagraph(paragraph: string, chunkSize: number): string[] {
  const parts: string[] = []
  let start = 0
  while (start < paragraph.length) {
    let end = Math.min(start + chunkSize, paragraph.length)
    if (end < paragraph.length) {
      const lastSpace = paragraph.lastIndexOf(' ', end)
      if (lastSpace > start) end = lastSpace
    }
    const piece = paragraph.slice(start, end).trim()
    if (piece.length > 0) parts.push(piece)
    start = end
  }
  return parts
}

function nonWhitespaceLength(text: string): number {
  return text.replace(/\s+/g, '').length
}

// Paragraph-aware sliding window: paragraphs are packed greedily up to
// chunkSize, and each chunk after the first is prefixed with a
// whitespace-snapped tail of the previous chunk (the overlap), so a fact
// split across a chunk boundary still appears whole in at least one chunk —
// without ever cutting a word in half, unlike a raw character offset.
export function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE_CHARS,
  overlap: number = CHUNK_OVERLAP_CHARS,
): TextChunk[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const paragraphs = splitParagraphs(trimmed).flatMap((paragraph) =>
    paragraph.length > chunkSize ? splitOversizedParagraph(paragraph, chunkSize) : [paragraph],
  )
  if (paragraphs.length === 0) return []

  const packed: string[] = []
  let current = ''
  for (const paragraph of paragraphs) {
    const candidate = current.length === 0 ? paragraph : `${current}\n\n${paragraph}`
    if (candidate.length > chunkSize && current.length > 0) {
      packed.push(current)
      current = paragraph
    } else {
      current = candidate
    }
  }
  if (current.length > 0) packed.push(current)

  const withOverlap = packed.map((chunk, i) => {
    if (i === 0 || overlap <= 0) return chunk
    const prev = packed[i - 1]!
    const tailStart = Math.max(0, prev.length - overlap)
    let snappedStart = tailStart
    if (tailStart > 0) {
      const nextSpace = prev.indexOf(' ', tailStart)
      snappedStart = nextSpace === -1 ? tailStart : nextSpace + 1
    }
    const tail = prev.slice(snappedStart).trim()
    return tail.length > 0 ? `${tail}\n\n${chunk}` : chunk
  })

  return withOverlap
    .filter((content) => nonWhitespaceLength(content) >= MIN_CHUNK_CHARS)
    .map((content, index) => ({ index, content }))
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/knowledge/chunk-text.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the DB-layer tests that depend on `chunkText`**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts`
Expected: PASS, no changes needed to that file. Traced by hand: `embedAndStoreChunks`'s test feeds `'a'.repeat(1500)` — a single paragraph with no spaces at all, exceeding `chunkSize` (1000). `splitOversizedParagraph` hits its no-space fallback and hard-cuts it into `['a'.repeat(1000), 'a'.repeat(500)]`; the packer can't merge them back (combined length exceeds 1000), so it still produces exactly 2 chunks — the same count the test asserts (`chunk_index: 0` / `chunk_index: 1`, two embeddings via `objectContaining`). The overlap prefix changes chunk 1's exact `content` (now `'a'.repeat(100) + '\n\n' + 'a'.repeat(500)'`, not a bare `'a'.repeat(500)`), but that test never asserts `content`, only `chunk_index` and `embedding` — unaffected.

- [ ] **Step 6: Commit**

```bash
git add src/lib/knowledge/chunk-text.ts src/lib/knowledge/chunk-text.test.ts
git commit -m "feat: replace fixed-char chunking with a paragraph-aware, word-safe packer"
```

---

### Task 7: Cross-page boilerplate stripper

**Files:**
- Create: `src/lib/knowledge/strip-boilerplate.ts`
- Test: `src/lib/knowledge/strip-boilerplate.test.ts`

**Interfaces:**
- Produces: `stripBoilerplateParagraphs(content: string, siblingContents: string[]): string` — consumed by Task 10.

- [ ] **Step 1: Write the failing test**

Create `src/lib/knowledge/strip-boilerplate.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { stripBoilerplateParagraphs } from './strip-boilerplate'

describe('stripBoilerplateParagraphs', () => {
  it('should return content unchanged when there are fewer than 2 siblings', () => {
    const content = 'Nav menu.\n\nUnique page content.'
    expect(stripBoilerplateParagraphs(content, [])).toBe(content)
    expect(stripBoilerplateParagraphs(content, ['Nav menu.\n\nOther page.'])).toBe(content)
  })

  it('should strip a paragraph that appears in every sibling (2-sibling client)', () => {
    const content = 'Nav menu.\n\nPage A unique content.'
    const siblings = ['Nav menu.\n\nPage B content.', 'Nav menu.\n\nPage C content.']
    const result = stripBoilerplateParagraphs(content, siblings)
    expect(result).toBe('Page A unique content.')
  })

  it('should keep a paragraph that only matches one of several siblings', () => {
    const content = 'Nav menu.\n\nShared with just one page.'
    const siblings = [
      'Nav menu.\n\nOther A.',
      'Nav menu.\n\nOther B.',
      'Nav menu.\n\nShared with just one page.',
    ]
    const result = stripBoilerplateParagraphs(content, siblings)
    expect(result).toBe('Shared with just one page.')
  })

  it('should keep unique content untouched', () => {
    const content = 'Completely unique paragraph.'
    const siblings = ['Something else.', 'Something else too.']
    expect(stripBoilerplateParagraphs(content, siblings)).toBe(content)
  })

  it('should treat whitespace-only differences as the same paragraph', () => {
    const content = 'Nav   menu.\n\nUnique content.'
    const siblings = ['Nav menu.\n\nOther.', 'Nav menu.\n\nOther2.']
    const result = stripBoilerplateParagraphs(content, siblings)
    expect(result).toBe('Unique content.')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/knowledge/strip-boilerplate.test.ts`
Expected: FAIL with "Cannot find module './strip-boilerplate'".

- [ ] **Step 3: Write the implementation**

Create `src/lib/knowledge/strip-boilerplate.ts`:

```ts
function normalizeParagraph(paragraph: string): string {
  return paragraph.trim().replace(/\s+/g, ' ')
}

function splitParagraphs(content: string): string[] {
  return content.split(/\n\s*\n/)
}

// A paragraph shared across enough of a client's other already-scraped pages
// is site chrome (nav, footer, cookie banner), not page content — strip it
// before chunking so it doesn't dilute the embedding signal or occupy a
// chunk slot. Needs at least 2 siblings to have anything to compare against;
// a client's first scraped page is left untouched (nothing to compare yet).
export function stripBoilerplateParagraphs(content: string, siblingContents: string[]): string {
  if (siblingContents.length < 2) return content

  // At least 2 occurrences required regardless of sibling count (avoids
  // stripping content two pages coincidentally share), capped at 3 so a
  // large site doesn't require unanimous repetition.
  const threshold = Math.max(2, Math.min(3, Math.ceil(siblingContents.length / 2)))
  const siblingParagraphSets = siblingContents.map(
    (sibling) => new Set(splitParagraphs(sibling).map(normalizeParagraph)),
  )

  const kept = splitParagraphs(content).filter((paragraph) => {
    const key = normalizeParagraph(paragraph)
    if (key.length === 0) return false
    const occurrences = siblingParagraphSets.filter((set) => set.has(key)).length
    return occurrences < threshold
  })

  return kept.join('\n\n')
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/knowledge/strip-boilerplate.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge/strip-boilerplate.ts src/lib/knowledge/strip-boilerplate.test.ts
git commit -m "feat: strip cross-page boilerplate paragraphs before chunking"
```

---

### Task 8: `listReadySiblingWebsiteContents` DB helper

**Files:**
- Modify: `src/lib/db/client-knowledge.ts`
- Test: `src/lib/db/client-knowledge.test.ts`

**Interfaces:**
- Produces: `listReadySiblingWebsiteContents(supabase, clientId: string, excludeSourceId: string): Promise<string[]>` — consumed by Task 10.

- [ ] **Step 1: Write the failing test**

In `src/lib/db/client-knowledge.test.ts`, add this describe block after the `matchClientKnowledgeChunks` block:

```ts
describe('listReadySiblingWebsiteContents', () => {
  it('should return content from ready website-page siblings, excluding the given source and nulls', async () => {
    const rows = [{ content: 'Sibling one.' }, { content: null }, { content: 'Sibling two.' }]
    const eq3 = vi.fn().mockReturnValue({ neq: () => Promise.resolve({ data: rows, error: null }) })
    const eq2 = vi.fn().mockReturnValue({ eq: eq3 })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const supabase = { from: () => ({ select: () => ({ eq: eq1 }) }) } as never

    const result = await listReadySiblingWebsiteContents(supabase, 'c1', 's1')

    expect(result).toEqual(['Sibling one.', 'Sibling two.'])
    expect(eq1).toHaveBeenCalledWith('client_id', 'c1')
    expect(eq2).toHaveBeenCalledWith('source_type', 'website_page')
    expect(eq3).toHaveBeenCalledWith('status', 'ready')
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const eq3 = vi.fn().mockReturnValue({ neq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) })
    const eq2 = vi.fn().mockReturnValue({ eq: eq3 })
    const eq1 = vi.fn().mockReturnValue({ eq: eq2 })
    const supabase = { from: () => ({ select: () => ({ eq: eq1 }) }) } as never
    await expect(listReadySiblingWebsiteContents(supabase, 'c1', 's1')).rejects.toBeInstanceOf(AppError)
  })
})
```

And add `listReadySiblingWebsiteContents` to the import list at the top of the test file.

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts -t listReadySiblingWebsiteContents`
Expected: FAIL — export does not exist yet.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/client-knowledge.ts`, add after `matchClientKnowledgeChunks`:

```ts
// Used by the boilerplate stripper before chunking a new website page — the
// client's other already-scraped, ready pages are the comparison set for
// detecting repeated nav/footer content. Excludes the source being processed
// (it may already have a stale `content` from a prior scrape attempt).
export async function listReadySiblingWebsiteContents(
  supabase: SupabaseClient<Database>,
  clientId: string,
  excludeSourceId: string,
): Promise<string[]> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .select('content')
    .eq('client_id', clientId)
    .eq('source_type', 'website_page')
    .eq('status', 'ready')
    .neq('id', excludeSourceId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list sibling knowledge sources', { clientId, cause: error.message })
  }
  return (data ?? [])
    .map((row) => row.content)
    .filter((content): content is string => content !== null)
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/client-knowledge.ts src/lib/db/client-knowledge.test.ts
git commit -m "feat: add listReadySiblingWebsiteContents for cross-page boilerplate detection"
```

---

### Task 9: Brightdata scrape cap split

**Files:**
- Modify: `src/lib/research/brightdata.ts:61-90`
- Test: `src/lib/research/brightdata.test.ts:51-71`

**Interfaces:**
- Produces: `brightdataResearch.scrape(url: string, maxChars?: number): Promise<string>` — default unchanged (`MAX_SCRAPE_CHARS = 6_000`), consumed with a higher value by Task 10. The `WebResearch` interface's `scrape` method type (`src/lib/research/provider.ts`, if it declares an explicit signature) must be checked and widened to match — read that file first; if `scrape(url: string): Promise<string>` is declared there, update it to `scrape(url: string, maxChars?: number): Promise<string>`.

- [ ] **Step 1: Write the failing test**

In `src/lib/research/brightdata.test.ts`, add to the `describe('brightdataResearch.scrape', ...)` block:

```ts
  it('should accept a custom maxChars ceiling and truncate to it instead of the default', async () => {
    fetchTextMock.mockResolvedValue('x'.repeat(50_000))
    const text = await brightdataResearch.scrape('https://acme.com/huge', 40_000)
    expect(text).toHaveLength(40_000)
  })
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/research/brightdata.test.ts -t "custom maxChars"`
Expected: FAIL — `scrape` currently takes only one argument.

- [ ] **Step 3: Update the implementation**

In `src/lib/research/brightdata.ts`, first check `src/lib/research/provider.ts` for the `WebResearch` interface's `scrape` signature and widen it there if it declares one explicitly (add the same optional `maxChars` parameter). Then replace the `scrape` method (lines 61-90):

```ts
  async scrape(url: string, maxChars: number = MAX_SCRAPE_CHARS): Promise<string> {
    try {
      // Web Unlocker returns the page as markdown when data_format=markdown,
      // which is far cheaper to feed to the model than raw HTML.
      const body = await fetchText(
        BRIGHTDATA_UNLOCKER_URL,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            zone: env.BRIGHTDATA_SCRAPE_ZONE,
            url,
            format: 'raw',
            data_format: 'markdown',
          }),
        },
        SCRAPE_TIMEOUT_MS,
      )
      return body.slice(0, maxChars)
    } catch (cause) {
      if (cause instanceof AppError) throw cause
      throw new AppError('EXTERNAL_ERROR', 'Brightdata scrape failed', {
        url,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
  },
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/research/brightdata.test.ts`
Expected: PASS — including the existing `'should truncate page text to the max length when the page is oversized'` test, which still gets the 6,000-char default.

- [ ] **Step 5: Run the research pipeline's tests to confirm the default is unaffected**

Run: `pnpm vitest run src/lib/research`
Expected: PASS — `agent.ts`'s dossier-building caller doesn't pass `maxChars`, so it keeps using the 6,000-char default.

- [ ] **Step 6: Commit**

```bash
git add src/lib/research/brightdata.ts src/lib/research/brightdata.test.ts
git commit -m "feat: let brightdataResearch.scrape accept a custom max-chars ceiling"
```

---

### Task 10: Wire boilerplate stripping, the new chunker, and the higher scrape cap into the knowledge-scrape route

**Files:**
- Modify: `src/app/api/pipeline/knowledge-scrape/route.ts`
- Test: `src/app/api/pipeline/knowledge-scrape/route.test.ts`

**Interfaces:**
- Consumes: `stripBoilerplateParagraphs` (Task 7), `listReadySiblingWebsiteContents` (Task 8), `brightdataResearch.scrape(url, maxChars)` (Task 9), the paragraph-aware `chunkText` (Task 6, used internally by the unchanged `embedAndStoreChunks`).
- Produces: no exported interface change — this is the final integration point; `client_knowledge_sources.content`/`char_count` continue to store the raw scrape, only the text handed to `embedAndStoreChunks` is boilerplate-stripped.

- [ ] **Step 1: Write the failing test updates**

In `src/app/api/pipeline/knowledge-scrape/route.test.ts`, add two new mocks and reset them, then add three new tests.

Add to the top-level mocks:

```ts
const listReadySiblingWebsiteContentsMock = vi.fn()
const stripBoilerplateParagraphsMock = vi.fn()
```

Update the `vi.mock('@/lib/db/client-knowledge', ...)` call to also export `listReadySiblingWebsiteContents`:

```ts
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  deleteChunksForSource: (...a: unknown[]) => deleteChunksForSourceMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
  markSourceReady: (...a: unknown[]) => markSourceReadyMock(...a),
  markSourceFailed: (...a: unknown[]) => markSourceFailedMock(...a),
  listReadySiblingWebsiteContents: (...a: unknown[]) => listReadySiblingWebsiteContentsMock(...a),
}))
```

Add a new mock for the stripper:

```ts
vi.mock('@/lib/knowledge/strip-boilerplate', () => ({
  stripBoilerplateParagraphs: (...a: unknown[]) => stripBoilerplateParagraphsMock(...a),
}))
```

Update `beforeEach` to add:

```ts
  listReadySiblingWebsiteContentsMock.mockReset().mockResolvedValue([])
  stripBoilerplateParagraphsMock.mockReset().mockImplementation((content: string) => content)
```

Add these tests inside the `describe('POST /api/pipeline/knowledge-scrape', ...)` block:

```ts
  it('should scrape with the knowledge-base max-chars ceiling, not the research default', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockResolvedValue('content')
    await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))
    expect(scrapeMock).toHaveBeenCalledWith('https://a.com/1', 40_000)
  })

  it('should strip boilerplate using sibling content before chunking, but store the raw content on the source', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockResolvedValue('Nav menu.\n\nReal content.')
    listReadySiblingWebsiteContentsMock.mockResolvedValue(['Nav menu.\n\nOther.'])
    stripBoilerplateParagraphsMock.mockReturnValue('Real content.')

    const res = await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))

    expect(res.status).toBe(200)
    expect(listReadySiblingWebsiteContentsMock).toHaveBeenCalledWith(
      expect.anything(), 'c1', 'f47ac10b-58cc-4372-a567-0e02b2c3d479',
    )
    expect(stripBoilerplateParagraphsMock).toHaveBeenCalledWith('Nav menu.\n\nReal content.', ['Nav menu.\n\nOther.'])
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(
      expect.anything(), expect.objectContaining({ content: 'Real content.' }),
    )
    expect(markSourceReadyMock).toHaveBeenCalledWith(
      expect.anything(), 'f47ac10b-58cc-4372-a567-0e02b2c3d479', 'Nav menu.\n\nReal content.', 24,
    )
  })

  it('should proceed unstripped and log a warning when the sibling lookup fails', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 'f47ac10b-58cc-4372-a567-0e02b2c3d479', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockResolvedValue('Only content.')
    listReadySiblingWebsiteContentsMock.mockRejectedValue(new AppError('DB_ERROR', 'boom'))

    const res = await POST(req({ sourceId: 'f47ac10b-58cc-4372-a567-0e02b2c3d479' }))

    expect(res.status).toBe(200)
    expect(stripBoilerplateParagraphsMock).toHaveBeenCalledWith('Only content.', [])
    expect(markSourceFailedMock).not.toHaveBeenCalled()
    expect(logEventSafeMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'knowledge.sibling_lookup_failed' }),
    )
  })
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm vitest run src/app/api/pipeline/knowledge-scrape/route.test.ts`
Expected: FAIL on the three new tests — the route doesn't call `listReadySiblingWebsiteContents`, `stripBoilerplateParagraphs`, or pass a `maxChars` to `scrape` yet.

- [ ] **Step 3: Update the route**

Replace `src/app/api/pipeline/knowledge-scrape/route.ts` in full:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getSourceById, deleteChunksForSource, embedAndStoreChunks, markSourceReady, markSourceFailed,
  listReadySiblingWebsiteContents,
} from '@/lib/db/client-knowledge'
import { brightdataResearch } from '@/lib/research/brightdata'
import { stripBoilerplateParagraphs } from '@/lib/knowledge/strip-boilerplate'
import { isAppError, AppError } from '@/lib/errors/app-error'
import { logEventSafe, logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const ACTOR = 'knowledge_scrape'
// Sized to store and chunk a whole marketing page, not to fit one LLM
// prompt — deliberately much higher than the research/dossier scraper's
// MAX_SCRAPE_CHARS (6,000), which shares brightdataResearch.scrape but has a
// different, tighter budget need.
const KNOWLEDGE_SCRAPE_MAX_CHARS = 40_000
const bodySchema = z.object({ sourceId: z.string().uuid() })

export async function POST(request: Request) {
  let clientId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const { sourceId } = bodySchema.parse(JSON.parse(rawBody))
    const admin = createAdminClient()

    const source = await getSourceById(admin, sourceId)
    if (!source) return NextResponse.json({ error: 'source_not_found' }, { status: 404 })
    clientId = source.client_id
    if (source.source_type !== 'website_page' || !source.url) {
      return NextResponse.json({ error: 'not_a_website_page' }, { status: 400 })
    }

    try {
      const content = await brightdataResearch.scrape(source.url, KNOWLEDGE_SCRAPE_MAX_CHARS)

      // Boilerplate cleanliness is a quality improvement, not a correctness
      // requirement — a failure here must never turn a working scrape into a
      // failed source, so it's caught locally and degrades to "no siblings".
      let siblingContents: string[] = []
      try {
        siblingContents = await listReadySiblingWebsiteContents(admin, source.client_id, sourceId)
      } catch (siblingError) {
        await logEventSafe({
          clientId: source.client_id, actor: ACTOR, type: 'knowledge.sibling_lookup_failed',
          severity: 'warn',
          payload: { sourceId, message: siblingError instanceof AppError ? siblingError.message : 'unknown' },
        })
      }
      const cleanedContent = stripBoilerplateParagraphs(content, siblingContents)

      // Delete-then-insert (not append) keeps this idempotent across QStash's
      // own automatic retries and the explicit re-scrape action — both funnel
      // through this same route and must never leave duplicate chunks behind.
      await deleteChunksForSource(admin, sourceId)
      await embedAndStoreChunks(admin, { clientId: source.client_id, sourceId, content: cleanedContent, actor: ACTOR })
      // The raw (unstripped) scrape is what's stored on the source row — the
      // audit trail / re-derivation source of truth. Only the text handed to
      // the chunker above is cleaned.
      await markSourceReady(admin, sourceId, content, content.length)
      await logEventSafe({
        clientId: source.client_id, actor: ACTOR, type: 'knowledge.page_scraped',
        payload: { sourceId, url: source.url, charCount: content.length },
      })
    } catch (scrapeError) {
      const message = scrapeError instanceof AppError ? scrapeError.message : 'Scrape failed'
      await markSourceFailed(admin, sourceId, message)
      await logEventSafe({
        clientId: source.client_id, actor: ACTOR, type: 'knowledge.page_scrape_failed',
        severity: 'warn', payload: { sourceId, url: source.url, message },
      })
    }

    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({ clientId, actor: ACTOR, type: 'knowledge.scrape_route_failed', source: 'pipeline', error })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/pipeline/knowledge-scrape/route.test.ts`
Expected: PASS — all existing tests (unaffected by the default `stripBoilerplateParagraphsMock` passthrough and empty-siblings default) plus the three new ones.

- [ ] **Step 5: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS.

- [ ] **Step 6: Update `.claude/roadmap.md`**

Add an entry documenting this feature's completion (source scrape cap raised, paragraph-aware chunking, cross-page boilerplate stripping, hybrid vector+full-text retrieval with RRF, near-duplicate suppression, prospect-signal-first query construction), following the existing entry format/style in that file (see the "Client knowledge base" entries for the pattern) and referencing this plan and its spec.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/pipeline/knowledge-scrape/route.ts src/app/api/pipeline/knowledge-scrape/route.test.ts .claude/roadmap.md
git commit -m "feat: wire boilerplate stripping and the raised scrape cap into knowledge ingestion"
```
