# Client Knowledge Base Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an operator-only, per-client knowledge base (scraped website pages + PDFs) with pgvector-backed semantic retrieval, and wire it into the write/followup/reply/knowledge-answer AI pipelines as grounding beyond the current freeform `value_prop` string.

**Architecture:** Two new client-scoped tables (`client_knowledge_sources`, `client_knowledge_chunks`) behind a fully operator-only RLS policy. Sitemap discovery via `<loc>` regex extraction with a Brightdata-crawl fallback. Selected pages fan out one QStash job each to a scrape+chunk+embed consumer route (parallel by construction). PDFs are extracted, chunked, and embedded inline on upload (no external network call, so no QStash needed). A shared `retrieveClientKnowledge` helper embeds a per-case query (dossier + value prop) and pulls the top-K most relevant chunks via a `match_client_knowledge_chunks` SQL function, formatted into an "About our company" block appended to all four AI copy-generation call sites.

**Tech Stack:** Next.js Route Handlers, Supabase Postgres + pgvector + Storage, `@ai-sdk/google` (`gemini-embedding-001` for embeddings, `gemini-3-flash-preview` already in use for generation), Upstash QStash, `unpdf` (new dependency, PDF text extraction), existing `brightdataResearch` client for scraping.

## Global Constraints

- `strict: true` TypeScript, no `any`, no `!` without a justifying comment (`.claude/QUALITY.md`).
- All external/DB inputs validated with Zod at the boundary.
- Every DB error mapped to `AppError` at the `lib/db/` layer — never a raw Supabase error escapes.
- Every route: validate input → check auth (`role === 'operator'`) → act → best-effort `logEventSafe`/`logEvent` audit log, in that order.
- No `console.log` anywhere.
- Named exports only (default exports reserved for Next.js pages/layouts).
- Every new external call (Brightdata, Gemini embeddings, QStash) has an explicit timeout.
- Test file colocated as `feature.test.ts`; Arrange-Act-Assert; mock at the boundary (Supabase client, `fetch`, QStash), never business logic.
- This repo has **no `.test.tsx` files** — UI components are verified via `tsc`/`eslint`/`pnpm build`, not unit tests. Don't introduce component tests; that would be inconsistent with the rest of the codebase.
- Update `.claude/roadmap.md` with progress as you go (project-wide instruction in `CLAUDE.md`).

---

### Task 1: Database schema — migration + TypeScript types

**Files:**
- Create: `supabase/migrations/0014_client_knowledge.sql`
- Modify: `src/types/database.ts` (add two table types, two enum entries, one function type)

**Interfaces:**
- Produces: tables `client_knowledge_sources` (`id, client_id, source_type: 'website_page'|'pdf', url, storage_path, title, content, char_count, status: 'pending'|'ready'|'failed', error_message, created_by, created_at, scraped_at`) and `client_knowledge_chunks` (`id, client_id, source_id, chunk_index, content, embedding: number[]`); SQL function `match_client_knowledge_chunks(p_client_id uuid, p_query_embedding vector(768), p_limit integer)`.

- [ ] **Step 1: Write the migration**

```sql
-- Client knowledge base: operator-only per-client website pages + PDFs, chunked
-- and embedded for semantic retrieval, grounding the write/followup/reply/
-- knowledge-answer AI pipelines beyond the freeform campaigns.value_prop string.
-- Deliberately NOT added to the shared client-or-operator RLS loop in
-- 0002_rls_policies.sql — this content must never be visible to client-role
-- sessions, only to the operator who curates it.

create extension if not exists vector;

create type knowledge_source_type as enum ('website_page', 'pdf');
create type knowledge_source_status as enum ('pending', 'ready', 'failed');

create table client_knowledge_sources (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  source_type   knowledge_source_type not null,
  url           text,
  storage_path  text,
  title         text not null,
  content       text,
  char_count    integer,
  status        knowledge_source_status not null default 'pending',
  error_message text,
  created_by    uuid not null references app_users(id),
  created_at    timestamptz not null default now(),
  scraped_at    timestamptz
);

-- Dedup guard for website pages: NULL url (pdf rows) is never subject to this
-- constraint, since a partial unique index ignores rows failing its WHERE.
create unique index client_knowledge_sources_url_uniq
  on client_knowledge_sources (client_id, url) where url is not null;

create index client_knowledge_sources_client_id_idx on client_knowledge_sources (client_id);

create table client_knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  source_id    uuid not null references client_knowledge_sources(id) on delete cascade,
  chunk_index  integer not null,
  content      text not null,
  embedding    vector(768) not null,
  created_at   timestamptz not null default now()
);

create index client_knowledge_chunks_source_id_idx on client_knowledge_chunks (source_id);
create index client_knowledge_chunks_embedding_idx
  on client_knowledge_chunks using hnsw (embedding vector_cosine_ops);

alter table client_knowledge_sources enable row level security;
alter table client_knowledge_chunks enable row level security;

create policy client_knowledge_sources_all on client_knowledge_sources
  for all using (is_operator()) with check (is_operator());
create policy client_knowledge_chunks_all on client_knowledge_chunks
  for all using (is_operator()) with check (is_operator());

-- SECURITY DEFINER so it can read across the operator-only RLS from
-- server-side pipeline code (admin client) — always called with a specific
-- client_id, never trusts the caller's session for scoping.
create or replace function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_limit integer
) returns table (
  source_id uuid,
  source_title text,
  content text,
  similarity float
) language sql stable security definer set search_path = public as $$
  select c.source_id, s.title as source_title, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  where c.client_id = p_client_id
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;

-- Private bucket: PDFs may contain sensitive client business content, unlike
-- the public client-logos bucket. Writes are operator-only, enforced at the
-- API route layer via the service-role client (same convention as
-- 0013_client_branding.sql's storage bucket — no storage RLS policies used
-- anywhere in this codebase). Reads go through a signed URL generated
-- server-side, never a public URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-knowledge-pdfs',
  'client-knowledge-pdfs',
  false,
  10485760, -- 10MB
  array['application/pdf']
)
on conflict (id) do nothing;
```

- [ ] **Step 2: Add the TypeScript types**

In `src/types/database.ts`, insert two new entries into the `Tables` object (place them right after the `case_knowledge` block, before `emails`, to keep knowledge-related tables adjacent):

```ts
      client_knowledge_sources: {
        Row: {
          id: string
          client_id: string
          source_type: Database['public']['Enums']['knowledge_source_type']
          url: string | null
          storage_path: string | null
          title: string
          content: string | null
          char_count: number | null
          status: Database['public']['Enums']['knowledge_source_status']
          error_message: string | null
          created_by: string
          created_at: string
          scraped_at: string | null
        }
        Insert: {
          id?: string
          client_id: string
          source_type: Database['public']['Enums']['knowledge_source_type']
          url?: string | null
          storage_path?: string | null
          title: string
          content?: string | null
          char_count?: number | null
          status?: Database['public']['Enums']['knowledge_source_status']
          error_message?: string | null
          created_by: string
          created_at?: string
          scraped_at?: string | null
        }
        Update: Partial<Database['public']['Tables']['client_knowledge_sources']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'client_knowledge_sources_client_id_fkey'
            columns: ['client_id']
            isOneToOne: false
            referencedRelation: 'clients'
            referencedColumns: ['id']
          },
        ]
      }
      client_knowledge_chunks: {
        Row: {
          id: string
          client_id: string
          source_id: string
          chunk_index: number
          content: string
          embedding: string
          created_at: string
        }
        Insert: {
          id?: string
          client_id: string
          source_id: string
          chunk_index: number
          content: string
          embedding: number[]
          created_at?: string
        }
        Update: Partial<Database['public']['Tables']['client_knowledge_chunks']['Insert']>
        Relationships: [
          {
            foreignKeyName: 'client_knowledge_chunks_source_id_fkey'
            columns: ['source_id']
            isOneToOne: false
            referencedRelation: 'client_knowledge_sources'
            referencedColumns: ['id']
          },
        ]
      }
```

(`embedding` is typed `string` on `Row` because PostgREST serializes `vector` columns back as their text form — this column is written but never read back by application code, only queried through the `match_client_knowledge_chunks` RPC, which returns `content`/`similarity`, not the raw vector. `Insert` accepts `number[]`: supabase-js JSON-serializes a plain number array to exactly the bracket literal `vector`'s input parser expects.)

Add the two enums to the `Enums` object (after `author_kind: 'agent' | 'human'`):

```ts
      knowledge_source_type: 'website_page' | 'pdf'
      knowledge_source_status: 'pending' | 'ready' | 'failed'
```

Add the function type to the `Functions` object (alongside `find_stuck_cases`):

```ts
      match_client_knowledge_chunks: {
        Args: { p_client_id: string; p_query_embedding: number[]; p_limit: number }
        Returns: {
          source_id: string
          source_title: string
          content: string
          similarity: number
        }[]
      }
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: no new errors (the new types aren't consumed by any code yet, so this only checks the edit itself is syntactically/structurally valid).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0014_client_knowledge.sql src/types/database.ts
git commit -m "feat: add client knowledge base schema (sources, chunks, pgvector retrieval)"
```

---

### Task 2: Embedding wrapper (`embedTexts`)

**Files:**
- Modify: `src/lib/llm/client.ts`
- Test: `src/lib/llm/client.test.ts` (extend if it exists, else create)

**Interfaces:**
- Consumes: `LlmCallContext` (existing), `AppError`, `logEventSafe`/`logError` (existing imports already in this file).
- Produces: `embedTexts(context: LlmCallContext, args: { values: string[]; taskType: 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY' }): Promise<number[][]>` — used by Task 7 (chunk embedding) and Task 8 (query embedding).

- [ ] **Step 1: Check for an existing test file and write the failing test**

Run: `ls src/lib/llm/client.test.ts` — if it doesn't exist, create it fresh with just this suite; if it exists, append this `describe` block.

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const embedManyMock = vi.fn()
vi.mock('ai', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ai')>()
  return { ...actual, embedMany: (...args: unknown[]) => embedManyMock(...args) }
})
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: vi.fn().mockResolvedValue(undefined),
  logError: vi.fn().mockResolvedValue(undefined),
}))

import { embedTexts } from './client'
import { AppError } from '@/lib/errors/app-error'

const context = { clientId: 'c1', actor: 'test' }

beforeEach(() => {
  embedManyMock.mockReset()
})

