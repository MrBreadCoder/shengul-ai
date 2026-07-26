'use client'

import { useCallback } from 'react'
import { useWebMcpTools } from '@/lib/webmcp/use-webmcp-tools'
import type { WebMcpTool } from '@/types/webmcp'
import type { MailboxHealthEntry } from '@/types/webmcp-app'

/**
 * Registers `getMailboxHealth` for as long as `/settings` is open. Renders nothing.
 *
 * The rows come from the page's RLS-scoped query, so a client-role viewer's
 * agent sees exactly the mailboxes that viewer sees.
 */
export function MailboxesWebMcpTools({
  mailboxes,
}: {
  mailboxes: readonly MailboxHealthEntry[]
}): null {
  const loadTools = useCallback(async (): Promise<readonly WebMcpTool[]> => {
    const { buildMailboxHealthTool } = await import('@/lib/webmcp/app-tools')
    return [buildMailboxHealthTool(mailboxes)]
  }, [mailboxes])

  useWebMcpTools(loadTools)
  return null
}
