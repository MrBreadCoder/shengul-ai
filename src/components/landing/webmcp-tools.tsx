'use client'

import { useCallback } from 'react'
import { useWebMcpTools } from '@/lib/webmcp/use-webmcp-tools'
import type { WebMcpTool } from '@/types/webmcp'

/**
 * Registers the marketing page's WebMCP tools. Renders nothing.
 *
 * A sibling of `<JsonLd />` in intent: both hand a machine the page's facts
 * directly instead of making it scrape them. JSON-LD serves the crawler that
 * indexes the page; this serves the agent standing on it.
 *
 * The descriptors are imported lazily so a human visitor never downloads them —
 * see `useWebMcpTools`.
 */
export function MarketingWebMcpTools(): null {
  const loadTools = useCallback(async (): Promise<readonly WebMcpTool[]> => {
    const { buildMarketingWebMcpTools } = await import('@/lib/webmcp/marketing-tools')
    return buildMarketingWebMcpTools()
  }, [])

  useWebMcpTools(loadTools)
  return null
}