describe('embedTexts', () => {
  it('should return an empty array without calling the model when values is empty', async () => {
    const result = await embedTexts(context, { values: [], taskType: 'RETRIEVAL_DOCUMENT' })
    expect(result).toEqual([])
    expect(embedManyMock).not.toHaveBeenCalled()
  })

  it('should return the embeddings in order', async () => {
    embedManyMock.mockResolvedValue({
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
      usage: { tokens: 12 },
    })
    const result = await embedTexts(context, { values: ['a', 'b'], taskType: 'RETRIEVAL_DOCUMENT' })
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]])
  })

  it('should pass the taskType through providerOptions', async () => {
    embedManyMock.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 3 } })
    await embedTexts(context, { values: ['q'], taskType: 'RETRIEVAL_QUERY' })
    const call = embedManyMock.mock.calls[0]![0] as { providerOptions: { google: { taskType: string } } }
    expect(call.providerOptions.google.taskType).toBe('RETRIEVAL_QUERY')
  })

  it('should throw AppError EXTERNAL_ERROR when the model call fails', async () => {
    embedManyMock.mockRejectedValue(new Error('quota exceeded'))
    await expect(embedTexts(context, { values: ['a'], taskType: 'RETRIEVAL_DOCUMENT' }))
      .rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/llm/client.test.ts`
Expected: FAIL — `embedTexts` is not exported from `./client`.

- [ ] **Step 3: Implement `embedTexts` in `src/lib/llm/client.ts`**

Add `embedMany` to the existing `ai` import at the top of the file:

```ts
import { generateObject, generateText as sdkGenerateText, embedMany, isStepCount, type ToolSet } from 'ai'
```

Add these constants near `MODEL_ID`/`DEFAULT_TIMEOUT_MS`:

```ts
const EMBEDDING_MODEL_ID = 'gemini-embedding-001'
// Matches the vector(768) column in client_knowledge_chunks — gemini-embedding-001
// supports Matryoshka truncation to 768/1536/3072; 768 keeps the HNSW index and
// per-chunk storage small without a meaningful quality loss for this use case.
const EMBEDDING_DIMENSIONS = 768
const EMBED_TIMEOUT_MS = 15_000

const embeddingModel = google.textEmbeddingModel(EMBEDDING_MODEL_ID)
```

Add the usage logger (mirrors `logUsage` above it, but embedding usage is shaped `{ tokens }`, not prompt/completion):

```ts
async function logEmbedUsage(context: LlmCallContext, tokens: number, count: number, durationMs: number): Promise<void> {
  await logEventSafe({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.embedded',
    severity: 'info',
    source: 'gemini',
    payload: { model: EMBEDDING_MODEL_ID, count, tokens, durationMs },
  })
}
```

Add the exported function at the end of the file:

```ts
export type EmbeddingTaskType = 'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'

export interface EmbedTextsArgs {
  values: string[]
  taskType: EmbeddingTaskType
}

// RETRIEVAL_DOCUMENT for chunks being stored, RETRIEVAL_QUERY for the search
// query at read time — gemini-embedding-001 produces asymmetric embeddings
// tuned per task, meaningfully improving retrieval quality over a single shared
// task type for both sides.
export async function embedTexts(context: LlmCallContext, args: EmbedTextsArgs): Promise<number[][]> {
  if (args.values.length === 0) return []
  const startedAt = Date.now()
  try {
    const result = await withTimeout(
      (signal) =>
        embedMany({
          model: embeddingModel,
          values: args.values,
          abortSignal: signal,
          providerOptions: {
            google: { outputDimensionality: EMBEDDING_DIMENSIONS, taskType: args.taskType },
          },
        }),
      EMBED_TIMEOUT_MS,
    )
    await logEmbedUsage(context, result.usage.tokens, args.values.length, Date.now() - startedAt)
    return result.embeddings
  } catch (cause) {
    await logLlmFailure(context, 'embedMany', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM embedMany failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/llm/client.test.ts`
Expected: PASS, all cases including any pre-existing ones in this file.

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: clean. If `embedMany`'s `model` param type mismatches `google.textEmbeddingModel(...)`'s return type, fix by importing the exact type the installed `ai`/`@ai-sdk/google` versions expect (checked during research: `ai@^7.0.34` exports `embedMany({ model: EmbeddingModel, ... })` and `@ai-sdk/google@^4.0.21`'s `textEmbeddingModel` returns `EmbeddingModelV4`, which is the aliased `EmbeddingModel` — this should compile as-is).

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/client.ts src/lib/llm/client.test.ts
git commit -m "feat: add embedTexts wrapper for pgvector-backed retrieval"
```

---

### Task 3: Chunking utility

**Files:**
- Create: `src/lib/knowledge/chunk-text.ts`
- Test: `src/lib/knowledge/chunk-text.test.ts`

**Interfaces:**
- Produces: `interface TextChunk { index: number; content: string }`, `chunkText(text: string, chunkSize?: number, overlap?: number): TextChunk[]`, `CHUNK_SIZE_CHARS`, `CHUNK_OVERLAP_CHARS` constants — consumed by Task 7's chunk-and-embed helpers.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect } from 'vitest'
import { chunkText, CHUNK_SIZE_CHARS, CHUNK_OVERLAP_CHARS } from './chunk-text'

describe('chunkText', () => {
  it('should return an empty array for empty or whitespace-only text', () => {
    expect(chunkText('')).toEqual([])
    expect(chunkText('   \n  ')).toEqual([])
  })

  it('should return a single chunk when text is shorter than chunkSize', () => {
    const result = chunkText('short text', 1000, 100)
    expect(result).toEqual([{ index: 0, content: 'short text' }])
  })

  it('should split long text into overlapping chunks', () => {
    const text = 'a'.repeat(2500)
    const result = chunkText(text, 1000, 100)
    expect(result.length).toBe(3)
    expect(result[0]!.content.length).toBe(1000)
    expect(result[1]!.content.length).toBe(1000)
    // Last chunk covers the remainder: starts at 1800 (2*(1000-100)), ends at 2500.
    expect(result[2]!.content.length).toBe(700)
    expect(result.map((c) => c.index)).toEqual([0, 1, 2])
  })

  it('should overlap consecutive chunks by exactly the overlap amount', () => {
    const text = '0123456789'.repeat(300) // 3000 chars
    const result = chunkText(text, 1000, 100)
    const firstChunkTail = result[0]!.content.slice(-100)
    const secondChunkHead = result[1]!.content.slice(0, 100)
    expect(firstChunkTail).toBe(secondChunkHead)
  })

  it('should trim leading/trailing whitespace before chunking', () => {
    const result = chunkText('  hello world  ', 1000, 100)
    expect(result).toEqual([{ index: 0, content: 'hello world' }])
  })

  it('should use the default chunk size and overlap constants when not provided', () => {
    const text = 'x'.repeat(CHUNK_SIZE_CHARS + 50)
    const result = chunkText(text)
    expect(result.length).toBe(2)
    expect(CHUNK_SIZE_CHARS).toBe(1000)
    expect(CHUNK_OVERLAP_CHARS).toBe(100)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/knowledge/chunk-text.test.ts`
Expected: FAIL — module `./chunk-text` doesn't exist.

- [ ] **Step 3: Implement**

```ts
export const CHUNK_SIZE_CHARS = 1000
export const CHUNK_OVERLAP_CHARS = 100

export interface TextChunk {
  index: number
  content: string
}

// Fixed-size sliding window with overlap so a fact split across a chunk
// boundary still appears whole in at least one chunk. Pure and deterministic —
// no tokenizer dependency, char-based is precise enough for this use case.
export function chunkText(
  text: string,
  chunkSize: number = CHUNK_SIZE_CHARS,
  overlap: number = CHUNK_OVERLAP_CHARS,
): TextChunk[] {
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  const step = chunkSize - overlap
  const chunks: TextChunk[] = []
  let start = 0
  let index = 0
  while (start < trimmed.length) {
    const end = Math.min(start + chunkSize, trimmed.length)
    chunks.push({ index, content: trimmed.slice(start, end) })
    if (end === trimmed.length) break
    index += 1
    start += step
  }
  return chunks
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/knowledge/chunk-text.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge/chunk-text.ts src/lib/knowledge/chunk-text.test.ts
git commit -m "feat: add chunkText utility for knowledge-base embedding"
```

---

### Task 4: Sitemap discovery utility

**Files:**
- Create: `src/lib/knowledge/sitemap.ts`
- Test: `src/lib/knowledge/sitemap.test.ts`

**Interfaces:**
- Consumes: `fetchText` (`@/lib/http/fetch-text`), `WebResearch` type + `brightdataResearch` (`@/lib/research/provider`, `@/lib/research/brightdata`), `AppError`.
- Produces: `discoverSitemapPages(research: WebResearch, websiteUrl: string): Promise<string[]>` — consumed by Task 9's discover-sitemap route.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import type { WebResearch } from '@/lib/research/provider'
import { discoverSitemapPages } from './sitemap'

const fetchMock = vi.fn()
beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

function textResponse(body: string, ok = true, status = 200) {
  return { ok, status, text: async () => body }
}

const flatSitemap = `<?xml version="1.0"?>
<urlset><url><loc>https://acme.com/</loc></url><url><loc>https://acme.com/pricing</loc></url></urlset>`

const sitemapIndex = `<?xml version="1.0"?>
<sitemapindex><sitemap><loc>https://acme.com/sitemap-pages.xml</loc></sitemap></sitemapindex>`

const childSitemap = `<?xml version="1.0"?>
<urlset><url><loc>https://acme.com/about</loc></url></urlset>`

const stubResearch: WebResearch = { search: vi.fn(), scrape: vi.fn() }

describe('discoverSitemapPages', () => {
  it('should return the loc urls from a flat sitemap', async () => {
    fetchMock.mockResolvedValue(textResponse(flatSitemap))
    const result = await discoverSitemapPages(stubResearch, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/', 'https://acme.com/pricing'])
  })

  it('should follow a sitemap index into its child sitemaps', async () => {
    fetchMock
      .mockResolvedValueOnce(textResponse(sitemapIndex))
      .mockResolvedValueOnce(textResponse(childSitemap))
    const result = await discoverSitemapPages(stubResearch, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/about'])
  })

  it('should cap the result at 500 urls', async () => {
    const many = Array.from({ length: 600 }, (_, i) => `<url><loc>https://acme.com/p${i}</loc></url>`).join('')
    fetchMock.mockResolvedValue(textResponse(`<urlset>${many}</urlset>`))
    const result = await discoverSitemapPages(stubResearch, 'https://acme.com')
    expect(result.length).toBe(500)
  })

  it('should fall back to a Brightdata crawl when sitemap.xml 404s', async () => {
    fetchMock.mockResolvedValue(textResponse('not found', false, 404))
    const research: WebResearch = {
      search: vi.fn(),
      scrape: vi.fn().mockResolvedValue('# Acme\n[Pricing](https://acme.com/pricing) [Ext](https://other.com/x)'),
    }
    const result = await discoverSitemapPages(research, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/pricing'])
  })

  it('should throw VALIDATION_ERROR when neither sitemap nor crawl finds anything', async () => {
    fetchMock.mockResolvedValue(textResponse('not found', false, 404))
    const research: WebResearch = { search: vi.fn(), scrape: vi.fn().mockResolvedValue('no links here') }
    await expect(discoverSitemapPages(research, 'https://acme.com')).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    })
  })

  it('should fall back to crawl when the sitemap has no loc entries', async () => {
    fetchMock.mockResolvedValueOnce(textResponse('<urlset></urlset>'))
    const research: WebResearch = {
      search: vi.fn(),
      scrape: vi.fn().mockResolvedValue('[Home](https://acme.com/)'),
    }
    const result = await discoverSitemapPages(research, 'https://acme.com')
    expect(result).toEqual(['https://acme.com/'])
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/knowledge/sitemap.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { fetchText } from '@/lib/http/fetch-text'
import { AppError } from '@/lib/errors/app-error'
import type { WebResearch } from '@/lib/research/provider'

const MAX_SITEMAP_URLS = 500
const MAX_SITEMAP_CHILD_FILES = 20
const SITEMAP_TIMEOUT_MS = 8000

const LOC_REGEX = /<loc>\s*([^<\s]+)\s*<\/loc>/gi
const MARKDOWN_LINK_REGEX = /\]\((https?:\/\/[^\s)]+)\)/g

function extractLocs(xml: string): string[] {
  return [...xml.matchAll(LOC_REGEX)].map((m) => m[1]!.trim())
}

function isSitemapIndex(xml: string): boolean {
  return /<sitemapindex[\s>]/i.test(xml)
}

function dedupeCap(urls: string[], cap: number): string[] {
  return Array.from(new Set(urls)).slice(0, cap)
}

function extractSameDomainLinks(markdown: string, origin: string): string[] {
  const host = new URL(origin).host
  const links = [...markdown.matchAll(MARKDOWN_LINK_REGEX)].map((m) => m[1]!)
  const sameDomain = links.filter((link) => {
    try {
      return new URL(link).host === host
    } catch {
      return false
    }
  })
  return dedupeCap(sameDomain, MAX_SITEMAP_URLS)
}

async function discoverViaCrawlFallback(research: WebResearch, origin: string): Promise<string[]> {
  const markdown = await research.scrape(origin)
  const links = extractSameDomainLinks(markdown, origin)
  if (links.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Could not discover any pages for this site', { origin })
  }
  return links
}

async function fetchSitemapXml(url: string): Promise<string | null> {
  try {
    return await fetchText(url, { method: 'GET' }, SITEMAP_TIMEOUT_MS)
  } catch {
    return null
  }
}

// Sitemap.xml first (fast, no Brightdata credits — sitemaps are almost never
// bot-blocked), falling back to a Brightdata homepage crawl when no sitemap
// exists or it has no <loc> entries. Never returns an empty array: throws
// VALIDATION_ERROR if discovery genuinely finds nothing, so the route can
// surface a clear message instead of an empty picker.
export async function discoverSitemapPages(research: WebResearch, websiteUrl: string): Promise<string[]> {
  const origin = new URL(websiteUrl).origin
  const rootXml = await fetchSitemapXml(`${origin}/sitemap.xml`)
  if (rootXml === null) return discoverViaCrawlFallback(research, origin)

  const rootLocs = extractLocs(rootXml)
  if (rootLocs.length === 0) return discoverViaCrawlFallback(research, origin)

  if (!isSitemapIndex(rootXml)) {
    return dedupeCap(rootLocs, MAX_SITEMAP_URLS)
  }

  const childSitemaps = rootLocs.slice(0, MAX_SITEMAP_CHILD_FILES)
  const allUrls: string[] = []
  for (const childUrl of childSitemaps) {
    const childXml = await fetchSitemapXml(childUrl)
    if (childXml) allUrls.push(...extractLocs(childXml))
    if (allUrls.length >= MAX_SITEMAP_URLS) break
  }
  if (allUrls.length === 0) return discoverViaCrawlFallback(research, origin)
  return dedupeCap(allUrls, MAX_SITEMAP_URLS)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/knowledge/sitemap.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge/sitemap.ts src/lib/knowledge/sitemap.test.ts
git commit -m "feat: add sitemap-based page discovery with Brightdata crawl fallback"
```

---

### Task 5: PDF text extraction

**Files:**
- Modify: `package.json`, `pnpm-lock.yaml` (add `unpdf`)
- Create: `src/lib/knowledge/pdf-extract.ts`
- Test: `src/lib/knowledge/pdf-extract.test.ts`

**Interfaces:**
- Produces: `PDF_MAX_EXTRACTED_CHARS` constant, `extractPdfText(buffer: ArrayBuffer): Promise<string>` — consumed by Task 12's PDF upload route.

- [ ] **Step 1: Add the dependency**

Run: `pnpm add unpdf`
Expected: `package.json` gains `"unpdf": "^<version>"` under `dependencies`, `pnpm-lock.yaml` updates.

- [ ] **Step 2: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'

const getDocumentProxyMock = vi.fn()
const extractTextMock = vi.fn()
vi.mock('unpdf', () => ({
  getDocumentProxy: (...a: unknown[]) => getDocumentProxyMock(...a),
  extractText: (...a: unknown[]) => extractTextMock(...a),
}))

import { extractPdfText, PDF_MAX_EXTRACTED_CHARS } from './pdf-extract'
import { AppError } from '@/lib/errors/app-error'

describe('extractPdfText', () => {
  it('should return the merged text from the pdf', async () => {
    getDocumentProxyMock.mockResolvedValue({ id: 'doc' })
    extractTextMock.mockResolvedValue({ text: 'Hello from the PDF' })
    const result = await extractPdfText(new ArrayBuffer(4))
    expect(result).toBe('Hello from the PDF')
    expect(extractTextMock).toHaveBeenCalledWith({ id: 'doc' }, { mergePages: true })
  })

  it('should truncate text longer than PDF_MAX_EXTRACTED_CHARS', async () => {
    getDocumentProxyMock.mockResolvedValue({ id: 'doc' })
    extractTextMock.mockResolvedValue({ text: 'x'.repeat(PDF_MAX_EXTRACTED_CHARS + 500) })
    const result = await extractPdfText(new ArrayBuffer(4))
    expect(result.length).toBe(PDF_MAX_EXTRACTED_CHARS)
  })

  it('should throw AppError VALIDATION_ERROR when parsing fails', async () => {
    getDocumentProxyMock.mockRejectedValue(new Error('not a pdf'))
    await expect(extractPdfText(new ArrayBuffer(4))).rejects.toBeInstanceOf(AppError)
    await expect(extractPdfText(new ArrayBuffer(4))).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run src/lib/knowledge/pdf-extract.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 4: Implement**

```ts
import { getDocumentProxy, extractText } from 'unpdf'
import { AppError } from '@/lib/errors/app-error'

// Mirrors brightdata.ts's MAX_SCRAPE_CHARS pattern — full documents can run
// much longer than a scraped page, so this cap is generous, but still bounds
// what a single source can contribute to the chunking/embedding budget.
export const PDF_MAX_EXTRACTED_CHARS = 12_000

// unpdf is chosen over pdf-parse: no filesystem side effects at import time
// (pdf-parse has a known debug-mode footgun that tries to read a test fixture
// off disk on first import), and it's built for serverless/edge runtimes.
export async function extractPdfText(buffer: ArrayBuffer): Promise<string> {
  try {
    const pdf = await getDocumentProxy(new Uint8Array(buffer))
    const { text } = await extractText(pdf, { mergePages: true })
    return text.slice(0, PDF_MAX_EXTRACTED_CHARS)
  } catch (cause) {
    throw new AppError('VALIDATION_ERROR', 'Could not extract text from this PDF', {
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `pnpm vitest run src/lib/knowledge/pdf-extract.test.ts`
Expected: PASS, 3/3. If `extractText`'s return shape differs from `{ text: string }` in the installed `unpdf` version, adjust the mock/implementation to match — check `node_modules/unpdf/dist/index.d.mts` for the exact signature first.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/knowledge/pdf-extract.ts src/lib/knowledge/pdf-extract.test.ts
git commit -m "feat: add PDF text extraction via unpdf"
```

---

### Task 6: PDF storage bucket helpers

**Files:**
- Create: `src/lib/storage/client-knowledge-pdfs.ts`
- Test: `src/lib/storage/client-knowledge-pdfs.test.ts`

**Interfaces:**
- Consumes: pattern mirrors `src/lib/storage/logos.ts` exactly.
- Produces: `KNOWLEDGE_PDF_BUCKET`, `assertValidPdfFile(file: File): void`, `uploadClientKnowledgePdf(supabase, clientId: string, file: File): Promise<string>` (returns the storage path, not a public URL — bucket is private), `deleteClientKnowledgePdfObject(supabase, storagePath: string): Promise<void>`, `getClientKnowledgePdfSignedUrl(supabase, storagePath: string): Promise<string>` — consumed by Task 12 (upload/delete routes) and Task 17 (UI download link).

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  KNOWLEDGE_PDF_BUCKET,
  KNOWLEDGE_PDF_MAX_BYTES,
  assertValidPdfFile,
  uploadClientKnowledgePdf,
  deleteClientKnowledgePdfObject,
  getClientKnowledgePdfSignedUrl,
} from './client-knowledge-pdfs'

function pdfFile(name: string, size: number, type = 'application/pdf'): File {
  return { name, size, type } as File
}

describe('assertValidPdfFile', () => {
  it('should not throw for a valid pdf under the size limit', () => {
    expect(() => assertValidPdfFile(pdfFile('doc.pdf', 1000))).not.toThrow()
  })

  it('should throw VALIDATION_ERROR for a non-pdf mime type', () => {
    expect(() => assertValidPdfFile(pdfFile('doc.png', 1000, 'image/png'))).toThrow(AppError)
  })

  it('should throw VALIDATION_ERROR when the file exceeds the size cap', () => {
    expect(() => assertValidPdfFile(pdfFile('doc.pdf', KNOWLEDGE_PDF_MAX_BYTES + 1))).toThrow(AppError)
  })
})

describe('uploadClientKnowledgePdf', () => {
  it('should upload to a fresh per-call path and return it', async () => {
    const uploadMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ upload: uploadMock }) } } as never
    const path = await uploadClientKnowledgePdf(supabase, 'client-1', pdfFile('doc.pdf', 1000))
    expect(path).toMatch(/^client-1\/[0-9a-f-]+\.pdf$/)
    expect(uploadMock).toHaveBeenCalledWith(path, expect.anything(), expect.objectContaining({ contentType: 'application/pdf' }))
  })

  it('should throw EXTERNAL_ERROR when the upload fails', async () => {
    const supabase = { storage: { from: () => ({ upload: vi.fn().mockResolvedValue({ error: { message: 'boom' } }) }) } } as never
    await expect(uploadClientKnowledgePdf(supabase, 'client-1', pdfFile('doc.pdf', 1000))).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('deleteClientKnowledgePdfObject', () => {
  it('should remove the object at the given path', async () => {
    const removeMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { storage: { from: () => ({ remove: removeMock }) } } as never
    await deleteClientKnowledgePdfObject(supabase, 'client-1/abc.pdf')
    expect(removeMock).toHaveBeenCalledWith(['client-1/abc.pdf'])
  })

  it('should swallow storage errors (best-effort cleanup)', async () => {
    const supabase = { storage: { from: () => ({ remove: vi.fn().mockRejectedValue(new Error('gone')) }) } } as never
    await expect(deleteClientKnowledgePdfObject(supabase, 'client-1/abc.pdf')).resolves.toBeUndefined()
  })
})

describe('getClientKnowledgePdfSignedUrl', () => {
  it('should return the signed url', async () => {
    const supabase = {
      storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: { signedUrl: 'https://x/signed' }, error: null }) }) },
    } as never
    const url = await getClientKnowledgePdfSignedUrl(supabase, 'client-1/abc.pdf')
    expect(url).toBe('https://x/signed')
  })

  it('should throw EXTERNAL_ERROR when signing fails', async () => {
    const supabase = {
      storage: { from: () => ({ createSignedUrl: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) }) },
    } as never
    await expect(getClientKnowledgePdfSignedUrl(supabase, 'client-1/abc.pdf')).rejects.toMatchObject({
      code: 'EXTERNAL_ERROR',
    })
  })
})

describe('KNOWLEDGE_PDF_BUCKET', () => {
  it('should be the client-knowledge-pdfs bucket id', () => {
    expect(KNOWLEDGE_PDF_BUCKET).toBe('client-knowledge-pdfs')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/storage/client-knowledge-pdfs.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { randomUUID } from 'node:crypto'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export const KNOWLEDGE_PDF_BUCKET = 'client-knowledge-pdfs'
export const KNOWLEDGE_PDF_MAX_BYTES = 10 * 1024 * 1024 // 10MB
// Private bucket (unlike client-logos) — signed URLs only, since a client's
// uploaded PDF may contain sensitive business content.
const SIGNED_URL_EXPIRY_SECONDS = 3600

export function assertValidPdfFile(file: File): void {
  if (file.type !== 'application/pdf') {
    throw new AppError('VALIDATION_ERROR', 'File must be a PDF', { contentType: file.type })
  }
  if (file.size > KNOWLEDGE_PDF_MAX_BYTES) {
    throw new AppError('VALIDATION_ERROR', 'PDF must be 10MB or smaller', { size: file.size })
  }
}

export async function uploadClientKnowledgePdf(
  supabase: SupabaseClient<Database>,
  clientId: string,
  file: File,
): Promise<string> {
  assertValidPdfFile(file)
  const path = `${clientId}/${randomUUID()}.pdf`
  const { error } = await supabase.storage.from(KNOWLEDGE_PDF_BUCKET).upload(path, file, {
    contentType: 'application/pdf',
    cacheControl: '3600',
    upsert: false,
  })
  if (error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to upload PDF', { clientId, cause: error.message })
  }
  return path
}

// Best-effort cleanup, same convention as deleteClientLogoObject — called
// after the DB row is already deleted, must never fail the request.
export async function deleteClientKnowledgePdfObject(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<void> {
  try {
    await supabase.storage.from(KNOWLEDGE_PDF_BUCKET).remove([storagePath])
  } catch {
    // Best-effort — see function comment.
  }
}

export async function getClientKnowledgePdfSignedUrl(
  supabase: SupabaseClient<Database>,
  storagePath: string,
): Promise<string> {
  const { data, error } = await supabase.storage
    .from(KNOWLEDGE_PDF_BUCKET)
    .createSignedUrl(storagePath, SIGNED_URL_EXPIRY_SECONDS)
  if (error || !data) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to sign PDF url', { storagePath, cause: error?.message })
  }
  return data.signedUrl
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/storage/client-knowledge-pdfs.test.ts`
Expected: PASS, 8/8.

- [ ] **Step 5: Commit**

```bash
git add src/lib/storage/client-knowledge-pdfs.ts src/lib/storage/client-knowledge-pdfs.test.ts
git commit -m "feat: add private PDF storage bucket helpers for the knowledge base"
```

---

### Task 7: DB access layer

**Files:**
- Create: `src/lib/db/client-knowledge.ts`
- Test: `src/lib/db/client-knowledge.test.ts`

**Interfaces:**
- Consumes: `Database` type, `AppError`, `chunkText`/`CHUNK_SIZE_CHARS`/`CHUNK_OVERLAP_CHARS` (Task 3), `embedTexts` (Task 2).
- Produces: `KnowledgeSourceRow`, `KnowledgeChunkRow` types; `insertPendingWebsiteSources`, `listSourcesForClient`, `getSourceById`, `markSourceReady`, `markSourceFailed`, `resetSourceToPending`, `deleteSource`, `insertPdfSourceReady`, `embedAndStoreChunks`, `deleteChunksForSource`, `matchClientKnowledgeChunks` — consumed by Tasks 8–13.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const embedTextsMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ embedTexts: (...a: unknown[]) => embedTextsMock(...a) }))

import {
  insertPendingWebsiteSources,
  listSourcesForClient,
  getSourceById,
  markSourceReady,
  markSourceFailed,
  resetSourceToPending,
  deleteSource,
  insertPdfSourceReady,
  embedAndStoreChunks,
  deleteChunksForSource,
  matchClientKnowledgeChunks,
} from './client-knowledge'

beforeEach(() => {
  embedTextsMock.mockReset()
})

describe('insertPendingWebsiteSources', () => {
  it('should return [] without querying when pages is empty', async () => {
    const supabase = {} as never
    const result = await insertPendingWebsiteSources(supabase, 'c1', 'op1', [])
    expect(result).toEqual([])
  })

  it('should skip urls that already exist for the client', async () => {
    const selectChain = {
      eq: () => ({ in: () => Promise.resolve({ data: [{ url: 'https://a.com/1' }], error: null }) }),
    }
    const insertMock = vi.fn().mockReturnValue({
      select: () => Promise.resolve({ data: [{ id: 's1', url: 'https://a.com/2' }], error: null }),
    })
    const supabase = {
      from: () => ({ select: () => selectChain, insert: insertMock }),
    } as never
    const result = await insertPendingWebsiteSources(supabase, 'c1', 'op1', [
      { url: 'https://a.com/1', title: 'https://a.com/1' },
      { url: 'https://a.com/2', title: 'https://a.com/2' },
    ])
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ url: 'https://a.com/2', client_id: 'c1', created_by: 'op1', status: 'pending' }),
    ])
    expect(result).toEqual([{ id: 's1', url: 'https://a.com/2' }])
  })

  it('should return [] without inserting when every url already exists', async () => {
    const selectChain = { eq: () => ({ in: () => Promise.resolve({ data: [{ url: 'https://a.com/1' }], error: null }) }) }
    const insertMock = vi.fn()
    const supabase = { from: () => ({ select: () => selectChain, insert: insertMock }) } as never
    const result = await insertPendingWebsiteSources(supabase, 'c1', 'op1', [{ url: 'https://a.com/1', title: 'x' }])
    expect(result).toEqual([])
    expect(insertMock).not.toHaveBeenCalled()
  })

  it('should throw DB_ERROR when the existence check fails', async () => {
    const selectChain = { eq: () => ({ in: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }
    const supabase = { from: () => ({ select: () => selectChain }) } as never
    await expect(insertPendingWebsiteSources(supabase, 'c1', 'op1', [{ url: 'https://a.com/1', title: 'x' }]))
      .rejects.toBeInstanceOf(AppError)
  })
})

describe('listSourcesForClient', () => {
  it('should return sources ordered newest first', async () => {
    const rows = [{ id: 's1' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }) }),
    } as never
    const result = await listSourcesForClient(supabase, 'c1')
    expect(result).toEqual(rows)
  })
})

describe('getSourceById', () => {
  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    expect(await getSourceById(supabase, 'missing')).toBeNull()
  })
})

describe('markSourceReady / markSourceFailed / resetSourceToPending', () => {
  it('markSourceReady should update content, char_count, status, scraped_at', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update: updateMock }) } as never
    await markSourceReady(supabase, 's1', 'full text', 9)
    expect(updateMock).toHaveBeenCalledWith(expect.objectContaining({
      status: 'ready', content: 'full text', char_count: 9,
    }))
  })

  it('markSourceFailed should set status failed with the error message', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update: updateMock }) } as never
    await markSourceFailed(supabase, 's1', 'scrape timed out')
    expect(updateMock).toHaveBeenCalledWith({ status: 'failed', error_message: 'scrape timed out' })
  })

  it('resetSourceToPending should clear status/content/error', async () => {
    const updateMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update: updateMock }) } as never
    await resetSourceToPending(supabase, 's1')
    expect(updateMock).toHaveBeenCalledWith({ status: 'pending', content: null, char_count: null, error_message: null, scraped_at: null })
  })
})

