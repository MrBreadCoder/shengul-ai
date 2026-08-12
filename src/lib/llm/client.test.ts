import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const generateObjectMock = vi.fn()
const generateTextMock = vi.fn()
const embedManyMock = vi.fn()

// Minimal stand-in for the AI SDK's real APICallError: enough to exercise
// client.ts's `APICallError.isInstance(cause)` branch and carry
// statusCode/isRetryable through to the wrapped AppError. vi.hoisted so it's
// safely usable both inside the vi.mock('ai', ...) factory below and later
// in test bodies to construct instances.
const MockAPICallError = vi.hoisted(() => {
  class MockAPICallError extends Error {
    statusCode?: number
    isRetryable: boolean
    constructor(opts: { message: string; statusCode?: number; isRetryable?: boolean }) {
      super(opts.message)
      this.statusCode = opts.statusCode
      this.isRetryable = opts.isRetryable ?? false
    }
    static isInstance(error: unknown): error is InstanceType<typeof MockAPICallError> {
      return error instanceof MockAPICallError
    }
  }
  return MockAPICallError
})

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  generateText: (...args: unknown[]) => generateTextMock(...args),
  isStepCount: (count: number) => ({ isStepCount: count }),
  embedMany: (...args: unknown[]) => embedManyMock(...args),
  APICallError: MockAPICallError,
}))
vi.mock('@ai-sdk/google', () => ({
  createGoogle: () => {
    const google = (modelId: string) => ({ modelId })
    google.textEmbeddingModel = (modelId: string) => ({ modelId })
    return google
  },
}))
const logEventMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  logEventSafe: (...a: unknown[]) => logEventMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
}))

import { generateJson, generateText, generateWithTools, embedTexts, isModelOverloadedError } from './client'

const ctx = { clientId: 'client1', caseId: 'case1', actor: 'research_agent' }

beforeEach(() => {
  generateObjectMock.mockReset()
  generateTextMock.mockReset()
  embedManyMock.mockReset()
  logEventMock.mockReset()
  logErrorMock.mockReset()
})

describe('generateJson', () => {
  it('should return the parsed object and log usage when the model succeeds', async () => {
    generateObjectMock.mockResolvedValue({
      object: { title: 'Acme' },
      usage: { inputTokens: 10, outputTokens: 5 },
    })
    const schema = z.object({ title: z.string() })
    const result = await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100 })
    expect(result).toEqual({ title: 'Acme' })
    expect(logEventMock).toHaveBeenCalledTimes(1)
  })

  it('should throw EXTERNAL_ERROR when the model call rejects', async () => {
    generateObjectMock.mockRejectedValue(new Error('model down'))
    const schema = z.object({ title: z.string() })
    await expect(
      generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100 }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should pass the thinking level through as a Google provider option when set', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, {
      instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, thinkingLevel: 'medium',
    })
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { google: { thinkingConfig: { thinkingLevel: 'medium' } } },
      }),
    )
  })

  it('should omit providerOptions when no thinking level is set', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100 })
    expect(generateObjectMock).toHaveBeenCalledWith(
      expect.objectContaining({ providerOptions: undefined }),
    )
  })

  it('should reject with EXTERNAL_TIMEOUT, not a generic abort error, when the call times out', async () => {
    // Mimics an SDK call that rejects synchronously the instant its abortSignal
    // fires — the scenario that used to race our own timeout rejection.
    generateObjectMock.mockImplementation(
      (args: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          args.abortSignal.addEventListener('abort', () => reject(new Error('The operation was aborted')))
        }),
    )
    const schema = z.object({ title: z.string() })
    await expect(
      generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, timeoutMs: 5 }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })

  it('should pass a string prompt and no messages when no files are given', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100 })
    const call = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.prompt).toBe('p')
    expect(call.messages).toBeUndefined()
  })

  it('should pass a string prompt when files is an empty array', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, files: [] })
    const call = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.prompt).toBe('p')
    expect(call.messages).toBeUndefined()
  })

  it('should send one user message with a text part and a file part per file', async () => {
    generateObjectMock.mockResolvedValue({ object: { title: 'Acme' }, usage: {} })
    const schema = z.object({ title: z.string() })
    const data = Buffer.from('%PDF-1.7')
    await generateJson(ctx, {
      instructions: 's',
      prompt: 'describe this',
      schema,
      maxOutputTokens: 100,
      files: [{ data, mediaType: 'application/pdf' }],
    })
    const call = generateObjectMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(call.prompt).toBeUndefined()
    expect(call.instructions).toBe('s')
    expect(call.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'describe this' },
          { type: 'file', data, mediaType: 'application/pdf' },
        ],
      },
    ])
  })

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

