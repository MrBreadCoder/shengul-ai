# AI Relevance Filter Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a company-level "last pass" AI relevance filter to the Apollo discovery pipeline — a Gemini call that rejects companies which pass every deterministic filter but are still not a good-fit prospect for the campaign, before an Emailable credit is spent on them.

**Architecture:** A new `generateJson` model override in `src/lib/llm/client.ts` lets one call use a lighter model than the pipeline default. A new `src/lib/pipeline/ai-relevance.ts` module wraps a single Gemini classification call (`checkCompanyRelevance`). `src/lib/pipeline/discover.ts`'s `enrichCandidates` gets a third stage in its existing suppression/exclude-keyword cascade — company-level, cached per discovery run via a `Map` threaded through both search passes — that runs before Emailable and parks (`status: 'parked'`) any lead whose company the AI rejects.

**Tech Stack:** TypeScript (strict), Zod, Vercel AI SDK (`generateObject` via `@ai-sdk/google`, model `gemini-3.1-flash-lite` for this feature specifically), Vitest, Supabase.

**Design doc:** `docs/superpowers/specs/2026-08-06-ai-relevance-filter-design.md` — read it first for the full rationale; this plan implements it task-by-task.

## Global Constraints

- No DB migration — no new columns, no new enum values (`lead_status` already has `'parked'`).
- No new env var — `GEMINI_API_KEY` is already required and loaded via `src/lib/env.ts`.
- Package manager is **pnpm**, not npm — `npm install` corrupts the tree (per `.claude/roadmap.md`).
- `tsconfig` is `strict: true` — no `any`; a `!` non-null assertion is only allowed with a comment proving it's safe.
- Every thrown/returned error carries `code`, `message`, `context` — use `AppError`, never a bare `Error`, at any boundary that isn't already inside a best-effort `try { } catch { }` audit-log wrapper.
- Test files are colocated (`feature.test.ts` next to `feature.ts`), run via Vitest, Arrange-Act-Assert, mock at the boundary (never the module under test).
- No `console.log` anywhere in the changed code.
- Named exports only (this plan touches no Next.js pages/layouts, so no default exports apply).
- After the final task, update `.claude/roadmap.md` under the P1 section to record this shipped (per `CLAUDE.md`: "UPDATE THE `.claude/roadmap.md` EVERY TIME YOU MAKE PROGRESS").
- Commit after every task (not every step) — one commit per task, on the current branch (`master` — this repo does not use feature branches, per `CLAUDE.md`: "dont branch use main").

---

### Task 1: `generateJson` model override

**Files:**
- Modify: `src/lib/llm/client.ts`
- Modify: `src/lib/llm/client.test.ts`

**Interfaces:**
- Produces: `GenerateJsonArgs<T>` gains `modelId?: string`. When set, `generateJson` calls the Google provider with that model id instead of the module default (`MODEL_ID = 'gemini-3-flash-preview'`), and the `llm.completed`/`llm.failed` events it logs record whichever model id actually ran.
- Consumed by: Task 2's `checkCompanyRelevance`, which will pass `modelId: 'gemini-3.1-flash-lite'`.

- [ ] **Step 1: Write the failing tests**