describe('deleteSource', () => {
  it('should delete and return the deleted row', async () => {
    const row = { id: 's1', storage_path: 'c1/x.pdf' }
    const deleteMock = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const supabase = { from: () => ({ delete: deleteMock }) } as never
    const result = await deleteSource(supabase, 's1')
    expect(result).toEqual(row)
  })
})

describe('insertPdfSourceReady', () => {
  it('should insert an already-ready pdf source row', async () => {
    const insertMock = vi.fn().mockReturnValue({
      select: () => ({ single: () => Promise.resolve({ data: { id: 's1' }, error: null }) }),
    })
    const supabase = { from: () => ({ insert: insertMock }) } as never
    const result = await insertPdfSourceReady(supabase, {
      clientId: 'c1', createdBy: 'op1', title: 'doc.pdf', storagePath: 'c1/x.pdf', content: 'text', charCount: 4,
    })
    expect(insertMock).toHaveBeenCalledWith(expect.objectContaining({
      client_id: 'c1', source_type: 'pdf', status: 'ready', storage_path: 'c1/x.pdf',
    }))
    expect(result).toEqual({ id: 's1' })
  })
})

describe('embedAndStoreChunks', () => {
  it('should chunk, embed, and insert one row per chunk', async () => {
    embedTextsMock.mockResolvedValue([[0.1], [0.2]])
    const insertMock = vi.fn().mockResolvedValue({ error: null })
    const supabase = { from: () => ({ insert: insertMock }) } as never
    const longText = 'a'.repeat(1500)
    await embedAndStoreChunks(supabase, { clientId: 'c1', sourceId: 's1', content: longText, actor: 'test' })
    expect(embedTextsMock).toHaveBeenCalledWith(
      { clientId: 'c1', actor: 'test' },
      expect.objectContaining({ taskType: 'RETRIEVAL_DOCUMENT' }),
    )
    expect(insertMock).toHaveBeenCalledWith([
      expect.objectContaining({ client_id: 'c1', source_id: 's1', chunk_index: 0, embedding: [0.1] }),
      expect.objectContaining({ client_id: 'c1', source_id: 's1', chunk_index: 1, embedding: [0.2] }),
    ])
  })

  it('should no-op when content produces no chunks', async () => {
    const insertMock = vi.fn()
    const supabase = { from: () => ({ insert: insertMock }) } as never
    await embedAndStoreChunks(supabase, { clientId: 'c1', sourceId: 's1', content: '   ', actor: 'test' })
    expect(embedTextsMock).not.toHaveBeenCalled()
    expect(insertMock).not.toHaveBeenCalled()
  })
})

