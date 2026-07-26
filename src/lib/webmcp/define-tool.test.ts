import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { defineWebMcpTool, type DefineWebMcpToolInput } from '@/lib/webmcp/define-tool'
import { jsonResult, textResult } from '@/lib/webmcp/result'
import type { WebMcpTool } from '@/types/webmcp'

const inputSchema = z.object({
  city: z.string().min(1, 'Name a city.').describe('The city to look up.'),
  limit: z.number().int().min(1).max(10).optional().describe('How many results.'),
})

type ToolOverrides = Partial<DefineWebMcpToolInput<typeof inputSchema, string>>

function buildTool(overrides: ToolOverrides = {}): WebMcpTool {
  return defineWebMcpTool({
    name: 'lookupCity',
    title: 'Look up a city',
    description: 'Returns a canned answer for a city.',
    inputSchema,
    isReadOnly: true,
    execute: ({ city }) => `found ${city}`,
    toResult: textResult,
    ...overrides,
  })
}

describe('defineWebMcpTool', () => {
  it('should expose an object JSON Schema derived from the Zod schema', () => {
    const { inputSchema: schema } = buildTool()
    expect(schema.type).toBe('object')
    expect(Object.keys(schema.properties)).toEqual(['city', 'limit'])
    expect(schema.required).toEqual(['city'])
    expect(schema.additionalProperties).toBe(false)
  })

  it('should carry each field description through to the JSON Schema', () => {
    const { inputSchema: schema } = buildTool()
    expect(schema.properties.city).toMatchObject({ type: 'string', description: 'The city to look up.' })
  })

  it('should omit the $schema key, which belongs to a standalone document', () => {
    expect(buildTool().inputSchema).not.toHaveProperty('$schema')
  })

  it('should mark a read-only tool with readOnlyHint and no untrusted-content hint by default', () => {
    expect(buildTool().annotations).toEqual({ readOnlyHint: true, untrustedContentHint: false })
  })

  it('should set untrustedContentHint when the tool returns content this app did not author', () => {
    expect(buildTool({ hasUntrustedContent: true }).annotations.untrustedContentHint).toBe(true)
  })

  it('should return the handler result wrapped in a text content part when input is valid', async () => {
    const result = await buildTool().execute({ city: 'Istanbul' })
    expect(result).toEqual({ content: [{ type: 'text', text: 'found Istanbul' }] })
    expect(result.isError).toBeUndefined()
  })

  it('should report an error result naming the offending field when input is invalid', async () => {
    const result = await buildTool().execute({ city: '' })
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('lookupCity')
    expect(result.content[0]?.text).toContain('city: Name a city.')
  })

  it('should report an error result when a required field is missing entirely', async () => {
    const result = await buildTool().execute({})
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toContain('city')
  })

  it('should not run the handler when input fails validation', async () => {
    const execute = vi.fn(() => 'never')
    await buildTool({ execute }).execute({ city: 123 })
    expect(execute).not.toHaveBeenCalled()
  })

  it('should treat omitted arguments as an empty object so a no-input tool still runs', async () => {
    const tool = defineWebMcpTool({
      name: 'ping',
      title: 'Ping',
      description: 'Returns a constant.',
      inputSchema: z.object({}),
      isReadOnly: true,
      execute: () => 'pong',
      toResult: textResult,
    })
    await expect(tool.execute(undefined)).resolves.toEqual({
      content: [{ type: 'text', text: 'pong' }],
    })
  })

  it('should await an async handler before wrapping its result', async () => {
    const tool = buildTool({ execute: async ({ city }) => Promise.resolve(`async ${city}`) })
    const result = await tool.execute({ city: 'Berlin' })
    expect(result.content[0]?.text).toBe('async Berlin')
  })

  it('should escalate a throwing handler and hide its detail from the agent', async () => {
    const onUnexpectedError = vi.fn()
    const boom = new Error('supabase exploded at clients.name')
    const tool = buildTool({
      execute: () => {
        throw boom
      },
      onUnexpectedError,
    })

    const result = await tool.execute({ city: 'Oslo' })

    expect(onUnexpectedError).toHaveBeenCalledWith(boom)
    expect(result.isError).toBe(true)
    expect(result.content[0]?.text).toBe('lookupCity failed while running on this page.')
    expect(result.content[0]?.text).not.toContain('supabase')
  })

  it('should escalate a rejected handler promise the same way', async () => {
    const onUnexpectedError = vi.fn()
    const tool = buildTool({
      execute: async () => Promise.reject(new Error('network down')),
      onUnexpectedError,
    })

    const result = await tool.execute({ city: 'Oslo' })

    expect(onUnexpectedError).toHaveBeenCalledOnce()
    expect(result.isError).toBe(true)
  })

  it('should serialise a structured handler result when jsonResult is the wrapper', async () => {
    const tool = defineWebMcpTool({
      name: 'listOne',
      title: 'List one',
      description: 'Returns structured data.',
      inputSchema: z.object({}),
      isReadOnly: true,
      execute: () => ({ total: 1, items: ['a'] }),
      toResult: jsonResult,
    })
    const result = await tool.execute({})
    expect(JSON.parse(String(result.content[0]?.text))).toEqual({ total: 1, items: ['a'] })
  })
})