Open `src/lib/llm/client.test.ts`. Find this exact block (the last test inside `describe('generateJson', ...)`, ending with that describe's closing `})`):

```ts
  it('should still log usage and return the object on the file path', async () => {
    generateObjectMock.mockResolvedValue({
      object: { title: 'Acme' },
      usage: { inputTokens: 900, outputTokens: 120 },
    })
    const schema = z.object({ title: z.string() })
    const result = await generateJson(ctx, {
      instructions: 's',
      prompt: 'p',
      schema,
      maxOutputTokens: 100,
      files: [{ data: Buffer.from('x'), mediaType: 'image/png' }],
    })
    expect(result).toEqual({ title: 'Acme' })
    expect(logEventMock).toHaveBeenCalledTimes(1)
  })
})
```

Replace it with (adds four new tests before the closing `})`):

```ts
  it('should still log usage and return the object on the file path', async () => {
    generateObjectMock.mockResolvedValue({
      object: { title: 'Acme' },
      usage: { inputTokens: 900, outputTokens: 120 },
    })
    const schema = z.object({ title: z.string() })
    const result = await generateJson(ctx, {
      instructions: 's',
      prompt: 'p',
      schema,
      maxOutputTokens: 100,
      files: [{ data: Buffer.from('x'), mediaType: 'image/png' }],
    })
    expect(result).toEqual({ title: 'Acme' })
    expect(logEventMock).toHaveBeenCalledTimes(1)
  })

  it('should use the module default model when modelId is omitted', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100 })
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: { modelId: 'gemini-3-flash-preview' } }),
    )
  })

  it('should use the overridden model when modelId is set', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, {
      instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, modelId: 'gemini-3.1-flash-lite',
    })
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: { modelId: 'gemini-3.1-flash-lite' } }),
    )
  })

  it('should log the overridden model id in the usage event, not the module default', async () => {
    generateObjectMock.mockResolvedValue({
      object: { title: 'Acme' },
      usage: { inputTokens: 1, outputTokens: 1 },
    })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, {
      instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, modelId: 'gemini-3.1-flash-lite',
    })
    expect(logEventMock.mock.calls[0]?.[0]).toMatchObject({
      payload: expect.objectContaining({ model: 'gemini-3.1-flash-lite' }),
    })
  })

  it('should log the overridden model id in the failure event, not the module default', async () => {
    generateObjectMock.mockRejectedValue(new Error('model down'))
    const schema = z.object({ title: z.string() })
    await expect(
      generateJson(ctx, {
        instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, modelId: 'gemini-3.1-flash-lite',
      }),
    ).rejects.toBeInstanceOf(AppError)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      payload: expect.objectContaining({ model: 'gemini-3.1-flash-lite' }),
    })
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/llm/client.test.ts`
Expected: the four new tests FAIL (`modelId` is not a recognized property yet / `model` in the mock call is always `{ modelId: 'gemini-3-flash-preview' }` regardless of what's passed) — every other test in the file still passes.

- [ ] **Step 3: Implement the model override**

Open `src/lib/llm/client.ts`. Find:

```ts
async function logUsage(
  context: LlmCallContext,
  usage: unknown,
  durationMs: number,
): Promise<void> {
  const { promptTokens, completionTokens } = readUsage(usage)
  // Safe variant on purpose: the generation already succeeded and its result is
  // about to be returned, so an audit-write failure must not reject the call
  // (and, on a QStash retry, pay for the same generation twice).
  await logEventSafe({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.completed',
    severity: 'info',
    source: 'gemini',
    payload: { model: MODEL_ID, promptTokens, completionTokens, durationMs },
  })
}
```

Replace with:

```ts
async function logUsage(
  context: LlmCallContext,
  modelId: string,
  usage: unknown,
  durationMs: number,
): Promise<void> {
  const { promptTokens, completionTokens } = readUsage(usage)
  // Safe variant on purpose: the generation already succeeded and its result is
  // about to be returned, so an audit-write failure must not reject the call
  // (and, on a QStash retry, pay for the same generation twice).
  await logEventSafe({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.completed',
    severity: 'info',
    source: 'gemini',
    payload: { model: modelId, promptTokens, completionTokens, durationMs },
  })
}
```

Find:

```ts
async function logLlmFailure(
  context: LlmCallContext,
  operation: string,
  cause: unknown,
  durationMs: number,
): Promise<void> {
  await logError({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.failed',
    source: 'gemini',
    error: cause,
    payload: { model: MODEL_ID, operation, durationMs },
  })
}
```

Replace with:

```ts
async function logLlmFailure(
  context: LlmCallContext,
  modelId: string,
  operation: string,
  cause: unknown,
  durationMs: number,
): Promise<void> {
  await logError({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.failed',
    source: 'gemini',
    error: cause,
    payload: { model: modelId, operation, durationMs },
  })
}
```

Find:

```ts
export interface GenerateJsonArgs<T> {
  instructions: string
  prompt: string
  schema: z.ZodType<T>
  maxOutputTokens: number
  timeoutMs?: number
  thinkingLevel?: ThinkingLevel
  files?: readonly LlmFile[]
}

export async function generateJson<T>(
  context: LlmCallContext,
  args: GenerateJsonArgs<T>,
): Promise<T> {
  const startedAt = Date.now()
  try {
    const result = await withTimeout((signal) => {
      const shared = {
        model,
        instructions: args.instructions,
        schema: args.schema,
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: signal,
        providerOptions: providerOptionsFor(args.thinkingLevel),
      }
      // Two explicit calls rather than a spread: the SDK types `prompt` and
      // `messages` as mutually exclusive, and branching keeps the far more
      // common text-only path exactly as it was.
      if (!args.files || args.files.length === 0) {
        return generateObject({ ...shared, prompt: args.prompt })
      }
      return generateObject({
        ...shared,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: args.prompt },
              ...args.files.map((file) => ({
                type: 'file' as const,
                data: file.data,
                mediaType: file.mediaType,
              })),
            ],
          },
        ],
      })
    }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    await logUsage(context, result.usage, Date.now() - startedAt)
    return result.object
  } catch (cause) {
    await logLlmFailure(context, 'generateObject', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateObject failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

Replace with:

```ts
export interface GenerateJsonArgs<T> {
  instructions: string
  prompt: string
  schema: z.ZodType<T>
  maxOutputTokens: number
  timeoutMs?: number
  thinkingLevel?: ThinkingLevel
  files?: readonly LlmFile[]
  /**
   * Overrides the module default (MODEL_ID) for this call only — e.g. a
   * lighter/cheaper model for a high-volume, low-complexity classification
   * that doesn't need the default model's full capability.
   */
  modelId?: string
}

export async function generateJson<T>(
  context: LlmCallContext,
  args: GenerateJsonArgs<T>,
): Promise<T> {
  const startedAt = Date.now()
  const resolvedModelId = args.modelId ?? MODEL_ID
  const resolvedModel = args.modelId ? google(args.modelId) : model
  try {
    const result = await withTimeout((signal) => {
      const shared = {
        model: resolvedModel,
        instructions: args.instructions,
        schema: args.schema,
        maxOutputTokens: args.maxOutputTokens,
        abortSignal: signal,
        providerOptions: providerOptionsFor(args.thinkingLevel),
      }
      // Two explicit calls rather than a spread: the SDK types `prompt` and
      // `messages` as mutually exclusive, and branching keeps the far more
      // common text-only path exactly as it was.
      if (!args.files || args.files.length === 0) {
        return generateObject({ ...shared, prompt: args.prompt })
      }
      return generateObject({
        ...shared,
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: args.prompt },
              ...args.files.map((file) => ({
                type: 'file' as const,
                data: file.data,
                mediaType: file.mediaType,
              })),
            ],
          },
        ],
      })
    }, args.timeoutMs ?? DEFAULT_TIMEOUT_MS)
    await logUsage(context, resolvedModelId, result.usage, Date.now() - startedAt)
    return result.object
  } catch (cause) {
    await logLlmFailure(context, resolvedModelId, 'generateObject', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateObject failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

Now update the two other callers of `logUsage`/`logLlmFailure` so they keep their current (unchanged) behavior explicitly. Find, inside `generateText`:

```ts
    await logUsage(context, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    await logLlmFailure(context, 'generateText', cause, Date.now() - startedAt)
```

Replace with:

```ts
    await logUsage(context, MODEL_ID, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    await logLlmFailure(context, MODEL_ID, 'generateText', cause, Date.now() - startedAt)
```

Find, inside `generateWithTools`:

```ts
    await logUsage(context, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    await logLlmFailure(context, 'generateWithTools', cause, Date.now() - startedAt)
```

Replace with:

```ts
    await logUsage(context, MODEL_ID, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    await logLlmFailure(context, MODEL_ID, 'generateWithTools', cause, Date.now() - startedAt)
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/llm/client.test.ts`
Expected: PASS — all tests in the file, including the four new ones.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/client.ts src/lib/llm/client.test.ts
git commit -m "feat(llm): let generateJson override the default Gemini model per call

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: `checkCompanyRelevance` module

**Files:**
- Create: `src/lib/pipeline/ai-relevance.ts`
- Create: `src/lib/pipeline/ai-relevance.test.ts`

**Interfaces:**
- Consumes: `generateJson`, `type LlmCallContext` from `@/lib/llm/client` (Task 1's `modelId` field); `type CompanyFirmographics` from `@/lib/apollo/format-company-summary`.
- Produces (used by Task 4): `RelevanceVerdict = { pass: boolean; reason: string }`, `CompanySnapshot extends CompanyFirmographics { companyName: string | null; companyDomain: string | null }`, `CampaignRelevanceContext = { name: string; valueProp: string | null; keywords: string[]; excludeKeywords: string[] }`, and `checkCompanyRelevance(context: LlmCallContext, campaign: CampaignRelevanceContext, company: CompanySnapshot): Promise<RelevanceVerdict>`.

- [ ] **Step 1: Write the failing tests**

Create `src/lib/pipeline/ai-relevance.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGenerateJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/llm/client', () => ({ generateJson: mockGenerateJson }))

import { checkCompanyRelevance, type CampaignRelevanceContext, type CompanySnapshot } from './ai-relevance'

const context = { clientId: 'client1', actor: 'system' }

const campaign: CampaignRelevanceContext = {
  name: 'School Outreach',
  valueProp: 'We help schools hire faster.',
  keywords: ['private school'],
  excludeKeywords: ['staffing agency'],
}

const company: CompanySnapshot = {
  companyName: 'Acme Academy',
  companyDomain: 'acmeacademy.edu',
  industry: 'Education',
  employeeCount: 120,
  foundedYear: 1998,
  description: 'A K-12 private school.',
  city: 'Austin',
  state: 'TX',
  country: 'US',
}

describe('checkCompanyRelevance', () => {
  beforeEach(() => {
    mockGenerateJson.mockReset()
  })

  it('should return the model verdict when it approves', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'Matches target: K-12 private school.' })
    const verdict = await checkCompanyRelevance(context, campaign, company)
    expect(verdict).toEqual({ pass: true, reason: 'Matches target: K-12 private school.' })
  })

  it('should return the model verdict when it rejects', async () => {
    mockGenerateJson.mockResolvedValue({ pass: false, reason: 'This is a staffing agency, not a school.' })
    const verdict = await checkCompanyRelevance(context, campaign, company)
    expect(verdict).toEqual({ pass: false, reason: 'This is a staffing agency, not a school.' })
  })

  it('should propagate an error when generateJson throws', async () => {
    mockGenerateJson.mockRejectedValue(new Error('gemini down'))
    await expect(checkCompanyRelevance(context, campaign, company)).rejects.toThrow('gemini down')
  })

  it('should call generateJson with the lite model id and the caller-supplied context', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    expect(mockGenerateJson).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ modelId: 'gemini-3.1-flash-lite' }),
    )
  })

  it('should cap maxOutputTokens for a small classification response', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { maxOutputTokens: number }
    expect(call.maxOutputTokens).toBeLessThanOrEqual(200)
  })

  it('should include the campaign name, value prop, keywords, exclude keywords, and company firmographics in the prompt', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { prompt: string }
    expect(call.prompt).toContain('School Outreach')
    expect(call.prompt).toContain('We help schools hire faster.')
    expect(call.prompt).toContain('private school')
    expect(call.prompt).toContain('staffing agency')
    expect(call.prompt).toContain('Acme Academy')
    expect(call.prompt).toContain('acmeacademy.edu')
    expect(call.prompt).toContain('Education')
    expect(call.prompt).toContain('120')
    expect(call.prompt).toContain('1998')
    expect(call.prompt).toContain('K-12 private school')
    expect(call.prompt).toContain('Austin')
  })

  it('should omit null company firmographic fields from the prompt instead of printing "null"', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    const sparseCompany: CompanySnapshot = {
      companyName: 'Acme',
      companyDomain: null,
      industry: null,
      employeeCount: null,
      foundedYear: null,
      description: null,
      city: null,
      state: null,
      country: null,
    }
    await checkCompanyRelevance(context, campaign, sparseCompany)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { prompt: string }
    expect(call.prompt).not.toContain('null')
    expect(call.prompt).toContain('Acme')
  })

  it('should omit the keyword lines from the prompt when the campaign has none', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    const noKeywordCampaign: CampaignRelevanceContext = {
      name: 'Generic Outreach', valueProp: null, keywords: [], excludeKeywords: [],
    }
    await checkCompanyRelevance(context, noKeywordCampaign, company)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { prompt: string }
    expect(call.prompt).not.toContain('Target keywords')
    expect(call.prompt).not.toContain('Excluded keywords')
    expect(call.prompt).not.toContain('Value proposition')
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/ai-relevance.test.ts`
Expected: FAIL — `Cannot find module './ai-relevance'` (the file doesn't exist yet).

- [ ] **Step 3: Implement `ai-relevance.ts`**

Create `src/lib/pipeline/ai-relevance.ts`:

```ts
import { z } from 'zod'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import type { CompanyFirmographics } from '@/lib/apollo/format-company-summary'

// A lighter/cheaper model than the pipeline's shared default
// (gemini-3-flash-preview, see src/lib/llm/client.ts) — this check can run
// once per distinct new company on every active campaign's every discovery
// run, and a single yes/no classification doesn't need the default model's
// full capability.
const AI_RELEVANCE_MODEL_ID = 'gemini-3.1-flash-lite'

// The schema is tiny (a bool + a short reason), so a small ceiling keeps
// latency down without risking truncation.
const MAX_OUTPUT_TOKENS = 200
const REASON_MAX_LENGTH = 300

export interface RelevanceVerdict {
  pass: boolean
  reason: string
}

export interface CompanySnapshot extends CompanyFirmographics {
  companyName: string | null
  companyDomain: string | null
}

// Narrow view of a campaign this module needs — deliberately not
// CampaignForDiscovery (defined in ./discover) to avoid a circular import
// between the two pipeline modules.
export interface CampaignRelevanceContext {
  name: string
  valueProp: string | null
  keywords: string[]
  excludeKeywords: string[]
}

const relevanceVerdictSchema = z.object({
  pass: z.boolean(),
  reason: z.string().min(1).max(REASON_MAX_LENGTH),
})

const INSTRUCTIONS = [
  'You are a lead-qualification judge for a B2B outreach campaign.',
  "Given the campaign's target description and one company's firmographics,",
  'decide whether this company is a genuine, relevant prospect for the',
  'campaign — not a wrong-industry, wrong-business-type, or clearly-unrelated',
  'match. Reject only when the mismatch is clear from the given data. When',
  'the data is ambiguous or incomplete, pass.',
].join(' ')

function formatField(label: string, value: string | number | null): string | null {
  if (value === null) return null
  return `${label}: ${value}`
}

function buildPrompt(campaign: CampaignRelevanceContext, company: CompanySnapshot): string {
  const campaignLines = [
    `Campaign name: ${campaign.name}`,
    formatField('Value proposition', campaign.valueProp),
    campaign.keywords.length > 0 ? `Target keywords: ${campaign.keywords.join(', ')}` : null,
    campaign.excludeKeywords.length > 0 ? `Excluded keywords: ${campaign.excludeKeywords.join(', ')}` : null,
  ].filter((line): line is string => line !== null)

  const companyLines = [
    `Company name: ${company.companyName ?? 'Unknown'}`,
    formatField('Domain', company.companyDomain),
    formatField('Industry', company.industry),
    formatField('Employee count', company.employeeCount),
    formatField('Founded year', company.foundedYear),
    formatField('Description', company.description),
    formatField('City', company.city),
    formatField('State', company.state),
    formatField('Country', company.country),
  ].filter((line): line is string => line !== null)

  return [
    'Campaign:',
    ...campaignLines,
    '',
    'Company:',
    ...companyLines,
    '',
    'Is this company a relevant prospect for this campaign?',
  ].join('\n')
}

/**
 * Judges whether one company is a relevant prospect for a campaign, given the
 * campaign's own targeting fields and the company's Apollo firmographics.
 * Company-level only — deliberately does not take a lead's title, so the
 * caller can cache one verdict per company and reuse it for every contact
 * discovered there in the same run (see src/lib/pipeline/discover.ts).
 */
export async function checkCompanyRelevance(
  context: LlmCallContext,
  campaign: CampaignRelevanceContext,
  company: CompanySnapshot,
): Promise<RelevanceVerdict> {
  return generateJson(context, {
    instructions: INSTRUCTIONS,
    prompt: buildPrompt(campaign, company),
    schema: relevanceVerdictSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    modelId: AI_RELEVANCE_MODEL_ID,
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/pipeline/ai-relevance.test.ts`
Expected: PASS — all tests.

- [ ] **Step 5: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/ai-relevance.ts src/lib/pipeline/ai-relevance.test.ts
git commit -m "feat(pipeline): add checkCompanyRelevance AI relevance judge

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Thread campaign name/valueProp through `CampaignForDiscovery`

**Files:**
- Modify: `src/lib/pipeline/discover.ts:29-34`
- Modify: `src/app/api/pipeline/discover/route.ts:37-42`
- Modify: `src/lib/pipeline/discover.test.ts` (fixture threading, mechanical)

**Interfaces:**
- Produces (used by Task 4): `CampaignForDiscovery` gains `name: string` and `valueProp: string | null`, sourced from `campaigns.name` / `campaigns.value_prop` (both already exist on `CampaignRow`, no migration).

This task has no new behavior of its own (the two new fields aren't read anywhere yet — Task 4 reads them) — its deliverable is "the codebase still compiles and every existing test still passes with the new required fields threaded through," which is why there's no new failing test to write first here.

- [ ] **Step 1: Widen the type**

Open `src/lib/pipeline/discover.ts`. Find:

```ts
export interface CampaignForDiscovery {
  id: string
  clientId: string
  dailyTarget: number
  icp: ApolloIcpFilters
}
```

Replace with:

```ts
export interface CampaignForDiscovery {
  id: string
  clientId: string
  /** Campaign display name — part of the context handed to the AI relevance filter (see ai-relevance.ts). */
  name: string
  /** Campaign value proposition — same purpose as `name` above. Nullable: not every campaign has one set. */
  valueProp: string | null
  dailyTarget: number
  icp: ApolloIcpFilters
}
```

- [ ] **Step 2: Update the production call site**

Open `src/app/api/pipeline/discover/route.ts`. Find:

```ts
    const icp = apolloIcpSchema.parse(campaign.icp)
    const summary = await runDiscoveryForCampaign(admin, {
      id: campaign.id,
      clientId: campaign.client_id,
      dailyTarget: campaign.daily_target,
      icp,
    })
```

Replace with:

```ts
    const icp = apolloIcpSchema.parse(campaign.icp)
    const summary = await runDiscoveryForCampaign(admin, {
      id: campaign.id,
      clientId: campaign.client_id,
      name: campaign.name,
      valueProp: campaign.value_prop,
      dailyTarget: campaign.daily_target,
      icp,
    })
```

- [ ] **Step 3: Update every test fixture in one pass**

Every one of the 39 `runDiscoveryForCampaign` call sites in `src/lib/pipeline/discover.test.ts` constructs its campaign argument starting with the exact literal text `id: 'camp1', clientId: 'client1',`. Run this from the repo root:

```bash
sed -i '' "s/id: 'camp1', clientId: 'client1',/id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.',/g" src/lib/pipeline/discover.test.ts
```

(macOS `sed` requires the empty `-i ''`; on Linux use `sed -i` with no argument after it.)

- [ ] **Step 4: Verify the substitution landed everywhere**

Run: `grep -c "id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.'," src/lib/pipeline/discover.test.ts`
Expected: `39`

Run: `grep -c "id: 'camp1', clientId: 'client1'," src/lib/pipeline/discover.test.ts`
Expected: `0` (no un-substituted occurrences left)

- [ ] **Step 5: Run the full existing test suite for this file**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — every existing test still passes (this task changes types/fixtures only, no behavior).

- [ ] **Step 6: Type-check**

Run: `pnpm tsc --noEmit`
Expected: no errors (this is the step that actually proves every call site — production and test — was updated; a missed one fails here with "Property 'name' is missing").

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/discover.ts src/app/api/pipeline/discover/route.ts src/lib/pipeline/discover.test.ts
git commit -m "refactor(pipeline): thread campaign name/valueProp into CampaignForDiscovery

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: Wire the AI relevance filter into `discover.ts`

**Files:**
- Modify: `src/lib/pipeline/discover.ts`
- Modify: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `checkCompanyRelevance`, `RelevanceVerdict`, `CampaignRelevanceContext`, `CompanySnapshot` from `./ai-relevance` (Task 2); `name`/`valueProp` on `CampaignForDiscovery` (Task 3).
- Produces: `DiscoverySummary` gains `aiChecked: number`, `aiRejected: number`, `aiFailedOpen: number`. New event types `pipeline.discover.ai_rejected` (`payload: { campaignId, leadSourceId, companyKey, reason }`) and `pipeline.discover.ai_check_failed` (`payload: { campaignId, companyKey, error }`).

- [ ] **Step 1: Write the failing tests**

Open `src/lib/pipeline/discover.test.ts`. Find:

```ts
const mockVerifyEmail = vi.hoisted(() => vi.fn())
const mockGetSuppressions = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apollo/client', () => ({ searchPeople: mockSearchPeople, bulkMatchPeople: mockBulkMatchPeople }))
```

Replace with:

```ts
const mockVerifyEmail = vi.hoisted(() => vi.fn())
const mockGetSuppressions = vi.hoisted(() => vi.fn())
const mockCheckCompanyRelevance = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apollo/client', () => ({ searchPeople: mockSearchPeople, bulkMatchPeople: mockBulkMatchPeople }))
```

Find:

```ts
vi.mock('@/lib/db/suppressions', () => ({ getSuppressions: mockGetSuppressions }))

import { runDiscoveryForCampaign } from './discover'
```

Replace with:

```ts
vi.mock('@/lib/db/suppressions', () => ({ getSuppressions: mockGetSuppressions }))
vi.mock('./ai-relevance', () => ({ checkCompanyRelevance: mockCheckCompanyRelevance }))

import { runDiscoveryForCampaign } from './discover'
```

Find:

```ts
function verification(state: string) {
  return { state, reason: 'x', email: 'jo@acme.com', score: state === 'deliverable' ? 100 : 10 }
}

describe('runDiscoveryForCampaign', () => {
```

Replace with:

```ts
function verification(state: string) {
  return { state, reason: 'x', email: 'jo@acme.com', score: state === 'deliverable' ? 100 : 10 }
}

// Every test in this file exercises a code path that may reach the AI
// relevance check (it runs on any row eligible for Emailable, which is most
// rows in most tests here) — default it to an unconditional pass, once, at
// the file level, so tests that don't care about AI relevance behavior don't
// have to configure it individually. The dedicated 'AI relevance filter'
// describe block below overrides this per-test with
// mockResolvedValueOnce/mockRejectedValueOnce. Root-level beforeEach hooks
// run before every nested describe's own beforeEach, so this always applies
// first.
beforeEach(() => {
  mockCheckCompanyRelevance.mockReset()
  mockCheckCompanyRelevance.mockResolvedValue({ pass: true, reason: 'ai default pass' })
})

describe('runDiscoveryForCampaign', () => {
```

Now add the new describe block. Find the very end of the file:

```ts
    const pass2SecondCallParams = mockSearchPeople.mock.calls[3]![0] as Record<string, string | string[]>
    expect(pass2SecondCallParams).toMatchObject({ q_keywords: 'academy', 'q_organization_domains_list[]': ['acme.com'] })
    expect(summary.secondPassCandidates).toBe(1)
  })
})
```

Replace with (adds a new top-level describe block after the existing one closes):

```ts
    const pass2SecondCallParams = mockSearchPeople.mock.calls[3]![0] as Record<string, string | string[]>
    expect(pass2SecondCallParams).toMatchObject({ q_keywords: 'academy', 'q_organization_domains_list[]': ['acme.com'] })
    expect(summary.secondPassCandidates).toBe(1)
  })
})

describe('runDiscoveryForCampaign — AI relevance filter', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGroupVerifiedLead.mockResolvedValue('case1')
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  function singleCandidateRun() {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
  }

  it('should park a lead the AI rejects, without calling Emailable, and never group it', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockResolvedValueOnce({ pass: false, reason: 'Wrong industry for this campaign.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ email_status: 'verified', status: 'parked' })
    expect(summary.aiChecked).toBe(1)
    expect(summary.aiRejected).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it('should log a pipeline.discover.ai_rejected event with the model reason', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockResolvedValueOnce({ pass: false, reason: 'Wrong industry for this campaign.' })

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.ai_rejected',
      source: 'pipeline',
      payload: expect.objectContaining({
        campaignId: 'camp1', leadSourceId: 'p1', companyKey: 'acme.com', reason: 'Wrong industry for this campaign.',
      }),
    }))
  })

  it('should still activate and group a lead the AI approves', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockResolvedValueOnce({ pass: true, reason: 'Matches target profile.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.aiChecked).toBe(1)
    expect(summary.aiRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should call checkCompanyRelevance only once for two eligible rows at the same company in one run', async () => {
    // Mirrors the very first test in this file: pass 1 finds a brand-new
    // company (p1 @ acme.com), it verifies this run, so pass 2 targets
    // acme.com for a second contact (p5) — both share a company_key within
    // one discovery run, the exact scenario the cache exists for.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] }) // pass 1, page 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: stop
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // pass 2: second contact
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockCheckCompanyRelevance.mockResolvedValue({ pass: true, reason: 'Matches target profile.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, icp },
    )

    expect(mockCheckCompanyRelevance).toHaveBeenCalledTimes(1)
    expect(summary.aiChecked).toBe(2)
    expect(summary.secondPassCandidates).toBe(1)
  })

  it('should not call checkCompanyRelevance for a lead already parked by suppression', async () => {
    singleCandidateRun()
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockCheckCompanyRelevance).not.toHaveBeenCalled()
    expect(summary.aiChecked).toBe(0)
  })

  it('should not call checkCompanyRelevance for a lead Apollo did not mark verified', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'unverified')),
    )

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockCheckCompanyRelevance).not.toHaveBeenCalled()
    expect(summary.aiChecked).toBe(0)
  })

  it('should fail open and still activate the lead when the AI check throws', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockRejectedValueOnce(new Error('gemini down'))

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.aiFailedOpen).toBe(1)
    expect(summary.aiRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should log a pipeline.discover.ai_check_failed event when the AI check throws', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockRejectedValueOnce(new Error('gemini down'))

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, icp },
    )

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.ai_check_failed',
      source: 'pipeline',
      payload: expect.objectContaining({ campaignId: 'camp1', companyKey: 'acme.com', error: 'gemini down' }),
    }))
  })

  it('should pass the campaign name, value prop, and ICP keywords to checkCompanyRelevance', async () => {
    singleCandidateRun()
    const keywordIcp: ApolloIcpFilters = { ...icp, keywords: ['private school'], excludeKeywords: ['staffing'] }

    await runDiscoveryForCampaign(
      {} as never,
      {
        id: 'camp1', clientId: 'client1', name: 'School Outreach', valueProp: 'We help schools hire.',
        dailyTarget: 2, icp: keywordIcp,
      },
    )

    expect(mockCheckCompanyRelevance).toHaveBeenCalledWith(
      { clientId: 'client1', actor: 'system' },
      { name: 'School Outreach', valueProp: 'We help schools hire.', keywords: ['private school'], excludeKeywords: ['staffing'] },
      expect.objectContaining({ companyName: 'Acme', companyDomain: 'acme.com' }),
    )
  })
})
```

- [ ] **Step 2: Run the tests to verify the new ones fail**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — the new `'AI relevance filter'` describe block's tests fail (`summary.aiChecked` is `undefined`, `mockCheckCompanyRelevance` is never called, `pipeline.discover.ai_rejected` is never logged). Every pre-existing test in the file should still PASS unchanged (the default-pass `beforeEach` you just added keeps their behavior identical).

- [ ] **Step 3: Implement the AI relevance stage in `discover.ts`**

Open `src/lib/pipeline/discover.ts`. Find:

```ts
import { groupVerifiedLead, computeCompanyKey } from './group-lead'
```

Replace with:

```ts
import { groupVerifiedLead, computeCompanyKey } from './group-lead'
import { checkCompanyRelevance, type RelevanceVerdict, type CampaignRelevanceContext, type CompanySnapshot } from './ai-relevance'
```

Find:

```ts
// Emailable allows 25 req/s on /v1/verify. Five in flight keeps us an order of
// magnitude under that with no token bucket, and a 429 would signal a bug
// rather than normal load.
const VERIFY_CONCURRENCY = 5
```

Replace with:

```ts
// Emailable allows 25 req/s on /v1/verify. Five in flight keeps us an order of
// magnitude under that with no token bucket, and a 429 would signal a bug
// rather than normal load.
const VERIFY_CONCURRENCY = 5

// Same conservative-default reasoning as VERIFY_CONCURRENCY: not tuned to a
// documented Gemini RPM ceiling, just a sane number of in-flight relevance
// checks per enrich batch.
const AI_RELEVANCE_CONCURRENCY = 5
```

Find:

```ts
  /** Apollo-verified leads parked without an Emailable call: matched an exclude keyword post-enrich. */
  excludedPostEnrich: number
  inserted: number
}
```

Replace with:

```ts
  /** Apollo-verified leads parked without an Emailable call: matched an exclude keyword post-enrich. */
  excludedPostEnrich: number
  /** Rows evaluated against the AI relevance filter (cache hits included). */
  aiChecked: number
  /** Rows parked because the AI relevance filter rejected their company. */
  aiRejected: number
  /** Rows that passed through unaffected because the AI relevance check itself failed (timeout/error). */
  aiFailedOpen: number
  inserted: number
}
```

Find:

```ts
async function logDiscoveryFilterEvent(
  campaign: CampaignForDiscovery,
  type: 'pipeline.discover.suppressed_skipped' | 'pipeline.discover.excluded_post_enrich',
  leadSourceId: string,
  companyKey: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type,
      source: 'pipeline',
      payload: { campaignId: campaign.id, leadSourceId, companyKey },
    })
  } catch {
    // Audit logging is best-effort.
  }
}
```

Replace with:

```ts
async function logDiscoveryFilterEvent(
  campaign: CampaignForDiscovery,
  type: 'pipeline.discover.suppressed_skipped' | 'pipeline.discover.excluded_post_enrich',
  leadSourceId: string,
  companyKey: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type,
      source: 'pipeline',
      payload: { campaignId: campaign.id, leadSourceId, companyKey },
    })
  } catch {
    // Audit logging is best-effort.
  }
}

// Separate from logDiscoveryFilterEvent above because this payload carries
// the model's own reason string, not just the (leadSourceId, companyKey)
// pair the other two filter events share.
async function logAiRejectedEvent(
  campaign: CampaignForDiscovery,
  leadSourceId: string,
  companyKey: string,
  reason: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type: 'pipeline.discover.ai_rejected',
      source: 'pipeline',
      payload: { campaignId: campaign.id, leadSourceId, companyKey, reason },
    })
  } catch {
    // Audit logging is best-effort.
  }
}

// Company-level, not lead-level (no leadSourceId) — the AI check itself is
// evaluated per company_key, so a failure is a company-level event even
// though it fail-opens every eligible row at that company.
async function logAiCheckFailedEvent(
  campaign: CampaignForDiscovery,
  companyKey: string,
  error: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type: 'pipeline.discover.ai_check_failed',
      source: 'pipeline',
      payload: { campaignId: campaign.id, companyKey, error },
    })
  } catch {
    // Audit logging is best-effort.
  }
}
```

Find:

```ts
interface EnrichResult {
  rows: LeadInsert[]
  /** Rows that ended at `status: 'active'` — i.e. actually cleared to send. */
  verifiedCount: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  suppressedSkipped: number
  excludedPostEnrich: number
}
```

Replace with:

```ts
interface EnrichResult {
  rows: LeadInsert[]
  /** Rows that ended at `status: 'active'` — i.e. actually cleared to send. */
  verifiedCount: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  suppressedSkipped: number
  excludedPostEnrich: number
  aiChecked: number
  aiRejected: number
  aiFailedOpen: number
}

// Mirrors verifyBatch's own inline eligibility check (email_status ===
// 'verified', not already parked upstream, has a real email) — kept as a
// standalone helper rather than refactored into verifyBatch itself, so this
// change doesn't touch that function's already-tested internals. A row that
// could never reach `active` regardless of company relevance isn't worth an
// AI call either.
function isVerifiableRow(row: LeadInsert, skipVerification: Set<string>): boolean {
  if (row.email_status !== 'verified') return false
  if (row.source_id && skipVerification.has(row.source_id)) return false
  return typeof row.email === 'string' && row.email.length > 0
}
```

Now replace the whole `enrichCandidates` function. Find:

```ts
async function enrichCandidates(
  candidates: FreshCandidate[],
  campaign: CampaignForDiscovery,
  supabase: SupabaseClient<Database>,
): Promise<EnrichResult> {
  const { icp } = campaign
  const rows: LeadInsert[] = []
  let verifiedCount = 0
  let emailableChecked = 0
  let emailableDeliverable = 0
  let emailableRejected = 0
  let emailableFailedOpen = 0
  let suppressedSkipped = 0
  let excludedPostEnrich = 0

  for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + ENRICH_BATCH_SIZE)
    const enrichedPeople = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.enrich.failed', { batchSize: batch.length }),
      () =>
        withRetry(() =>
          bulkMatchPeople(
            batch.map((c) => ({
              id: c.apolloId,
              organizationName: c.organizationName ?? undefined,
              domain: c.organizationDomain ?? undefined,
              linkedinUrl: c.linkedinUrl ?? undefined,
            })),
          ),
        ),
    )

    const batchRows: LeadInsert[] = []
    // Apollo person ids parked without ever reaching Emailable — either the
    // post-enrich exclude-keyword check below matched, or the suppression
    // check further down matched. Apollo's raw email_status stays on the row
    // untouched (it may still read 'verified' — that is Apollo's true
    // verdict, not a lie), but `status` is forced to 'parked' so nothing
    // downstream mistakes these for send-eligible. `status`, not
    // `email_status`, is what every caller below and in
    // runDiscoveryForCampaign now checks for exactly this reason.
    const skipVerification = new Set<string>()

    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      const title = person.title ?? source?.title ?? null
      const companyName = person.organizationName ?? source?.organizationName ?? null
      const companyDomain = person.organizationDomain ?? source?.organizationDomain ?? null

      // Post-enrich exclude check: catches companies the pre-enrich pass-1/
      // pass-2 title+org-name check couldn't see, because industry and
      // description only exist after this enrich call.
      if (
        matchesExcludedKeywords(
          {
            title,
            organizationName: companyName,
            organizationIndustry: person.organizationIndustry,
            organizationDescription: person.organizationDescription,
          },
          icp.excludeKeywords,
        )
      ) {
        skipVerification.add(person.apolloId)
        excludedPostEnrich += 1
        await logDiscoveryFilterEvent(
          campaign,
          'pipeline.discover.excluded_post_enrich',
          person.apolloId,
          computeCompanyKey(companyDomain, companyName),
        )
      }

      batchRows.push({
        client_id: campaign.clientId,
        campaign_id: campaign.id,
        source_id: person.apolloId,
        full_name: fullName,
        title,
        company_name: companyName,
        company_domain: companyDomain,
        linkedin_url: person.linkedinUrl ?? source?.linkedinUrl ?? null,
        source: 'apollo',
        raw: { ...person },
        email: person.email,
        email_status: emailStatus,
        email_verified_at: null,
        status: 'parked',
        email_verification: null,
      })
    }

    // Suppression check: one bulk lookup per batch, client-scoped, for every
    // row not already parked above — a contact who already bounced or
    // unsubscribed for this client must never reach Emailable spend or case
    // grouping, no matter which campaign rediscovers them.
    const emailsToCheck = batchRows
      .filter((row) => row.source_id != null && !skipVerification.has(row.source_id))
      .map((row) => row.email)
      .filter((email): email is string => typeof email === 'string' && email.length > 0)
    if (emailsToCheck.length > 0) {
      const suppressed = await getSuppressions(supabase, campaign.clientId, emailsToCheck)
      for (const row of batchRows) {
        if (row.source_id && row.email && suppressed.has(row.email.trim().toLowerCase())) {
          skipVerification.add(row.source_id)
          suppressedSkipped += 1
          await logDiscoveryFilterEvent(
            campaign,
            'pipeline.discover.suppressed_skipped',
            row.source_id,
            computeCompanyKey(row.company_domain ?? null, row.company_name ?? null),
          )
        }
      }
    }

    // The deliverability guard, not Apollo, has the final say on activation —
    // for every row not already parked above.
    const verified = await verifyBatch(campaign, batchRows, skipVerification)
    emailableChecked += verified.checked
    emailableDeliverable += verified.deliverable
    emailableRejected += verified.rejected
    emailableFailedOpen += verified.failedOpen
    for (const row of verified.rows) {
      if (row.status === 'active') verifiedCount += 1
      rows.push(row)
    }
  }

  return {
    rows,
    verifiedCount,
    emailableChecked,
    emailableDeliverable,
    emailableRejected,
    emailableFailedOpen,
    suppressedSkipped,
    excludedPostEnrich,
  }
}
```

Replace with:

```ts
async function enrichCandidates(
  candidates: FreshCandidate[],
  campaign: CampaignForDiscovery,
  supabase: SupabaseClient<Database>,
  aiVerdictCache: Map<string, RelevanceVerdict>,
): Promise<EnrichResult> {
  const { icp } = campaign
  const rows: LeadInsert[] = []
  let verifiedCount = 0
  let emailableChecked = 0
  let emailableDeliverable = 0
  let emailableRejected = 0
  let emailableFailedOpen = 0
  let suppressedSkipped = 0
  let excludedPostEnrich = 0
  let aiChecked = 0
  let aiRejected = 0
  let aiFailedOpen = 0

  const relevanceCampaign: CampaignRelevanceContext = {
    name: campaign.name,
    valueProp: campaign.valueProp,
    keywords: icp.keywords,
    excludeKeywords: icp.excludeKeywords,
  }

  for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + ENRICH_BATCH_SIZE)
    const enrichedPeople = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.enrich.failed', { batchSize: batch.length }),
      () =>
        withRetry(() =>
          bulkMatchPeople(
            batch.map((c) => ({
              id: c.apolloId,
              organizationName: c.organizationName ?? undefined,
              domain: c.organizationDomain ?? undefined,
              linkedinUrl: c.linkedinUrl ?? undefined,
            })),
          ),
        ),
    )

    const batchRows: LeadInsert[] = []
    // Apollo person ids parked without ever reaching Emailable — either the
    // post-enrich exclude-keyword check below matched, the suppression check
    // further down matched, or the AI relevance check rejected the company.
    // Apollo's raw email_status stays on the row untouched (it may still
    // read 'verified' — that is Apollo's true verdict, not a lie), but
    // `status` is forced to 'parked' so nothing downstream mistakes these
    // for send-eligible. `status`, not `email_status`, is what every caller
    // below and in runDiscoveryForCampaign now checks for exactly this
    // reason.
    const skipVerification = new Set<string>()
    // Built alongside batchRows below, keyed the same way skipVerification's
    // callers key everything else (computeCompanyKey(domain, name)) — lets
    // the AI relevance stage further down look up a row's firmographics
    // without re-parsing anything back out of `raw`.
    const companySnapshotByKey = new Map<string, CompanySnapshot>()

    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      const title = person.title ?? source?.title ?? null
      const companyName = person.organizationName ?? source?.organizationName ?? null
      const companyDomain = person.organizationDomain ?? source?.organizationDomain ?? null

      companySnapshotByKey.set(computeCompanyKey(companyDomain, companyName), {
        companyName,
        companyDomain,
        industry: person.organizationIndustry,
        employeeCount: person.organizationEmployeeCount,
        foundedYear: person.organizationFoundedYear,
        description: person.organizationDescription,
        city: person.organizationCity,
        state: person.organizationState,
        country: person.organizationCountry,
      })

      // Post-enrich exclude check: catches companies the pre-enrich pass-1/
      // pass-2 title+org-name check couldn't see, because industry and
      // description only exist after this enrich call.
      if (
        matchesExcludedKeywords(
          {
            title,
            organizationName: companyName,
            organizationIndustry: person.organizationIndustry,
            organizationDescription: person.organizationDescription,
          },
          icp.excludeKeywords,
        )
      ) {
        skipVerification.add(person.apolloId)
        excludedPostEnrich += 1
        await logDiscoveryFilterEvent(
          campaign,
          'pipeline.discover.excluded_post_enrich',
          person.apolloId,
          computeCompanyKey(companyDomain, companyName),
        )
      }

      batchRows.push({
        client_id: campaign.clientId,
        campaign_id: campaign.id,
        source_id: person.apolloId,
        full_name: fullName,
        title,
        company_name: companyName,
        company_domain: companyDomain,
        linkedin_url: person.linkedinUrl ?? source?.linkedinUrl ?? null,
        source: 'apollo',
        raw: { ...person },
        email: person.email,
        email_status: emailStatus,
        email_verified_at: null,
        status: 'parked',
        email_verification: null,
      })
    }

    // Suppression check: one bulk lookup per batch, client-scoped, for every
    // row not already parked above — a contact who already bounced or
    // unsubscribed for this client must never reach Emailable spend or case
    // grouping, no matter which campaign rediscovers them.
    const emailsToCheck = batchRows
      .filter((row) => row.source_id != null && !skipVerification.has(row.source_id))
      .map((row) => row.email)
      .filter((email): email is string => typeof email === 'string' && email.length > 0)
    if (emailsToCheck.length > 0) {
      const suppressed = await getSuppressions(supabase, campaign.clientId, emailsToCheck)
      for (const row of batchRows) {
        if (row.source_id && row.email && suppressed.has(row.email.trim().toLowerCase())) {
          skipVerification.add(row.source_id)
          suppressedSkipped += 1
          await logDiscoveryFilterEvent(
            campaign,
            'pipeline.discover.suppressed_skipped',
            row.source_id,
            computeCompanyKey(row.company_domain ?? null, row.company_name ?? null),
          )
        }
      }
    }

    // AI relevance check: company-level, cached per company_key across the
    // whole discovery run (aiVerdictCache is created once in
    // runDiscoveryForCampaign and shared between the pass-1 and pass-2 calls
    // to this function), so a second contact discovered at an
    // already-judged company costs no extra Gemini call. Runs before
    // Emailable — same reasoning as the suppression/exclude-keyword checks
    // above: a check that's cheap relative to Emailable gates the more
    // expensive vendor call — and only ever considers rows still eligible
    // for Emailable, since a row that could never reach `active` anyway
    // isn't worth an AI call either.
    const aiEligibleRows = batchRows.filter((row) => isVerifiableRow(row, skipVerification))
    const uncachedKeys = new Set<string>()
    for (const row of aiEligibleRows) {
      const key = computeCompanyKey(row.company_domain ?? null, row.company_name ?? null)
      if (!aiVerdictCache.has(key)) uncachedKeys.add(key)
    }
    const keysToResolve = [...uncachedKeys]
    for (let k = 0; k < keysToResolve.length; k += AI_RELEVANCE_CONCURRENCY) {
      const slice = keysToResolve.slice(k, k + AI_RELEVANCE_CONCURRENCY)
      const resolved = await Promise.all(
        slice.map(async (key) => {
          // Safe: every key in uncachedKeys was derived from a row in
          // aiEligibleRows (a filter of batchRows), and the loop above that
          // builds batchRows sets this same key in companySnapshotByKey for
          // every row, unconditionally, before this point.
          const snapshot = companySnapshotByKey.get(key)!
          try {
            const verdict = await checkCompanyRelevance(
              { clientId: campaign.clientId, actor: 'system' },
              relevanceCampaign,
              snapshot,
            )
            return { key, verdict, failed: false as const, error: null as string | null }
          } catch (error) {
            return {
              key,
              verdict: { pass: true, reason: 'ai_check_failed' } as RelevanceVerdict,
              failed: true as const,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
      )
      for (const { key, verdict, failed, error } of resolved) {
        aiVerdictCache.set(key, verdict)
        if (failed) {
          aiFailedOpen += 1
          await logAiCheckFailedEvent(campaign, key, error ?? 'unknown error')
        }
      }
    }
    for (const row of aiEligibleRows) {
      const key = computeCompanyKey(row.company_domain ?? null, row.company_name ?? null)
      const verdict = aiVerdictCache.get(key)
      if (!verdict) continue
      aiChecked += 1
      if (verdict.pass) continue
      if (row.source_id) skipVerification.add(row.source_id)
      aiRejected += 1
      await logAiRejectedEvent(campaign, row.source_id ?? 'unknown', key, verdict.reason)
    }

    // The deliverability guard, not Apollo, has the final say on activation —
    // for every row not already parked above.
    const verified = await verifyBatch(campaign, batchRows, skipVerification)
    emailableChecked += verified.checked
    emailableDeliverable += verified.deliverable
    emailableRejected += verified.rejected
    emailableFailedOpen += verified.failedOpen
    for (const row of verified.rows) {
      if (row.status === 'active') verifiedCount += 1
      rows.push(row)
    }
  }

  return {
    rows,
    verifiedCount,
    emailableChecked,
    emailableDeliverable,
    emailableRejected,
    emailableFailedOpen,
    suppressedSkipped,
    excludedPostEnrich,
    aiChecked,
    aiRejected,
    aiFailedOpen,
  }
}
```

Now update `runDiscoveryForCampaign`. Find:

```ts
    const existingCompanies = await getVerifiedLeadCompanies(supabase, campaign.id)

    const priorCompanyCounts = new Map<string, number>()
```

Replace with:

```ts
    const existingCompanies = await getVerifiedLeadCompanies(supabase, campaign.id)
    // Shared across both enrichCandidates calls below (pass 1 and pass 2) so
    // a company judged once by the AI relevance filter is never re-judged
    // for a second contact discovered at the same company later in this run.
    const aiVerdictCache = new Map<string, RelevanceVerdict>()

    const priorCompanyCounts = new Map<string, number>()
```

Find:

```ts
    // Enrich pass-1 picks before deciding pass-2 targets: only a company
    // whose pass-1 contact actually verified is worth a second-contact search.
    const firstPassEnriched = await enrichCandidates(firstPass.picks, campaign, supabase)
```

Replace with:

```ts
    // Enrich pass-1 picks before deciding pass-2 targets: only a company
    // whose pass-1 contact actually verified is worth a second-contact search.
    const firstPassEnriched = await enrichCandidates(firstPass.picks, campaign, supabase, aiVerdictCache)
```

Find:

```ts
    const secondPassEnriched = await enrichCandidates(secondPass.picks, campaign, supabase)
    const secondInserted = await insertLeads(supabase, secondPassEnriched.rows)
```

Replace with:

```ts
    const secondPassEnriched = await enrichCandidates(secondPass.picks, campaign, supabase, aiVerdictCache)
    const secondInserted = await insertLeads(supabase, secondPassEnriched.rows)
```

Find:

```ts
      suppressedSkipped: firstPassEnriched.suppressedSkipped + secondPassEnriched.suppressedSkipped,
      excludedPostEnrich: firstPassEnriched.excludedPostEnrich + secondPassEnriched.excludedPostEnrich,
      inserted: inserted.length,
    }
```

Replace with:

```ts
      suppressedSkipped: firstPassEnriched.suppressedSkipped + secondPassEnriched.suppressedSkipped,
      excludedPostEnrich: firstPassEnriched.excludedPostEnrich + secondPassEnriched.excludedPostEnrich,
      aiChecked: firstPassEnriched.aiChecked + secondPassEnriched.aiChecked,
      aiRejected: firstPassEnriched.aiRejected + secondPassEnriched.aiRejected,
      aiFailedOpen: firstPassEnriched.aiFailedOpen + secondPassEnriched.aiFailedOpen,
      inserted: inserted.length,
    }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — every test in the file, including all new ones in the `'AI relevance filter'` describe block.

- [ ] **Step 5: Run the full test suite**

Run: `pnpm vitest run`
Expected: PASS — no other file references `enrichCandidates` or constructs a `CampaignForDiscovery` outside the files this plan already touched, so nothing else should be affected, but confirm.

- [ ] **Step 6: Type-check and lint**

Run: `pnpm tsc --noEmit`
Expected: no errors.

Run: `pnpm eslint src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts src/lib/pipeline/ai-relevance.ts src/lib/pipeline/ai-relevance.test.ts src/lib/llm/client.ts src/lib/llm/client.test.ts src/app/api/pipeline/discover/route.ts`
Expected: no errors (fix any and re-run before continuing).

- [ ] **Step 7: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "feat(pipeline): wire AI relevance filter into discovery, before Emailable

Runs after suppression/post-enrich-exclude, on rows still eligible for
Emailable verification; company-level and cached per discovery run so a
second contact at the same company costs no extra Gemini call; fails open
on Gemini errors.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: Roadmap update and final verification

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Run the whole suite one more time from a clean state**

Run: `pnpm vitest run`
Expected: PASS, full suite green.

Run: `pnpm tsc --noEmit`
Expected: no errors.

Run: `pnpm eslint .`
Expected: no errors (or only the single pre-existing unrelated warning already noted in `.claude/roadmap.md`'s P2 section, if still present).

- [ ] **Step 2: Update the roadmap**

Open `.claude/roadmap.md`. Under the `## P1 — Apollo Discovery + Verify + CRM View` section, find the last `- [x]` bullet in that section (the multi-threading discovery bullet ending `...See implementation plan: docs/superpowers/plans/2026-07-19-apollo-multi-thread-discovery.md`.) and add a new bullet immediately after it:

```markdown
- [x] **AI relevance filter**: a company-level Gemini check (`gemini-3.1-flash-lite`, `src/lib/pipeline/ai-relevance.ts`) rejects Apollo-matched-but-irrelevant companies before an Emailable credit is spent — slotted into `discover.ts`'s existing suppression/post-enrich-exclude cascade, cached per company per discovery run (a second contact at the same company costs no extra Gemini call), fails open on Gemini errors/timeouts. Design: `docs/superpowers/specs/2026-08-06-ai-relevance-filter-design.md`. Plan: `docs/superpowers/plans/2026-08-06-ai-relevance-filter.md`.
```

- [ ] **Step 3: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs(roadmap): AI relevance filter shipped

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```
