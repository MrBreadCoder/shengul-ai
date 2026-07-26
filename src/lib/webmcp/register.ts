import { AppError } from '@/lib/errors/app-error'
import type { ModelContext, WebMcpTool } from '@/types/webmcp'

/**
 * Registers a page's tools with the browser's model context.
 */

export type RegisterToolsResult =
  /** WebMCP is not available here. The expected outcome in most browsers. */
  | { readonly status: 'unsupported' }
  | { readonly status: 'registered'; readonly toolNames: readonly string[] }
  /** The caller unmounted (or navigated) before registration settled. */
  | { readonly status: 'aborted' }
  | { readonly status: 'failed'; readonly error: AppError }

export interface RegisterToolsInput {
  /** `null` when WebMCP is unavailable — resolved by the caller, not probed here. */
  readonly modelContext: ModelContext | null
  readonly tools: readonly WebMcpTool[]
  /** Aborting unregisters every tool registered through this call. */
  readonly signal: AbortSignal
}

function toAppError(error: unknown, toolNames: readonly string[]): AppError {
  return new AppError('EXTERNAL_ERROR', 'Failed to register WebMCP tools', {
    toolNames,
    cause: error instanceof Error ? error.message : String(error),
  })
}

/**
 * Registers every tool under one `AbortSignal`, so a single `abort()` in a
 * React cleanup removes them all — there is no per-tool handle to track.
 *
 * Never throws. A browser without WebMCP, or one that rejects a descriptor,
 * must not take the page down over an optional enhancement; the outcome comes
 * back in the result for the caller to escalate as it sees fit.
 */
export async function registerWebMcpTools({
  modelContext,
  tools,
  signal,
}: RegisterToolsInput): Promise<RegisterToolsResult> {
  if (modelContext === null) return { status: 'unsupported' }
  if (signal.aborted) return { status: 'aborted' }

  const toolNames = tools.map(({ name }) => name)
  try {
    await Promise.all(tools.map((tool) => modelContext.registerTool(tool, { signal })))
  } catch (error) {
    // An abort mid-flight surfaces as a rejection; that is cleanup, not failure.
    if (signal.aborted) return { status: 'aborted' }
    return { status: 'failed', error: toAppError(error, toolNames) }
  }

  if (signal.aborted) return { status: 'aborted' }
  return { status: 'registered', toolNames }
}
