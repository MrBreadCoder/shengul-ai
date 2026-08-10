import { generateObject, generateText as sdkGenerateText, embedMany, isStepCount, type ToolSet } from 'ai'
import { createGoogle, type GoogleLanguageModelOptions } from '@ai-sdk/google'
import type { z } from 'zod'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'
import { logEventSafe, logError } from '@/lib/events/log-event'

const MODEL_ID = 'gemini-3-flash-preview'

// Shared modelId override for every pipeline stage that writes outbound
// email copy (write.ts, followup.ts, redesign.ts, reply.ts,
// knowledge-answer.ts) — gemini-3.6-flash (GA July 2026) is more
// disciplined than the module default about not padding a thin dossier
// with an invented claim. Centralized here (not duplicated per-file) so
// there is exactly one place to change it. Not used by ai-relevance.ts —
// that call is a classification, not email writing, and stays on its own
// lighter model (gemini-3.1-flash-lite).
export const EMAIL_WRITER_MODEL_ID = 'gemini-3.6-flash'

const DEFAULT_TIMEOUT_MS = 60_000
// Tool loops make several external calls (each of which can itself stall for
// up to brightdata.ts's own SCRAPE_TIMEOUT_MS under a congested zone), so
// this needs enough headroom for multiple slow steps in the same run, not
// just one — see 2026-08-10 roadmap entry on the BrightData timeout cluster.
// At GATHER_STEPS=6 steps and a 40s scrape timeout, this is still below the
// theoretical worst case (6 slow steps back to back) — see the caveat this
// entry logs about Vercel's per-function maxDuration possibly capping this
// before it ever fires.
const TOOL_LOOP_TIMEOUT_MS = 180_000

const google = createGoogle({ apiKey: env.GEMINI_API_KEY })
const model = google(MODEL_ID)

const EMBEDDING_MODEL_ID = 'gemini-embedding-001'
// Matches the vector(768) column in client_knowledge_chunks — gemini-embedding-001
// supports Matryoshka truncation to 768/1536/3072; 768 keeps the HNSW index and
// per-chunk storage small without a meaningful quality loss for this use case.
const EMBEDDING_DIMENSIONS = 768
const EMBED_TIMEOUT_MS = 45_000

const embeddingModel = google.textEmbeddingModel(EMBEDDING_MODEL_ID)

// Gemini 3 Flash reasoning depth. Omit to use the model's default; only pass this
// for calls where a judgment-heavy task (research, reply triage) benefits enough
// from deeper reasoning to justify the added latency/cost.
export type ThinkingLevel = 'minimal' | 'low' | 'medium' | 'high'

function providerOptionsFor(
  thinkingLevel: ThinkingLevel | undefined,
): { google: GoogleLanguageModelOptions } | undefined {
  if (!thinkingLevel) return undefined
  return { google: { thinkingConfig: { thinkingLevel } } }
}

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

/**
 * Attributes a Gemini failure to the client whose pipeline run triggered it, so
 * an operator sees "this client's AI is erroring" on the client's Logs tab.
 * Best-effort by construction (`logError` never throws) — the AppError raised
 * by the caller immediately below is what callers actually see.
 */
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

// Races `work(signal)` against a timeout and always clears the timer, so a fast
// success never leaves a dangling setTimeout holding the event loop open. On
// timeout the controller is aborted so the underlying SDK call actually stops
// instead of continuing to run after we've moved on.
async function withTimeout<T>(work: (signal: AbortSignal) => Promise<T>, ms: number): Promise<T> {
  const controller = new AbortController()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      // Reject first: aborting can synchronously reject `work`'s promise too,
      // and whichever settles first wins the race. Rejecting before abort()
      // guarantees callers see EXTERNAL_TIMEOUT instead of a generic AbortError.
      reject(new AppError('EXTERNAL_TIMEOUT', 'LLM call timed out', { ms }))
      controller.abort()
    }, ms)
  })
  try {
    return await Promise.race([work(controller.signal), timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// Inline file input for a structured generation — a resource PDF or image handed
// to the model to be read. Bytes only: the storage objects are private, so a URL
// the provider could fetch does not exist.
export interface LlmFile {
  data: Buffer
  mediaType: string
}

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

export interface GenerateTextArgs {
  instructions: string
  prompt: string
  maxOutputTokens: number
  timeoutMs?: number
  thinkingLevel?: ThinkingLevel
  /** Overrides the module default (MODEL_ID) for this call only — see generateJson's identical field. */
  modelId?: string
}

export async function generateText(
  context: LlmCallContext,
  args: GenerateTextArgs,
): Promise<string> {
  const startedAt = Date.now()
  const resolvedModelId = args.modelId ?? MODEL_ID
  const resolvedModel = args.modelId ? google(args.modelId) : model
  try {
    const result = await withTimeout(
      (signal) =>
        sdkGenerateText({
          model: resolvedModel,
          instructions: args.instructions,
          prompt: args.prompt,
          maxOutputTokens: args.maxOutputTokens,
          abortSignal: signal,
          providerOptions: providerOptionsFor(args.thinkingLevel),
        }),
      args.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    )
    await logUsage(context, resolvedModelId, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    await logLlmFailure(context, resolvedModelId, 'generateText', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateText failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export interface GenerateWithToolsArgs {
  instructions: string
  prompt: string
  tools: ToolSet
  maxSteps: number
  maxOutputTokens: number
  timeoutMs?: number
  thinkingLevel?: ThinkingLevel
}

// Runs a multi-step agentic tool loop and returns the model's final text. The
// AI SDK auto-executes each tool's `execute` and feeds results back until the
// model stops or the step budget (isStepCount) is hit.
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
          instructions: args.instructions,
          prompt: args.prompt,
          tools: args.tools,
          stopWhen: isStepCount(args.maxSteps),
          maxOutputTokens: args.maxOutputTokens,
          abortSignal: signal,
          providerOptions: providerOptionsFor(args.thinkingLevel),
        }),
      args.timeoutMs ?? TOOL_LOOP_TIMEOUT_MS,
    )
    await logUsage(context, MODEL_ID, result.usage, Date.now() - startedAt)
    return result.text
  } catch (cause) {
    await logLlmFailure(context, MODEL_ID, 'generateWithTools', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM tool loop failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

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
    await logLlmFailure(context, MODEL_ID, 'embedMany', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM embedMany failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
