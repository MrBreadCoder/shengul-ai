'use client'

import { useCallback } from 'react'
import { useWebMcpTools } from '@/lib/webmcp/use-webmcp-tools'
import type { WebMcpTool } from '@/types/webmcp'
import type { CampaignDirectoryEntry } from '@/types/webmcp-app'

/**
 * Registers `listCampaigns` for as long as `/campaigns` is open. Renders nothing.
 */
export function CampaignsWebMcpTools({
  campaigns,
}: {
  campaigns: readonly CampaignDirectoryEntry[]
}): null {
  const loadTools = useCallback(async (): Promise<readonly WebMcpTool[]> => {
    const { buildCampaignDirectoryTool } = await import('@/lib/webmcp/app-tools')
    return [buildCampaignDirectoryTool(campaigns)]
  }, [campaigns])

  useWebMcpTools(loadTools)
  return null
}