describe('generateText', () => {
  it('should return the text and log usage when the model succeeds', async () => {
    generateTextMock.mockResolvedValue({ text: 'hello', usage: { inputTokens: 3, outputTokens: 2 } })
    const result = await generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50 })
    expect(result).toBe('hello')
    expect(logEventMock).toHaveBeenCalledTimes(1)
  })

  it('should throw EXTERNAL_ERROR when the model call rejects', async () => {
    generateTextMock.mockRejectedValue(new Error('model down'))
    await expect(
      generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50 }),
    ).rejects.toBeInstanceOf(AppError)
  })

  it('should use the module default model when modelId is omitted', async () => {
    generateTextMock.mockResolvedValue({ text: 'hello', usage: {} })
    await generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50 })
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: { modelId: 'gemini-3-flash-preview' } }),
    )
  })

  it('should use the overridden model when modelId is set', async () => {
    generateTextMock.mockResolvedValue({ text: 'hello', usage: {} })
    await generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50, modelId: 'gemini-3.6-flash' })
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({ model: { modelId: 'gemini-3.6-flash' } }),
    )
  })

  it('should log the overridden model id in the usage event, not the module default', async () => {
    generateTextMock.mockResolvedValue({ text: 'hello', usage: { inputTokens: 1, outputTokens: 1 } })
    await generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50, modelId: 'gemini-3.6-flash' })
    expect(logEventMock.mock.calls[0]?.[0]).toMatchObject({
      payload: expect.objectContaining({ model: 'gemini-3.6-flash' }),
    })
  })

  it('should log the overridden model id in the failure event, not the module default', async () => {
    generateTextMock.mockRejectedValue(new Error('model down'))
    await expect(
      generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50, modelId: 'gemini-3.6-flash' }),
    ).rejects.toBeInstanceOf(AppError)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      payload: expect.objectContaining({ model: 'gemini-3.6-flash' }),
    })
  })
})

describe('generateWithTools', () => {
  it('should return the final text and pass the thinking level through when set', async () => {
    generateTextMock.mockResolvedValue({ text: 'done', usage: { inputTokens: 4, outputTokens: 6 } })
    const result = await generateWithTools(ctx, {
      instructions: 's', prompt: 'p', tools: {}, maxSteps: 3, maxOutputTokens: 200, thinkingLevel: 'high',
    })
    expect(result).toBe('done')
    expect(generateTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        providerOptions: { google: { thinkingConfig: { thinkingLevel: 'high' } } },
      }),
    )
  })

  it('should throw EXTERNAL_ERROR when the model call rejects', async () => {
    generateTextMock.mockRejectedValue(new Error('model down'))
    await expect(
      generateWithTools(ctx, { instructions: 's', prompt: 'p', tools: {}, maxSteps: 3, maxOutputTokens: 200 }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('gemini failure logging', () => {
  it('should log an llm.failed event attributed to the client when generateText throws', async () => {
    generateTextMock.mockRejectedValue(new Error('503 Service Unavailable'))

    await expect(
      generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 100 }),
    ).rejects.toBeInstanceOf(AppError)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      caseId: 'case1',
      actor: 'research_agent',
      type: 'llm.failed',
      source: 'gemini',
      payload: { model: 'gemini-3-flash-preview', operation: 'generateText' },
    })
  })

  it('should log an llm.failed event when the tool loop throws', async () => {
    generateTextMock.mockRejectedValue(new Error('tool exploded'))

    await expect(
      generateWithTools(ctx, {
        instructions: 's',
        prompt: 'p',
        tools: {},
        maxSteps: 2,
        maxOutputTokens: 100,
      }),
    ).rejects.toBeInstanceOf(AppError)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'llm.failed',
      source: 'gemini',
      payload: { operation: 'generateWithTools' },
    })
  })

  it('should tag successful usage logs with the gemini source', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } })

    await generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 100 })

    expect(logEventMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'llm.completed',
      severity: 'info',
      source: 'gemini',
    })
  })
})

