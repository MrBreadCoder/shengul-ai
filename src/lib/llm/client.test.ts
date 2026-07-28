import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const generateObjectMock = vi.fn()
const generateTextMock = vi.fn()
const embedManyMock = vi.fn()

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObjectMock(...args),
  generateText: (...args: unknown[]) => generateTextMock(...args),
  isStepCount: (count: number) => ({ isStepCount: count }),
  embedMany: (...args: unknown[]) => embedManyMock(...args),
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

import { generateJson, generateText, generateWithTools, embedTexts } from './client'

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
