'use client'

import { useEffect } from 'react'
import type { WebMcpTool } from '@/types/webmcp'
import { resolveBrowserModelContext } from './model-context'
import { registerWebMcpTools } from './register'
import { reportBrowserError } from './report-error'

/**
 * Loads and registers a page's WebMCP tools, for as long as the calling
 * component is mounted.
 *
 * `loadTools` is an async factory, not an array, so the descriptors and the Zod
 * schemas behind them stay in a separate chunk that is only fetched once the
 * browser is known to support WebMCP. Almost nobody's browser does yet, and a
 * marketing page should not pay for a capability its visitor cannot use. The
 * eager part — the feature probe — is a property read.
 *
 * `loadTools` must be referentially stable: wrap it in `useCallback` keyed on
 * the data it closes over. An unstable factory re-registers every render.
 *
 * A browser that gains WebMCP *after* this effect runs is not picked up. That
 * cannot currently happen — Chrome exposes `modelContext` before any script
 * executes — and the draft has no event to observe for it.
 */
export function useWebMcpTools(loadTools: () => Promise<readonly WebMcpTool[]>): void {
  useEffect(() => {
    const modelContext = resolveBrowserModelContext()
    // No WebMCP: nothing is registered and, deliberately, nothing is fetched.
    if (modelContext === null) return

    const controller = new AbortController()

    void (async (): Promise<void> => {
      try {
        const tools = await loadTools()
        if (controller.signal.aborted) return

        const result = await registerWebMcpTools({ modelContext, tools, signal: controller.signal })
        // 'aborted' is ordinary cleanup. A rejection from a browser that does
        // have WebMCP means a malformed descriptor — a bug worth surfacing.
        if (result.status === 'failed') reportBrowserError(result.error)
      } catch (error) {
        // The dynamic import itself failed: a chunk 404 after a redeploy, or an
        // offline navigation. The page is unaffected; the tools just never appear.
        reportBrowserError(error)
      }
    })()

    return () => controller.abort()
  }, [loadTools])
}
