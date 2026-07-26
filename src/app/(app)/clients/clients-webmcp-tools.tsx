'use client'

import { useCallback } from 'react'
import { useWebMcpTools } from '@/lib/webmcp/use-webmcp-tools'
import type { WebMcpTool } from '@/types/webmcp'
import type { ClientDirectoryEntry } from '@/types/webmcp-app'

/**
 * Registers `listClients` for as long as `/clients` is open. Renders nothing.
 *
 * The rows arrive as props because the page already fetched them under the
 * operator's own scope — this component never queries.
 */
export function ClientsWebMcpTools({
  clients,
}: {
  clients: readonly ClientDirectoryEntry[]
}): null {
  const loadTools = useCallback(async (): Promise<readonly WebMcpTool[]> => {
    const { buildClientDirectoryTool } = await import('@/lib/webmcp/app-tools')
    return [buildClientDirectoryTool(clients)]
  }, [clients])

  useWebMcpTools(loadTools)
  return null
}
