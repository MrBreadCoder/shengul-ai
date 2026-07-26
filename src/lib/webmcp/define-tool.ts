import { z } from 'zod'
import type { JsonSchemaObject, WebMcpTool, WebMcpToolResult } from '@/types/webmcp'
import { reportBrowserError } from './report-error'
import { errorResult } from './result'

/**
 * Turns a Zod schema plus a handler into a registrable WebMCP tool.
 *
 * One schema serves both jobs: it generates the JSON Schema the agent reads,
 * and it validates the arguments the agent sends. They cannot drift, which is
 * what Lighthouse's `webmcp-schema-validity` audit checks for.
 */

export interface DefineWebMcpToolInput<Schema extends z.ZodObject<z.ZodRawShape>, Output> {
  /** Stable identifier the agent calls. `camelCase`, unique per page. */
  readonly name: string
  /** Short human-readable label shown in agent UIs. */
  readonly title: string
  /** What the tool returns and when to reach for it. */
  readonly description: string
  readonly inputSchema: Schema
  /** `false` only for a tool that mutates. Nothing in this app registers one. */
  readonly isReadOnly: boolean
  /**
   * `true` when the returned text includes content this app did not author —
   * a prospect's reply, a scraped page — which the agent must not obey.
   */
  readonly hasUntrustedContent?: boolean
  readonly execute: (input: z.output<Schema>) => Output | Promise<Output>
  /** Wraps the handler's return value in the MCP content envelope. */
  readonly toResult: (output: Output) => WebMcpToolResult
  /** Where a handler crash is escalated. Injectable so tests can assert on it. */
  readonly onUnexpectedError?: (error: unknown) => void
}

function toInputJsonSchema(schema: z.ZodObject<z.ZodRawShape>): JsonSchemaObject {
  const generated: Record<string, unknown> = { ...z.toJSONSchema(schema, { target: 'draft-2020-12' }) }
  // Zod adds `$schema` to identify a standalone document. A tool's `inputSchema`
  // is embedded in a tool descriptor, so it is dropped.
  delete generated.$schema
  // Safe: `z.toJSONSchema` on a `ZodObject` always emits `type: 'object'` with a
  // `properties` map. The declared return type is the loose union covering every
  // Zod type, so it has to be narrowed here.
  return generated as unknown as JsonSchemaObject
}

/** Flattens a Zod issue list into one line an agent can act on. */
function formatIssues(error: z.ZodError): string {
  return error.issues
    .map(({ path, message }) => (path.length > 0 ? `${path.join('.')}: ${message}` : message))
    .join('; ')
}

export function defineWebMcpTool<Schema extends z.ZodObject<z.ZodRawShape>, Output>({
  name,
  title,
  description,
  inputSchema,
  isReadOnly,
  hasUntrustedContent = false,
  execute,
  toResult,
  onUnexpectedError = reportBrowserError,
}: DefineWebMcpToolInput<Schema, Output>): WebMcpTool {
  return {
    name,
    title,
    description,
    inputSchema: toInputJsonSchema(inputSchema),
    annotations: { readOnlyHint: isReadOnly, untrustedContentHint: hasUntrustedContent },
    execute: async (input: unknown): Promise<WebMcpToolResult> => {
      // An agent may omit arguments entirely for a no-input tool.
      const parsed = inputSchema.safeParse(input ?? {})
      if (!parsed.success) {
        return errorResult(`Invalid arguments for ${name} — ${formatIssues(parsed.error)}`)
      }

      try {
        return toResult(await execute(parsed.data))
      } catch (error) {
        // A throwing handler is a bug in this app, not a bad agent call, so it
        // is escalated to the page's error monitoring. The agent gets a bare
        // failure: a transcript is not a place to leak internals.
        onUnexpectedError(error)
        return errorResult(`${name} failed while running on this page.`)
      }
    },
  }
}
