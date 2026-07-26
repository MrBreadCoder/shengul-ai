import { describe, expect, it, vi } from 'vitest'
import { registerWebMcpTools } from '@/lib/webmcp/register'
import { isAppError } from '@/lib/errors/app-error'
import type { ModelContext, WebMcpTool } from '@/types/webmcp'

function fakeTool(name: string): WebMcpTool {
  return {
    name,
    title: name,
    description: `Tool ${name}`,
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true, untrustedContentHint: false },
    execute: async () => ({ content: [{ type: 'text', text: 'ok' }] }),
  }
}

const TOOLS = [fakeTool('alpha'), fakeTool('beta')] as const

describe('registerWebMcpTools', () => {
  it('should report unsupported without touching the tools when WebMCP is absent', async () => {
    const result = await registerWebMcpTools({
      modelContext: null,
      tools: TOOLS,
      signal: new AbortController().signal,
    })
    expect(result).toEqual({ status: 'unsupported' })
  })

  it('should register every tool under the given abort signal', async () => {
    const registerTool = vi.fn(async (): Promise<void> => {})
    const controller = new AbortController()

    const result = await registerWebMcpTools({
      modelContext: { registerTool } satisfies ModelContext,
      tools: TOOLS,
      signal: controller.signal,
    })

    expect(result).toEqual({ status: 'registered', toolNames: ['alpha', 'beta'] })
    expect(registerTool).toHaveBeenCalledTimes(2)
    expect(registerTool).toHaveBeenCalledWith(TOOLS[0], { signal: controller.signal })
    expect(registerTool).toHaveBeenCalledWith(TOOLS[1], { signal: controller.signal })
  })

  it('should register nothing when the caller has already aborted', async () => {
    const registerTool = vi.fn(async (): Promise<void> => {})
    const controller = new AbortController()
    controller.abort()

    const result = await registerWebMcpTools({
      modelContext: { registerTool },
      tools: TOOLS,
      signal: controller.signal,
    })

    expect(result).toEqual({ status: 'aborted' })
    expect(registerTool).not.toHaveBeenCalled()
  })

  it('should report aborted rather than failed when registration is cancelled mid-flight', async () => {
    const controller = new AbortController()
    const registerTool = vi.fn(async (): Promise<void> => {
      controller.abort()
      throw new DOMException('aborted', 'AbortError')
    })

    const result = await registerWebMcpTools({
      modelContext: { registerTool },
      tools: TOOLS,
      signal: controller.signal,
    })

    expect(result).toEqual({ status: 'aborted' })
  })

  it('should report aborted when the component unmounts after a successful registration', async () => {
    const controller = new AbortController()
    const registerTool = vi.fn(async (): Promise<void> => {
      controller.abort()
    })

    const result = await registerWebMcpTools({
      modelContext: { registerTool },
      tools: [fakeTool('alpha')],
      signal: controller.signal,
    })

    expect(result).toEqual({ status: 'aborted' })
  })

  it('should return a failed result carrying an AppError when the browser rejects a descriptor', async () => {
    const registerTool = vi.fn(async (): Promise<void> => {
      throw new TypeError('duplicate tool name')
    })

    const result = await registerWebMcpTools({
      modelContext: { registerTool },
      tools: TOOLS,
      signal: new AbortController().signal,
    })

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected a failed result')
    expect(isAppError(result.error)).toBe(true)
    expect(result.error.code).toBe('EXTERNAL_ERROR')
    expect(result.error.context).toEqual({
      toolNames: ['alpha', 'beta'],
      cause: 'duplicate tool name',
    })
  })

  it('should never throw, whatever the browser does', async () => {
    const registerTool = vi.fn(async (): Promise<void> => {
      throw 'a string, not an error'
    })

    const result = await registerWebMcpTools({
      modelContext: { registerTool },
      tools: TOOLS,
      signal: new AbortController().signal,
    })

    expect(result.status).toBe('failed')
    if (result.status !== 'failed') throw new Error('expected a failed result')
    expect(result.error.context.cause).toBe('a string, not an error')
  })

  it('should report registered with an empty tool list when there is nothing to register', async () => {
    const registerTool = vi.fn(async (): Promise<void> => {})
    const result = await registerWebMcpTools({
      modelContext: { registerTool },
      tools: [],
      signal: new AbortController().signal,
    })

    expect(result).toEqual({ status: 'registered', toolNames: [] })
    expect(registerTool).not.toHaveBeenCalled()
  })
})