describe('embedTexts', () => {
  it('should return an empty array without calling the model when values is empty', async () => {
    const result = await embedTexts(ctx, { values: [], taskType: 'RETRIEVAL_DOCUMENT' })
    expect(result).toEqual([])
    expect(embedManyMock).not.toHaveBeenCalled()
  })

  it('should return the embeddings in order', async () => {
    embedManyMock.mockResolvedValue({
      embeddings: [[0.1, 0.2], [0.3, 0.4]],
      usage: { tokens: 12 },
    })
    const result = await embedTexts(ctx, { values: ['a', 'b'], taskType: 'RETRIEVAL_DOCUMENT' })
    expect(result).toEqual([[0.1, 0.2], [0.3, 0.4]])
  })

  it('should pass the taskType through providerOptions', async () => {
    embedManyMock.mockResolvedValue({ embeddings: [[0.1]], usage: { tokens: 3 } })
    await embedTexts(ctx, { values: ['q'], taskType: 'RETRIEVAL_QUERY' })
    const call = embedManyMock.mock.calls[0]![0] as { providerOptions: { google: { taskType: string } } }
    expect(call.providerOptions.google.taskType).toBe('RETRIEVAL_QUERY')
  })

  it('should throw AppError EXTERNAL_ERROR when the model call fails', async () => {
    embedManyMock.mockRejectedValue(new Error('quota exceeded'))
    await expect(embedTexts(ctx, { values: ['a'], taskType: 'RETRIEVAL_DOCUMENT' }))
      .rejects.toBeInstanceOf(AppError)
  })
})

describe('overload detection', () => {
  it('should preserve statusCode and isRetryable from an APICallError onto the thrown AppError context', async () => {
    generateObjectMock.mockRejectedValue(
      new MockAPICallError({ message: '503 Service Unavailable', statusCode: 503, isRetryable: true }),
    )
    const schema = z.object({ title: z.string() })
    const error = await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).context).toMatchObject({ statusCode: 503, isRetryable: true })
  })

  it('should leave statusCode/isRetryable undefined when the cause is not an APICallError', async () => {
    generateTextMock.mockRejectedValue(new Error('plain network blip'))
    const error = await generateText(ctx, { instructions: 's', prompt: 'p', maxOutputTokens: 50 })
      .catch((e: unknown) => e)
    expect(error).toBeInstanceOf(AppError)
    expect((error as AppError).context.statusCode).toBeUndefined()
    expect((error as AppError).context.isRetryable).toBeUndefined()
  })

  it('should not double-wrap an already-AppError cause (e.g. EXTERNAL_TIMEOUT), so its own context is untouched', async () => {
    generateObjectMock.mockImplementation(
      (args: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          args.abortSignal.addEventListener('abort', () => reject(new Error('aborted')))
        }),
    )
    const schema = z.object({ title: z.string() })
    const error = await generateJson(ctx, { instructions: 's', prompt: 'p', schema, maxOutputTokens: 100, timeoutMs: 5 })
      .catch((e: unknown) => e)
    expect(error).toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })

  it('isModelOverloadedError should return true for a 503 statusCode', () => {
    expect(isModelOverloadedError(new AppError('EXTERNAL_ERROR', 'x', { statusCode: 503 }))).toBe(true)
  })

  it('isModelOverloadedError should return true for a 429 statusCode', () => {
    expect(isModelOverloadedError(new AppError('EXTERNAL_ERROR', 'x', { statusCode: 429 }))).toBe(true)
  })

  it('isModelOverloadedError should return true when isRetryable is true regardless of statusCode', () => {
    expect(isModelOverloadedError(new AppError('EXTERNAL_ERROR', 'x', { statusCode: 500, isRetryable: true }))).toBe(true)
  })

  it('isModelOverloadedError should return false for a non-retryable EXTERNAL_ERROR', () => {
    expect(isModelOverloadedError(new AppError('EXTERNAL_ERROR', 'x', { statusCode: 400 }))).toBe(false)
  })

  it('isModelOverloadedError should return false for a different AppError code', () => {
    expect(isModelOverloadedError(new AppError('EXTERNAL_TIMEOUT', 'x', { statusCode: 503 }))).toBe(false)
  })

  it('isModelOverloadedError should return false for a non-AppError value', () => {
    expect(isModelOverloadedError(new Error('plain'))).toBe(false)
    expect(isModelOverloadedError('not an error')).toBe(false)
    expect(isModelOverloadedError(null)).toBe(false)
  })
})
