# Multi-Agent Case Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single shared search+LLM research call per case with one agent per subject (the company plus each active lead), each running a Brightdata search+scrape tool loop before extracting structured dossier facts.

**Architecture:** `runResearchForCase` becomes an orchestrator that runs N+1 research agents concurrently in-process (`Promise.allSettled`) — one company agent and one per active lead. Each agent gathers free-text notes via an AI-SDK multi-step tool loop (`search` + `scrape`, 4-step budget), then a second cheap `generateJson` call extracts `case_knowledge` entries. Results merge with graceful partial-failure handling. Downstream consumers (`write.ts`, `reply.ts`, `knowledge-answer.ts`) are unchanged — they read the dossier only via `listKnowledgeForCase`.

**Tech Stack:** TypeScript (strict), Vercel AI SDK v5 (`ai@^5.0.216`, `@ai-sdk/google`), Gemini Flash, Zod, Brightdata SERP + Web Unlocker APIs, Supabase, Vitest.

## Global Constraints

- TypeScript `strict: true` — no `any`, no unchecked `!`. Copied verbatim from `.claude/QUALITY.md`.
- Every external call (Brightdata, LLM) wrapped and mapped to `AppError` — never let raw SDK errors escape.
- Every external call has a timeout.
- Zod validates all external data (Brightdata responses, LLM structured output).
- Files are `kebab-case.ts`; types `PascalCase`; constants `UPPER_SNAKE_CASE`; DB columns `snake_case` mapped to camelCase in TS.
- Named exports only (no default exports in lib files). No barrel files. No `console.log`. No commented-out code, no TODO/FIXME.
- Test naming: `it('should [behavior] when [condition]')`. Mock at the boundary (Brightdata, LLM client), never mock our own business logic. Arrange-Act-Assert.
- Anti-hallucination prompt rule (from existing `research.ts`): agents extract only facts backed by a snippet/page; `sourceUrl` is the source URL or `null`; never invent facts.
- `knowledge_kind` enum is fixed: `company | person | news | pain_point` (plus `answer`, used elsewhere). No new enum value, no migration.

---

## File Structure