describe('deleteChunksForSource', () => {
  it('should delete every chunk for the source', async () => {
    const deleteMock = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ delete: deleteMock }) } as never
    await deleteChunksForSource(supabase, 's1')
    expect(deleteMock).toHaveBeenCalled()
  })
})

describe('matchClientKnowledgeChunks', () => {
  it('should call the rpc and return its rows', async () => {
    const rows = [{ source_id: 's1', source_title: 'About', content: 'x', similarity: 0.9 }]
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: rows, error: null }) } as never
    const result = await matchClientKnowledgeChunks(supabase, 'c1', [0.1, 0.2], 6)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } as never
    await expect(matchClientKnowledgeChunks(supabase, 'c1', [0.1], 6)).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { chunkText } from '@/lib/knowledge/chunk-text'
import { embedTexts } from '@/lib/llm/client'

export type KnowledgeSourceRow = Database['public']['Tables']['client_knowledge_sources']['Row']
export type KnowledgeChunkRow = Database['public']['Tables']['client_knowledge_chunks']['Row']
export interface MatchedChunk {
  sourceId: string
  sourceTitle: string
  content: string
  similarity: number
}

export interface PendingWebsitePage {
  url: string
  title: string
}

// Check-before-insert on (client_id, url): cheap for a batch of <=50 urls, and
// avoids relying on supabase-js's upsert+ignoreDuplicates ON CONFLICT inference
// against the partial unique index (Postgres arbiter inference for a partial
// index needs the WHERE clause restated, which PostgREST's onConflict option
// does not do). A rare concurrent double-submit still can't create a true
// duplicate row: the partial unique index rejects it at the DB level.
export async function insertPendingWebsiteSources(
  supabase: SupabaseClient<Database>,
  clientId: string,
  createdBy: string,
  pages: PendingWebsitePage[],
): Promise<KnowledgeSourceRow[]> {
  if (pages.length === 0) return []

  const { data: existing, error: selectError } = await supabase
    .from('client_knowledge_sources')
    .select('url')
    .eq('client_id', clientId)
    .in('url', pages.map((p) => p.url))
  if (selectError) {
    throw new AppError('DB_ERROR', 'Failed to check for existing knowledge sources', {
      clientId, cause: selectError.message,
    })
  }
  const existingUrls = new Set((existing ?? []).map((row) => row.url))
  const toInsert = pages.filter((p) => !existingUrls.has(p.url))
  if (toInsert.length === 0) return []

  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .insert(toInsert.map((p) => ({
      client_id: clientId,
      source_type: 'website_page' as const,
      url: p.url,
      title: p.title,
      status: 'pending' as const,
      created_by: createdBy,
    })))
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert knowledge sources', { clientId, cause: error.message })
  }
  return data ?? []
}

export async function listSourcesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<KnowledgeSourceRow[]> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
  if (error) throw new AppError('DB_ERROR', 'Failed to list knowledge sources', { clientId, cause: error.message })
  return data ?? []
}

export async function getSourceById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<KnowledgeSourceRow | null> {
  const { data, error } = await supabase.from('client_knowledge_sources').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load knowledge source', { id, cause: error.message })
  return data
}

export async function markSourceReady(
  supabase: SupabaseClient<Database>,
  id: string,
  content: string,
  charCount: number,
): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .update({ status: 'ready', content, char_count: charCount, error_message: null, scraped_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to mark knowledge source ready', { id, cause: error.message })
}

export async function markSourceFailed(
  supabase: SupabaseClient<Database>,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .update({ status: 'failed', error_message: errorMessage })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to mark knowledge source failed', { id, cause: error.message })
}

export async function resetSourceToPending(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .update({ status: 'pending', content: null, char_count: null, error_message: null, scraped_at: null })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to reset knowledge source', { id, cause: error.message })
}

// Returns the deleted row (needed by the caller to clean up a pdf's storage
// object) or null if it was already gone. Chunks cascade via the FK.
export async function deleteSource(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<KnowledgeSourceRow | null> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .delete()
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to delete knowledge source', { id, cause: error.message })
  return data
}

export interface InsertPdfSourceInput {
  clientId: string
  createdBy: string
  title: string
  storagePath: string
  content: string
  charCount: number
}

// PDFs are extracted inline (no network dependency, unlike a website scrape),
// so the row is created already 'ready' — there's no pending window to show.
export async function insertPdfSourceReady(
  supabase: SupabaseClient<Database>,
  input: InsertPdfSourceInput,
): Promise<KnowledgeSourceRow> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .insert({
      client_id: input.clientId,
      source_type: 'pdf',
      title: input.title,
      storage_path: input.storagePath,
      content: input.content,
      char_count: input.charCount,
      status: 'ready',
      created_by: input.createdBy,
      scraped_at: new Date().toISOString(),
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert PDF knowledge source', { clientId: input.clientId, cause: error?.message })
  }
  return data
}

export interface EmbedAndStoreChunksInput {
  clientId: string
  sourceId: string
  content: string
  actor: string
}

// Chunks content, embeds every chunk in one batched call, inserts one row per
// chunk. Callers are responsible for deleting any prior chunks for this
// source first (see deleteChunksForSource) — this function only ever appends.
export async function embedAndStoreChunks(
  supabase: SupabaseClient<Database>,
  input: EmbedAndStoreChunksInput,
): Promise<void> {
  const chunks = chunkText(input.content)
  if (chunks.length === 0) return

  const embeddings = await embedTexts(
    { clientId: input.clientId, actor: input.actor },
    { values: chunks.map((c) => c.content), taskType: 'RETRIEVAL_DOCUMENT' },
  )

  const { error } = await supabase.from('client_knowledge_chunks').insert(
    chunks.map((chunk, i) => ({
      client_id: input.clientId,
      source_id: input.sourceId,
      chunk_index: chunk.index,
      content: chunk.content,
      embedding: embeddings[i]!,
    })),
  )
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to store knowledge chunks', { sourceId: input.sourceId, cause: error.message })
  }
}

export async function deleteChunksForSource(supabase: SupabaseClient<Database>, sourceId: string): Promise<void> {
  const { error } = await supabase.from('client_knowledge_chunks').delete().eq('source_id', sourceId)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete knowledge chunks', { sourceId, cause: error.message })
}

export async function matchClientKnowledgeChunks(
  supabase: SupabaseClient<Database>,
  clientId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<MatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_client_knowledge_chunks', {
    p_client_id: clientId,
    p_query_embedding: queryEmbedding,
    p_limit: limit,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to match knowledge chunks', { clientId, cause: error.message })
  }
  return (data ?? []).map((row) => ({
    sourceId: row.source_id, sourceTitle: row.source_title, content: row.content, similarity: row.similarity,
  }))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/client-knowledge.test.ts`
Expected: PASS, all cases.

- [ ] **Step 5: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/client-knowledge.ts src/lib/db/client-knowledge.test.ts
git commit -m "feat: add client_knowledge_sources/chunks DB access layer"
```

---

### Task 8: Retrieval helper for the AI pipelines

**Files:**
- Create: `src/lib/knowledge/client-context.ts`
- Test: `src/lib/knowledge/client-context.test.ts`

**Interfaces:**
- Consumes: `embedTexts` (Task 2), `matchClientKnowledgeChunks` (Task 7).
- Produces: `retrieveClientKnowledge(supabase, clientId: string, queryText: string, limit?: number): Promise<string>` — consumed by Task 14's four pipeline edits.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const embedTextsMock = vi.fn()
const matchClientKnowledgeChunksMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ embedTexts: (...a: unknown[]) => embedTextsMock(...a) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  matchClientKnowledgeChunks: (...a: unknown[]) => matchClientKnowledgeChunksMock(...a),
}))

import { retrieveClientKnowledge } from './client-context'

beforeEach(() => {
  embedTextsMock.mockReset()
  matchClientKnowledgeChunksMock.mockReset()
})

