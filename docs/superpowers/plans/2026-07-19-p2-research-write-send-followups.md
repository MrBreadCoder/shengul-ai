# P2 — Research + Write + Send + Follow-ups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Take a grouped, Apollo-verified case from `status = new` all the way to a sent, human-sounding cold email with a running 3/7/14-day follow-up cadence — via a Research Agent (Brightdata + Gemini → `case_knowledge`), an Email-Writer Agent (`/api/pipeline/write`), a deterministic Mailbox Sender (rotation, caps, jitter), a reply-mode gate (`auto_send` / `human_approve` / `hybrid`, drafts in `/inbox`), and a QStash-delayed follow-up sequencer.

**Architecture:** Purely additive to the P0/P1 pipeline (`.claude/architecture.md` §6 Stages 3–5). Each stage is one QStash fan-out cron → one per-entity route → one unit of work, exactly like `discover-fanout` → `discover`. New LLM work goes behind a single `src/lib/llm/` wrapper (Gemini via Vercel AI SDK); new web-research work goes behind a `WebResearch` interface with a Brightdata implementation. All data access lives in `src/lib/db/`. Idempotency comes from a claim-then-do pattern: a unique DB index claims the `(lead_id, sequence_step, direction)` slot with a `queued` email row **before** any send, so a QStash retry can never double-send. Mailbox cap enforcement is an atomic Postgres function, not read-modify-write.

**Tech Stack:** TypeScript (strict), Next.js 16 App Router, Vitest, Supabase (`@supabase/supabase-js`), QStash (`@upstash/qstash`), Vercel AI SDK (`ai` + `@ai-sdk/google`, Gemini), Brightdata HTTP API, Gmail API, Microsoft Graph.

## Global Constraints

- No `any` — use `unknown` and narrow, or a proper type (`.claude/QUALITY.md`, `.claude/BEHAVIORS.md`).
- No `!` non-null assertion without a `// why it is safe` comment (`.claude/QUALITY.md`).
- Every thrown error uses `AppError` with `code`, `message`, `context` — never bare `Error` (`.claude/QUALITY.md` Error Handling). Existing codes live in `src/lib/errors/app-error.ts`: `VALIDATION_ERROR | NOT_FOUND | UNAUTHORIZED | FORBIDDEN | RATE_LIMITED | EXTERNAL_TIMEOUT | EXTERNAL_ERROR | DB_ERROR | CONFIG_ERROR | INVARIANT_VIOLATION`. Do not invent new codes.
- All external inputs validated with Zod. All external API responses validated with Zod (`.claude/QUALITY.md` Defensive Programming).
- Every external call has a timeout. Use `fetchJson` (`src/lib/http/fetch-json.ts`, default 8000ms) for HTTP, and an explicit `timeoutMs` (default 20000ms) for LLM calls.
- Data access lives exclusively in `src/lib/db/`; one function per DB operation; map DB `snake_case` columns to TypeScript `camelCase` explicitly (`.claude/BEHAVIORS.md`).
- Every AI call sets an explicit output-token ceiling and logs token usage after completion (`.claude/QUALITY.md` Observability, Defensive Programming). Never log raw prompt/response bodies (PII).
- Every state change and agent action writes to `events` via `logEvent` (`src/lib/events/log-event.ts`), after the core action succeeds.
- Every QStash-triggered route calls `verifyQstashSignature(request)` first and is idempotent (`.claude/architecture.md` §8).
- Tests: Vitest, colocated `feature.test.ts`, Arrange-Act-Assert, `it('should ... when ...')` naming, mock at the boundary (mock Supabase / Apollo / LLM / provider clients, never your own business logic). DB query functions ≥80% coverage; utility + Zod schemas 100% (`.claude/QUALITY.md` Testing).
- No `console.log`, no commented-out code, no `TODO`/`FIXME`/`HACK` in output (`.claude/BEHAVIORS.md`, `.claude/ANTI_LAZY.md`).
- Named exports only; default exports reserved for Next.js pages/layouts/components (`.claude/QUALITY.md`).
- Early returns over nested conditionals (`.claude/BEHAVIORS.md`).
- Next.js pages handle all four UI states: loading, error, empty, success. Mutations use Server Actions, never client fetch to own API (`.claude/BEHAVIORS.md`).
- Write complete code — no placeholders, no stubs, no truncation (`.claude/ANTI_LAZY.md`, `CLAUDE.md`).
- Update `.claude/roadmap.md` every time progress is made (`CLAUDE.md`).
- **Known risk carried into this plan** (same posture as the Apollo client, `.claude/architecture.md` §12): the exact Brightdata HTTP request/response shape and the Vercel AI SDK `usage` field names (`inputTokens`/`outputTokens` vs `promptTokens`/`completionTokens`) are not reconciled against live services in this codebase yet. Both are parsed/read defensively (Zod for Brightdata, nullish fallback for usage) and must be reconciled the first time real `BRIGHTDATA_API_KEY` / `GEMINI_API_KEY` are exercised. This is deliberate, mirroring how `src/lib/apollo/client.ts` already parses defensively.

---

## File Structure

**New — LLM & research infrastructure**
- `src/lib/llm/client.ts` — Gemini wrapper: `generateJson` (schema-validated) + `generateText`, timeout, token cap, usage logging, error mapping.
- `src/lib/research/provider.ts` — `WebResearch` interface + `WebSnippet` type.
- `src/lib/research/brightdata.ts` — `brightdataResearch: WebResearch` (SERP search over Brightdata HTTP API).

**New — data access (`src/lib/db/`)**
- `src/lib/db/case-knowledge.ts` — `insertKnowledge`, `listKnowledgeForCase`.
- `src/lib/db/emails.ts` — `claimOutboundEmail`, `markEmailSent`, `markEmailFailed`, `listThreadEmails`, `hasInboundReply`.
- `src/lib/db/sequences.ts` — `createSequence`, `getSequenceById`, `advanceSequence`, `stopSequence`.
- `src/lib/db/suppressions.ts` — `isSuppressed`, `addSuppression`.

**Modified — data access**
- `src/lib/db/mailboxes.ts` — add `listMailboxesByIds`, `claimMailboxSend`.
- `src/lib/db/cases.ts` — add `getCaseById`, `updateCaseStatus`, `listCasesByStatus`.
- `src/lib/db/leads.ts` — add `getLeadById`, `listActiveLeadsForCase`.
- `src/lib/db/campaigns.ts` — add `getCampaignForCase` (join case → campaign settings).

**New — mailbox sender & pipeline**
- `src/lib/mailbox/sender.ts` — `sendViaMailbox` (rotation, atomic cap claim, jitter, provider send, token persistence).
- `src/lib/pipeline/research.ts` — `runResearchForCase`.
- `src/lib/pipeline/write.ts` — `runWriteForCase`.
- `src/lib/pipeline/followup.ts` — `runFollowupStep`, `FOLLOWUP_DELAYS_SECONDS`.

**Modified — mailbox providers (threading)**
- `src/lib/mailbox/provider.ts` — `SendEmailInput` gains `threadId?`, `inReplyToMessageId?`, `references?`.
- `src/lib/mailbox/gmail-provider.ts` — thread via `threadId` + `In-Reply-To`/`References` headers.
- `src/lib/mailbox/outlook-provider.ts` — thread via `internetMessageHeaders`.

**Modified — QStash**
- `src/lib/qstash/client.ts` — add `publishJsonWithDelay`.

**New — routes**
- `src/app/api/pipeline/research-fanout/route.ts`, `src/app/api/pipeline/research/route.ts`
- `src/app/api/pipeline/write-fanout/route.ts`, `src/app/api/pipeline/write/route.ts`
- `src/app/api/pipeline/followup/route.ts`

**New — cron registration scripts**
- `scripts/schedule-research-cron.ts`, `scripts/schedule-write-cron.ts`, `scripts/schedule-mailbox-reset-cron.ts`
- `src/app/api/pipeline/mailbox-reset/route.ts` — daily `sent_today` reset.

**New — frontend**
- `src/app/inbox/page.tsx`, `src/app/inbox/loading.tsx`, `src/app/inbox/error.tsx`, `src/app/inbox/draft-row.tsx`, `src/app/inbox/actions.ts`.

**Modified — schema, types, env, deps, docs**
- `supabase/migrations/0005_p2_pipeline.sql`
- `src/types/database.ts` — new `Functions` entries.
- `package.json` — add `ai`, `@ai-sdk/google`.
- `.claude/architecture.md`, `.claude/roadmap.md` — mark P2 progress.

---

## Execution Phases

The 20 tasks group into 7 phases. Each later phase depends on the earlier ones; within a phase, tasks are independently testable except where a build-order note says otherwise.

| Phase | Tasks | Deliverable / Demo |
|---|---|---|
| **1 — Foundations** | 1–3 | Migration (idempotency indexes + atomic mailbox functions), Gemini LLM wrapper, Brightdata research client. No user-facing behavior; all unit-tested. |
| **2 — Data access layer** | 4–8 | `src/lib/db/` modules: `case_knowledge`, `emails` (claim-then-send slot), `sequences`, `suppressions`, and mailbox/case/lead/campaign helpers. |
| **3 — Sending infrastructure** | 9–10 | Provider threading + the rotation/cap/jitter Mailbox Sender. Unit-tested in isolation. |
| **4 — Research stage** | 11–12 | **Demo:** a `new` case runs through `/api/pipeline/research` → `status = ready` with a cited `case_knowledge` dossier. |
| **5 — Write, send & follow-ups** | 13–17 | **Demo:** a `ready` case is written, sent from a rotated mailbox, and a 3/7/14-day follow-up is scheduled and fires (cancelling on reply, `dead` after step 3). Build order: **15 → 13 → 14 → 16 → 17**. |
| **6 — Human-approval UI** | 18 | **Demo:** a `human_approve` campaign's drafts appear in `/inbox` and send on approval. |
| **7 — Docs & verification** | 19–20 | Roadmap/architecture updated; full suite, types, lint, build green. |

Each phase ends on a green test run and committed work, so it is a safe stopping point.

---

## Phase 1 — Foundations

**Tasks 1–3.** The database migration (idempotency indexes + atomic mailbox `claim_mailbox_send` / `reset_mailbox_daily_counters` functions), the Gemini LLM wrapper, and the Brightdata web-research client. No user-facing behavior yet — every unit is tested in isolation, and nothing else in the plan can be built until these exist.

---

### Task 1: Migration 0005 — idempotency indexes + atomic mailbox functions

**Files:**
- Create: `supabase/migrations/0005_p2_pipeline.sql`
- Modify: `src/types/database.ts` (add to `Functions`)

**Interfaces:**
- Produces (SQL/RPC): unique index `emails_outbound_step_uniq` on `emails (lead_id, sequence_step, direction)`; unique index `sequences_lead_uniq` on `sequences (lead_id)`; unique index `suppressions_client_email_uniq` on `suppressions (client_id, email)`; RPC `claim_mailbox_send(p_mailbox_id uuid) returns setof mailboxes`; RPC `reset_mailbox_daily_counters() returns void`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0005_p2_pipeline.sql`:

```sql
-- P2 pipeline: idempotency + atomic mailbox cap enforcement.

-- One outbound email per (lead, sequence_step). Inbound rows have a null
-- sequence_step; Postgres treats nulls as distinct, so many inbound rows per
-- lead remain allowed. This index is the claim slot that makes send idempotent.
create unique index emails_outbound_step_uniq
  on public.emails (lead_id, sequence_step, direction);

-- Exactly one follow-up sequence per lead.
create unique index sequences_lead_uniq
  on public.sequences (lead_id);

-- One suppression per (client, email); makes addSuppression idempotent.
create unique index suppressions_client_email_uniq
  on public.suppressions (client_id, email);

-- Atomically claim one send against a mailbox's daily cap. Returns the updated
-- row when the send is allowed (healthy + under cap), or no rows when the cap
-- is reached or the mailbox is unhealthy. SECURITY DEFINER so the service role
-- executes it; callers use the admin client only.
create or replace function public.claim_mailbox_send(p_mailbox_id uuid)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         updated_at = now()
   where id = p_mailbox_id
     and health = 'ok'
     and sent_today < daily_cap
  returning *;
$$;

-- Reset every mailbox's daily counter. Called by the daily reset cron.
create or replace function public.reset_mailbox_daily_counters()
returns void
language sql
security definer
set search_path = public
as $$
  update public.mailboxes set sent_today = 0, updated_at = now() where sent_today <> 0;
$$;
```

- [ ] **Step 2: Add the function types to `src/types/database.ts`**

Replace the existing `Functions` block (currently `is_operator` and `current_client_id`) so it also declares the two new RPCs. Find:

```ts
    Functions: {
      is_operator: {
        Args: Record<string, never>
        Returns: boolean
      }
      current_client_id: {
        Args: Record<string, never>
        Returns: string
      }
    }
```

Replace with:

```ts
    Functions: {
      is_operator: {
        Args: Record<string, never>
        Returns: boolean
      }
      current_client_id: {
        Args: Record<string, never>
        Returns: string
      }
      claim_mailbox_send: {
        Args: { p_mailbox_id: string }
        Returns: Database['public']['Tables']['mailboxes']['Row'][]
      }
      reset_mailbox_daily_counters: {
        Args: Record<string, never>
        Returns: undefined
      }
    }
```

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0005_p2_pipeline.sql src/types/database.ts
git commit -m "feat: P2 migration — idempotency indexes + atomic mailbox send/reset functions"
```

---

### Task 2: LLM client wrapper (`src/lib/llm/client.ts`)

**Files:**
- Modify: `package.json` (add deps)
- Create: `src/lib/llm/client.ts`
- Test: `src/lib/llm/client.test.ts`

**Interfaces:**
- Consumes: `env.GEMINI_API_KEY`, `logEvent`.
- Produces:
  - `interface LlmCallContext { clientId: string; caseId?: string | null; actor: string }`
  - `generateJson<T>(context: LlmCallContext, args: { system: string; prompt: string; schema: z.ZodType<T>; maxOutputTokens: number; timeoutMs?: number }): Promise<T>`
  - `generateText(context: LlmCallContext, args: { system: string; prompt: string; maxOutputTokens: number; timeoutMs?: number }): Promise<string>`

- [ ] **Step 1: Add dependencies**

Run:
```bash
npm install ai@^5 @ai-sdk/google@^2
```
Expected: `ai` and `@ai-sdk/google` appear under `dependencies` in `package.json`.