**New files:**
- `src/lib/http/fetch-text.ts` — raw-text HTTP fetch with timeout + AppError (scrape returns markdown, not JSON, so `fetchJson` can't be reused).
- `src/lib/http/fetch-text.test.ts`
- `src/lib/research/tools.ts` — AI-SDK tool defs wrapping `research.search` / `research.scrape`.
- `src/lib/research/tools.test.ts`
- `src/lib/research/agent.ts` — `runResearchAgent` (gather via tool loop → extract structured entries).
- `src/lib/research/agent.test.ts`

**Modified files:**
- `src/lib/env.ts` — add `BRIGHTDATA_SCRAPE_ZONE`.
- `.env.example` — document `BRIGHTDATA_SCRAPE_ZONE`.
- `src/lib/research/provider.ts` — add `scrape` to `WebResearch`; move shared research types here.
- `src/lib/research/brightdata.ts` — implement `scrape`.
- `src/lib/research/brightdata.test.ts` — add `scrape` tests.
- `src/lib/llm/client.ts` — add `generateWithTools` (multi-step tool loop wrapper).
- `src/lib/pipeline/research.ts` — rewrite `runResearchForCase` as the multi-agent orchestrator.
- `src/lib/pipeline/research.test.ts` — rewrite to cover merge + partial-failure paths.

No change to `src/app/api/pipeline/research/route.ts` — it already calls `runResearchForCase(admin, { research: brightdataResearch }, input)` and the signature is preserved.

---

## Task 1: Raw-text HTTP fetch helper

**Files:**
- Create: `src/lib/http/fetch-text.ts`
- Test: `src/lib/http/fetch-text.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors/app-error`.
- Produces: `fetchText(url: string, options: RequestInit, timeoutMs?: number): Promise<string>` — returns the response body as text; throws `AppError('EXTERNAL_TIMEOUT')` on abort, `AppError('EXTERNAL_ERROR')` on non-2xx or transport failure.

- [ ] **Step 1: Write the failing test**

Create `src/lib/http/fetch-text.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { fetchText } from './fetch-text'

const fetchMock = vi.fn()

beforeEach(() => {
  fetchMock.mockReset()
  vi.stubGlobal('fetch', fetchMock)
})
afterEach(() => vi.unstubAllGlobals())

describe('fetchText', () => {
  it('should return the response body as text when the request succeeds', async () => {
    fetchMock.mockResolvedValue({ ok: true, status: 200, text: async () => '# Acme\nWe build widgets' })
    const body = await fetchText('https://acme.com', { method: 'GET' })
    expect(body).toBe('# Acme\nWe build widgets')
  })

  it('should throw EXTERNAL_ERROR when the response is not ok', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, text: async () => 'unavailable' })
    await expect(fetchText('https://acme.com', { method: 'GET' })).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_TIMEOUT when the fetch aborts', async () => {
    fetchMock.mockRejectedValue(new DOMException('aborted', 'AbortError'))
    await expect(fetchText('https://acme.com', { method: 'GET' })).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })

  it('should throw EXTERNAL_ERROR when the transport fails for a non-abort reason', async () => {
    fetchMock.mockRejectedValue(new Error('ECONNRESET'))
    const error = await fetchText('https://acme.com', { method: 'GET' }).catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).code).toBe('EXTERNAL_ERROR')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/http/fetch-text.test.ts`
Expected: FAIL — `Failed to resolve import "./fetch-text"` (module not created yet).

- [ ] **Step 3: Write the implementation**

Create `src/lib/http/fetch-text.ts` (mirrors `fetch-json.ts` structure, but returns raw text and skips JSON/Zod parsing):

```ts
import { AppError } from '@/lib/errors/app-error'

const DEFAULT_TIMEOUT_MS = 8000

export async function fetchText(
  url: string,
  options: RequestInit,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...options, signal: controller.signal })
  } catch (cause) {
    const isAbort = cause instanceof DOMException && cause.name === 'AbortError'
    throw new AppError(isAbort ? 'EXTERNAL_TIMEOUT' : 'EXTERNAL_ERROR', 'HTTP request failed', {
      url, cause: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppError('EXTERNAL_ERROR', `HTTP ${response.status}`, {
      url, status: response.status, body: text.slice(0, 500),
    })
  }
  return response.text()
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/http/fetch-text.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/http/fetch-text.ts src/lib/http/fetch-text.test.ts
git commit -m "feat: add fetchText raw-text HTTP helper for page scraping"
```

---

## Task 2: Add BRIGHTDATA_SCRAPE_ZONE env var

**Files:**
- Modify: `src/lib/env.ts`
- Modify: `.env.example`

**Interfaces:**
- Produces: `env.BRIGHTDATA_SCRAPE_ZONE: string` — the Brightdata Web Unlocker zone name used by `scrape`.

- [ ] **Step 1: Add the env key**

In `src/lib/env.ts`, add to the `envSchema` object literal, immediately after the `BRIGHTDATA_API_KEY: nonEmpty,` line:

```ts
  BRIGHTDATA_SCRAPE_ZONE: nonEmpty,
```

- [ ] **Step 2: Document it in `.env.example`**

In `.env.example`, add on the line after the existing `BRIGHTDATA_API_KEY=` entry:

```
# Brightdata Web Unlocker zone name used to scrape full page content during research
BRIGHTDATA_SCRAPE_ZONE=
```

- [ ] **Step 3: Verify the env test suite still passes**

Run: `pnpm vitest run src/lib/env.test.ts`
Expected: PASS. (If `src/lib/env.test.ts` builds a full valid env object, add `BRIGHTDATA_SCRAPE_ZONE: 'web_unlocker'` to that fixture so the suite stays green. Open the file, find the object passed to `loadEnv`, and add the key alongside `BRIGHTDATA_API_KEY`.)

- [ ] **Step 4: Commit**

```bash
git add src/lib/env.ts .env.example src/lib/env.test.ts
git commit -m "feat: add BRIGHTDATA_SCRAPE_ZONE env var"
```

---

## Task 3: Extend WebResearch provider with scrape + shared types

**Files:**
- Modify: `src/lib/research/provider.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface WebSnippet { url: string; title: string; content: string }` (unchanged, re-stated).
  - `interface WebResearch { search(query: string): Promise<WebSnippet[]>; scrape(url: string): Promise<string> }`.
  - `interface ResearchLead { fullName: string; title: string | null }` (moved here so `agent.ts` and `research.ts` share one definition).

- [ ] **Step 1: Rewrite the provider interface file**

Replace the entire contents of `src/lib/research/provider.ts` with:

```ts
export interface WebSnippet {
  url: string
  title: string
  content: string
}

export interface ResearchLead {
  fullName: string
  title: string | null
}

export interface WebResearch {
  // Runs a single web search and returns the top result snippets. Never throws
  // for "no results" — returns an empty array. Throws AppError only on a
  // transport/parse failure.
  search(query: string): Promise<WebSnippet[]>

  // Fetches a single page and returns its text content (capped by the
  // implementation). Throws AppError on a transport/parse failure.
  scrape(url: string): Promise<string>
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: FAIL only in `brightdata.ts` (does not yet implement `scrape`) and possibly `research.ts` (still imports `WebResearch`/`ResearchLead` — that's fine, `research.ts` is rewritten in Task 7). Confirm the ONLY errors are "Property 'scrape' is missing" on `brightdataResearch` and any `ResearchLead` import location. If other files break, stop and reconcile.

- [ ] **Step 3: Commit**

```bash
git add src/lib/research/provider.ts
git commit -m "feat: add scrape to WebResearch interface and share ResearchLead type"
```

---

## Task 4: Implement Brightdata scrape

**Files:**
- Modify: `src/lib/research/brightdata.ts`
- Modify: `src/lib/research/brightdata.test.ts`

**Interfaces:**
- Consumes: `fetchText` (Task 1), `env.BRIGHTDATA_SCRAPE_ZONE` (Task 2), `WebResearch` (Task 3).
- Produces: `brightdataResearch.scrape(url): Promise<string>` returning page markdown truncated to `MAX_SCRAPE_CHARS = 6_000`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/research/brightdata.test.ts`. First, extend the existing mock block at the top of the file to also mock `fetchText` — replace the existing `vi.mock('@/lib/http/fetch-json', ...)` block and the `fetchJsonMock` declaration region with:

```ts
const fetchJsonMock = vi.fn()
const fetchTextMock = vi.fn()
vi.mock('@/lib/http/fetch-json', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))
vi.mock('@/lib/http/fetch-text', () => ({
  fetchText: (...args: unknown[]) => fetchTextMock(...args),
}))
vi.mock('@/lib/env', () => ({ env: { BRIGHTDATA_API_KEY: 'k', BRIGHTDATA_SCRAPE_ZONE: 'web_unlocker' } }))
```

Then update the `beforeEach` to also reset the new mock:

```ts
beforeEach(() => { fetchJsonMock.mockReset(); fetchTextMock.mockReset() })
```

Then add a new describe block at the end of the file:

```ts
describe('brightdataResearch.scrape', () => {
  it('should return the page text when scrape succeeds', async () => {
    fetchTextMock.mockResolvedValue('# Acme\nWe build widgets for logistics teams.')
    const text = await brightdataResearch.scrape('https://acme.com/about')
    expect(text).toBe('# Acme\nWe build widgets for logistics teams.')
  })

  it('should truncate page text to the max length when the page is oversized', async () => {
    fetchTextMock.mockResolvedValue('x'.repeat(10_000))
    const text = await brightdataResearch.scrape('https://acme.com/huge')
    expect(text).toHaveLength(6_000)
  })

  it('should wrap a transport failure as AppError', async () => {
    fetchTextMock.mockRejectedValueOnce(new AppError('EXTERNAL_ERROR', 'boom'))
    const pending = brightdataResearch.scrape('https://acme.com')
    fetchTextMock.mockResolvedValueOnce('flush')
    await fetchTextMock('flush')
    await expect(pending).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/research/brightdata.test.ts`
Expected: FAIL — `brightdataResearch.scrape is not a function`.

- [ ] **Step 3: Implement scrape**

In `src/lib/research/brightdata.ts`:

Add the import near the top (after the existing `fetchJson` import):

```ts
import { fetchText } from '@/lib/http/fetch-text'
```

Add constants near the existing `MAX_SNIPPETS` / `TIMEOUT_MS` constants:

```ts
const BRIGHTDATA_UNLOCKER_URL = 'https://api.brightdata.com/request'
const MAX_SCRAPE_CHARS = 6_000
const SCRAPE_TIMEOUT_MS = 12_000
```

Add the `scrape` method to the `brightdataResearch` object, after the existing `search` method (inside the same object literal, add a comma after `search`'s closing brace):

```ts
  async scrape(url: string): Promise<string> {
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
      return body.slice(0, MAX_SCRAPE_CHARS)
    } catch (cause) {
      if (cause instanceof AppError) throw cause
      throw new AppError('EXTERNAL_ERROR', 'Brightdata scrape failed', {
        url,
        cause: cause instanceof Error ? cause.message : String(cause),
      })
    }
  },
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/research/brightdata.test.ts`
Expected: PASS (existing search tests + 3 new scrape tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/research/brightdata.ts src/lib/research/brightdata.test.ts
git commit -m "feat: implement Brightdata scrape via Web Unlocker markdown"
```

---

## Task 5: LLM tool-loop wrapper

**Files:**
- Modify: `src/lib/llm/client.ts`

**Interfaces:**
- Consumes: existing `withTimeout`, `logUsage`, `model`, `LlmCallContext` in `client.ts`.
- Produces: `generateWithTools(context: LlmCallContext, args: GenerateWithToolsArgs): Promise<string>` where
  `GenerateWithToolsArgs = { system: string; prompt: string; tools: ToolSet; maxSteps: number; maxOutputTokens: number; timeoutMs?: number }`.

- [ ] **Step 1: Add the tool-loop wrapper**

In `src/lib/llm/client.ts`:

Update the top import from `ai` to also pull in `stepCountIs` and the `ToolSet` type:

```ts
import { generateObject, generateText as sdkGenerateText, stepCountIs, type ToolSet } from 'ai'
```

Add a constant near `DEFAULT_TIMEOUT_MS` (tool loops make several external calls, so they need a larger ceiling than a single generation):

```ts
const TOOL_LOOP_TIMEOUT_MS = 45_000
```

Append at the end of the file:

```ts
export interface GenerateWithToolsArgs {
  system: string
  prompt: string
  tools: ToolSet
  maxSteps: number
  maxOutputTokens: number
  timeoutMs?: number
}

// Runs a multi-step agentic tool loop and returns the model's final text. The
// AI SDK auto-executes each tool's `execute` and feeds results back until the
// model stops or the step budget (stepCountIs) is hit.
export async function generateWithTools(
  context: LlmCallContext,
  args: GenerateWithToolsArgs,
): Promise<string> {
  const startedAt = Date.now()
  try {
    const result = await withTimeout(
      (signal) =>
        sdkGenerateText({
          model,
          system: args.system,
          prompt: args.prompt,
          tools: args.tools,
          stopWhen: stepCountIs(args.maxSteps),
          maxOutputTokens: args.maxOutputTokens,
          abortSignal: signal,
        }),
      args.timeoutMs ?? TOOL_LOOP_TIMEOUT_MS,
    )
    await logUsage(context, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM tool loop failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: PASS for `client.ts` (other files may still error until later tasks; confirm no error originates in `src/lib/llm/client.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/llm/client.ts
git commit -m "feat: add generateWithTools multi-step tool loop to llm client"
```

---

## Task 6: Research tools + agent (gather → extract)

**Files:**
- Create: `src/lib/research/tools.ts`
- Create: `src/lib/research/tools.test.ts`
- Create: `src/lib/research/agent.ts`
- Create: `src/lib/research/agent.test.ts`

**Interfaces:**
- Consumes: `WebResearch`, `ResearchLead` (Task 3); `generateWithTools` (Task 5); `generateJson`, `LlmCallContext` (existing).
- Produces:
  - `buildResearchTools(deps: { research: WebResearch }): ToolSet` with tools `search` and `scrape`, each catching failures and returning an error object rather than throwing.
  - `type ResearchAgentRole = { kind: 'company'; companyName: string; companyDomain: string | null } | { kind: 'person'; lead: ResearchLead; companyName: string; companyDomain: string | null }`.
  - `interface AgentDossierEntry { kind: 'company' | 'person' | 'news' | 'pain_point'; content: string; sourceUrl: string | null; citation: string | null }`.
  - `runResearchAgent(context: LlmCallContext, deps: { research: WebResearch }, args: { role: ResearchAgentRole; valueProp: string | null }): Promise<AgentDossierEntry[]>`.

- [ ] **Step 1: Write the failing test for the tools**

Create `src/lib/research/tools.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import { buildResearchTools } from './tools'

describe('buildResearchTools', () => {
  it('should return search results from the provider when search succeeds', async () => {
    const research = {
      search: vi.fn().mockResolvedValue([{ url: 'https://acme.com', title: 'Acme', content: 'widgets' }]),
      scrape: vi.fn(),
    }
    const tools = buildResearchTools({ research })
    const result = await tools.search.execute({ query: 'Acme' }, {} as never)
    expect(research.search).toHaveBeenCalledWith('Acme')
    expect(result).toEqual([{ url: 'https://acme.com', title: 'Acme', content: 'widgets' }])
  })

  it('should return an error object instead of throwing when search fails', async () => {
    const research = { search: vi.fn().mockRejectedValue(new Error('down')), scrape: vi.fn() }
    const tools = buildResearchTools({ research })
    const result = await tools.search.execute({ query: 'Acme' }, {} as never)
    expect(result).toEqual({ error: 'search failed' })
  })

  it('should return scraped text from the provider when scrape succeeds', async () => {
    const research = { search: vi.fn(), scrape: vi.fn().mockResolvedValue('# Acme page') }
    const tools = buildResearchTools({ research })
    const result = await tools.scrape.execute({ url: 'https://acme.com/about' }, {} as never)
    expect(research.scrape).toHaveBeenCalledWith('https://acme.com/about')
    expect(result).toBe('# Acme page')
  })

  it('should return an error object instead of throwing when scrape fails', async () => {
    const research = { search: vi.fn(), scrape: vi.fn().mockRejectedValue(new Error('blocked')) }
    const tools = buildResearchTools({ research })
    const result = await tools.scrape.execute({ url: 'https://acme.com' }, {} as never)
    expect(result).toEqual({ error: 'scrape failed' })
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/research/tools.test.ts`
Expected: FAIL — `Failed to resolve import "./tools"`.

- [ ] **Step 3: Implement the tools**

Create `src/lib/research/tools.ts`:

```ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import type { WebResearch } from './provider'

// The tool `execute` functions deliberately swallow provider failures and
// return an { error } result so a single bad search/scrape becomes a datum the
// model can route around, instead of throwing and killing the whole agent loop.
export function buildResearchTools(deps: { research: WebResearch }): ToolSet {
  return {
    search: tool({
      description: 'Search the web and return the top result snippets (url, title, content).',
      inputSchema: z.object({ query: z.string().describe('The web search query') }),
      execute: async ({ query }: { query: string }) => {
        try {
          return await deps.research.search(query)
        } catch {
          return { error: 'search failed' }
        }
      },
    }),
    scrape: tool({
      description: 'Fetch the full text of a specific result URL for deeper detail than a snippet.',
      inputSchema: z.object({ url: z.string().describe('The page URL to fetch') }),
      execute: async ({ url }: { url: string }) => {
        try {
          return await deps.research.scrape(url)
        } catch {
          return { error: 'scrape failed' }
        }
      },
    }),
  }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/research/tools.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Write the failing test for the agent**

Create `src/lib/research/agent.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateWithToolsMock = vi.fn()
const generateJsonMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({
  generateWithTools: (...a: unknown[]) => generateWithToolsMock(...a),
  generateJson: (...a: unknown[]) => generateJsonMock(...a),
}))
vi.mock('./tools', () => ({ buildResearchTools: () => ({}) }))

import { runResearchAgent } from './agent'

const context = { clientId: 'c1', caseId: 'case1', actor: 'research_agent' }
const research = { search: vi.fn(), scrape: vi.fn() }

beforeEach(() => { generateWithToolsMock.mockReset(); generateJsonMock.mockReset() })

describe('runResearchAgent', () => {
  it('should gather notes then extract entries for a company role', async () => {
    generateWithToolsMock.mockResolvedValue('Acme builds widgets. Series B in 2026.')
    generateJsonMock.mockResolvedValue({
      entries: [{ kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: 'site' }],
    })
    const entries = await runResearchAgent(context, { research }, {
      role: { kind: 'company', companyName: 'Acme', companyDomain: 'acme.com' },
      valueProp: 'save time',
    })
    expect(entries).toEqual([
      { kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: 'site' },
    ])
    const gatherPrompt = generateWithToolsMock.mock.calls[0][1].prompt as string
    expect(gatherPrompt).toContain('Acme')
  })

  it('should include the person name in the gather prompt for a person role', async () => {
    generateWithToolsMock.mockResolvedValue('Jane Doe is CTO, spoke at a conference.')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      role: { kind: 'person', lead: { fullName: 'Jane Doe', title: 'CTO' }, companyName: 'Acme', companyDomain: 'acme.com' },
      valueProp: null,
    })
    const gatherPrompt = generateWithToolsMock.mock.calls[0][1].prompt as string
    expect(gatherPrompt).toContain('Jane Doe')
  })

  it('should return an empty array when extraction yields no entries', async () => {
    generateWithToolsMock.mockResolvedValue('nothing notable')
    generateJsonMock.mockResolvedValue({ entries: [] })
    const entries = await runResearchAgent(context, { research }, {
      role: { kind: 'company', companyName: 'Acme', companyDomain: null },
      valueProp: null,
    })
    expect(entries).toEqual([])
  })
})
```

- [ ] **Step 6: Run to verify it fails**

Run: `pnpm vitest run src/lib/research/agent.test.ts`
Expected: FAIL — `Failed to resolve import "./agent"`.

- [ ] **Step 7: Implement the agent**

Create `src/lib/research/agent.ts`:

```ts
import { z } from 'zod'
import type { WebResearch, ResearchLead } from './provider'
import { buildResearchTools } from './tools'
import { generateWithTools, generateJson, type LlmCallContext } from '@/lib/llm/client'

const GATHER_STEPS = 4
const GATHER_MAX_OUTPUT_TOKENS = 1_200
const EXTRACT_MAX_OUTPUT_TOKENS = 1_400

export type ResearchAgentRole =
  | { kind: 'company'; companyName: string; companyDomain: string | null }
  | { kind: 'person'; lead: ResearchLead; companyName: string; companyDomain: string | null }

const entrySchema = z.object({
  kind: z.enum(['company', 'person', 'news', 'pain_point']),
  content: z.string().min(1),
  sourceUrl: z.string().nullable(),
  citation: z.string().nullable(),
})
const extractionSchema = z.object({ entries: z.array(entrySchema) })

export type AgentDossierEntry = z.infer<typeof entrySchema>

const COMPANY_GATHER_SYSTEM = [
  'You are a B2B sales research analyst gathering facts about a target company.',
  'Use the search tool to find: what the company does, size/industry, recent news',
  'or funding, its LinkedIn/X presence and recent posts, hiring/careers pages',
  '(growth or pain signals), and public reviews or complaints (G2, Glassdoor).',
  'When a snippet looks promising, use the scrape tool to read the full page',
  'instead of trusting a two-line snippet. Keep notes concise and cite the URL',
  'each fact came from. Do not invent facts.',
].join(' ')

const PERSON_GATHER_SYSTEM = [
  'You are a B2B sales research analyst gathering an outreach angle for one person.',
  'Use the search tool to find their role/background and, above all, recent public',
  'activity: LinkedIn posts, X/Twitter, interviews, conference talks, or articles',
  'quoting them. Look for something this specific person said or did recently — a',
  'genuine personalization hook, not generic bio facts. Use the scrape tool to read',
  'a promising page in full. Keep notes concise and cite the URL each fact came',
  'from. Do not invent facts.',
].join(' ')

const EXTRACT_SYSTEM = [
  'You convert research notes into discrete dossier entries.',
  'Use ONLY facts present in the notes. Never invent anything.',
  'For every entry set sourceUrl to the URL the fact came from, or null if the',
  'notes give no single source. Keep each entry to one or two sentences.',
  'Classify each entry by kind: company (company facts), person (facts about the',
  'individual), news (recent events/announcements), pain_point (a problem or',
  'buying signal). Social posts are classified by their substance.',
].join(' ')

function seedQuery(role: ResearchAgentRole): string {
  if (role.kind === 'company') {
    return role.companyDomain
      ? `${role.companyName} ${role.companyDomain} news funding`
      : `${role.companyName} company news funding`
  }
  return `${role.lead.fullName} ${role.companyName} linkedin`
}

function gatherPrompt(role: ResearchAgentRole, valueProp: string | null): string {
  const subject =
    role.kind === 'company'
      ? `Company: ${role.companyName}${role.companyDomain ? ` (${role.companyDomain})` : ''}`
      : `Person: ${role.lead.fullName}${role.lead.title ? `, ${role.lead.title}` : ''} at ${role.companyName}`
  return [
    subject,
    `Our value proposition to them: ${valueProp ?? 'n/a'}`,
    `Start by searching: ${seedQuery(role)}`,
    'Gather the most useful facts, then write your research notes.',
  ].join('\n\n')
}

export async function runResearchAgent(
  context: LlmCallContext,
  deps: { research: WebResearch },
  args: { role: ResearchAgentRole; valueProp: string | null },
): Promise<AgentDossierEntry[]> {
  const { role, valueProp } = args
  const notes = await generateWithTools(context, {
    system: role.kind === 'company' ? COMPANY_GATHER_SYSTEM : PERSON_GATHER_SYSTEM,
    prompt: gatherPrompt(role, valueProp),
    tools: buildResearchTools(deps),
    maxSteps: GATHER_STEPS,
    maxOutputTokens: GATHER_MAX_OUTPUT_TOKENS,
  })

  const extracted = await generateJson(context, {
    system: EXTRACT_SYSTEM,
    prompt: `Research notes:\n${notes}\n\nExtract the dossier entries.`,
    schema: extractionSchema,
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
  })
  return extracted.entries
}
```

- [ ] **Step 8: Run to verify it passes**

Run: `pnpm vitest run src/lib/research/agent.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 9: Commit**

```bash
git add src/lib/research/tools.ts src/lib/research/tools.test.ts src/lib/research/agent.ts src/lib/research/agent.test.ts
git commit -m "feat: add research tools and per-subject research agent"
```

---

## Task 7: Rewrite runResearchForCase as the multi-agent orchestrator

**Files:**
- Modify: `src/lib/pipeline/research.ts`
- Modify: `src/lib/pipeline/research.test.ts`

**Interfaces:**
- Consumes: `runResearchAgent`, `ResearchAgentRole`, `AgentDossierEntry` (Task 6); `ResearchLead` (Task 3); `WebResearch` (Task 3); `insertKnowledge` / `KnowledgeInsert` (existing); `updateCaseStatus` (existing); `logEventSafe` (existing); `AppError` / `isAppError` (existing).
- Produces: `runResearchForCase(supabase, deps: { research: WebResearch }, input: RunResearchInput): Promise<ResearchSummary>` — signature unchanged so `route.ts` is untouched. `RunResearchInput = { clientId; caseId; companyName; companyDomain: string | null; valueProp: string | null; leads: ResearchLead[] }`. `ResearchSummary = { caseId: string; knowledgeCount: number }`.

- [ ] **Step 1: Rewrite the test**

Replace the entire contents of `src/lib/pipeline/research.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const runResearchAgentMock = vi.fn()
const insertKnowledgeMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/research/agent', () => ({ runResearchAgent: (...a: unknown[]) => runResearchAgentMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertKnowledge: (...a: unknown[]) => insertKnowledgeMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  logEventSafe: (...a: unknown[]) => logEventMock(...a),
}))

import { runResearchForCase } from './research'

const research = { search: vi.fn(), scrape: vi.fn() }
const input = {
  clientId: 'c1', caseId: 'case1', companyName: 'Acme', companyDomain: 'acme.com',
  valueProp: 'We save you time', leads: [{ fullName: 'Jane Doe', title: 'CTO' }],
}

beforeEach(() => {
  runResearchAgentMock.mockReset(); insertKnowledgeMock.mockReset()
  updateCaseStatusMock.mockReset(); logEventMock.mockReset()
})

describe('runResearchForCase', () => {
  it('should merge entries from all agents, write them, and mark the case ready', async () => {
    // company agent then person agent
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: null }])
      .mockResolvedValueOnce([{ kind: 'person', content: 'Jane spoke at a conf', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(runResearchAgentMock).toHaveBeenCalledTimes(2)
    expect(insertKnowledgeMock).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([
      expect.objectContaining({ case_id: 'case1', kind: 'company', content: 'Builds widgets' }),
      expect.objectContaining({ case_id: 'case1', kind: 'person', content: 'Jane spoke at a conf' }),
    ]))
    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 2 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should proceed to ready with a partial dossier when one agent fails', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
      .mockRejectedValueOnce(new Error('llm timeout'))
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 1 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.research.agent_failed' }))
  })

  it('should mark the case ready with zero knowledge when agents succeed but find nothing', async () => {
    runResearchAgentMock.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    insertKnowledgeMock.mockResolvedValue([])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should NOT mark ready and should not insert when every agent fails', async () => {
    runResearchAgentMock
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.completed',
      payload: expect.objectContaining({ knowledgeCount: 0, agentsFailed: 2 }),
    }))
  })

  it('should run only the company agent when the case has no leads', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'x', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, { ...input, leads: [] })

    expect(runResearchAgentMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/research.test.ts`
Expected: FAIL — current `research.ts` calls `deps.research.search` + `generateJson` directly and knows nothing about `runResearchAgent`; assertions on agent count / `agent_failed` fail.

- [ ] **Step 3: Rewrite the orchestrator**

Replace the entire contents of `src/lib/pipeline/research.ts` with:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { WebResearch, ResearchLead } from '@/lib/research/provider'
import { runResearchAgent, type ResearchAgentRole, type AgentDossierEntry } from '@/lib/research/agent'
import { insertKnowledge, type KnowledgeInsert } from '@/lib/db/case-knowledge'
import { updateCaseStatus } from '@/lib/db/cases'
import { logEventSafe } from '@/lib/events/log-event'
import { LlmCallContext } from '@/lib/llm/client'
import { isAppError } from '@/lib/errors/app-error'

const ACTOR = 'research_agent'

export interface RunResearchInput {
  clientId: string
  caseId: string
  companyName: string
  companyDomain: string | null
  valueProp: string | null
  leads: ResearchLead[]
}

export interface ResearchSummary {
  caseId: string
  knowledgeCount: number
}

function buildRoles(input: RunResearchInput): ResearchAgentRole[] {
  const company: ResearchAgentRole = {
    kind: 'company', companyName: input.companyName, companyDomain: input.companyDomain,
  }
  const people: ResearchAgentRole[] = input.leads.map((lead) => ({
    kind: 'person', lead, companyName: input.companyName, companyDomain: input.companyDomain,
  }))
  return [company, ...people]
}

function toRows(input: RunResearchInput, entries: AgentDossierEntry[]): KnowledgeInsert[] {
  return entries.map((entry) => ({
    client_id: input.clientId,
    case_id: input.caseId,
    kind: entry.kind,
    content: entry.content,
    source_url: entry.sourceUrl,
    citation: entry.citation,
    created_by: 'agent',
  }))
}

async function logAgentFailure(
  input: RunResearchInput,
  role: ResearchAgentRole,
  reason: unknown,
): Promise<void> {
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.research.agent_failed',
    payload: {
      caseId: input.caseId,
      role: role.kind,
      leadName: role.kind === 'person' ? role.lead.fullName : null,
      errorCode: isAppError(reason) ? reason.code : 'EXTERNAL_ERROR',
    },
  })
}

// Runs one research agent per subject (company + each active lead) concurrently.
// A single agent failure is logged and dropped, not fatal: as long as one agent
// succeeds we ship the partial dossier and mark the case ready. If EVERY agent
// fails we leave the case in 'researching' so the stuck-case sweep retries it,
// rather than flipping to 'ready' with an empty (misleading) dossier.
export async function runResearchForCase(
  supabase: SupabaseClient<Database>,
  deps: { research: WebResearch },
  input: RunResearchInput,
): Promise<ResearchSummary> {
  const roles = buildRoles(input)
  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }

  const results = await Promise.allSettled(
    roles.map((role) => runResearchAgent(context, deps, { role, valueProp: input.valueProp })),
  )

  const entries: AgentDossierEntry[] = []
  let failed = 0
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]
    if (result && result.status === 'fulfilled') {
      entries.push(...result.value)
    } else if (result) {
      failed += 1
      // roles[i] is guaranteed to exist: results has one entry per role.
      await logAgentFailure(input, roles[i]!, result.reason)
    }
  }

  const allFailed = failed === roles.length
  if (allFailed) {
    await logEventSafe({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: ACTOR,
      type: 'pipeline.research.completed',
      payload: { caseId: input.caseId, knowledgeCount: 0, agentsFailed: failed },
    })
    return { caseId: input.caseId, knowledgeCount: 0 }
  }

  const inserted = await insertKnowledge(supabase, toRows(input, entries))
  await updateCaseStatus(supabase, input.caseId, 'ready')
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.research.completed',
    payload: { caseId: input.caseId, knowledgeCount: inserted.length, agentsFailed: failed },
  })
  return { caseId: input.caseId, knowledgeCount: inserted.length }
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/research.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Typecheck the whole project**