describe('retrieveClientKnowledge', () => {
  it('should return an empty string when no chunks match', async () => {
    embedTextsMock.mockResolvedValue([[0.1, 0.2]])
    matchClientKnowledgeChunksMock.mockResolvedValue([])
    const result = await retrieveClientKnowledge({} as never, 'c1', 'prospect facts')
    expect(result).toBe('')
  })

  it('should format matched chunks with their source titles', async () => {
    embedTextsMock.mockResolvedValue([[0.1, 0.2]])
    matchClientKnowledgeChunksMock.mockResolvedValue([
      { sourceId: 's1', sourceTitle: 'Pricing', content: 'Starts at $99/mo.', similarity: 0.9 },
      { sourceId: 's2', sourceTitle: 'About', content: 'Founded in 2019.', similarity: 0.8 },
    ])
    const result = await retrieveClientKnowledge({} as never, 'c1', 'prospect facts')
    expect(result).toBe('- (Pricing) Starts at $99/mo.\n- (About) Founded in 2019.')
  })

  it('should embed the query with RETRIEVAL_QUERY task type and pass the limit through', async () => {
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockResolvedValue([])
    await retrieveClientKnowledge({} as never, 'c1', 'q', 3)
    expect(embedTextsMock).toHaveBeenCalledWith(
      { clientId: 'c1', actor: 'client_knowledge_retrieval' },
      { values: ['q'], taskType: 'RETRIEVAL_QUERY' },
    )
    expect(matchClientKnowledgeChunksMock).toHaveBeenCalledWith(expect.anything(), 'c1', [0.1], 3)
  })

  it('should return an empty string and swallow the error when embedding fails', async () => {
    embedTextsMock.mockRejectedValue(new Error('quota exceeded'))
    const result = await retrieveClientKnowledge({} as never, 'c1', 'q')
    expect(result).toBe('')
  })

  it('should return an empty string and swallow the error when the match query fails', async () => {
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockRejectedValue(new Error('db down'))
    const result = await retrieveClientKnowledge({} as never, 'c1', 'q')
    expect(result).toBe('')
  })

  it('should return an empty string without calling anything when queryText is blank', async () => {
    const result = await retrieveClientKnowledge({} as never, 'c1', '   ')
    expect(result).toBe('')
    expect(embedTextsMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/knowledge/client-context.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { embedTexts } from '@/lib/llm/client'
import { matchClientKnowledgeChunks } from '@/lib/db/client-knowledge'

const DEFAULT_LIMIT = 6
const ACTOR = 'client_knowledge_retrieval'

// Embeds `queryText` (dossier facts + value prop, joined by the caller) and
// pulls the top-K most relevant client-knowledge chunks, formatted as a block
// ready to append to a prompt. Never throws — a retrieval hiccup (embedding
// API error, RPC error) must not block sending an email, so any failure
// degrades to '' instead of propagating.
export async function retrieveClientKnowledge(
  supabase: SupabaseClient<Database>,
  clientId: string,
  queryText: string,
  limit: number = DEFAULT_LIMIT,
): Promise<string> {
  if (queryText.trim().length === 0) return ''
  try {
    const [queryEmbedding] = await embedTexts(
      { clientId, actor: ACTOR },
      { values: [queryText], taskType: 'RETRIEVAL_QUERY' },
    )
    if (!queryEmbedding) return ''
    const matches = await matchClientKnowledgeChunks(supabase, clientId, queryEmbedding, limit)
    if (matches.length === 0) return ''
    return matches.map((m) => `- (${m.sourceTitle}) ${m.content}`).join('\n')
  } catch {
    return ''
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/knowledge/client-context.test.ts`
Expected: PASS, 6/6.

- [ ] **Step 5: Commit**

```bash
git add src/lib/knowledge/client-context.ts src/lib/knowledge/client-context.test.ts
git commit -m "feat: add retrieveClientKnowledge for AI pipeline grounding"
```

---

### Task 9: Route — discover sitemap pages

**Files:**
- Create: `src/app/api/clients/[clientId]/knowledge/discover-sitemap/route.ts`
- Test: `src/app/api/clients/[clientId]/knowledge/discover-sitemap/route.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `discoverSitemapPages` (Task 4), `brightdataResearch`.
- Produces: `POST` handler returning `{ ok: true, urls: string[] }` — consumed by Task 15's sitemap picker UI.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const discoverSitemapPagesMock = vi.fn()
vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/knowledge/sitemap', () => ({ discoverSitemapPages: (...a: unknown[]) => discoverSitemapPagesMock(...a) }))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: {} }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  discoverSitemapPagesMock.mockReset()
})

describe('POST /api/clients/[clientId]/knowledge/discover-sitemap', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ websiteUrl: 'https://acme.com' }))
    expect(res.status).toBe(403)
    expect(discoverSitemapPagesMock).not.toHaveBeenCalled()
  })

  it('should return 400 for an invalid url', async () => {
    const res = await POST(req({ websiteUrl: 'not-a-url' }))
    expect(res.status).toBe(400)
  })

  it('should return the discovered urls on success', async () => {
    discoverSitemapPagesMock.mockResolvedValue(['https://acme.com/', 'https://acme.com/pricing'])
    const res = await POST(req({ websiteUrl: 'https://acme.com' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, urls: ['https://acme.com/', 'https://acme.com/pricing'] })
  })

  it('should return 400 when discovery finds nothing', async () => {
    discoverSitemapPagesMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'Could not discover any pages for this site'))
    const res = await POST(req({ websiteUrl: 'https://acme.com' }))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/clients/[clientId]/knowledge/discover-sitemap/route.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { discoverSitemapPages } from '@/lib/knowledge/sitemap'
import { brightdataResearch } from '@/lib/research/brightdata'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ websiteUrl: z.string().url() })

// Operator-only, no clientId scoping needed for the discovery step itself —
// it doesn't write anything, just returns candidate urls for the picker.
export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const rawBody: unknown = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error', issues: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const urls = await discoverSitemapPages(brightdataResearch, parsed.data.websiteUrl)
    return NextResponse.json({ ok: true, urls })
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/clients/[clientId]/knowledge/discover-sitemap/route.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/knowledge/discover-sitemap/route.ts" "src/app/api/clients/[clientId]/knowledge/discover-sitemap/route.test.ts"
git commit -m "feat: add sitemap discovery route for the client knowledge base"
```

---

### Task 10: Route — select pages, insert pending sources, fan out scrape jobs

**Files:**
- Create: `src/app/api/clients/[clientId]/knowledge/pages/route.ts`
- Test: `src/app/api/clients/[clientId]/knowledge/pages/route.test.ts`

**Interfaces:**
- Consumes: `requireUser`, `getClientById` (`@/lib/db/clients`), `insertPendingWebsiteSources` (Task 7), `publishJson` (`@/lib/qstash/client`), `logEventSafe`.
- Produces: `POST` handler returning `{ ok: true, insertedCount: number }` — consumed by Task 15's UI.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const insertPendingWebsiteSourcesMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  insertPendingWebsiteSources: (...a: unknown[]) => insertPendingWebsiteSourcesMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  insertPendingWebsiteSourcesMock.mockReset()
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/pages', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ urls: ['https://a.com/1'] }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(req({ urls: ['https://a.com/1'] }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when more than 50 urls are submitted', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    const urls = Array.from({ length: 51 }, (_, i) => `https://a.com/${i}`)
    const res = await POST(req({ urls }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should insert pending sources and fan out one qstash job per new source', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    insertPendingWebsiteSourcesMock.mockResolvedValue([{ id: 's1' }, { id: 's2' }])
    const res = await POST(req({ urls: ['https://a.com/1', 'https://a.com/2'] }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, insertedCount: 2 })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's1' })
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's2' })
  })

  it('should return insertedCount 0 without publishing when every url already existed', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    insertPendingWebsiteSourcesMock.mockResolvedValue([])
    const res = await POST(req({ urls: ['https://a.com/1'] }), ctx('c1'))
    const json = await res.json()
    expect(json).toEqual({ ok: true, insertedCount: 0 })
    expect(publishJsonMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/knowledge/pages/route.test.ts"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { insertPendingWebsiteSources } from '@/lib/db/client-knowledge'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const MAX_URLS_PER_BATCH = 50
const bodySchema = z.object({ urls: z.array(z.string().url()).min(1).max(MAX_URLS_PER_BATCH) })

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  const rawBody: unknown = await request.json().catch(() => null)
  const parsed = bodySchema.safeParse(rawBody)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error', issues: parsed.error.flatten() }, { status: 400 })
  }

  try {
    const inserted = await insertPendingWebsiteSources(
      admin,
      clientId,
      appUser.id,
      parsed.data.urls.map((url) => ({ url, title: url })),
    )

    for (const source of inserted) {
      await publishJson('/api/pipeline/knowledge-scrape', { sourceId: source.id })
    }

    await logEventSafe({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'knowledge.pages_selected',
      payload: { requestedCount: parsed.data.urls.length, insertedCount: inserted.length },
    })

    return NextResponse.json({ ok: true, insertedCount: inserted.length })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/knowledge/pages/route.test.ts"`
Expected: PASS, 5/5.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/knowledge/pages/route.ts" "src/app/api/clients/[clientId]/knowledge/pages/route.test.ts"
git commit -m "feat: add page-selection route that fans out parallel scrape jobs"
```

---

### Task 11: Route — QStash consumer that scrapes, chunks, and embeds one page

**Files:**
- Create: `src/app/api/pipeline/knowledge-scrape/route.ts`
- Test: `src/app/api/pipeline/knowledge-scrape/route.test.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature`, `getSourceById`/`deleteChunksForSource`/`embedAndStoreChunks`/`markSourceReady`/`markSourceFailed` (Task 7), `brightdataResearch`.
- Produces: `POST` handler, the target of Task 10's fan-out.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const verifyQstashSignatureMock = vi.fn()
const getSourceByIdMock = vi.fn()
const deleteChunksForSourceMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
const markSourceReadyMock = vi.fn()
const markSourceFailedMock = vi.fn()
const scrapeMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyQstashSignatureMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  deleteChunksForSource: (...a: unknown[]) => deleteChunksForSourceMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
  markSourceReady: (...a: unknown[]) => markSourceReadyMock(...a),
  markSourceFailed: (...a: unknown[]) => markSourceFailedMock(...a),
}))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: { scrape: (...a: unknown[]) => scrapeMock(...a) } }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function req(body: unknown): Request {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyQstashSignatureMock.mockReset().mockResolvedValue(JSON.stringify({ sourceId: 's1' }))
  getSourceByIdMock.mockReset()
  deleteChunksForSourceMock.mockReset().mockResolvedValue(undefined)
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
  markSourceReadyMock.mockReset().mockResolvedValue(undefined)
  markSourceFailedMock.mockReset().mockResolvedValue(undefined)
  scrapeMock.mockReset()
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/pipeline/knowledge-scrape', () => {
  it('should return 401 when the qstash signature is invalid', async () => {
    verifyQstashSignatureMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature'))
    const res = await POST(req({ sourceId: 's1' }))
    expect(res.status).toBe(401)
  })

  it('should return 404 when the source does not exist', async () => {
    getSourceByIdMock.mockResolvedValue(null)
    const res = await POST(req({ sourceId: 's1' }))
    expect(res.status).toBe(404)
  })

  it('should scrape, delete old chunks, embed, and mark ready on success', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockResolvedValue('# Acme\nWe build widgets')
    const res = await POST(req({ sourceId: 's1' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteChunksForSourceMock).toHaveBeenCalledWith(expect.anything(), 's1')
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', sourceId: 's1', content: '# Acme\nWe build widgets',
    }))
    expect(markSourceReadyMock).toHaveBeenCalledWith(expect.anything(), 's1', '# Acme\nWe build widgets', 24)
    expect(markSourceFailedMock).not.toHaveBeenCalled()
  })

  it('should mark the source failed when the scrape throws', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', url: 'https://a.com/1', source_type: 'website_page' })
    scrapeMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'Brightdata scrape failed'))
    const res = await POST(req({ sourceId: 's1' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(markSourceFailedMock).toHaveBeenCalledWith(expect.anything(), 's1', 'Brightdata scrape failed')
    expect(embedAndStoreChunksMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/pipeline/knowledge-scrape/route.test.ts`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getSourceById, deleteChunksForSource, embedAndStoreChunks, markSourceReady, markSourceFailed,
} from '@/lib/db/client-knowledge'
import { brightdataResearch } from '@/lib/research/brightdata'
import { isAppError, AppError } from '@/lib/errors/app-error'
import { logEventSafe, logError } from '@/lib/events/log-event'

export const runtime = 'nodejs'

const ACTOR = 'knowledge_scrape'
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
      const content = await brightdataResearch.scrape(source.url)
      // Delete-then-insert (not append) keeps this idempotent across QStash's
      // own automatic retries and the explicit re-scrape action — both funnel
      // through this same route and must never leave duplicate chunks behind.
      await deleteChunksForSource(admin, sourceId)
      await embedAndStoreChunks(admin, { clientId: source.client_id, sourceId, content, actor: ACTOR })
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/pipeline/knowledge-scrape/route.test.ts`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/pipeline/knowledge-scrape/route.ts src/app/api/pipeline/knowledge-scrape/route.test.ts
git commit -m "feat: add QStash consumer that scrapes, chunks, and embeds one knowledge page"
```

---

### Task 12: Routes — PDF upload and source delete

**Files:**
- Create: `src/app/api/clients/[clientId]/knowledge/pdf/route.ts`
- Create: `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts`
- Test: `src/app/api/clients/[clientId]/knowledge/pdf/route.test.ts`
- Test: `src/app/api/clients/[clientId]/knowledge/[sourceId]/route.test.ts`

**Interfaces:**
- Consumes: `uploadClientKnowledgePdf`/`deleteClientKnowledgePdfObject` (Task 6), `extractPdfText` (Task 5), `insertPdfSourceReady`/`embedAndStoreChunks`/`deleteSource`/`getSourceById` (Task 7).
- Produces: `POST` (pdf upload) and `DELETE` (source removal) handlers — consumed by Task 17's UI.

- [ ] **Step 1: Write the failing tests**

`src/app/api/clients/[clientId]/knowledge/pdf/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const uploadClientKnowledgePdfMock = vi.fn()
const extractPdfTextMock = vi.fn()
const insertPdfSourceReadyMock = vi.fn()
const embedAndStoreChunksMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/storage/client-knowledge-pdfs', () => ({
  uploadClientKnowledgePdf: (...a: unknown[]) => uploadClientKnowledgePdfMock(...a),
}))
vi.mock('@/lib/knowledge/pdf-extract', () => ({ extractPdfText: (...a: unknown[]) => extractPdfTextMock(...a) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  insertPdfSourceReady: (...a: unknown[]) => insertPdfSourceReadyMock(...a),
  embedAndStoreChunks: (...a: unknown[]) => embedAndStoreChunksMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function postReq(file?: File): Request {
  const formData = new FormData()
  if (file) formData.set('file', file)
  return new Request('http://x', { method: 'POST', body: formData })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  uploadClientKnowledgePdfMock.mockReset()
  extractPdfTextMock.mockReset()
  insertPdfSourceReadyMock.mockReset()
  embedAndStoreChunksMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/pdf', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when no file is provided', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    const res = await POST(postReq(), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return 400 when the upload is rejected as invalid', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    uploadClientKnowledgePdfMock.mockRejectedValue(new AppError('VALIDATION_ERROR', 'PDF must be 10MB or smaller'))
    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should upload, extract, embed, insert the ready source, and log on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1' })
    uploadClientKnowledgePdfMock.mockResolvedValue('c1/x.pdf')
    extractPdfTextMock.mockResolvedValue('Extracted PDF text')
    insertPdfSourceReadyMock.mockResolvedValue({ id: 's1', title: 'doc.pdf' })

    const res = await POST(postReq(new File(['x'], 'doc.pdf', { type: 'application/pdf' })), ctx('c1'))
    const json = await res.json()

    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, source: { id: 's1', title: 'doc.pdf' } })
    expect(insertPdfSourceReadyMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', title: 'doc.pdf', storagePath: 'c1/x.pdf', content: 'Extracted PDF text', charCount: 19,
    }))
    expect(embedAndStoreChunksMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      clientId: 'c1', sourceId: 's1', content: 'Extracted PDF text',
    }))
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'knowledge.pdf_uploaded' }))
  })
})
```

`src/app/api/clients/[clientId]/knowledge/[sourceId]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getSourceByIdMock = vi.fn()
const deleteSourceMock = vi.fn()
const deleteClientKnowledgePdfObjectMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  deleteSource: (...a: unknown[]) => deleteSourceMock(...a),
}))
vi.mock('@/lib/storage/client-knowledge-pdfs', () => ({
  deleteClientKnowledgePdfObject: (...a: unknown[]) => deleteClientKnowledgePdfObjectMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { DELETE } from './route'

function ctx(clientId: string, sourceId: string) {
  return { params: Promise.resolve({ clientId, sourceId }) }
}
function req(): Request {
  return new Request('http://x', { method: 'DELETE' })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getSourceByIdMock.mockReset()
  deleteSourceMock.mockReset()
  deleteClientKnowledgePdfObjectMock.mockReset().mockResolvedValue(undefined)
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/clients/[clientId]/knowledge/[sourceId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the source does not exist', async () => {
    getSourceByIdMock.mockResolvedValue(null)
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(404)
  })

  it('should return 404 when the source belongs to a different client', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'other-client' })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(404)
  })

  it('should delete a website_page source without touching storage', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'website_page', storage_path: null })
    deleteSourceMock.mockResolvedValue({ id: 's1' })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(200)
    expect(deleteClientKnowledgePdfObjectMock).not.toHaveBeenCalled()
  })

  it('should delete a pdf source and its storage object', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'pdf', storage_path: 'c1/x.pdf' })
    deleteSourceMock.mockResolvedValue({ id: 's1' })
    const res = await DELETE(req(), ctx('c1', 's1'))
    expect(res.status).toBe(200)
    expect(deleteClientKnowledgePdfObjectMock).toHaveBeenCalledWith(expect.anything(), 'c1/x.pdf')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/knowledge/pdf/route.test.ts" "src/app/api/clients/[clientId]/knowledge/[sourceId]/route.test.ts"`
Expected: FAIL — modules don't exist.

- [ ] **Step 3: Implement the PDF upload route**

`src/app/api/clients/[clientId]/knowledge/pdf/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById } from '@/lib/db/clients'
import { uploadClientKnowledgePdf } from '@/lib/storage/client-knowledge-pdfs'
import { extractPdfText } from '@/lib/knowledge/pdf-extract'
import { insertPdfSourceReady, embedAndStoreChunks } from '@/lib/db/client-knowledge'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'
const ACTOR = 'knowledge_pdf_upload'

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) return NextResponse.json({ error: 'not_found' }, { status: 404 })

  try {
    const formData = await request.formData()
    const file = formData.get('file')
    if (!(file instanceof File)) {
      return NextResponse.json({ error: 'validation_error', issues: 'file is required' }, { status: 400 })
    }

    // No network call — extraction, chunking, and embedding all happen inline
    // (no QStash needed, unlike a website page's Brightdata scrape).
    const storagePath = await uploadClientKnowledgePdf(admin, clientId, file)
    const buffer = await file.arrayBuffer()
    const content = await extractPdfText(buffer)

    const source = await insertPdfSourceReady(admin, {
      clientId, createdBy: appUser.id, title: file.name, storagePath, content, charCount: content.length,
    })
    await embedAndStoreChunks(admin, { clientId, sourceId: source.id, content, actor: ACTOR })

    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.pdf_uploaded',
      payload: { sourceId: source.id, title: file.name, charCount: content.length },
    })

    return NextResponse.json({ ok: true, source })
  } catch (error) {
    if (isAppError(error) && error.code === 'VALIDATION_ERROR') {
      return NextResponse.json({ error: 'validation_error', issues: error.message }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Implement the source delete route**

`src/app/api/clients/[clientId]/knowledge/[sourceId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSourceById, deleteSource } from '@/lib/db/client-knowledge'
import { deleteClientKnowledgePdfObject } from '@/lib/storage/client-knowledge-pdfs'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ clientId: string; sourceId: string }> },
) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId, sourceId } = await context.params
  const admin = createAdminClient()
  const source = await getSourceById(admin, sourceId)
  // Cross-client mismatch returns the same 404 as "not found" — no existence leak.
  if (!source || source.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    await deleteSource(admin, sourceId)
    if (source.source_type === 'pdf' && source.storage_path) {
      await deleteClientKnowledgePdfObject(admin, source.storage_path)
    }
    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.source_deleted',
      payload: { sourceId, sourceType: source.source_type, title: source.title },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/knowledge/pdf/route.test.ts" "src/app/api/clients/[clientId]/knowledge/[sourceId]/route.test.ts"`
Expected: PASS, 5/5 and 5/5.

- [ ] **Step 6: Commit**

```bash
git add "src/app/api/clients/[clientId]/knowledge/pdf" "src/app/api/clients/[clientId]/knowledge/[sourceId]"
git commit -m "feat: add PDF upload and knowledge source delete routes"
```

---

### Task 13: Route — re-scrape a website page source

**Files:**
- Create: `src/app/api/clients/[clientId]/knowledge/[sourceId]/rescrape/route.ts`
- Test: `src/app/api/clients/[clientId]/knowledge/[sourceId]/rescrape/route.test.ts`

**Interfaces:**
- Consumes: `getSourceById`/`resetSourceToPending` (Task 7), `publishJson`.
- Produces: `POST` handler — consumed by Task 17's UI.

- [ ] **Step 1: Write the failing test**

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getSourceByIdMock = vi.fn()
const resetSourceToPendingMock = vi.fn()
const publishJsonMock = vi.fn()
const logEventSafeMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  getSourceById: (...a: unknown[]) => getSourceByIdMock(...a),
  resetSourceToPending: (...a: unknown[]) => resetSourceToPendingMock(...a),
}))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventSafeMock(...a) }))

