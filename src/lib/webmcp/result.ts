import type { WebMcpToolResult } from '@/types/webmcp'

/**
 * Builders for the `{ content: [...] }` envelope `execute` must resolve to.
 */

/** A successful result carrying prose an agent can read out verbatim. */
export function textResult(text: string): WebMcpToolResult {
  return { content: [{ type: 'text', text }] }
}

/**
 * A successful result carrying structured data. Serialised because MCP content
 * parts are text — agents parse the JSON themselves.
 */
export function jsonResult(value: unknown): WebMcpToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] }
}

/**
 * A tool-level failure. Resolves rather than rejects so the agent sees a
 * correctable problem (bad argument, no match) instead of a transport fault.
 */
export function errorResult(message: string): WebMcpToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}