- [ ] **Step 2: Write the failing test**

Create `src/lib/llm/client.test.ts`. The AI SDK functions are mocked at the module boundary:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const generateObjectMock = vi.fn()
const generateTextMock = vi.fn()

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  generateText: (...args: unknown[]) => generateTextMock(...args),
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (modelId: string) => ({ modelId }),
}))
const logEventMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { generateJson, generateText } from './client'

const ctx = { clientId: 'client1', caseId: 'case1', actor: 'research_agent' }

beforeEach(() => {
  generateObjectMock.mockReset()
  generateTextMock.mockReset()
  logEventMock.mockReset()
})

describe('generateJson', () => {
  it('should return the parsed object and log usage when the model succeeds', async () => {
    generateObjectMock.mockResolvedValue({
      object: { title: 'Acme' },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const schema = z.object({ title: z.string() })
    const result = await generateJson(ctx, { system: 's', prompt: 'p', schema, maxOutputTokens: 100 })
    expect(result).toEqual({ title: 'Acme' })
    expect(logEventMock).toHaveBeenCalledTimes(1)
  })

  it('should throw EXTERNAL_ERROR when the model call rejects', async () => {
    generateObjectMock.mockRejectedValue(new Error('model down'))
    const schema = z.object({ title: z.string() })
    await expect(
      generateJson(ctx, { system: 's', prompt: 'p', schema, maxOutputTokens: 100 }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('generateText', () => {
  it('should return the text and log usage when the model succeeds', async () => {
    generateTextMock.mockResolvedValue({ text: 'hello', usage: { promptTokens: 3, completionTokens: 2 } })
    const result = await generateText(ctx, { system: 's', prompt: 'p', maxOutputTokens: 50 })
    expect(result).toBe('hello')
    expect(logEventMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/llm/client.test.ts`
Expected: FAIL — cannot find module `./client`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/llm/client.ts`:

```ts
import { generateObject, generateText as sdkGenerateText } from 'ai'
import { createGoogleGenerativeAI } from '@ai-sdk/google'
import type { z } from 'zod'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'
import { logEvent } from '@/lib/events/log-event'

const MODEL_ID = 'gemini-3-flash-preview'
const DEFAULT_TIMEOUT_MS = 20_000

const google = createGoogleGenerativeAI({ apiKey: env.GEMINI_API_KEY })
const model = google(MODEL_ID)

export interface LlmCallContext {
  clientId: string
  caseId?: string | null
  actor: string
}

// The AI SDK has renamed usage fields across versions; read both shapes.
interface RawUsage {
  inputTokens?: number
  outputTokens?: number
  promptTokens?: number
  completionTokens?: number
}

function readUsage(usage: unknown): { promptTokens: number; completionTokens: number } {
  const u = (usage ?? {}) as RawUsage
  return {
    promptTokens: u.inputTokens ?? u.promptTokens ?? 0,
    completionTokens: u.outputTokens ?? u.completionTokens ?? 0,
  }
}

async function logUsage(
  context: LlmCallContext,
  usage: unknown,
  durationMs: number,
): Promise<void> {
  const { promptTokens, completionTokens } = readUsage(usage)
  await logEvent({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.completed',
    payload: { model: MODEL_ID, promptTokens, completionTokens, durationMs },
  })
}

function rejectAfter(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new AppError('EXTERNAL_TIMEOUT', 'LLM call timed out', { ms })), ms),
  )
}

export interface GenerateJsonArgs<T> {
  system: string
  prompt: string
  schema: z.ZodType<T>
  maxOutputTokens: number
  timeoutMs?: number
}

export async function generateJson<T>(
  context: LlmCallContext,
  args: GenerateJsonArgs<T>,
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await Promise.race([
      generateObject({
        model,
        system: args.system,
        prompt: args.prompt,
        schema: args.schema,
        maxOutputTokens: args.maxOutputTokens,
      }),
      rejectAfter(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ])
    await logUsage(context, result.usage, Date.now() - startedAt)
    return result.object
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateObject failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export interface GenerateTextArgs {
  system: string
  prompt: string
  maxOutputTokens: number
  timeoutMs?: number
}

export async function generateText(
  context: LlmCallContext,
  args: GenerateTextArgs,
): Promise<string> {
  const startedAt = Date.now()
  try {
    const result = await Promise.race([
      sdkGenerateText({
        model,
        system: args.system,
        prompt: args.prompt,
        maxOutputTokens: args.maxOutputTokens,
      }),
      rejectAfter(args.timeoutMs ?? DEFAULT_TIMEOUT_MS),
    ])
    await logUsage(context, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateText failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/llm/client.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json src/lib/llm/client.ts src/lib/llm/client.test.ts
git commit -m "feat: add Gemini LLM wrapper (generateJson/generateText) with timeout + usage logging"
```

---

### Task 3: Web research provider + Brightdata client (`src/lib/research/`)

**Files:**
- Create: `src/lib/research/provider.ts`
- Create: `src/lib/research/brightdata.ts`
- Test: `src/lib/research/brightdata.test.ts`

**Interfaces:**
- Consumes: `env.BRIGHTDATA_API_KEY`, `fetchJson`.
- Produces:
  - `interface WebSnippet { url: string; title: string; content: string }`
  - `interface WebResearch { search(query: string): Promise<WebSnippet[]> }`
  - `const brightdataResearch: WebResearch`

- [ ] **Step 1: Write the interface**

Create `src/lib/research/provider.ts`:

```ts
export interface WebSnippet {
  url: string
  title: string
  content: string
}

export interface WebResearch {
  // Runs a single web search and returns the top result snippets. Never throws
  // for "no results" — returns an empty array. Throws AppError only on a
  // transport/parse failure.
  search(query: string): Promise<WebSnippet[]>
}
```

- [ ] **Step 2: Write the failing test**

Create `src/lib/research/brightdata.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const fetchJsonMock = vi.fn()
vi.mock('@/lib/http/fetch-json', () => ({
  fetchJson: (...args: unknown[]) => fetchJsonMock(...args),
}))
vi.mock('@/lib/env', () => ({ env: { BRIGHTDATA_API_KEY: 'bd-key' } }))

import { brightdataResearch } from './brightdata'

beforeEach(() => fetchJsonMock.mockReset())

describe('brightdataResearch.search', () => {
  it('should map organic results to snippets when the API returns them', async () => {
    fetchJsonMock.mockResolvedValue({
      organic: [
        { link: 'https://acme.com', title: 'Acme', description: 'We do things' },
        { link: 'https://news.com/acme', title: 'Acme raises', description: 'Series B' },
      ],
    })
    const snippets = await brightdataResearch.search('Acme company')
    expect(snippets).toEqual([
      { url: 'https://acme.com', title: 'Acme', content: 'We do things' },
      { url: 'https://news.com/acme', title: 'Acme raises', content: 'Series B' },
    ])
  })

  it('should return an empty array when there are no organic results', async () => {
    fetchJsonMock.mockResolvedValue({ organic: [] })
    const snippets = await brightdataResearch.search('nothing here')
    expect(snippets).toEqual([])
  })

  it('should propagate AppError when the transport fails', async () => {
    fetchJsonMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'boom'))
    await expect(brightdataResearch.search('x')).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 3: Run test to verify it fails**

Run: `npx vitest run src/lib/research/brightdata.test.ts`
Expected: FAIL — cannot find module `./brightdata`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/research/brightdata.ts`. Brightdata's SERP API returns a JSON object with an `organic` array; parsed defensively with Zod (see Global Constraints known-risk note):

```ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import type { WebResearch, WebSnippet } from './provider'

const BRIGHTDATA_SERP_URL = 'https://api.brightdata.com/serp/req'
const MAX_SNIPPETS = 8

const serpResponseSchema = z.object({
  organic: z
    .array(
      z.object({
        link: z.string(),
        title: z.string().optional(),
        description: z.string().optional(),
      }),
    )
    .optional(),
})

export const brightdataResearch: WebResearch = {
  async search(query: string): Promise<WebSnippet[]> {
    const response = await fetchJson(
      BRIGHTDATA_SERP_URL,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ query, search_engine: 'google', parse: true }),
      },
      serpResponseSchema,
    )
    const organic = response.organic ?? []
    return organic.slice(0, MAX_SNIPPETS).map((r) => ({
      url: r.link,
      title: r.title ?? r.link,
      content: r.description ?? '',
    }))
  },
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/research/brightdata.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add src/lib/research/provider.ts src/lib/research/brightdata.ts src/lib/research/brightdata.test.ts
git commit -m "feat: add WebResearch interface + Brightdata SERP client"
```

---

## Phase 2 — Data access layer

**Tasks 4–8.** All new `src/lib/db/` modules the pipeline stages call: `case_knowledge`, `emails` (with the claim-then-send slot that makes sending idempotent), `sequences`, `suppressions`, plus the mailbox / case / lead / campaign helpers. Pure query functions, ≥80% coverage, mocked Supabase at the boundary.

---

### Task 4: DB — case_knowledge (`src/lib/db/case-knowledge.ts`)

**Files:**
- Create: `src/lib/db/case-knowledge.ts`
- Test: `src/lib/db/case-knowledge.test.ts`

**Interfaces:**
- Produces:
  - `type KnowledgeRow`, `type KnowledgeInsert`
  - `insertKnowledge(supabase, rows: KnowledgeInsert[]): Promise<KnowledgeRow[]>`
  - `listKnowledgeForCase(supabase, caseId: string): Promise<KnowledgeRow[]>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/case-knowledge.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { insertKnowledge, listKnowledgeForCase } from './case-knowledge'
import { AppError } from '@/lib/errors/app-error'

function mockInsert(result: { data: unknown; error: unknown }) {
  return { from: () => ({ insert: () => ({ select: () => Promise.resolve(result) }) }) } as never
}
function mockList(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => Promise.resolve(result) }) }),
    }),
  } as never
}

const row = {
  client_id: 'c1', case_id: 'case1', kind: 'company' as const,
  content: 'x', source_url: null, citation: null, created_by: 'agent' as const,
}

describe('insertKnowledge', () => {
  it('should return an empty array when given no rows', async () => {
    const result = await insertKnowledge(mockInsert({ data: [], error: null }), [])
    expect(result).toEqual([])
  })

  it('should return inserted rows when the insert succeeds', async () => {
    const inserted = [{ id: 'k1' }]
    const result = await insertKnowledge(mockInsert({ data: inserted, error: null }), [row])
    expect(result).toEqual(inserted)
  })

  it('should throw DB_ERROR when the insert errors', async () => {
    await expect(
      insertKnowledge(mockInsert({ data: null, error: { message: 'boom' } }), [row]),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listKnowledgeForCase', () => {
  it('should return rows for the case when the query succeeds', async () => {
    const rows = [{ id: 'k1' }]
    const result = await listKnowledgeForCase(mockList({ data: rows, error: null }), 'case1')
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listKnowledgeForCase(mockList({ data: null, error: { message: 'boom' } }), 'case1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/case-knowledge.test.ts`
Expected: FAIL — cannot find module `./case-knowledge`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/case-knowledge.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type KnowledgeRow = Database['public']['Tables']['case_knowledge']['Row']
export type KnowledgeInsert = Database['public']['Tables']['case_knowledge']['Insert']

export async function insertKnowledge(
  supabase: SupabaseClient<Database>,
  rows: KnowledgeInsert[],
): Promise<KnowledgeRow[]> {
  if (rows.length === 0) return []
  const { data, error } = await supabase.from('case_knowledge').insert(rows).select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert case knowledge', {
      count: rows.length, cause: error.message,
    })
  }
  return data ?? []
}

export async function listKnowledgeForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<KnowledgeRow[]> {
  const { data, error } = await supabase
    .from('case_knowledge')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list case knowledge', { caseId, cause: error.message })
  }
  return data ?? []
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/db/case-knowledge.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/case-knowledge.ts src/lib/db/case-knowledge.test.ts
git commit -m "feat: add case_knowledge db module (insert + list)"
```

---

### Task 5: DB — emails (`src/lib/db/emails.ts`)

**Files:**
- Create: `src/lib/db/emails.ts`
- Test: `src/lib/db/emails.test.ts`

**Interfaces:**
- Produces:
  - `type EmailRow`, `type EmailInsert`
  - `claimOutboundEmail(supabase, row: EmailInsert): Promise<EmailRow | null>` — upsert with `ignoreDuplicates` on `(lead_id, sequence_step, direction)`; returns the claimed row, or `null` when the slot was already claimed (idempotency).
  - `markEmailSent(supabase, id: string, patch: { providerMessageId: string; threadId: string; mailboxId: string }): Promise<void>`
  - `markEmailFailed(supabase, id: string): Promise<void>`
  - `listThreadEmails(supabase, leadId: string): Promise<EmailRow[]>`
  - `hasInboundReply(supabase, leadId: string): Promise<boolean>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/emails.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { claimOutboundEmail, markEmailSent, hasInboundReply } from './emails'
import { AppError } from '@/lib/errors/app-error'

function mockClaim(result: { data: unknown; error: unknown }) {
  return { from: () => ({ upsert: () => ({ select: () => Promise.resolve(result) }) }) } as never
}
function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
function mockReply(result: { count: number | null; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }),
    }),
  } as never
}

const insert = {
  client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
  direction: 'outbound' as const, subject: 's', body: 'b',
  status: 'queued' as const, sequence_step: 0,
}

describe('claimOutboundEmail', () => {
  it('should return the claimed row when the slot is free', async () => {
    const claimed = { id: 'e1' }
    const result = await claimOutboundEmail(mockClaim({ data: [claimed], error: null }), insert)
    expect(result).toEqual(claimed)
  })

  it('should return null when the slot is already claimed', async () => {
    const result = await claimOutboundEmail(mockClaim({ data: [], error: null }), insert)
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      claimOutboundEmail(mockClaim({ data: null, error: { message: 'boom' } }), insert),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('markEmailSent', () => {
  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      markEmailSent(mockUpdate({ error: { message: 'boom' } }), 'e1', {
        providerMessageId: 'p', threadId: 't', mailboxId: 'm',
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('hasInboundReply', () => {
  it('should return true when at least one inbound email exists', async () => {
    const result = await hasInboundReply(mockReply({ count: 1, error: null }), 'lead1')
    expect(result).toBe(true)
  })

  it('should return false when no inbound email exists', async () => {
    const result = await hasInboundReply(mockReply({ count: 0, error: null }), 'lead1')
    expect(result).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/emails.test.ts`
Expected: FAIL — cannot find module `./emails`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/emails.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EmailRow = Database['public']['Tables']['emails']['Row']
export type EmailInsert = Database['public']['Tables']['emails']['Insert']

// Claims the (lead_id, sequence_step, direction) slot. ignoreDuplicates makes a
// QStash retry idempotent: a slot already claimed returns no row, so the caller
// knows this step was already handled and must not send again.
export async function claimOutboundEmail(
  supabase: SupabaseClient<Database>,
  row: EmailInsert,
): Promise<EmailRow | null> {
  const { data, error } = await supabase
    .from('emails')
    .upsert(row, { onConflict: 'lead_id,sequence_step,direction', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim outbound email', {
      leadId: row.lead_id, step: row.sequence_step, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  return data && data.length > 0 ? data[0]! : null
}

export async function markEmailSent(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: { providerMessageId: string; threadId: string; mailboxId: string },
): Promise<void> {
  const { error } = await supabase
    .from('emails')
    .update({
      status: 'sent',
      provider_message_id: patch.providerMessageId,
      thread_id: patch.threadId,
      mailbox_id: patch.mailboxId,
      sent_at: new Date().toISOString(),
    })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email sent', { id, cause: error.message })
  }
}

export async function markEmailFailed(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<void> {
  const { error } = await supabase.from('emails').update({ status: 'failed' }).eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to mark email failed', { id, cause: error.message })
  }
}

export async function listThreadEmails(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('lead_id', leadId)
    .order('created_at', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list thread emails', { leadId, cause: error.message })
  }
  return data ?? []
}

export async function hasInboundReply(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('emails')
    .select('id', { count: 'exact', head: true })
    .eq('lead_id', leadId)
    .eq('direction', 'inbound')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check inbound reply', { leadId, cause: error.message })
  }
  return (count ?? 0) > 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/db/emails.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts
git commit -m "feat: add emails db module (claim/mark/list/hasInboundReply)"
```

---

### Task 6: DB — sequences (`src/lib/db/sequences.ts`)

**Files:**
- Create: `src/lib/db/sequences.ts`
- Test: `src/lib/db/sequences.test.ts`

**Interfaces:**
- Produces:
  - `type SequenceRow`, `type SequenceInsert`
  - `createSequence(supabase, row: SequenceInsert): Promise<SequenceRow | null>` — upsert `ignoreDuplicates` on `(lead_id)`; `null` if the lead already has a sequence.
  - `getSequenceById(supabase, id: string): Promise<SequenceRow | null>`
  - `advanceSequence(supabase, id: string, patch: { currentStep: number; nextActionAt: string | null; qstashMessageId: string | null }): Promise<void>`
  - `stopSequence(supabase, id: string, state: 'stopped' | 'completed'): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/sequences.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { createSequence, getSequenceById, advanceSequence, stopSequence } from './sequences'
import { AppError } from '@/lib/errors/app-error'

function mockUpsert(result: { data: unknown; error: unknown }) {
  return { from: () => ({ upsert: () => ({ select: () => Promise.resolve(result) }) }) } as never
}
function mockGet(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}

const row = { client_id: 'c1', case_id: 'case1', lead_id: 'lead1' }

describe('createSequence', () => {
  it('should return the created sequence when the lead has none', async () => {
    const created = { id: 'seq1' }
    const result = await createSequence(mockUpsert({ data: [created], error: null }), row)
    expect(result).toEqual(created)
  })

  it('should return null when the lead already has a sequence', async () => {
    const result = await createSequence(mockUpsert({ data: [], error: null }), row)
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      createSequence(mockUpsert({ data: null, error: { message: 'boom' } }), row),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getSequenceById', () => {
  it('should return the sequence when found', async () => {
    const seq = { id: 'seq1' }
    const result = await getSequenceById(mockGet({ data: seq, error: null }), 'seq1')
    expect(result).toEqual(seq)
  })
})

describe('advanceSequence', () => {
  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      advanceSequence(mockUpdate({ error: { message: 'boom' } }), 'seq1', {
        currentStep: 1, nextActionAt: null, qstashMessageId: null,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('stopSequence', () => {
  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      stopSequence(mockUpdate({ error: { message: 'boom' } }), 'seq1', 'stopped'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/sequences.test.ts`
Expected: FAIL — cannot find module `./sequences`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/sequences.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type SequenceRow = Database['public']['Tables']['sequences']['Row']
export type SequenceInsert = Database['public']['Tables']['sequences']['Insert']

// ignoreDuplicates on the (lead_id) unique index: a retried write can't create a
// second sequence for the same lead. Returns null when one already exists.
export async function createSequence(
  supabase: SupabaseClient<Database>,
  row: SequenceInsert,
): Promise<SequenceRow | null> {
  const { data, error } = await supabase
    .from('sequences')
    .upsert(row, { onConflict: 'lead_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to create sequence', {
      leadId: row.lead_id, cause: error.message,
    })
  }
  return data && data.length > 0 ? data[0]! : null
}

export async function getSequenceById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<SequenceRow | null> {
  const { data, error } = await supabase.from('sequences').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load sequence', { id, cause: error.message })
  }
  return data
}

export async function advanceSequence(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: { currentStep: number; nextActionAt: string | null; qstashMessageId: string | null },
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({
      current_step: patch.currentStep,
      next_action_at: patch.nextActionAt,
      qstash_message_id: patch.qstashMessageId,
      state: 'active',
    })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to advance sequence', { id, cause: error.message })
  }
}

export async function stopSequence(
  supabase: SupabaseClient<Database>,
  id: string,
  state: 'stopped' | 'completed',
): Promise<void> {
  const { error } = await supabase
    .from('sequences')
    .update({ state, next_action_at: null, qstash_message_id: null })
    .eq('id', id)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to stop sequence', { id, state, cause: error.message })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/db/sequences.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/sequences.ts src/lib/db/sequences.test.ts
git commit -m "feat: add sequences db module (create/get/advance/stop)"
```

---

### Task 7: DB — suppressions (`src/lib/db/suppressions.ts`)

**Files:**
- Create: `src/lib/db/suppressions.ts`
- Test: `src/lib/db/suppressions.test.ts`

**Interfaces:**
- Produces:
  - `type SuppressionReason = Database['public']['Enums']['suppression_reason']`
  - `isSuppressed(supabase, clientId: string, email: string): Promise<boolean>`
  - `addSuppression(supabase, input: { clientId: string; email: string; reason: SuppressionReason }): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `src/lib/db/suppressions.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { isSuppressed, addSuppression } from './suppressions'
import { AppError } from '@/lib/errors/app-error'

function mockCheck(result: { count: number | null; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }),
    }),
  } as never
}
function mockInsert(result: { error: unknown }) {
  return { from: () => ({ upsert: () => Promise.resolve(result) }) } as never
}

describe('isSuppressed', () => {
  it('should return true when the email is suppressed', async () => {
    expect(await isSuppressed(mockCheck({ count: 1, error: null }), 'c1', 'a@b.com')).toBe(true)
  })

  it('should return false when the email is not suppressed', async () => {
    expect(await isSuppressed(mockCheck({ count: 0, error: null }), 'c1', 'a@b.com')).toBe(false)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      isSuppressed(mockCheck({ count: null, error: { message: 'boom' } }), 'c1', 'a@b.com'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('addSuppression', () => {
  it('should resolve when the upsert succeeds', async () => {
    await expect(
      addSuppression(mockInsert({ error: null }), { clientId: 'c1', email: 'a@b.com', reason: 'replied' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the upsert errors', async () => {
    await expect(
      addSuppression(mockInsert({ error: { message: 'boom' } }), { clientId: 'c1', email: 'a@b.com', reason: 'replied' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/db/suppressions.test.ts`
Expected: FAIL — cannot find module `./suppressions`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/db/suppressions.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type SuppressionReason = Database['public']['Enums']['suppression_reason']

export async function isSuppressed(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
): Promise<boolean> {
  const { count, error } = await supabase
    .from('suppressions')
    .select('id', { count: 'exact', head: true })
    .eq('client_id', clientId)
    .eq('email', email)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check suppression', { clientId, cause: error.message })
  }
  return (count ?? 0) > 0
}

export async function addSuppression(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; email: string; reason: SuppressionReason },
): Promise<void> {
  const { error } = await supabase
    .from('suppressions')
    .upsert(
      { client_id: input.clientId, email: input.email, reason: input.reason },
      { onConflict: 'client_id,email', ignoreDuplicates: true },
    )
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to add suppression', {
      clientId: input.clientId, reason: input.reason, cause: error.message,
    })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/db/suppressions.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/suppressions.ts src/lib/db/suppressions.test.ts
git commit -m "feat: add suppressions db module (isSuppressed + addSuppression)"
```

---

### Task 8: DB additions — mailboxes, cases, leads, campaigns

**Files:**
- Modify: `src/lib/db/mailboxes.ts`, `src/lib/db/cases.ts`, `src/lib/db/leads.ts`, `src/lib/db/campaigns.ts`
- Test: `src/lib/db/mailboxes.test.ts` (create), extend `src/lib/db/cases.test.ts`, `src/lib/db/leads.test.ts`, `src/lib/db/campaigns.test.ts`

**Interfaces:**
- Produces:
  - `listMailboxesByIds(supabase, ids: string[]): Promise<MailboxRow[]>`
  - `claimMailboxSend(supabase, mailboxId: string): Promise<MailboxRow | null>` — calls RPC `claim_mailbox_send`; `null` when cap reached / unhealthy.
  - `getCaseById(supabase, caseId: string): Promise<CaseRow | null>`
  - `updateCaseStatus(supabase, caseId: string, status: CaseStatus): Promise<void>`
  - `listCasesByStatus(supabase, status: CaseStatus, limit: number): Promise<CaseRow[]>`
  - `getLeadById(supabase, leadId: string): Promise<LeadRow | null>`
  - `listActiveLeadsForCase(supabase, caseId: string): Promise<LeadRow[]>` — verified/active leads only.
  - `getCampaignForCase(supabase, caseId: string): Promise<CampaignRow | null>`

- [ ] **Step 1: Append the mailbox helpers**

Add to the end of `src/lib/db/mailboxes.ts`:

```ts
export async function listMailboxesByIds(
  supabase: SupabaseClient<Database>,
  ids: string[],
): Promise<MailboxRow[]> {
  if (ids.length === 0) return []
  const { data, error } = await supabase.from('mailboxes').select('*').in('id', ids)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list mailboxes by ids', { count: ids.length, cause: error.message })
  }
  return data ?? []
}

// Atomic cap claim via the claim_mailbox_send Postgres function (migration
// 0005). Returns the updated mailbox row when the send is allowed, or null when
// the mailbox is at its daily cap or not healthy.
export async function claimMailboxSend(
  supabase: SupabaseClient<Database>,
  mailboxId: string,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.rpc('claim_mailbox_send', { p_mailbox_id: mailboxId })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to claim mailbox send', { mailboxId, cause: error.message })
  }
  return data && data.length > 0 ? data[0]! : null
}
```

- [ ] **Step 2: Append the case helpers**

Add to the end of `src/lib/db/cases.ts` (note `CaseStatus` type + imports already present at top — add the enum type export):

```ts
export type CaseStatus = Database['public']['Enums']['case_status']

export async function getCaseById(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CaseRow | null> {
  const { data, error } = await supabase.from('cases').select('*').eq('id', caseId).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load case', { caseId, cause: error.message })
  }
  return data
}

export async function updateCaseStatus(
  supabase: SupabaseClient<Database>,
  caseId: string,
  status: CaseStatus,
): Promise<void> {
  const { error } = await supabase
    .from('cases')
    .update({ status, updated_at: new Date().toISOString() })
    .eq('id', caseId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to update case status', { caseId, status, cause: error.message })
  }
}

export async function listCasesByStatus(
  supabase: SupabaseClient<Database>,
  status: CaseStatus,
  limit: number,
): Promise<CaseRow[]> {
  const { data, error } = await supabase
    .from('cases')
    .select('*')
    .eq('status', status)
    .order('created_at', { ascending: true })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list cases by status', { status, cause: error.message })
  }
  return data ?? []
}
```

- [ ] **Step 3: Append the lead helpers**

Add to the end of `src/lib/db/leads.ts`:

```ts
export async function getLeadById(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<LeadRow | null> {
  const { data, error } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load lead', { leadId, cause: error.message })
  }
  return data
}

// Verified, case-attached leads for a case — the people we are allowed to email.
export async function listActiveLeadsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<LeadRow[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('case_id', caseId)
    .eq('status', 'active')
    .eq('email_status', 'verified')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list active leads for case', { caseId, cause: error.message })
  }
  return data ?? []
}
```

- [ ] **Step 4: Append the campaign helper**

Add to the end of `src/lib/db/campaigns.ts`:

```ts
// Loads the campaign that owns a case, via a case → campaign lookup. Returns
// null if the case or its campaign is missing.
export async function getCampaignForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<CampaignRow | null> {
  const { data, error } = await supabase
    .from('cases')
    .select('campaign:campaigns(*)')
    .eq('id', caseId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load campaign for case', { caseId, cause: error.message })
  }
  const campaign = (data as { campaign: CampaignRow | null } | null)?.campaign ?? null
  return campaign
}
```

- [ ] **Step 5: Write tests for the new helpers**

Create `src/lib/db/mailboxes.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { listMailboxesByIds, claimMailboxSend } from './mailboxes'
import { AppError } from '@/lib/errors/app-error'

function mockIn(result: { data: unknown; error: unknown }) {
  return { from: () => ({ select: () => ({ in: () => Promise.resolve(result) }) }) } as never
}
function mockRpc(result: { data: unknown; error: unknown }) {
  return { rpc: () => Promise.resolve(result) } as never
}

describe('listMailboxesByIds', () => {
  it('should return an empty array when given no ids', async () => {
    expect(await listMailboxesByIds(mockIn({ data: null, error: null }), [])).toEqual([])
  })

  it('should return rows when the query succeeds', async () => {
    const rows = [{ id: 'm1' }]
    expect(await listMailboxesByIds(mockIn({ data: rows, error: null }), ['m1'])).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listMailboxesByIds(mockIn({ data: null, error: { message: 'boom' } }), ['m1']),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('claimMailboxSend', () => {
  it('should return the mailbox when the claim succeeds', async () => {
    const row = { id: 'm1', sent_today: 1 }
    expect(await claimMailboxSend(mockRpc({ data: [row], error: null }), 'm1')).toEqual(row)
  })

  it('should return null when the cap is reached (no row)', async () => {
    expect(await claimMailboxSend(mockRpc({ data: [], error: null }), 'm1')).toBeNull()
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    await expect(
      claimMailboxSend(mockRpc({ data: null, error: { message: 'boom' } }), 'm1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Add to `src/lib/db/cases.test.ts` a new block (reuse a fresh local mock; keep the existing `mockSupabase` for `findOrCreateCase`):

```ts
import { getCaseById, updateCaseStatus, listCasesByStatus } from './cases'

function mockMaybe(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockStatusUpdate(result: { error: unknown }) {
  return { from: () => ({ update: () => ({ eq: () => Promise.resolve(result) }) }) } as never
}
function mockByStatus(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ order: () => ({ limit: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('getCaseById', () => {
  it('should return the case when found', async () => {
    const c = { id: 'case1' }
    expect(await getCaseById(mockMaybe({ data: c, error: null }), 'case1')).toEqual(c)
  })
})

describe('updateCaseStatus', () => {
  it('should throw DB_ERROR when the update errors', async () => {
    await expect(
      updateCaseStatus(mockStatusUpdate({ error: { message: 'boom' } }), 'case1', 'ready'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listCasesByStatus', () => {
  it('should return rows when the query succeeds', async () => {
    const rows = [{ id: 'case1' }]
    expect(await listCasesByStatus(mockByStatus({ data: rows, error: null }), 'new', 100)).toEqual(rows)
  })
})
```

Add to `src/lib/db/leads.test.ts`:

```ts
import { getLeadById, listActiveLeadsForCase } from './leads'

function mockLeadMaybe(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}
function mockActiveLeads(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ eq: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('getLeadById', () => {
  it('should return the lead when found', async () => {
    const l = { id: 'lead1' }
    expect(await getLeadById(mockLeadMaybe({ data: l, error: null }), 'lead1')).toEqual(l)
  })
})

describe('listActiveLeadsForCase', () => {
  it('should return verified active leads when the query succeeds', async () => {
    const rows = [{ id: 'lead1', email_status: 'verified' }]
    expect(await listActiveLeadsForCase(mockActiveLeads({ data: rows, error: null }), 'case1')).toEqual(rows)
  })
})
```

Add to `src/lib/db/campaigns.test.ts` (create if it lacks a suitable block):

```ts
import { getCampaignForCase } from './campaigns'

function mockCampaignForCase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }) }),
  } as never
}

describe('getCampaignForCase', () => {
  it('should return the joined campaign when present', async () => {
    const campaign = { id: 'camp1', reply_mode: 'auto_send' }
    const result = await getCampaignForCase(
      mockCampaignForCase({ data: { campaign }, error: null }),
      'case1',
    )
    expect(result).toEqual(campaign)
  })

  it('should return null when the case has no campaign', async () => {
    const result = await getCampaignForCase(mockCampaignForCase({ data: null, error: null }), 'case1')
    expect(result).toBeNull()
  })
})
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/db/mailboxes.test.ts src/lib/db/cases.test.ts src/lib/db/leads.test.ts src/lib/db/campaigns.test.ts`
Expected: PASS (all blocks, including the pre-existing ones).

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/mailboxes.ts src/lib/db/mailboxes.test.ts src/lib/db/cases.ts src/lib/db/cases.test.ts src/lib/db/leads.ts src/lib/db/leads.test.ts src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat: add P2 db helpers (mailbox claim/list, case status, active leads, campaign-for-case)"
```

---

## Phase 3 — Sending infrastructure

**Tasks 9–10.** Extend the mailbox providers for threading (`threadId` + `In-Reply-To` / `References` headers) and build the Mailbox Sender (least-used rotation, atomic cap claim, jitter, refreshed-token persistence). No demo on its own; both are unit-tested against mocked providers and exercised end-to-end once the write stage (Phase 5) uses them.

---

### Task 9: Mailbox provider threading support

**Files:**
- Modify: `src/lib/mailbox/provider.ts`, `src/lib/mailbox/gmail-provider.ts`, `src/lib/mailbox/outlook-provider.ts`
- Test: extend `src/lib/mailbox/gmail-provider.test.ts`, `src/lib/mailbox/outlook-provider.test.ts`

**Interfaces:**
- Consumes: existing `MailboxProvider.sendEmail`.
- Produces: `SendEmailInput` extended with `threadId?: string | null`, `inReplyToMessageId?: string | null`, `references?: string | null`. Follow-ups pass these so replies thread onto the first-touch conversation. First-touch passes them all `undefined`/`null`.

- [ ] **Step 1: Extend the interface**

In `src/lib/mailbox/provider.ts`, replace the `SendEmailInput` interface:

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
}
```

- [ ] **Step 2: Write the failing Gmail test**

Add to `src/lib/mailbox/gmail-provider.test.ts` a test asserting that when `threadId` is supplied, the send request body includes it (adapt the existing `fetchJson` mock in that file):

```ts
it('should include threadId in the send request body when threading a follow-up', async () => {
  fetchJsonMock.mockResolvedValueOnce({ access_token: 'a', expires_in: 3600 }) // refresh (if triggered)
  fetchJsonMock.mockResolvedValueOnce({ id: 'msg1', threadId: 'thr1' }) // send
  const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: new Date(Date.now() + 3_600_000).toISOString() }
  await gmailProvider.sendEmail(tokens, {
    to: 'x@y.com', subject: 'Re: hi', body: 'b', threadId: 'thr1', inReplyToMessageId: '<abc@mail>',
  })
  const sendCall = fetchJsonMock.mock.calls.find(([url]) => String(url).includes('/messages/send'))
  const body = JSON.parse((sendCall![1] as { body: string }).body)
  expect(body.threadId).toBe('thr1')
})
```

> If the existing test file does not already expose `fetchJsonMock`, mirror the mock setup it uses. The assertion that must newly pass is: the send body carries `threadId`.

- [ ] **Step 3: Run the Gmail test to verify it fails**

Run: `npx vitest run src/lib/mailbox/gmail-provider.test.ts`
Expected: FAIL — `body.threadId` is `undefined`.

- [ ] **Step 4: Implement Gmail threading**

In `src/lib/mailbox/gmail-provider.ts`, update `encodeMessage` to add threading headers and update `sendEmail` to pass `threadId`:

```ts
function encodeMessage(from: string, input: SendEmailInput): string {
  const headers = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ]
  if (input.inReplyToMessageId) headers.push(`In-Reply-To: ${input.inReplyToMessageId}`)
  if (input.references) headers.push(`References: ${input.references}`)
  const raw = [...headers, '', input.body].join('\r\n')
  return Buffer.from(raw, 'utf-8').toString('base64url')
}
```

And in `sendEmail`, change the request body to include `threadId` when present:

```ts
  async sendEmail(tokens: MailboxTokens, input: SendEmailInput) {
    const fresh = await ensureFresh(tokens)
    const payload: { raw: string; threadId?: string } = { raw: encodeMessage('me', input) }
    if (input.threadId) payload.threadId = input.threadId
    const sendResponse = await fetchJson(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      sendResponseSchema,
    )
    return { result: { providerMessageId: sendResponse.id, threadId: sendResponse.threadId }, tokens: fresh }
  },
```

- [ ] **Step 5: Implement Outlook threading (best-effort headers)**

In `src/lib/mailbox/outlook-provider.ts`, when building the Graph `sendMail` message, add `internetMessageHeaders` for `In-Reply-To`/`References` when present. Locate the message object passed to Graph and extend it:

```ts
// Graph threads a message when it carries In-Reply-To / References headers that
// point at the original conversation's Message-IDs. threadId isn't used
// directly by Graph sendMail, so we thread purely via these headers.
const internetMessageHeaders: { name: string; value: string }[] = []
if (input.inReplyToMessageId) internetMessageHeaders.push({ name: 'In-Reply-To', value: input.inReplyToMessageId })
if (input.references) internetMessageHeaders.push({ name: 'References', value: input.references })
```

Then include `...(internetMessageHeaders.length > 0 ? { internetMessageHeaders } : {})` in the `message` object. (Match the exact shape already present in the file — the existing `sendEmail` builds a `{ message: { subject, body, toRecipients } }` object; spread the new field into that inner `message`.)

- [ ] **Step 6: Run both provider test suites**

Run: `npx vitest run src/lib/mailbox/gmail-provider.test.ts src/lib/mailbox/outlook-provider.test.ts`
Expected: PASS (existing tests still green + new threading test green).

- [ ] **Step 7: Commit**

```bash
git add src/lib/mailbox/provider.ts src/lib/mailbox/gmail-provider.ts src/lib/mailbox/gmail-provider.test.ts src/lib/mailbox/outlook-provider.ts src/lib/mailbox/outlook-provider.test.ts
git commit -m "feat: mailbox providers support threading (threadId + In-Reply-To/References)"
```

---
### Task 10: Mailbox Sender (`src/lib/mailbox/sender.ts`)

**Files:**
- Create: `src/lib/mailbox/sender.ts`
- Test: `src/lib/mailbox/sender.test.ts`

**Interfaces:**
- Consumes: `listMailboxesByIds`, `claimMailboxSend`, `updateMailboxOauth` (`src/lib/db/mailboxes.ts`); `getMailboxProvider` (`src/lib/mailbox/registry.ts`); `MailboxTokens`, `SendEmailInput` (`src/lib/mailbox/provider.ts`).
- Produces:
  - `interface SendViaMailboxInput { clientId: string; mailboxIds: string[]; to: string; subject: string; body: string; threadId?: string | null; inReplyToMessageId?: string | null; references?: string | null; maxJitterMs?: number }`
  - `interface SendViaMailboxResult { mailboxId: string; providerMessageId: string; threadId: string }`
  - `sendViaMailbox(supabase, input: SendViaMailboxInput): Promise<SendViaMailboxResult>`
  - Throws `AppError('RATE_LIMITED', ...)` when every candidate mailbox is at its cap / unhealthy (so the caller can leave the case for the next run).

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/sender.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const listMailboxesByIdsMock = vi.fn()
const claimMailboxSendMock = vi.fn()
const updateMailboxOauthMock = vi.fn()
const getMailboxProviderMock = vi.fn()

vi.mock('@/lib/db/mailboxes', () => ({
  listMailboxesByIds: (...a: unknown[]) => listMailboxesByIdsMock(...a),
  claimMailboxSend: (...a: unknown[]) => claimMailboxSendMock(...a),
  updateMailboxOauth: (...a: unknown[]) => updateMailboxOauthMock(...a),
}))
vi.mock('@/lib/mailbox/registry', () => ({
  getMailboxProvider: (...a: unknown[]) => getMailboxProviderMock(...a),
}))

import { sendViaMailbox } from './sender'

const tokens = { accessToken: 'a', refreshToken: 'r', expiresAt: '2099-01-01T00:00:00.000Z' }
const mailbox = { id: 'm1', provider: 'gmail', email_address: 'me@co.com', oauth: tokens, sent_today: 0, daily_cap: 50, health: 'ok' }
const baseInput = { clientId: 'c1', mailboxIds: ['m1'], to: 'x@y.com', subject: 's', body: 'b', maxJitterMs: 0 }

beforeEach(() => {
  listMailboxesByIdsMock.mockReset(); claimMailboxSendMock.mockReset()
  updateMailboxOauthMock.mockReset(); getMailboxProviderMock.mockReset()
})

describe('sendViaMailbox', () => {
  it('should claim a healthy mailbox, send, persist tokens, and return the result', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue({ ...mailbox, sent_today: 1 })
    const sendEmail = vi.fn().mockResolvedValue({
      result: { providerMessageId: 'pm1', threadId: 'thr1' },
      tokens: { ...tokens, accessToken: 'a2' },
    })
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail })
    const result = await sendViaMailbox({} as never, baseInput)
    expect(result).toEqual({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    expect(updateMailboxOauthMock).toHaveBeenCalledTimes(1)
  })

  it('should throw RATE_LIMITED when no mailbox can be claimed', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue(null) // at cap
    getMailboxProviderMock.mockReturnValue({ provider: 'gmail', sendEmail: vi.fn() })
    await expect(sendViaMailbox({} as never, baseInput)).rejects.toMatchObject({ code: 'RATE_LIMITED' })
  })

  it('should throw VALIDATION_ERROR when no mailboxes are configured', async () => {
    await expect(sendViaMailbox({} as never, { ...baseInput, mailboxIds: [] })).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/mailbox/sender.test.ts`
Expected: FAIL — cannot find module `./sender`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/mailbox/sender.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database, Json } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  listMailboxesByIds,
  claimMailboxSend,
  updateMailboxOauth,
  type MailboxRow,
} from '@/lib/db/mailboxes'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import type { MailboxTokens } from '@/lib/mailbox/provider'

const DEFAULT_MAX_JITTER_MS = 4_000

const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

export interface SendViaMailboxInput {
  clientId: string
  mailboxIds: string[]
  to: string
  subject: string
  body: string
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
  maxJitterMs?: number
}

export interface SendViaMailboxResult {
  mailboxId: string
  providerMessageId: string
  threadId: string
}

function parseTokens(oauth: Json, mailboxId: string): MailboxTokens {
  const parsed = tokensSchema.safeParse(oauth)
  if (!parsed.success) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox oauth tokens malformed', { mailboxId })
  }
  return parsed.data
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// Rotation: least-used-first, so sends spread evenly across a campaign's
// mailboxes and warm them uniformly.
function rotationOrder(mailboxes: MailboxRow[]): MailboxRow[] {
  return [...mailboxes]
    .filter((m) => m.health === 'ok')
    .sort((a, b) => a.sent_today - b.sent_today)
}

export async function sendViaMailbox(
  supabase: SupabaseClient<Database>,
  input: SendViaMailboxInput,
): Promise<SendViaMailboxResult> {
  if (input.mailboxIds.length === 0) {
    throw new AppError('VALIDATION_ERROR', 'Campaign has no mailboxes configured', { clientId: input.clientId })
  }
  const mailboxes = await listMailboxesByIds(supabase, input.mailboxIds)
  const ordered = rotationOrder(mailboxes)
  if (ordered.length === 0) {
    throw new AppError('RATE_LIMITED', 'No healthy mailbox available', { clientId: input.clientId })
  }

  for (const candidate of ordered) {
    const claimed = await claimMailboxSend(supabase, candidate.id)
    if (!claimed) continue // at cap or turned unhealthy — try the next mailbox

    const tokens = parseTokens(claimed.oauth, claimed.id)
    const provider = getMailboxProvider(claimed.provider)
    const jitter = Math.floor(Math.random() * (input.maxJitterMs ?? DEFAULT_MAX_JITTER_MS))
    if (jitter > 0) await sleep(jitter)

    const { result, tokens: refreshed } = await provider.sendEmail(tokens, {
      to: input.to,
      subject: input.subject,
      body: input.body,
      threadId: input.threadId ?? null,
      inReplyToMessageId: input.inReplyToMessageId ?? null,
      references: input.references ?? null,
    })

    // Persist any refreshed access token so the next send doesn't re-refresh.
    await updateMailboxOauth(supabase, claimed.id, { ...refreshed })

    return {
      mailboxId: claimed.id,
      providerMessageId: result.providerMessageId,
      threadId: result.threadId,
    }
  }

  throw new AppError('RATE_LIMITED', 'All mailboxes at daily cap', { clientId: input.clientId })
}
```

> Note: `updateMailboxOauth` takes `Record<string, Json>`; `{ ...refreshed }` is a string-valued object and satisfies that.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/mailbox/sender.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts
git commit -m "feat: add mailbox sender (rotation, atomic cap claim, jitter, token persistence)"
```

---

## Phase 4 — Research stage (architecture §6 Stage 3)

**Tasks 11–12.** The Research Agent: Brightdata SERP + Gemini dossier → `case_knowledge`, plus the fan-out cron and the per-case route that claims a case (`new → researching`) and marks it `ready`.

**Demo:** a `new` case runs through `/api/pipeline/research` and lands at `status = ready` with cited dossier entries in `case_knowledge`.

---

### Task 11: Research pipeline (`src/lib/pipeline/research.ts`)

**Files:**
- Create: `src/lib/pipeline/research.ts`
- Test: `src/lib/pipeline/research.test.ts`

**Interfaces:**
- Consumes: `WebResearch` (`src/lib/research/provider.ts`), `generateJson` + `LlmCallContext` (`src/lib/llm/client.ts`), `insertKnowledge` (`src/lib/db/case-knowledge.ts`), `updateCaseStatus` (`src/lib/db/cases.ts`), `logEvent`.
- Produces:
  - `interface ResearchLead { fullName: string; title: string | null }`
  - `interface RunResearchInput { clientId: string; caseId: string; companyName: string; companyDomain: string | null; valueProp: string | null; leads: ResearchLead[] }`
  - `interface ResearchSummary { caseId: string; knowledgeCount: number }`
  - `runResearchForCase(supabase, deps: { research: WebResearch }, input: RunResearchInput): Promise<ResearchSummary>` — `research` is injected so the test mocks the web boundary without module mocking.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipeline/research.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateJsonMock = vi.fn()
const insertKnowledgeMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertKnowledge: (...a: unknown[]) => insertKnowledgeMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { runResearchForCase } from './research'

const research = { search: vi.fn() }
const input = {
  clientId: 'c1', caseId: 'case1', companyName: 'Acme', companyDomain: 'acme.com',
  valueProp: 'We save you time', leads: [{ fullName: 'Jane Doe', title: 'CTO' }],
}

beforeEach(() => {
  generateJsonMock.mockReset(); insertKnowledgeMock.mockReset()
  updateCaseStatusMock.mockReset(); logEventMock.mockReset(); research.search.mockReset()
})

describe('runResearchForCase', () => {
  it('should build knowledge from search + llm, write it, and mark the case ready', async () => {
    research.search.mockResolvedValue([{ url: 'https://acme.com', title: 'Acme', content: 'We build widgets' }])
    generateJsonMock.mockResolvedValue({
      summary: 'Acme builds widgets',
      entries: [
        { kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: 'Acme site' },
        { kind: 'pain_point', content: 'Manual ops', sourceUrl: null, citation: null },
      ],
    })
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }])
    const result = await runResearchForCase({} as never, { research }, input)
    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 2 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
    expect(logEventMock).toHaveBeenCalled()
  })

  it('should still mark the case ready when the web search returns nothing', async () => {
    research.search.mockResolvedValue([])
    generateJsonMock.mockResolvedValue({ summary: 'No public data', entries: [] })
    insertKnowledgeMock.mockResolvedValue([])
    const result = await runResearchForCase({} as never, { research }, input)
    expect(result.knowledgeCount).toBe(0)
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipeline/research.test.ts`
Expected: FAIL — cannot find module `./research`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/research.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/types/database'
import type { WebResearch, WebSnippet } from '@/lib/research/provider'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { insertKnowledge, type KnowledgeInsert } from '@/lib/db/case-knowledge'
import { updateCaseStatus } from '@/lib/db/cases'
import { logEvent } from '@/lib/events/log-event'

const MAX_OUTPUT_TOKENS = 1_400
const ACTOR = 'research_agent'

const dossierSchema = z.object({
  summary: z.string(),
  entries: z.array(
    z.object({
      kind: z.enum(['company', 'person', 'news', 'pain_point']),
      content: z.string().min(1),
      sourceUrl: z.string().nullable(),
      citation: z.string().nullable(),
    }),
  ),
})

export interface ResearchLead {
  fullName: string
  title: string | null
}

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

const SYSTEM_PROMPT = [
  'You are a B2B sales research analyst.',
  'From the provided web snippets, extract only facts that are supported by a snippet.',
  'Never invent facts. If a fact has no supporting snippet, omit it.',
  'For every entry, set sourceUrl to the snippet URL it came from, or null if it is a',
  'general inference with no single source. Keep each entry to one or two sentences.',
].join(' ')

function buildPrompt(input: RunResearchInput, snippets: WebSnippet[]): string {
  const people = input.leads.map((l) => `- ${l.fullName}${l.title ? `, ${l.title}` : ''}`).join('\n')
  const evidence = snippets
    .map((s, i) => `[${i + 1}] ${s.title} (${s.url})\n${s.content}`)
    .join('\n\n')
  return [
    `Company: ${input.companyName}${input.companyDomain ? ` (${input.companyDomain})` : ''}`,
    `Our value proposition to them: ${input.valueProp ?? 'n/a'}`,
    `People we plan to contact:\n${people}`,
    `Web snippets:\n${evidence || '(none found)'}`,
    'Produce a short dossier: a one-paragraph summary plus discrete knowledge entries',
    '(company facts, per-person angles, recent news, and likely pain points).',
  ].join('\n\n')
}

export async function runResearchForCase(
  supabase: SupabaseClient<Database>,
  deps: { research: WebResearch },
  input: RunResearchInput,
): Promise<ResearchSummary> {
  const query = input.companyDomain
    ? `${input.companyName} ${input.companyDomain} company news`
    : `${input.companyName} company news`
  const snippets = await deps.research.search(query)

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const dossier = await generateJson(context, {
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input, snippets),
    schema: dossierSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  const rows: KnowledgeInsert[] = dossier.entries.map((e) => ({
    client_id: input.clientId,
    case_id: input.caseId,
    kind: e.kind,
    content: e.content,
    source_url: e.sourceUrl,
    citation: e.citation,
    created_by: 'agent',
  }))
  const inserted = await insertKnowledge(supabase, rows)

  await updateCaseStatus(supabase, input.caseId, 'ready')

  await logEvent({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.research.completed',
    payload: { caseId: input.caseId, knowledgeCount: inserted.length, summary: dossier.summary },
  })

  return { caseId: input.caseId, knowledgeCount: inserted.length }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipeline/research.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/research.ts src/lib/pipeline/research.test.ts
git commit -m "feat: add research pipeline (web search + Gemini dossier -> case_knowledge)"
```

---

### Task 12: Research routes + fan-out cron

**Files:**
- Create: `src/app/api/pipeline/research-fanout/route.ts`, `src/app/api/pipeline/research/route.ts`, `scripts/schedule-research-cron.ts`
- Test: `src/app/api/pipeline/research/route.test.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature`, `createAdminClient`, `listCasesByStatus`, `getCaseById`, `updateCaseStatus`, `listActiveLeadsForCase`, `getCampaignForCase`, `publishJson`, `runResearchForCase`, `brightdataResearch`, `logEvent`, `isAppError`.
- Idempotency: `/api/pipeline/research` transitions the case `new → researching` at entry; if the case is not `new` it no-ops (`skipped`). A QStash retry after a partial run sees `researching`/`ready` and safely skips. Research is only re-derivable work, and duplicate `case_knowledge` rows are harmless append-only entries, so this claim is sufficient.

- [ ] **Step 1: Write the fan-out route**

Create `src/app/api/pipeline/research-fanout/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCasesByStatus } from '@/lib/db/cases'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const FANOUT_LIMIT = 200

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const cases = await listCasesByStatus(admin, 'new', FANOUT_LIMIT)
    const failedCaseIds: string[] = []
    for (const c of cases) {
      try {
        await publishJson('/api/pipeline/research', { caseId: c.id })
      } catch {
        failedCaseIds.push(c.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.research_fanout.completed',
        payload: { caseCount: cases.length, failedCaseIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, caseCount: cases.length, failedCaseIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the failing per-case route test**

Create `src/app/api/pipeline/research/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const listActiveLeadsMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const runResearchMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ listActiveLeadsForCase: (...a: unknown[]) => listActiveLeadsMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/pipeline/research', () => ({ runResearchForCase: (...a: unknown[]) => runResearchMock(...a) }))
vi.mock('@/lib/research/brightdata', () => ({ brightdataResearch: { search: vi.fn() } }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/research', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(JSON.stringify({ caseId: 'case1' }))
  getCaseByIdMock.mockReset(); updateCaseStatusMock.mockReset()
  listActiveLeadsMock.mockReset(); getCampaignForCaseMock.mockReset(); runResearchMock.mockReset()
})

describe('POST /api/pipeline/research', () => {
  it('should run research and return ok when the case is new', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ caseId: 'case1' }))
    getCaseByIdMock.mockResolvedValue({ id: 'case1', client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com' })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v' })
    listActiveLeadsMock.mockResolvedValue([{ full_name: 'Jane', title: 'CTO' }])
    runResearchMock.mockResolvedValue({ caseId: 'case1', knowledgeCount: 2 })
    const res = await POST(req({ caseId: 'case1' }))
    expect(res.status).toBe(200)
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'researching')
    expect(runResearchMock).toHaveBeenCalled()
  })

  it('should skip when the case is not new', async () => {
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'ready' })
    const res = await POST(req({ caseId: 'case1' }))
    const json = await res.json()
    expect(json.skipped).toBe('case_not_new')
    expect(runResearchMock).not.toHaveBeenCalled()
  })

  it('should return 401 when the signature is invalid', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad sig'))
    const res = await POST(req({ caseId: 'case1' }))
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/app/api/pipeline/research/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 4: Write the per-case route**

Create `src/app/api/pipeline/research/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, updateCaseStatus } from '@/lib/db/cases'
import { listActiveLeadsForCase } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { runResearchForCase } from '@/lib/pipeline/research'
import { brightdataResearch } from '@/lib/research/brightdata'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ caseId: z.string().uuid() })

export async function POST(request: Request) {
  try {
    const rawBody = await verifyQstashSignature(request)
    const { caseId } = bodySchema.parse(JSON.parse(rawBody))
    const admin = createAdminClient()

    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
    if (kase.status !== 'new') return NextResponse.json({ ok: true, skipped: 'case_not_new' })

    // Claim the case so a concurrent/retried fan-out won't re-research it.
    await updateCaseStatus(admin, caseId, 'researching')

    const campaign = await getCampaignForCase(admin, caseId)
    const leads = await listActiveLeadsForCase(admin, caseId)
    const summary = await runResearchForCase(
      admin,
      { research: brightdataResearch },
      {
        clientId: kase.client_id,
        caseId,
        companyName: kase.company_name,
        companyDomain: kase.company_domain,
        valueProp: campaign?.value_prop ?? null,
        leads: leads.map((l) => ({ fullName: l.full_name, title: l.title })),
      },
    )
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 5: Write the cron registration script**

Create `scripts/schedule-research-cron.ts`:

```ts
// One-time setup: registers the QStash daily schedule that fans research out to
// every case in status 'new'. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-research-cron.ts [cron-expression]
// Default cron: "0 7 * * *" (07:00 UTC daily, after discovery at 06:00).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 7 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/research-fanout', cron)
  process.stdout.write(`Scheduled research-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/app/api/pipeline/research/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/pipeline/research-fanout src/app/api/pipeline/research scripts/schedule-research-cron.ts
git commit -m "feat: add research fan-out + per-case research route + cron script"
```

---

## Phase 5 — Write, send & follow-ups (architecture §6 Stages 4–5)

**Tasks 13–17.** The Email-Writer Agent + reply-mode gate, the write fan-out/route, the QStash-delayed follow-up sequencer + route, and the daily mailbox-reset job.

**Build order within this phase: 15 → 13 → 14 → 16 → 17.** Task 13 (write) imports `FOLLOWUP_DELAYS_SECONDS` and `publishJsonWithDelay` from Task 15, so build the sequencer first (the dependency note in Task 13 repeats this).

**Demo:** a `ready` case is written, sent from a rotated mailbox under its daily cap, and a 3/7/14-day follow-up is scheduled — firing on cadence when there is no reply, cancelling when a reply arrives, and marking the case `dead` after step 3.

---

### Task 13: Write pipeline (`src/lib/pipeline/write.ts`)

**Files:**
- Create: `src/lib/pipeline/write.ts`
- Test: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `listKnowledgeForCase` (`case-knowledge`), `listActiveLeadsForCase`/`getLeadById` (`leads`), `isSuppressed` (`suppressions`), `claimOutboundEmail`/`markEmailSent`/`markEmailFailed` (`emails`), `createSequence` (`sequences`), `sendViaMailbox` (`sender`), `generateJson` + `LlmCallContext` (`llm`), `updateCaseStatus` (`cases`), `publishJsonWithDelay` (`qstash/client`, Task 15), `FOLLOWUP_DELAYS_SECONDS` (`followup`, Task 15), `logEvent`.
- Produces:
  - `type ReplyMode = Database['public']['Enums']['reply_mode']`
  - `interface RunWriteInput { clientId: string; campaignId: string; caseId: string; replyMode: ReplyMode; valueProp: string | null; bookingLink: string | null; mailboxIds: string[]; companyName: string }`
  - `interface WriteSummary { caseId: string; drafted: number; sent: number }`
  - `runWriteForCase(supabase, input: RunWriteInput): Promise<WriteSummary>`

> **Dependency ordering:** this task references `publishJsonWithDelay` and `FOLLOWUP_DELAYS_SECONDS`, both created in Task 15. Implement Task 15 first if executing strictly in order, **or** stub the two imports here and let Task 15's tests light up the send-then-enqueue path. Recommended: reorder execution to do Task 15 before Task 13. The plan lists Task 13 first only because it is the larger conceptual unit.

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipeline/write.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const listKnowledgeMock = vi.fn()
const listActiveLeadsMock = vi.fn()
const isSuppressedMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const createSequenceMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateJsonMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const publishDelayMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ listActiveLeadsForCase: (...a: unknown[]) => listActiveLeadsMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ isSuppressed: (...a: unknown[]) => isSuppressedMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({ createSequence: (...a: unknown[]) => createSequenceMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { runWriteForCase } from './write'

const lead = { id: 'lead1', client_id: 'c1', case_id: 'case1', full_name: 'Jane Doe', title: 'CTO', email: 'jane@acme.com' }
const input = {
  clientId: 'c1', campaignId: 'camp1', caseId: 'case1', replyMode: 'auto_send' as const,
  valueProp: 'We save time', bookingLink: 'https://cal.com/x', mailboxIds: ['m1'], companyName: 'Acme',
}

beforeEach(() => {
  for (const m of [listKnowledgeMock, listActiveLeadsMock, isSuppressedMock, claimOutboundEmailMock,
    markEmailSentMock, markEmailFailedMock, createSequenceMock, sendViaMailboxMock, generateJsonMock,
    updateCaseStatusMock, publishDelayMock, logEventMock]) m.mockReset()
  listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])
  isSuppressedMock.mockResolvedValue(false)
  generateJsonMock.mockResolvedValue({ subject: 'Quick idea for Acme', body: 'Hi Jane...' })
})

describe('runWriteForCase', () => {
  it('should write, send, create a sequence, and enqueue the first follow-up on auto_send', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 1 })
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalled()
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'contacted')
  })

  it('should draft (not send) when reply_mode is human_approve', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    const result = await runWriteForCase({} as never, { ...input, replyMode: 'human_approve' })
    expect(result).toEqual({ caseId: 'case1', drafted: 1, sent: 0 })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should skip a suppressed lead', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    isSuppressedMock.mockResolvedValue(true)
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
  })

  it('should skip a lead whose email slot is already claimed (idempotent retry)', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue(null) // already claimed
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/pipeline/write.test.ts`
Expected: FAIL — cannot find module `./write`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/write.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import { z } from 'zod'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { listKnowledgeForCase, type KnowledgeRow } from '@/lib/db/case-knowledge'
import { listActiveLeadsForCase, type LeadRow } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { claimOutboundEmail, markEmailSent, markEmailFailed } from '@/lib/db/emails'
import { createSequence } from '@/lib/db/sequences'
import { updateCaseStatus } from '@/lib/db/cases'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { FOLLOWUP_DELAYS_SECONDS } from './followup'
import { logEvent } from '@/lib/events/log-event'

const MAX_OUTPUT_TOKENS = 700
const ACTOR = 'email_writer_agent'
const FIRST_TOUCH_STEP = 0

export type ReplyMode = Database['public']['Enums']['reply_mode']

const draftSchema = z.object({ subject: z.string().min(1), body: z.string().min(1) })

export interface RunWriteInput {
  clientId: string
  campaignId: string
  caseId: string
  replyMode: ReplyMode
  valueProp: string | null
  bookingLink: string | null
  mailboxIds: string[]
  companyName: string
}

export interface WriteSummary {
  caseId: string
  drafted: number
  sent: number
}

const SYSTEM_PROMPT = [
  'You write short, human-sounding B2B cold emails.',
  'No bulk markers, no unsubscribe footer, no tracking language.',
  'One clear idea, one soft call to action. 90 words or fewer.',
  'Use only facts present in the provided dossier. Never invent specifics.',
].join(' ')

function buildPrompt(input: RunWriteInput, lead: LeadRow, knowledge: KnowledgeRow[]): string {
  const dossier = knowledge.map((k) => `- (${k.kind}) ${k.content}`).join('\n') || '(no dossier facts)'
  return [
    `Recipient: ${lead.full_name}${lead.title ? `, ${lead.title}` : ''} at ${input.companyName}`,
    `Our value proposition: ${input.valueProp ?? 'n/a'}`,
    input.bookingLink ? `Booking link (optional CTA): ${input.bookingLink}` : '',
    `Dossier:\n${dossier}`,
    'Write the first-touch email. Return a subject and a body.',
  ]
    .filter(Boolean)
    .join('\n\n')
}

// auto_send and hybrid both send first-touch immediately (hybrid only diverges
// on replies, per architecture.md §6 Stage 4). human_approve leaves a draft.
function shouldSendFirstTouch(replyMode: ReplyMode): boolean {
  return replyMode === 'auto_send' || replyMode === 'hybrid'
}

async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
): Promise<'sent' | 'drafted' | 'skipped'> {
  if (!lead.email) return 'skipped'
  if (await isSuppressed(supabase, input.clientId, lead.email)) return 'skipped'

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    system: SYSTEM_PROMPT,
    prompt: buildPrompt(input, lead, knowledge),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // Claim the (lead, step 0, outbound) slot BEFORE sending — a retry that finds
  // the slot taken returns null and we never double-send.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: lead.id,
    direction: 'outbound',
    subject: draft.subject,
    body: draft.body,
    status: shouldSendFirstTouch(input.replyMode) ? 'queued' : 'draft',
    sequence_step: FIRST_TOUCH_STEP,
  })
  if (!claimed) return 'skipped'

  if (!shouldSendFirstTouch(input.replyMode)) return 'drafted'

  try {
    const sent = await sendViaMailbox(supabase, {
      clientId: input.clientId,
      mailboxIds: input.mailboxIds,
      to: lead.email,
      subject: draft.subject,
      body: draft.body,
    })
    await markEmailSent(supabase, claimed.id, {
      providerMessageId: sent.providerMessageId,
      threadId: sent.threadId,
      mailboxId: sent.mailboxId,
    })
    const sequence = await createSequence(supabase, {
      client_id: input.clientId,
      case_id: input.caseId,
      lead_id: lead.id,
      current_step: FIRST_TOUCH_STEP,
      state: 'active',
    })
    if (sequence) {
      const messageId = await publishJsonWithDelay(
        '/api/pipeline/followup',
        { sequenceId: sequence.id, step: 1 },
        FOLLOWUP_DELAYS_SECONDS[0]!, // step 1 delay (3d); index 0 always exists
      )
      await supabase
        .from('sequences')
        .update({ qstash_message_id: messageId, next_action_at: null })
        .eq('id', sequence.id)
    }
    return 'sent'
  } catch (error) {
    await markEmailFailed(supabase, claimed.id)
    if (error instanceof AppError && error.code === 'RATE_LIMITED') return 'skipped'
    throw error
  }
}

export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)

  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    const outcome = await processLead(supabase, input, lead, knowledge)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
  }

  await updateCaseStatus(supabase, input.caseId, 'contacted')
  await logEvent({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.write.completed',
    payload: { caseId: input.caseId, sent, drafted, leadCount: leads.length },
  })
  return { caseId: input.caseId, drafted, sent }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/pipeline/write.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "feat: add write pipeline (Gemini draft, reply-mode gate, claim-then-send, sequence start)"
```

---

### Task 14: Write routes + fan-out cron

**Files:**
- Create: `src/app/api/pipeline/write-fanout/route.ts`, `src/app/api/pipeline/write/route.ts`, `scripts/schedule-write-cron.ts`
- Test: `src/app/api/pipeline/write/route.test.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature`, `createAdminClient`, `listCasesByStatus`, `getCaseById`, `updateCaseStatus`, `getCampaignForCase`, `publishJson`, `runWriteForCase`, `apolloIcpSchema` (not needed), `logEvent`, `isAppError`.
- Idempotency: `/api/pipeline/write` transitions `ready → contacted` at entry; not-`ready` no-ops. Within `runWriteForCase`, `claimOutboundEmail` provides per-lead idempotency even across the status window, so a retry cannot double-send.

- [ ] **Step 1: Write the fan-out route**

Create `src/app/api/pipeline/write-fanout/route.ts` (identical shape to research-fanout, but selects `ready` cases and publishes to `/api/pipeline/write`):

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCasesByStatus } from '@/lib/db/cases'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const FANOUT_LIMIT = 200

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const cases = await listCasesByStatus(admin, 'ready', FANOUT_LIMIT)
    const failedCaseIds: string[] = []
    for (const c of cases) {
      try {
        await publishJson('/api/pipeline/write', { caseId: c.id })
      } catch {
        failedCaseIds.push(c.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.write_fanout.completed',
        payload: { caseCount: cases.length, failedCaseIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, caseCount: cases.length, failedCaseIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 2: Write the failing per-case route test**

Create `src/app/api/pipeline/write/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const getCaseByIdMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const runWriteMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/cases', () => ({
  getCaseById: (...a: unknown[]) => getCaseByIdMock(...a),
  updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/pipeline/write', () => ({ runWriteForCase: (...a: unknown[]) => runWriteMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/write', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(JSON.stringify({ caseId: 'case1' }))
  getCaseByIdMock.mockReset(); updateCaseStatusMock.mockReset()
  getCampaignForCaseMock.mockReset(); runWriteMock.mockReset()
})

describe('POST /api/pipeline/write', () => {
  it('should run write when the case is ready', async () => {
    getCaseByIdMock.mockResolvedValue({ id: 'case1', client_id: 'c1', status: 'ready', company_name: 'Acme' })
    getCampaignForCaseMock.mockResolvedValue({
      id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'],
    })
    runWriteMock.mockResolvedValue({ caseId: 'case1', sent: 1, drafted: 0 })
    const res = await POST(req({ caseId: 'case1' }))
    expect(res.status).toBe(200)
    expect(runWriteMock).toHaveBeenCalled()
  })

  it('should skip when the case is not ready', async () => {
    getCaseByIdMock.mockResolvedValue({ id: 'case1', status: 'new' })
    const res = await POST(req({ caseId: 'case1' }))
    const json = await res.json()
    expect(json.skipped).toBe('case_not_ready')
    expect(runWriteMock).not.toHaveBeenCalled()
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req({ caseId: 'case1' }))
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/app/api/pipeline/write/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 4: Write the per-case route**

Create `src/app/api/pipeline/write/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById, updateCaseStatus } from '@/lib/db/cases'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { runWriteForCase } from '@/lib/pipeline/write'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({ caseId: z.string().uuid() })

export async function POST(request: Request) {
  try {
    const rawBody = await verifyQstashSignature(request)
    const { caseId } = bodySchema.parse(JSON.parse(rawBody))
    const admin = createAdminClient()

    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
    if (kase.status !== 'ready') return NextResponse.json({ ok: true, skipped: 'case_not_ready' })

    const campaign = await getCampaignForCase(admin, caseId)
    if (!campaign) return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 })

    // Claim the case so a retried/concurrent fan-out won't re-enter write.
    await updateCaseStatus(admin, caseId, 'contacted')

    const summary = await runWriteForCase(admin, {
      clientId: kase.client_id,
      campaignId: campaign.id,
      caseId,
      replyMode: campaign.reply_mode,
      valueProp: campaign.value_prop,
      bookingLink: campaign.booking_link,
      mailboxIds: campaign.mailbox_ids,
      companyName: kase.company_name,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

> Note: `runWriteForCase` sets the case status to `contacted` again at the end — harmless and idempotent (already `contacted`).

- [ ] **Step 5: Write the cron registration script**

Create `scripts/schedule-write-cron.ts`:

```ts
// One-time setup: registers the QStash daily schedule that fans the writer out
// to every case in status 'ready'. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-write-cron.ts [cron-expression]
// Default cron: "0 8 * * *" (08:00 UTC daily, after research at 07:00).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 8 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/write-fanout', cron)
  process.stdout.write(`Scheduled write-fanout cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run src/app/api/pipeline/write/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 7: Commit**

```bash
git add src/app/api/pipeline/write-fanout src/app/api/pipeline/write scripts/schedule-write-cron.ts
git commit -m "feat: add write fan-out + per-case write route + cron script"
```

---

### Task 15: QStash delay helper + Follow-up sequencer (`src/lib/pipeline/followup.ts`)

**Files:**
- Modify: `src/lib/qstash/client.ts` (add `publishJsonWithDelay`)
- Create: `src/lib/pipeline/followup.ts`
- Test: extend `src/lib/qstash/client.test.ts` (create if absent), create `src/lib/pipeline/followup.test.ts`

**Interfaces:**
- Produces:
  - `publishJsonWithDelay(path: string, body: Record<string, unknown>, delaySeconds: number): Promise<string>`
  - `const FOLLOWUP_DELAYS_SECONDS: readonly number[]` = `[3d, 7d, 14d]` in seconds — index `i` is the delay **before** step `i + 1`.
  - `const MAX_FOLLOWUP_STEP = 3`
  - `interface RunFollowupInput { sequenceId: string; step: number }`
  - `interface FollowupSummary { sequenceId: string; action: 'sent' | 'completed' | 'stopped' | 'skipped' }`
  - `runFollowupStep(supabase, input: RunFollowupInput): Promise<FollowupSummary>`

- [ ] **Step 1: Add `publishJsonWithDelay` to the QStash client**

In `src/lib/qstash/client.ts`, add:

```ts
export async function publishJsonWithDelay(
  path: string,
  body: Record<string, unknown>,
  delaySeconds: number,
): Promise<string> {
  try {
    const res = await client.publishJSON({ url: destination(path), body, delay: delaySeconds })
    return res.messageId
  } catch (cause) {
    throw new AppError('EXTERNAL_ERROR', 'QStash delayed publish failed', {
      path, delaySeconds, cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 2: Write the failing follow-up test**

Create `src/lib/pipeline/followup.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const getSequenceByIdMock = vi.fn()
const hasInboundReplyMock = vi.fn()
const stopSequenceMock = vi.fn()
const advanceSequenceMock = vi.fn()
const getLeadByIdMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const isSuppressedMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateTextMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const publishDelayMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/sequences', () => ({
  getSequenceById: (...a: unknown[]) => getSequenceByIdMock(...a),
  stopSequence: (...a: unknown[]) => stopSequenceMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
}))
vi.mock('@/lib/db/emails', () => ({
  hasInboundReply: (...a: unknown[]) => hasInboundReplyMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ isSuppressed: (...a: unknown[]) => isSuppressedMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { runFollowupStep } from './followup'

const sequence = { id: 'seq1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', current_step: 0, state: 'active' }
const lead = { id: 'lead1', email: 'jane@acme.com', full_name: 'Jane', title: 'CTO' }

beforeEach(() => {
  for (const m of [getSequenceByIdMock, hasInboundReplyMock, stopSequenceMock, advanceSequenceMock,
    getLeadByIdMock, listThreadEmailsMock, claimOutboundEmailMock, markEmailSentMock, markEmailFailedMock,
    isSuppressedMock, sendViaMailboxMock, generateTextMock, getCampaignForCaseMock, updateCaseStatusMock,
    publishDelayMock, logEventMock]) m.mockReset()
  getSequenceByIdMock.mockResolvedValue(sequence)
  hasInboundReplyMock.mockResolvedValue(false)
  getLeadByIdMock.mockResolvedValue(lead)
  isSuppressedMock.mockResolvedValue(false)
  listThreadEmailsMock.mockResolvedValue([
    { direction: 'outbound', subject: 'Quick idea', body: 'Hi', thread_id: 'thr1', provider_message_id: '<a@mail>' },
  ])
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v' })
  generateTextMock.mockResolvedValue('Just following up, Jane.')
})

describe('runFollowupStep', () => {
  it('should send the nudge, advance the step, and enqueue the next follow-up', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('sent')
    expect(advanceSequenceMock).toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalled() // step 2 enqueued
  })

  it('should complete the sequence when a reply exists', async () => {
    hasInboundReplyMock.mockResolvedValue(true)
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('completed')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'completed')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should stop the sequence and mark the case dead after the final step', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e4' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<d@mail>', threadId: 'thr1' })
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 3 })
    expect(result.action).toBe('stopped')
    expect(stopSequenceMock).toHaveBeenCalledWith(expect.anything(), 'seq1', 'stopped')
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'dead')
    expect(publishDelayMock).not.toHaveBeenCalled() // nothing after step 3
  })

  it('should skip when the sequence step no longer matches (stale/duplicate delivery)', async () => {
    getSequenceByIdMock.mockResolvedValue({ ...sequence, current_step: 2 }) // already past step 1
    const result = await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })
    expect(result.action).toBe('skipped')
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/lib/pipeline/followup.test.ts`
Expected: FAIL — cannot find module `./followup`.

- [ ] **Step 4: Write the implementation**

Create `src/lib/pipeline/followup.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { getSequenceById, advanceSequence, stopSequence } from '@/lib/db/sequences'
import {
  hasInboundReply,
  listThreadEmails,
  claimOutboundEmail,
  markEmailSent,
  markEmailFailed,
} from '@/lib/db/emails'
import { getLeadById } from '@/lib/db/leads'
import { isSuppressed } from '@/lib/db/suppressions'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { updateCaseStatus } from '@/lib/db/cases'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { generateText, type LlmCallContext } from '@/lib/llm/client'
import { publishJsonWithDelay } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'

const DAY_SECONDS = 86_400
export const FOLLOWUP_DELAYS_SECONDS: readonly number[] = [3 * DAY_SECONDS, 7 * DAY_SECONDS, 14 * DAY_SECONDS]
export const MAX_FOLLOWUP_STEP = 3
const MAX_OUTPUT_TOKENS = 500
const ACTOR = 'email_writer_agent'

export interface RunFollowupInput {
  sequenceId: string
  step: number
}

export interface FollowupSummary {
  sequenceId: string
  action: 'sent' | 'completed' | 'stopped' | 'skipped'
}

const SYSTEM_PROMPT = [
  'You write a short, polite follow-up nudge to a cold email that got no reply.',
  'Reference the earlier message lightly, add one new angle or question, stay under 60 words.',
  'No pushiness, no bulk markers, no unsubscribe footer.',
].join(' ')

function buildNudgePrompt(
  priorSubject: string,
  priorBody: string,
  valueProp: string | null,
  step: number,
): string {
  return [
    `This is follow-up number ${step} (of ${MAX_FOLLOWUP_STEP}).`,
    `Original subject: ${priorSubject}`,
    `Original message:\n${priorBody}`,
    `Our value proposition: ${valueProp ?? 'n/a'}`,
    'Write only the follow-up body text (no subject line).',
  ].join('\n\n')
}

export async function runFollowupStep(
  supabase: SupabaseClient<Database>,
  input: RunFollowupInput,
): Promise<FollowupSummary> {
  const sequence = await getSequenceById(supabase, input.sequenceId)
  if (!sequence) throw new AppError('NOT_FOUND', 'Sequence not found', { sequenceId: input.sequenceId })

  // Stale/duplicate QStash delivery guard: this message drives step N only when
  // the sequence is still active and sitting at step N-1.
  if (sequence.state !== 'active' || sequence.current_step !== input.step - 1) {
    return { sequenceId: sequence.id, action: 'skipped' }
  }

  // A reply anywhere on the thread ends the sequence.
  if (await hasInboundReply(supabase, sequence.lead_id)) {
    await stopSequence(supabase, sequence.id, 'completed')
    await logEvent({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: 'system',
      type: 'pipeline.followup.completed_on_reply', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'completed' }
  }

  const lead = await getLeadById(supabase, sequence.lead_id)
  if (!lead || !lead.email || (await isSuppressed(supabase, sequence.client_id, lead.email))) {
    await stopSequence(supabase, sequence.id, 'stopped')
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const thread = await listThreadEmails(supabase, sequence.lead_id)
  const firstOutbound = thread.find((e) => e.direction === 'outbound')
  const priorSubject = firstOutbound?.subject ?? 'Following up'
  const replySubject = priorSubject.startsWith('Re: ') ? priorSubject : `Re: ${priorSubject}`
  const threadId = firstOutbound?.thread_id ?? null
  const inReplyTo = thread.at(-1)?.provider_message_id ?? null

  const campaign = await getCampaignForCase(supabase, sequence.case_id)
  const context: LlmCallContext = { clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR }
  const nudgeBody = await generateText(context, {
    system: SYSTEM_PROMPT,
    prompt: buildNudgePrompt(priorSubject, firstOutbound?.body ?? '', campaign?.value_prop ?? null, input.step),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // Claim the (lead, step, outbound) slot before sending — retry-safe.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: sequence.client_id,
    case_id: sequence.case_id,
    lead_id: sequence.lead_id,
    thread_id: threadId,
    direction: 'outbound',
    subject: replySubject,
    body: nudgeBody,
    status: 'queued',
    sequence_step: input.step,
  })
  if (!claimed) return { sequenceId: sequence.id, action: 'skipped' }

  try {
    const sent = await sendViaMailbox(supabase, {
      clientId: sequence.client_id,
      mailboxIds: campaign?.mailbox_ids ?? [],
      to: lead.email,
      subject: replySubject,
      body: nudgeBody,
      threadId,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
    })
    await markEmailSent(supabase, claimed.id, {
      providerMessageId: sent.providerMessageId,
      threadId: sent.threadId,
      mailboxId: sent.mailboxId,
    })
  } catch (error) {
    await markEmailFailed(supabase, claimed.id)
    if (error instanceof AppError && error.code === 'RATE_LIMITED') {
      return { sequenceId: sequence.id, action: 'skipped' }
    }
    throw error
  }

  // Final step? Stop the sequence and mark the case dead. Otherwise advance and
  // enqueue the next delay (index step-1 → step's own delay; step 1 used index 0
  // at first-touch, so step N enqueues index N).
  if (input.step >= MAX_FOLLOWUP_STEP) {
    await advanceSequence(supabase, sequence.id, { currentStep: input.step, nextActionAt: null, qstashMessageId: null })
    await stopSequence(supabase, sequence.id, 'stopped')
    await updateCaseStatus(supabase, sequence.case_id, 'dead')
    await logEvent({
      clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
      type: 'pipeline.followup.exhausted', payload: { sequenceId: sequence.id, step: input.step },
    })
    return { sequenceId: sequence.id, action: 'stopped' }
  }

  const nextStep = input.step + 1
  const messageId = await publishJsonWithDelay(
    '/api/pipeline/followup',
    { sequenceId: sequence.id, step: nextStep },
    FOLLOWUP_DELAYS_SECONDS[input.step]!, // index = current step → delay before nextStep; always in range for step < MAX
  )
  await advanceSequence(supabase, sequence.id, {
    currentStep: input.step,
    nextActionAt: null,
    qstashMessageId: messageId,
  })
  await logEvent({
    clientId: sequence.client_id, caseId: sequence.case_id, actor: ACTOR,
    type: 'pipeline.followup.sent', payload: { sequenceId: sequence.id, step: input.step },
  })
  return { sequenceId: sequence.id, action: 'sent' }
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/pipeline/followup.test.ts src/lib/qstash/client.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/qstash/client.ts src/lib/qstash/client.test.ts src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts
git commit -m "feat: add QStash delayed publish + follow-up sequencer (3/7/14d, reply-cancel, exhaust)"
```

---

### Task 16: Follow-up route

**Files:**
- Create: `src/app/api/pipeline/followup/route.ts`
- Test: `src/app/api/pipeline/followup/route.test.ts`

**Interfaces:**
- Consumes: `verifyQstashSignature`, `createAdminClient`, `runFollowupStep`, `isAppError`.
- Idempotency: entirely inside `runFollowupStep` — the `state === 'active' && current_step === step - 1` guard plus the `claimOutboundEmail` slot make a duplicate QStash delivery a no-op.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/pipeline/followup/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const runFollowupMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/pipeline/followup', () => ({ runFollowupStep: (...a: unknown[]) => runFollowupMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x/api/pipeline/followup', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  verifyMock.mockReset(); runFollowupMock.mockReset()
})

describe('POST /api/pipeline/followup', () => {
  it('should run the follow-up step and return the summary', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: '11111111-1111-1111-1111-111111111111', step: 1 }))
    runFollowupMock.mockResolvedValue({ sequenceId: 's1', action: 'sent' })
    const res = await POST(req({}))
    expect(res.status).toBe(200)
    const json = await res.json()
    expect(json.summary.action).toBe('sent')
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(req({}))
    expect(res.status).toBe(401)
  })

  it('should return 400 when the step is out of range', async () => {
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: '11111111-1111-1111-1111-111111111111', step: 9 }))
    const res = await POST(req({}))
    expect(res.status).toBe(400)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/app/api/pipeline/followup/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 3: Write the route**

Create `src/app/api/pipeline/followup/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { runFollowupStep, MAX_FOLLOWUP_STEP } from '@/lib/pipeline/followup'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const bodySchema = z.object({
  sequenceId: z.string().uuid(),
  step: z.number().int().min(1).max(MAX_FOLLOWUP_STEP),
})

export async function POST(request: Request) {
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsed = bodySchema.safeParse(JSON.parse(rawBody))
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    const admin = createAdminClient()
    const summary = await runFollowupStep(admin, parsed.data)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run src/app/api/pipeline/followup/route.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/app/api/pipeline/followup
git commit -m "feat: add follow-up route (signature-verified, step-validated, delegates to sequencer)"
```

---

### Task 17: Mailbox daily-reset route + cron

**Files:**
- Create: `src/app/api/pipeline/mailbox-reset/route.ts`, `scripts/schedule-mailbox-reset-cron.ts`
- Test: `src/app/api/pipeline/mailbox-reset/route.test.ts`
- Modify: `src/lib/db/mailboxes.ts` (add `resetDailyCounters`)

**Interfaces:**
- Produces: `resetDailyCounters(supabase): Promise<void>` (calls RPC `reset_mailbox_daily_counters`).

- [ ] **Step 1: Add the db helper**

Append to `src/lib/db/mailboxes.ts`:

```ts
export async function resetDailyCounters(supabase: SupabaseClient<Database>): Promise<void> {
  const { error } = await supabase.rpc('reset_mailbox_daily_counters')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to reset mailbox daily counters', { cause: error.message })
  }
}
```

- [ ] **Step 2: Write the failing route test**

Create `src/app/api/pipeline/mailbox-reset/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const resetMock = vi.fn()

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (...a: unknown[]) => verifyMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/mailboxes', () => ({ resetDailyCounters: (...a: unknown[]) => resetMock(...a) }))

import { POST } from './route'

beforeEach(() => { verifyMock.mockReset(); resetMock.mockReset() })

describe('POST /api/pipeline/mailbox-reset', () => {
  it('should reset counters and return ok', async () => {
    verifyMock.mockResolvedValue('{}')
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(200)
    expect(resetMock).toHaveBeenCalled()
  })

  it('should return 401 on invalid signature', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad'))
    const res = await POST(new Request('http://x', { method: 'POST', body: '{}' }))
    expect(res.status).toBe(401)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/app/api/pipeline/mailbox-reset/route.test.ts`
Expected: FAIL — cannot find module `./route`.

- [ ] **Step 4: Write the route + cron script**

Create `src/app/api/pipeline/mailbox-reset/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { resetDailyCounters } from '@/lib/db/mailboxes'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    await resetDailyCounters(admin)
    try {
      await logEvent({ clientId: null, actor: 'system', type: 'mailbox.daily_reset.completed', payload: {} })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

Create `scripts/schedule-mailbox-reset-cron.ts`:

```ts
// One-time setup: registers the QStash daily schedule that resets every
// mailbox's sent_today counter. Run once per environment after deploy:
//   Usage: tsx scripts/schedule-mailbox-reset-cron.ts [cron-expression]
// Default cron: "0 0 * * *" (00:00 UTC daily, before the day's sends).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '0 0 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/mailbox-reset', cron)
  process.stdout.write(`Scheduled mailbox-reset cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/app/api/pipeline/mailbox-reset/route.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/mailbox-reset scripts/schedule-mailbox-reset-cron.ts src/lib/db/mailboxes.ts
git commit -m "feat: add daily mailbox sent_today reset route + cron"
```

---

## Phase 6 — Human-approval UI

**Task 18.** The `/inbox` draft queue (RLS-scoped list) and the approve-and-send Server Action, with all four UI states (loading, error, empty, success).

**Demo:** a `human_approve` (or `hybrid`) campaign's first-touch drafts appear in `/inbox` and send when a human approves them.

---

### Task 18: `/inbox` — draft approval queue

**Files:**
- Create: `src/lib/db/emails.ts` addition `listDraftEmailsForClient`; `src/app/inbox/page.tsx`, `src/app/inbox/loading.tsx`, `src/app/inbox/error.tsx`, `src/app/inbox/draft-row.tsx`, `src/app/inbox/actions.ts`
- Test: extend `src/lib/db/emails.test.ts`; `src/app/inbox/actions.test.ts`

**Interfaces:**
- Consumes: RLS-scoped `createServerClient` (`src/lib/supabase/server.ts`), `requireUser` (`src/lib/auth/require-user.ts`), `sendViaMailbox`, `markEmailSent`, `getCampaignForCase`, `getLeadById`.
- Produces:
  - `listDraftEmailsForClient(supabase): Promise<EmailRow[]>` — RLS-scoped drafts (status `draft`, direction `outbound`).
  - Server Action `approveDraft(formData): Promise<void>` in `src/app/inbox/actions.ts` — validates session, loads the draft, sends via the case's campaign mailboxes, marks it sent, revalidates `/inbox`.

- [ ] **Step 1: Add the draft-list db helper + test**

Append to `src/lib/db/emails.ts`:

```ts
// RLS-scoped: pass a session-bound server client so a client role only sees
// their own drafts. Used by /inbox (human_approve / hybrid queue).
export async function listDraftEmailsForClient(
  supabase: SupabaseClient<Database>,
): Promise<EmailRow[]> {
  const { data, error } = await supabase
    .from('emails')
    .select('*')
    .eq('status', 'draft')
    .eq('direction', 'outbound')
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list draft emails', { cause: error.message })
  }
  return data ?? []
}

export async function getEmailById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<EmailRow | null> {
  const { data, error } = await supabase.from('emails').select('*').eq('id', id).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load email', { id, cause: error.message })
  }
  return data
}
```

Add to `src/lib/db/emails.test.ts`:

```ts
import { listDraftEmailsForClient, getEmailById } from './emails'

function mockDraftList(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ eq: () => ({ order: () => Promise.resolve(result) }) }) }),
    }),
  } as never
}

describe('listDraftEmailsForClient', () => {
  it('should return draft rows when the query succeeds', async () => {
    const rows = [{ id: 'e1', status: 'draft' }]
    expect(await listDraftEmailsForClient(mockDraftList({ data: rows, error: null }))).toEqual(rows)
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      listDraftEmailsForClient(mockDraftList({ data: null, error: { message: 'boom' } })),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Run: `npx vitest run src/lib/db/emails.test.ts`
Expected: PASS (all, including new).

- [ ] **Step 2: Write the failing Server Action test**

Create `src/app/inbox/actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const createServerClientMock = vi.fn()
const getEmailByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const getLeadByIdMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const markEmailSentMock = vi.fn()
const revalidatePathMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/server', () => ({ createServerClient: (...a: unknown[]) => createServerClientMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('next/cache', () => ({ revalidatePath: (...a: unknown[]) => revalidatePathMock(...a) }))

import { approveDraft } from './actions'

function fd(emailId: string) {
  const f = new FormData()
  f.set('emailId', emailId)
  return f
}

beforeEach(() => {
  for (const m of [requireUserMock, createServerClientMock, getEmailByIdMock, getCampaignForCaseMock,
    getLeadByIdMock, sendViaMailboxMock, markEmailSentMock, revalidatePathMock]) m.mockReset()
  requireUserMock.mockResolvedValue({ id: 'user1' })
  createServerClientMock.mockResolvedValue({})
})

describe('approveDraft', () => {
  it('should send the draft via the campaign mailbox and mark it sent', async () => {
    getEmailByIdMock.mockResolvedValue({
      id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
      subject: 's', body: 'b', status: 'draft', direction: 'outbound',
    })
    getLeadByIdMock.mockResolvedValue({ id: 'lead1', email: 'jane@acme.com' })
    getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'] })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    await approveDraft(fd('e1'))
    expect(sendViaMailboxMock).toHaveBeenCalled()
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(revalidatePathMock).toHaveBeenCalledWith('/inbox')
  })

  it('should throw when the email is not a draft', async () => {
    getEmailByIdMock.mockResolvedValue({ id: 'e1', status: 'sent', direction: 'outbound' })
    await expect(approveDraft(fd('e1'))).rejects.toBeTruthy()
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npx vitest run src/app/inbox/actions.test.ts`
Expected: FAIL — cannot find module `./actions`.

- [ ] **Step 4: Write the Server Action**

Create `src/app/inbox/actions.ts`:

```ts
'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getEmailById, markEmailSent } from '@/lib/db/emails'
import { getCampaignForCase } from '@/lib/db/campaigns'
import { getLeadById } from '@/lib/db/leads'
import { sendViaMailbox } from '@/lib/mailbox/sender'
import { AppError } from '@/lib/errors/app-error'

const approveSchema = z.object({ emailId: z.string().uuid() })

export async function approveDraft(formData: FormData): Promise<void> {
  await requireUser()
  const { emailId } = approveSchema.parse({ emailId: formData.get('emailId') })
  const supabase = await createServerClient()

  const email = await getEmailById(supabase, emailId)
  if (!email || email.status !== 'draft' || email.direction !== 'outbound') {
    throw new AppError('VALIDATION_ERROR', 'Email is not an approvable draft', { emailId })
  }
  if (!email.case_id || !email.lead_id || !email.subject || !email.body) {
    throw new AppError('VALIDATION_ERROR', 'Draft is missing required fields', { emailId })
  }

  const lead = await getLeadById(supabase, email.lead_id)
  if (!lead?.email) throw new AppError('VALIDATION_ERROR', 'Lead has no email', { emailId })

  const campaign = await getCampaignForCase(supabase, email.case_id)
  if (!campaign) throw new AppError('NOT_FOUND', 'Campaign not found for case', { emailId })

  const sent = await sendViaMailbox(supabase, {
    clientId: email.client_id,
    mailboxIds: campaign.mailbox_ids,
    to: lead.email,
    subject: email.subject,
    body: email.body,
  })
  await markEmailSent(supabase, email.id, {
    providerMessageId: sent.providerMessageId,
    threadId: sent.threadId,
    mailboxId: sent.mailboxId,
  })
  revalidatePath('/inbox')
}
```

- [ ] **Step 5: Run the action test to verify it passes**

Run: `npx vitest run src/app/inbox/actions.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 6: Write the page + row + loading + error**

Create `src/app/inbox/draft-row.tsx`:

```tsx
'use client'

import { useTransition } from 'react'
import { approveDraft } from './actions'

interface DraftRowProps {
  emailId: string
  subject: string
  body: string
  companyName: string
}

export function DraftRow({ emailId, subject, body, companyName }: DraftRowProps) {
  const [isPending, startTransition] = useTransition()

  const onApprove = () => {
    const formData = new FormData()
    formData.set('emailId', emailId)
    startTransition(() => {
      void approveDraft(formData)
    })
  }

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 16, marginBottom: 12 }}>
      <div style={{ fontSize: 12, color: '#666' }}>{companyName}</div>
      <div style={{ fontWeight: 600, margin: '4px 0' }}>{subject}</div>
      <pre style={{ whiteSpace: 'pre-wrap', fontFamily: 'inherit', margin: '8px 0' }}>{body}</pre>
      <button type="button" onClick={onApprove} disabled={isPending}>
        {isPending ? 'Sending…' : 'Approve & send'}
      </button>
    </div>
  )
}
```

Create `src/app/inbox/page.tsx`:

```tsx
import { createServerClient } from '@/lib/supabase/server'
import { requireUser } from '@/lib/auth/require-user'
import { listDraftEmailsForClient } from '@/lib/db/emails'
import { listCasesWithLeads } from '@/lib/db/crm'
import { DraftRow } from './draft-row'

export default async function InboxPage() {
  await requireUser()
  const supabase = await createServerClient()
  const [drafts, cases] = await Promise.all([
    listDraftEmailsForClient(supabase),
    listCasesWithLeads(supabase),
  ])
  const companyByCaseId = new Map(cases.map((c) => [c.id, c.company_name]))

  if (drafts.length === 0) {
    return (
      <main style={{ padding: 24 }}>
        <h1>Inbox</h1>
        <p>No drafts awaiting approval.</p>
      </main>
    )
  }

  return (
    <main style={{ padding: 24 }}>
      <h1>Inbox</h1>
      <p>{drafts.length} draft(s) awaiting approval.</p>
      {drafts.map((d) => (
        <DraftRow
          key={d.id}
          emailId={d.id}
          subject={d.subject ?? '(no subject)'}
          body={d.body ?? ''}
          companyName={(d.case_id && companyByCaseId.get(d.case_id)) || 'Unknown company'}
        />
      ))}
    </main>
  )
}
```

Create `src/app/inbox/loading.tsx`:

```tsx
export default function Loading() {
  return (
    <main style={{ padding: 24 }}>
      <h1>Inbox</h1>
      <p>Loading drafts…</p>
    </main>
  )
}
```

Create `src/app/inbox/error.tsx`:

```tsx
'use client'

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ padding: 24 }}>
      <h1>Inbox</h1>
      <p>Something went wrong loading your inbox.</p>
      <button type="button" onClick={reset}>Try again</button>
    </main>
  )
}
```

> Match the existing `/crm` and `/settings` pages for the exact `createServerClient`/`requireUser` call signatures (e.g. whether `createServerClient` is awaited). Adjust these two calls to mirror those pages rather than assuming.

- [ ] **Step 7: Verify the build compiles**

Run: `npx tsc --noEmit && npx next build`
Expected: type-check passes and `/inbox` is included in the build output.

- [ ] **Step 8: Commit**

```bash
git add src/lib/db/emails.ts src/lib/db/emails.test.ts src/app/inbox
git commit -m "feat: add /inbox draft-approval queue (RLS list + approve-and-send server action)"
```

---

## Phase 7 — Docs & verification

**Tasks 19–20.** Mark P2 complete in `.claude/roadmap.md`, update the architecture integration table, and run the full suite + type-check + lint + build to green.

---

### Task 19: Docs — roadmap + architecture

**Files:**
- Modify: `.claude/roadmap.md`, `.claude/architecture.md`

- [ ] **Step 1: Mark P2 checkboxes in `.claude/roadmap.md`**

Under `## P2 — Research + Write + Send + Follow-ups`, change each `- [ ]` to `- [x]` and update the heading to note completion, e.g. `## P2 — Research + Write + Send + Follow-ups DONE`. Add a short note under the list:

```markdown
Implemented per `docs/superpowers/plans/2026-07-19-p2-research-write-send-followups.md`:
Research (`/api/pipeline/research`, Brightdata SERP + Gemini dossier → `case_knowledge`),
Writer (`/api/pipeline/write`, reply-mode gate), Mailbox Sender (rotation + atomic cap
claim `claim_mailbox_send` + jitter), Follow-up sequencer (QStash delays 3/7/14d, reply-cancel,
exhaust → case `dead`), `/inbox` draft-approval queue. Idempotency via the
`emails (lead_id, sequence_step, direction)` unique index (claim-then-send) and
per-stage case-status transitions. Crons: research-fanout 07:00, write-fanout 08:00,
mailbox-reset 00:00 UTC.
```

- [ ] **Step 2: Update `.claude/architecture.md` §10 integration table**

In the External Integrations table, update the Brightdata and LLM rows to reflect that they are now implemented:
- Web research row → Interface `src/lib/research/provider.ts` (`WebResearch`), impl `src/lib/research/brightdata.ts`; Swappable: yes.
- LLM row → Interface `src/lib/llm/client.ts` (`generateJson`/`generateText`), Gemini via Vercel AI SDK; Swappable: yes.

- [ ] **Step 3: Commit**

```bash
git add .claude/roadmap.md .claude/architecture.md
git commit -m "docs: mark P2 complete in roadmap; update architecture integration table"
```

---

### Task 20: Full-suite verification

**Files:** none (verification only)

- [ ] **Step 1: Run the whole test suite**

Run: `npx vitest run`
Expected: all suites PASS, no skips.

- [ ] **Step 2: Type-check + lint + build**

Run: `npx tsc --noEmit && npx eslint . && npx next build`
Expected: no type errors, no lint errors, successful build.

- [ ] **Step 3: Coverage on the new units**

Run: `npx vitest run --coverage`
Expected: `src/lib/db/*` P2 modules ≥ 80%; `src/lib/pipeline/*`, `src/lib/llm/client.ts`, `src/lib/research/brightdata.ts`, `src/lib/mailbox/sender.ts` covered by their colocated tests.

- [ ] **Step 4: Final commit (if coverage config or minor fixes changed anything)**

```bash
git add -A
git commit -m "chore: P2 full-suite verification (tests, types, lint, build green)"
```

---

## Post-Implementation Notes (reconcile against live services)

1. **Brightdata SERP shape** (`src/lib/research/brightdata.ts`) — the endpoint URL, auth header, request body, and the `organic[]` response shape are documented-best-guess and parsed defensively. Reconcile the first time a real `BRIGHTDATA_API_KEY` is exercised, same posture as the Apollo client.
2. **AI SDK `usage` fields** (`src/lib/llm/client.ts`) — `readUsage` reads both `inputTokens`/`outputTokens` and `promptTokens`/`completionTokens`. Confirm which the installed `ai` version returns and drop the dead branch if desired.
3. **Outlook threading** (`src/lib/mailbox/outlook-provider.ts`) — threading is best-effort via `internetMessageHeaders`. Verify against a live Graph mailbox that replies actually thread; if not, switch follow-ups to the Graph `/messages/{id}/createReply` flow (needs the stored `provider_message_id` of the prior send).
4. **Gemini model id** (`src/lib/llm/client.ts`) — `gemini-3-flash-preview` is the default; confirm it is enabled on the project's key and that the installed `@ai-sdk/google` version recognizes the model id (a preview id may need a recent SDK version), or adjust `MODEL_ID`.