import { POST } from './route'

function ctx(clientId: string, sourceId: string) {
  return { params: Promise.resolve({ clientId, sourceId }) }
}
function req(): Request {
  return new Request('http://x', { method: 'POST' })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getSourceByIdMock.mockReset()
  resetSourceToPendingMock.mockReset().mockResolvedValue(undefined)
  publishJsonMock.mockReset().mockResolvedValue('msg1')
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/knowledge/[sourceId]/rescrape', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the source is missing or belongs to a different client', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'other', source_type: 'website_page' })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(404)
  })

  it('should return 400 for a pdf source', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'pdf' })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(400)
    expect(resetSourceToPendingMock).not.toHaveBeenCalled()
  })

  it('should reset to pending and republish a scrape job', async () => {
    getSourceByIdMock.mockResolvedValue({ id: 's1', client_id: 'c1', source_type: 'website_page', url: 'https://a.com/1' })
    const res = await POST(req(), ctx('c1', 's1'))
    expect(res.status).toBe(200)
    expect(resetSourceToPendingMock).toHaveBeenCalledWith(expect.anything(), 's1')
    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/knowledge-scrape', { sourceId: 's1' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/knowledge/[sourceId]/rescrape/route.test.ts"`
Expected: FAIL — module doesn't exist.

- [ ] **Step 3: Implement**

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getSourceById, resetSourceToPending } from '@/lib/db/client-knowledge'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(
  _request: Request,
  context: { params: Promise<{ clientId: string; sourceId: string }> },
) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId, sourceId } = await context.params
  const admin = createAdminClient()
  const source = await getSourceById(admin, sourceId)
  if (!source || source.client_id !== clientId) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (source.source_type !== 'website_page') {
    return NextResponse.json({ error: 'validation_error', issues: 'only website pages can be re-scraped' }, { status: 400 })
  }

  try {
    // The scrape route itself deletes the source's existing chunks before
    // inserting fresh ones, so resetting to 'pending' here doesn't need to
    // touch client_knowledge_chunks — this is just the visible status flip.
    await resetSourceToPending(admin, sourceId)
    await publishJson('/api/pipeline/knowledge-scrape', { sourceId })
    await logEventSafe({
      clientId, actor: `human:${appUser.id}`, type: 'knowledge.page_rescrape_requested',
      payload: { sourceId, url: source.url },
    })
    return NextResponse.json({ ok: true })
  } catch (error) {
    return NextResponse.json({ error: isAppError(error) ? error.code : 'unknown' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/knowledge/[sourceId]/rescrape/route.test.ts"`
Expected: PASS, 4/4.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/knowledge/[sourceId]/rescrape"
git commit -m "feat: add knowledge page re-scrape route"
```

---

### Task 14: Wire retrieval into the four AI copy-generation pipelines

**Files:**
- Modify: `src/lib/pipeline/write.ts`
- Modify: `src/lib/pipeline/followup.ts`
- Modify: `src/lib/pipeline/reply.ts`
- Modify: `src/lib/pipeline/knowledge-answer.ts`
- Modify (tests): `src/lib/pipeline/write.test.ts`, `src/lib/pipeline/followup.test.ts`, `src/lib/pipeline/reply.test.ts`, `src/lib/pipeline/knowledge-answer.test.ts` — add a mock for `retrieveClientKnowledge` to each (find the existing `vi.mock` block for `@/lib/db/case-knowledge` or similar and add a sibling mock so pre-existing tests keep passing with the new call in place).

**Interfaces:**
- Consumes: `retrieveClientKnowledge` (Task 8).

- [ ] **Step 1: Update `write.ts`'s test mocks first (keeps the suite green through the edit)**

In `src/lib/pipeline/write.test.ts`, add near the other `vi.mock` calls:

```ts
vi.mock('@/lib/knowledge/client-context', () => ({ retrieveClientKnowledge: vi.fn().mockResolvedValue('') }))
```

- [ ] **Step 2: Edit `src/lib/pipeline/write.ts`**

Add the import:

```ts
import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'
```

Change `buildPrompt` to accept the client-knowledge block and insert it after the value-prop line:

```ts
function buildPrompt(input: RunWriteInput, lead: LeadRow, knowledge: KnowledgeRow[], clientKnowledge: string): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
    input.bookingLink ? `Booking link (optional CTA): ${input.bookingLink}` : '',
    `Dossier:\n${dossier}`,
    'Write the first-touch email. Return a subject and a body.',
  ]
    .filter(Boolean)
    .join('\n\n')
}
```

Update `processLead`'s signature and its `buildPrompt` call:

```ts
async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  clientKnowledge: string,
): Promise<'sent' | 'drafted' | 'skipped'> {
  if (!lead.email) return 'skipped'
  if (await isSuppressed(supabase, input.clientId, lead.email)) return 'skipped'

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
```

(the rest of `processLead`'s body is unchanged). Update `runWriteForCase` to build the retrieval query once per case and pass it through:

```ts
export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)

  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(
    supabase, input.clientId, `${dossierText} ${input.valueProp ?? ''}`.trim(),
  )

  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    const outcome = await processLead(supabase, input, lead, knowledge, clientKnowledge)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
  }
  // ...rest unchanged
