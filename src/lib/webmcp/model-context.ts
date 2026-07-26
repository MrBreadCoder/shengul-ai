import type { ModelContext } from '@/types/webmcp'

/**
 * Locates the WebMCP entry point without touching globals directly, so the
 * probe is unit-testable in a Node environment.
 */

/** The globals `resolveModelContext` reads. Every member is optional so a test can omit it. */
export interface ModelContextScope {
  readonly isSecureContext?: boolean
  readonly document?: { readonly modelContext?: unknown }
  readonly navigator?: { readonly modelContext?: unknown }
}

function asModelContext(candidate: unknown): ModelContext | null {
  if (typeof candidate !== 'object' || candidate === null) return null
  if (!('registerTool' in candidate)) return null
  const { registerTool } = candidate as { registerTool: unknown }
  if (typeof registerTool !== 'function') return null
  // Structurally verified above: the object exposes a callable `registerTool`,
  // which is the whole surface `ModelContext` declares.
  return candidate as ModelContext
}

/**
 * Returns the page's `ModelContext`, or `null` when WebMCP is unavailable.
 *
 * `null` is the expected result in most browsers today and is never an error —
 * WebMCP is a progressive enhancement, so callers no-op rather than report.
 *
 * The spec exposes `modelContext` on `Document` and marks it `[SecureContext]`.
 * Chrome's origin trial shipped it on `Navigator` first (deprecated in Chrome
 * 150), so `document` is preferred and `navigator` is the fallback.
 */
export function resolveModelContext(scope: ModelContextScope): ModelContext | null {
  // A non-secure page cannot have the API at all; probing further would only
  // find a same-named property planted by something else.
  if (scope.isSecureContext !== true) return null
  return asModelContext(scope.document?.modelContext) ?? asModelContext(scope.navigator?.modelContext)
}

/**
 * `resolveModelContext` bound to the real page. Returns `null` during SSR,
 * where none of these globals exist.
 */
export function resolveBrowserModelContext(): ModelContext | null {
  if (typeof window === 'undefined') return null
  return resolveModelContext(window)
}