Run: `pnpm tsc --noEmit`
Expected: PASS with no errors. (If `LlmCallContext` triggers an "imported as a value but used only as a type" lint under `verbatimModuleSyntax`, change its import to `import { type LlmCallContext } from '@/lib/llm/client'`.)

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/research.ts src/lib/pipeline/research.test.ts
git commit -m "feat: run multi-agent research per case with partial-failure handling"
```

---

## Task 8: Full suite + route smoke check

**Files:**
- No new files. Verification only.

- [ ] **Step 1: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS across the repo. In particular `src/app/api/pipeline/research/route.test.ts`, `write.test.ts`, `reply.test.ts`, and `knowledge-answer.test.ts` pass unchanged (they depend only on the `runResearchForCase` signature and on `case_knowledge` rows, both preserved).

- [ ] **Step 2: Typecheck + lint**

Run: `pnpm tsc --noEmit && pnpm lint`
Expected: PASS. Fix any lint issues (import ordering: external → `@/…` → relative) inline.

- [ ] **Step 3: Confirm the route wiring is intact**

Read `src/app/api/pipeline/research/route.ts` and confirm it still calls `runResearchForCase(admin, { research: brightdataResearch }, { … })` with the same input fields. No change expected — this step is a guard, not an edit.

- [ ] **Step 4: Update the roadmap**

Per `CLAUDE.md`, update `.claude/roadmap.md`: add an entry recording that multi-agent case research (company + per-lead agents with search+scrape tool loops) is implemented, replacing the single shared search+LLM research call.

- [ ] **Step 5: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: mark multi-agent case research complete in roadmap"
```

---

## Self-Review Notes

- **Spec coverage:** scrape helper (Tasks 1–4) · in-process `Promise.allSettled` orchestration (Task 7) · per-subject agents with 4-step search+scrape loop then extract (Task 6) · seed queries + role prompts incl. social signals (Task 6, `agent.ts`) · social classified into existing `knowledge_kind` (Task 6, `EXTRACT_SYSTEM`) · no dedup (orchestrator flattens, no dedup logic) · partial-failure → ready; all-fail → stays `researching` + `knowledgeCount:0` event (Task 7) · every active lead, no cap (Task 7 `buildRoles`) · downstream consumers untouched (Task 8 verification).
- **Type consistency:** `ResearchLead` defined once in `provider.ts` (Task 3), consumed by `agent.ts` and `research.ts`. `AgentDossierEntry` / `ResearchAgentRole` defined in `agent.ts` (Task 6), consumed by `research.ts` (Task 7). `generateWithTools` signature (Task 5) matches its call in `agent.ts` (Task 6). `WebResearch.scrape` (Task 3) implemented in Task 4, consumed via tools in Task 6.
- **No placeholders:** every code step shows complete code; every run step shows the command + expected result.
```