```

- [ ] **Step 3: Run write.ts's tests, fix the `processLead`/`buildPrompt` call-site test expectations**

Run: `pnpm vitest run src/lib/pipeline/write.test.ts`
Expected: any existing test asserting on `generateJson`'s exact `prompt` string (if one exists) needs its expected string updated to account for the new empty `clientKnowledge` block (which renders as nothing, since `''` is falsy and filtered out — so most prompt-content assertions should be unaffected). Fix any that fail by re-reading the actual received prompt in the test failure output and adjusting the expectation.

- [ ] **Step 4: Repeat the same shape of edit for `followup.ts`**

Test file `src/lib/pipeline/followup.test.ts` gets the same mock line as Step 1. In `src/lib/pipeline/followup.ts`, add the import, change `buildNudgePrompt` to take `clientKnowledge: string` and insert `clientKnowledge ? \`About our company:\n${clientKnowledge}\` : ''` right after the value-prop line (same pattern as write.ts), and in `runFollowupStep` call `retrieveClientKnowledge` once (using `thread` facts + `campaign.value_prop` as the query — reuse `firstOutbound?.body ?? ''` plus `campaign.value_prop` since there's no per-case dossier fetched in this file) right before building the prompt:

```ts
const clientKnowledge = await retrieveClientKnowledge(
  supabase, sequence.client_id, `${firstOutbound?.body ?? ''} ${campaign.value_prop ?? ''}`.trim(),
)
const nudgeBody = await generateText(context, {
  instructions: SYSTEM_PROMPT,
  prompt: buildNudgePrompt(
    priorSubject,
    firstOutbound?.body ?? '',
    campaign.value_prop,
    campaign.booking_link,
    input.step,
    clientKnowledge,
  ),
  maxOutputTokens: MAX_OUTPUT_TOKENS,
})
```

And update `buildNudgePrompt`:

```ts
function buildNudgePrompt(
  priorSubject: string,
  priorBody: string,
  valueProp: string | null,
  bookingLink: string | null,
  step: number,
  clientKnowledge: string,
): string {
  const showBookingLink = bookingLink !== null && step >= BOOKING_LINK_ELIGIBLE_STEP
  return [
    `This is follow-up number ${step} (of ${MAX_FOLLOWUP_STEP}).`,
    `Original subject: ${priorSubject}`,
    `Original message:\n${priorBody}`,
    `Our value proposition: ${valueProp ?? 'n/a'}`,
    clientKnowledge ? `About our company:\n${clientKnowledge}` : '',
    showBookingLink ? `Booking link (optional CTA): ${bookingLink}` : '',
    'Write only the follow-up body text (no subject line).',
  ]
    .filter(Boolean)
    .join('\n\n')
}
```

Run: `pnpm vitest run src/lib/pipeline/followup.test.ts` — fix any failing prompt-string assertions the same way as Step 3.

- [ ] **Step 5: Repeat for `reply.ts`**

Test file `src/lib/pipeline/reply.test.ts` gets the same mock line. In `src/lib/pipeline/reply.ts`, add the import, change `buildClassifyPrompt` to accept `clientKnowledge: string` and insert the block after the value-prop line, and in `runReplyForInbound` fetch it once (query built from the dossier + inbound body + value prop, since this is triaging a live reply) before calling `classifyReply`:

```ts
function buildClassifyPrompt(args: {
  thread: EmailRow[]; knowledge: KnowledgeRow[]; valueProp: string | null; inboundBody: string; clientKnowledge: string
}): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const transcript = args.thread
    .map((e) => `[${e.direction}] ${e.subject ?? ''}\n${e.body ?? ''}`)
    .join('\n---\n')
  return [
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    args.clientKnowledge ? `About our company:\n${args.clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    `Thread so far:\n${transcript}`,
    `Latest inbound reply to triage:\n${args.inboundBody}`,
  ]
    .filter(Boolean)
    .join('\n\n')
}

export async function classifyReply(
  context: LlmCallContext,
  args: { thread: EmailRow[]; knowledge: KnowledgeRow[]; valueProp: string | null; inboundBody: string; clientKnowledge: string },
): Promise<ReplyClassification> {
  return generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildClassifyPrompt(args),
    schema: classificationSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    timeoutMs: CLASSIFY_TIMEOUT_MS,
    thinkingLevel: 'medium',
  })
}
```

And in `runReplyForInbound`, right before `classifyReply` is called:

```ts
  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(
    supabase, inbound.client_id, `${dossierText} ${inbound.body ?? ''} ${campaign.value_prop ?? ''}`.trim(),
  )
  const classification = await classifyReply(context, {
    thread, knowledge, valueProp: campaign.value_prop, inboundBody: inbound.body ?? '', clientKnowledge,
  })
```

Add the import at the top: `import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'`.

Run: `pnpm vitest run src/lib/pipeline/reply.test.ts` — fix any failing assertions on `classifyReply`'s args shape (it now requires `clientKnowledge` in the args object) or the prompt string.

- [ ] **Step 6: Repeat for `knowledge-answer.ts`**

Test file `src/lib/pipeline/knowledge-answer.test.ts` gets the same mock line. In `src/lib/pipeline/knowledge-answer.ts`, add the import, change `buildAnswerPrompt` to accept `clientKnowledge: string`, and fetch it once in `runKnowledgeAnswer` before calling `generateText`:

```ts
function buildAnswerPrompt(args: {
  thread: EmailRow[]; knowledge: KnowledgeRow[]; humanAnswer: string; valueProp: string | null; clientKnowledge: string
}): string {
  const dossier = args.knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  const lastInbound = [...args.thread].reverse().find((e) => e.direction === 'inbound')
  return [
    `The colleague's answer to use: ${args.humanAnswer}`,
    `Our value proposition: ${args.valueProp ?? 'n/a'}`,
    args.clientKnowledge ? `About our company:\n${args.clientKnowledge}` : '',
    `Dossier:\n${dossier}`,
    `The prospect's question:\n${lastInbound?.body ?? ''}`,
    'Write only the reply body (no subject line).',
  ]
    .filter(Boolean)
    .join('\n\n')
}
```

```ts
  const context: LlmCallContext = { clientId: inbound.client_id, caseId: inbound.case_id, actor: ACTOR }
  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(
    supabase, inbound.client_id, `${dossierText} ${kr.human_answer} ${campaign.value_prop ?? ''}`.trim(),
  )
  const body = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildAnswerPrompt({ thread, knowledge, humanAnswer: kr.human_answer, valueProp: campaign.value_prop, clientKnowledge }),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })
```

Add the import: `import { retrieveClientKnowledge } from '@/lib/knowledge/client-context'`.

Run: `pnpm vitest run src/lib/pipeline/knowledge-answer.test.ts` — fix any failing assertions.

- [ ] **Step 7: Run the full pipeline test suite and typecheck**

Run: `pnpm vitest run src/lib/pipeline/`
Expected: all pipeline tests PASS.

Run: `pnpm tsc --noEmit`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts \
        src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts \
        src/lib/pipeline/reply.ts src/lib/pipeline/reply.test.ts \
        src/lib/pipeline/knowledge-answer.ts src/lib/pipeline/knowledge-answer.test.ts
git commit -m "feat: ground write/followup/reply/knowledge-answer prompts in the client knowledge base"
```

---

### Task 15: UI — sitemap picker and PDF upload components

**Files:**
- Create: `src/app/(app)/clients/[id]/knowledge-sitemap-picker.tsx`
- Create: `src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx`

**Interfaces:**
- Consumes: `POST /api/clients/[clientId]/knowledge/discover-sitemap`, `POST /api/clients/[clientId]/knowledge/pages`, `POST /api/clients/[clientId]/knowledge/pdf` (Tasks 9, 10, 12).
- Produces: `<KnowledgeSitemapPicker clientId />`, `<KnowledgePdfUpload clientId />` — consumed by Task 17's tab wiring.

- [ ] **Step 1: Implement the sitemap picker**

`src/app/(app)/clients/[id]/knowledge-sitemap-picker.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { MagnifyingGlass } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type DiscoverState = { status: 'idle' } | { status: 'loading' } | { status: 'error'; message: string }
type SubmitState = { status: 'idle' } | { status: 'submitting' }

interface KnowledgeSitemapPickerProps {
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

// Enter a website -> discover its pages via sitemap.xml (Brightdata crawl
// fallback server-side) -> pick which ones to scrape into the knowledge base.
export function KnowledgeSitemapPicker({ clientId }: KnowledgeSitemapPickerProps): React.ReactElement {
  const router = useRouter()
  const [websiteUrl, setWebsiteUrl] = useState('')
  const [discoverState, setDiscoverState] = useState<DiscoverState>({ status: 'idle' })
  const [urls, setUrls] = useState<string[]>([])
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [submitState, setSubmitState] = useState<SubmitState>({ status: 'idle' })

  async function onDiscover(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setDiscoverState({ status: 'loading' })
    setUrls([])
    setSelected(new Set())
    try {
      const res = await fetch(`/api/clients/${clientId}/knowledge/discover-sitemap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ websiteUrl }),
      })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not discover pages for this site.')
        setDiscoverState({ status: 'error', message })
        return
      }
      const json = (await res.json()) as { urls: string[] }
      setUrls(json.urls)
      setDiscoverState({ status: 'idle' })
      if (json.urls.length === 0) toast.info('No pages found on this site.')
    } catch {
      setDiscoverState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  function toggle(url: string): void {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(url)) next.delete(url)
      else next.add(url)
      return next
    })
  }

  function toggleAll(): void {
    setSelected((prev) => (prev.size === urls.length ? new Set() : new Set(urls)))
  }

  async function onAddSelected(): Promise<void> {
    if (selected.size === 0) return
    setSubmitState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/knowledge/pages`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ urls: Array.from(selected) }),
      })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not add the selected pages.')
        toast.error('Add failed', { description: message })
        setSubmitState({ status: 'idle' })
        return
      }
      const json = (await res.json()) as { insertedCount: number }
      toast.success(
        json.insertedCount > 0 ? `${json.insertedCount} page(s) queued for scraping` : 'Those pages were already added',
      )
      setUrls([])
      setSelected(new Set())
      setWebsiteUrl('')
      setSubmitState({ status: 'idle' })
      router.refresh()
    } catch {
      toast.error('Add failed', { description: 'Network request failed. Check your connection and retry.' })
      setSubmitState({ status: 'idle' })
    }
  }

  const isDiscovering = discoverState.status === 'loading'
  const isSubmitting = submitState.status === 'submitting'
  const overBatchLimit = selected.size > 50

  return (
    <div className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-4">
      <form onSubmit={(e) => void onDiscover(e)} className="flex items-center gap-2">
        <Input
          type="url"
          required
          placeholder="https://client-website.com"
          value={websiteUrl}
          onChange={(e) => setWebsiteUrl(e.target.value)}
          aria-label="Website URL"
        />
        <Button type="submit" disabled={isDiscovering}>
          <MagnifyingGlass size={14} weight="light" />
          {isDiscovering ? 'Discovering…' : 'Discover pages'}
        </Button>
      </form>

      {discoverState.status === 'error' ? (
        <p role="alert" className="text-destructive text-[13px]">{discoverState.message}</p>
      ) : null}

      {urls.length > 0 ? (
        <div className="flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <label className="flex items-center gap-2 text-[13px]">
              <input type="checkbox" checked={selected.size === urls.length} onChange={toggleAll} />
              Select all ({urls.length} found)
            </label>
            <Button type="button" size="sm" disabled={selected.size === 0 || overBatchLimit || isSubmitting} onClick={() => void onAddSelected()}>
              {isSubmitting ? 'Adding…' : `Add selected (${selected.size})`}
            </Button>
          </div>
          {overBatchLimit ? (
            <p className="text-destructive text-[12px]">Select 50 or fewer pages at a time.</p>
          ) : null}
          <ul className="border-hairline max-h-80 overflow-y-auto rounded-md border">
            {urls.map((url) => (
              <li key={url} className="border-hairline flex items-center gap-2 border-b px-3 py-2 text-[13px] last:border-b-0">
                <input type="checkbox" checked={selected.has(url)} onChange={() => toggle(url)} />
                <span className="truncate">{url}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Implement the PDF upload component**

`src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx`:

```tsx
'use client'

import { useRef, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FilePdf } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

type UploadState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface KnowledgePdfUploadProps {
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

export function KnowledgePdfUpload({ clientId }: KnowledgePdfUploadProps): React.ReactElement {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [state, setState] = useState<UploadState>({ status: 'idle' })

  async function onFileSelected(event: React.ChangeEvent<HTMLInputElement>): Promise<void> {
    const file = event.target.files?.[0]
    event.target.value = ''
    if (!file) return

    setState({ status: 'submitting' })
    try {
      const formData = new FormData()
      formData.set('file', file)
      const res = await fetch(`/api/clients/${clientId}/knowledge/pdf`, { method: 'POST', body: formData })
      if (!res.ok) {
        const message = await extractErrorMessage(res, 'Could not upload the PDF.')
        setState({ status: 'error', message })
        toast.error('Upload failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success('PDF added to the knowledge base')
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Upload failed', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <div className="flex items-center gap-2">
      <input
        ref={inputRef}
        type="file"
        accept="application/pdf"
        className="sr-only"
        onChange={(event) => void onFileSelected(event)}
        aria-label="Upload PDF"
      />
      <Button type="button" variant="secondary" size="sm" disabled={isSubmitting} onClick={() => inputRef.current?.click()}>
        <FilePdf size={14} weight="light" />
        {isSubmitting ? 'Uploading…' : 'Upload PDF'}
      </Button>
      {state.status === 'error' ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">{state.message}</span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: clean (these components aren't imported anywhere yet, so this only checks the files compile standalone).

- [ ] **Step 4: Lint**

Run: `pnpm eslint src/app/\(app\)/clients/\[id\]/knowledge-sitemap-picker.tsx src/app/\(app\)/clients/\[id\]/knowledge-pdf-upload.tsx`
Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/clients/[id]/knowledge-sitemap-picker.tsx" "src/app/(app)/clients/[id]/knowledge-pdf-upload.tsx"
git commit -m "feat: add sitemap picker and PDF upload UI for the client knowledge base"
```

---

### Task 16: UI — sources list, row actions, and realtime refresher

**Files:**
- Create: `src/app/(app)/clients/[id]/knowledge-sources-list.tsx`
- Create: `src/app/(app)/clients/[id]/knowledge-source-actions.tsx`
- Create: `src/app/(app)/clients/[id]/knowledge-realtime-refresher.tsx`
- Modify: `src/lib/ui/status.ts` (add `KNOWLEDGE_SOURCE_STATUS` map)

**Interfaces:**
- Consumes: `KnowledgeSourceRow` (Task 7), `POST .../rescrape` (Task 13), `DELETE .../[sourceId]` (Task 12), `formatRelative` (`@/lib/format`), `StatusPill`/`Table` primitives.
- Produces: `<KnowledgeSourcesList clientId sources />`, `<KnowledgeRealtimeRefresher clientId />` — consumed by Task 17.

- [ ] **Step 1: Add the status map**

In `src/lib/ui/status.ts`, add the type import and the map (place near `KNOWLEDGE_REQ_STATUS` or `CLIENT_STATUS`):

```ts
type KnowledgeSourceStatus = Database['public']['Enums']['knowledge_source_status']
```

```ts
export const KNOWLEDGE_SOURCE_STATUS: Record<KnowledgeSourceStatus, StatusMeta> = {
  pending: { label: 'Pending', color: 'var(--status-researching)' },
  ready: { label: 'Ready', color: 'var(--status-won)' },
  failed: { label: 'Failed', color: 'var(--status-lost)' },
}
```

- [ ] **Step 2: Implement the row actions (client component)**

`src/app/(app)/clients/[id]/knowledge-source-actions.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowClockwise, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

interface KnowledgeSourceActionsProps {
  clientId: string
  sourceId: string
  sourceType: 'website_page' | 'pdf'
}

type ActionState = { status: 'idle' } | { status: 'submitting' }

export function KnowledgeSourceActions({ clientId, sourceId, sourceType }: KnowledgeSourceActionsProps): React.ReactElement {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({ status: 'idle' })
  const isSubmitting = state.status === 'submitting'

  async function onRescrape(): Promise<void> {
    setState({ status: 'submitting' })
    const res = await fetch(`/api/clients/${clientId}/knowledge/${sourceId}/rescrape`, { method: 'POST' })
    setState({ status: 'idle' })
    if (!res.ok) {
      toast.error('Could not re-scrape this page')
      return
    }
    toast.success('Re-scrape queued')
    router.refresh()
  }

  async function onDelete(): Promise<void> {
    if (!window.confirm('Remove this from the knowledge base?')) return
    setState({ status: 'submitting' })
    const res = await fetch(`/api/clients/${clientId}/knowledge/${sourceId}`, { method: 'DELETE' })
    setState({ status: 'idle' })
    if (!res.ok) {
      toast.error('Could not delete this source')
      return
    }
    toast.success('Removed from the knowledge base')
    router.refresh()
  }

  return (
    <div className="flex items-center gap-1">
      {sourceType === 'website_page' ? (
        <Button type="button" variant="ghost" size="sm" aria-label="Re-scrape" disabled={isSubmitting} onClick={() => void onRescrape()}>
          <ArrowClockwise size={14} weight="light" />
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="sm" aria-label="Delete" disabled={isSubmitting} onClick={() => void onDelete()}>
        <Trash size={14} weight="light" />
      </Button>
    </div>
  )
}
```

- [ ] **Step 3: Implement the sources list (server-renderable, no data fetching of its own — props in)**

`src/app/(app)/clients/[id]/knowledge-sources-list.tsx`:

```tsx
import { Files } from '@phosphor-icons/react/dist/ssr'
import type { KnowledgeSourceRow } from '@/lib/db/client-knowledge'
import { KNOWLEDGE_SOURCE_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { EmptyState } from '@/components/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatRelative } from '@/lib/format'
import { KnowledgeSourceActions } from './knowledge-source-actions'

interface KnowledgeSourcesListProps {
  clientId: string
  sources: KnowledgeSourceRow[]
  now: Date
}

export function KnowledgeSourcesList({ clientId, sources, now }: KnowledgeSourcesListProps): React.ReactElement {
  if (sources.length === 0) {
    return (
      <EmptyState
        icon={Files}
        title="No knowledge sources yet"
        description="Discover a website above or upload a PDF to start building this client's knowledge base."
      />
    )
  }

  return (
    <div className="border-hairline overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Source</TableHead>
            <TableHead scope="col">Type</TableHead>
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Added</TableHead>
            <TableHead scope="col" className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((source) => (
            <TableRow key={source.id}>
              <TableCell className="max-w-xs truncate text-[13px]" title={source.error_message ?? undefined}>
                {source.title}
              </TableCell>
              <TableCell className="text-muted-foreground text-[13px]">
                {source.source_type === 'pdf' ? 'PDF' : 'Web page'}
              </TableCell>
              <TableCell>
                <StatusPill meta={KNOWLEDGE_SOURCE_STATUS[source.status]} />
              </TableCell>
              <TableCell className="text-muted-foreground text-[13px]">{formatRelative(source.created_at, now)}</TableCell>
              <TableCell className="text-right">
                <KnowledgeSourceActions clientId={clientId} sourceId={source.id} sourceType={source.source_type} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
```

- [ ] **Step 4: Implement the realtime refresher**

`src/app/(app)/clients/[id]/knowledge-realtime-refresher.tsx`:

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

const REFRESH_DEBOUNCE_MS = 1500

interface KnowledgeRealtimeRefresherProps {
  clientId: string
}

// Same pattern as analytics/realtime-refresher.tsx: listens for a source row
// flipping pending -> ready/failed and asks the server to re-render, so the
// operator sees scrape progress without a manual refresh. Filtered to this
// client's rows only — a QStash fan-out can touch many clients' sources
// concurrently.
export function KnowledgeRealtimeRefresher({ clientId }: KnowledgeRealtimeRefresherProps): null {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel(`knowledge-sources-${clientId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'client_knowledge_sources', filter: `client_id=eq.${clientId}` },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'client_knowledge_sources', filter: `client_id=eq.${clientId}` },
        scheduleRefresh,
      )
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(channel)
    }
  }, [router, clientId])

  return null
}
```

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm tsc --noEmit && pnpm eslint "src/app/(app)/clients/[id]/knowledge-sources-list.tsx" "src/app/(app)/clients/[id]/knowledge-source-actions.tsx" "src/app/(app)/clients/[id]/knowledge-realtime-refresher.tsx" src/lib/ui/status.ts`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/clients/[id]/knowledge-sources-list.tsx" \
        "src/app/(app)/clients/[id]/knowledge-source-actions.tsx" \
        "src/app/(app)/clients/[id]/knowledge-realtime-refresher.tsx" \
        src/lib/ui/status.ts
git commit -m "feat: add knowledge sources list, row actions, and realtime refresher"
```

---

### Task 17: Wire the "Knowledge Base" tab into `/clients/[id]`

**Files:**
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `listSourcesForClient` (Task 7), `<KnowledgeSitemapPicker>`/`<KnowledgePdfUpload>` (Task 15), `<KnowledgeSourcesList>`/`<KnowledgeRealtimeRefresher>` (Task 16).

- [ ] **Step 1: Add imports**

At the top of `src/app/(app)/clients/[id]/page.tsx`, alongside the existing icon import, add `Books` to the phosphor import line, and add these new imports:

```ts
import { ArrowLeft, Books, ChartLineUp, Lightning, ListMagnifyingGlass, UsersThree } from '@phosphor-icons/react/dist/ssr'
```

```ts
import { listSourcesForClient } from '@/lib/db/client-knowledge'
import { KnowledgeSitemapPicker } from './knowledge-sitemap-picker'
import { KnowledgePdfUpload } from './knowledge-pdf-upload'
import { KnowledgeSourcesList } from './knowledge-sources-list'
import { KnowledgeRealtimeRefresher } from './knowledge-realtime-refresher'
```

- [ ] **Step 2: Extend the tab schema and add the tab's data fetch**

Change:

```ts
const tabSchema = z.enum(['campaigns', 'analytics', 'users', 'logs'])
```

to:

```ts
const tabSchema = z.enum(['campaigns', 'analytics', 'users', 'knowledge', 'logs'])
```

Add the knowledge-sources fetch alongside the existing `logRows` conditional fetch (same "only query when this tab is open" convention):

```ts
  const knowledgeSources = tab === 'knowledge' ? await listSourcesForClient(admin, clientId) : []
```

- [ ] **Step 3: Add the tab trigger**

In the `<TabsList>`, add a new trigger between `users` and `logs`:

```tsx
          <TabsTrigger value="knowledge" asChild>
            <Link href={`/clients/${clientId}?tab=knowledge`}>
              <Books size={14} weight="light" />
              Knowledge Base
              <span className="tnum text-faint">{knowledgeSources.length}</span>
            </Link>
          </TabsTrigger>
```

- [ ] **Step 4: Add the tab content**

Between the `<TabsContent value="users">` block and `<TabsContent value="logs">`, add:

```tsx
        <TabsContent value="knowledge">
          <div className="flex flex-col gap-4">
            <KnowledgeRealtimeRefresher clientId={client.id} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground max-w-[60ch] text-[13px]">
                Scraped website pages and uploaded PDFs the AI grounds its emails and
                replies in for this client. Operator-only — never visible to this
                client&apos;s own logins.
              </p>
              <KnowledgePdfUpload clientId={client.id} />
            </div>
            <KnowledgeSitemapPicker clientId={client.id} />
            <KnowledgeSourcesList clientId={client.id} sources={knowledgeSources} now={now} />
          </div>
        </TabsContent>

```

(placed immediately before the existing `<TabsContent value="logs">` line — `now` is already computed earlier in the component for the logs tab, so it's in scope here too).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm tsc --noEmit && pnpm eslint "src/app/(app)/clients/[id]/page.tsx"`
Expected: clean.

- [ ] **Step 6: Build**

Run: `pnpm build`
Expected: succeeds, `/clients/[id]` still compiles with the new route dependencies included.

- [ ] **Step 7: Manual verification**

Run the dev server (`pnpm dev`), sign in as an operator, open a client's page, click "Knowledge Base": confirm the tab renders with the empty state, entering a real website URL and clicking "Discover pages" returns a checklist, selecting a few and clicking "Add selected" shows a "queued" toast and the sources list shows `pending` rows that flip to `ready` shortly after (requires `QSTASH_TOKEN`/`BRIGHTDATA_API_KEY`/`GEMINI_API_KEY` configured against real services — if not available in this environment, note that explicitly rather than claiming it was verified, per this repo's own convention in the roadmap for previously-unverified integrations).

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat: add Knowledge Base tab to the client detail page"
```

---

### Task 18: Final verification pass + roadmap update

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: every test file passes, including all new ones from Tasks 1–14.

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: clean, no errors anywhere in the repo.

- [ ] **Step 3: Lint**

Run: `pnpm eslint .`
Expected: 0 errors (pre-existing warnings unrelated to this feature are fine, matching the repo's existing baseline).

- [ ] **Step 4: Build**

Run: `pnpm build`
Expected: succeeds, new routes appear in the route list (`/api/clients/[clientId]/knowledge/*`, `/api/pipeline/knowledge-scrape`).

- [ ] **Step 5: Update the roadmap**

Add a new dated section to `.claude/roadmap.md` (append after the most recent entry) summarizing what shipped: the schema (pgvector-backed `client_knowledge_sources`/`client_knowledge_chunks`, operator-only RLS), the sitemap-discovery + parallel-scrape flow, PDF upload/extraction, the `retrieveClientKnowledge` wiring into `write`/`followup`/`reply`/`knowledge-answer`, and the new `/clients/[id]` "Knowledge Base" tab. Note any caveats actually encountered during implementation (e.g. if `unpdf`'s API differed from what Task 5 assumed, or if the migration was never applied against a live Postgres because Docker was unavailable — matching this repo's existing convention of flagging unverified-against-a-real-database migrations, as seen for `0008_analytics.sql` and `0012_p4_deliverability.sql`).

- [ ] **Step 6: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: update roadmap for the client knowledge base feature"
```

---

## Self-Review Notes

- **Spec coverage:** data model (Task 1) ✓, storage bucket + PDF extraction (Tasks 5–6) ✓, sitemap discovery + fallback (Task 4) ✓, parallel scrape execution via QStash fan-out (Tasks 10–11) ✓, PDF upload inline path (Task 12) ✓, re-scrape (Task 13) ✓, delete (Task 12) ✓, pgvector retrieval + AI pipeline grounding (Tasks 2, 7, 8, 14) ✓, operator-only RLS + route gating (Task 1, every route task) ✓, UI tab + components + realtime status (Tasks 15–17) ✓.
- **Placeholder scan:** no `TBD`/`TODO` left in any task; every step has literal, complete code.
- **Type consistency check:** `KnowledgeSourceRow`/`KnowledgeChunkRow`/`MatchedChunk` (Task 7) are the single source of truth referenced identically by Tasks 8, 9–13, 16, 17. `retrieveClientKnowledge`'s signature (Task 8) matches its four call sites in Task 14 exactly (`supabase, clientId, queryText, limit?`). `embedTexts`'s `EmbeddingTaskType` union (`'RETRIEVAL_DOCUMENT' | 'RETRIEVAL_QUERY'`) is used consistently in Task 7 (`embedAndStoreChunks` → `'RETRIEVAL_DOCUMENT'`) and Task 8 (`retrieveClientKnowledge` → `'RETRIEVAL_QUERY'`).
