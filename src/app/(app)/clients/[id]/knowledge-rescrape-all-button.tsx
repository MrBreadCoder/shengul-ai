'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowsClockwise } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

interface KnowledgeRescrapeAllButtonProps {
  clientId: string
  websitePageCount: number
}

type ActionState = { status: 'idle' } | { status: 'submitting' }

export function KnowledgeRescrapeAllButton({ clientId, websitePageCount }: KnowledgeRescrapeAllButtonProps): React.ReactElement | null {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({ status: 'idle' })

  // No web-page sources to re-scrape (a client with only file uploads, or
  // none at all) — nothing for this action to do.
  if (websitePageCount === 0) return null

  async function onRescrapeAll(): Promise<void> {
    if (!window.confirm(`Re-scrape all ${websitePageCount} web page source(s) for this client?`)) return
    setState({ status: 'submitting' })
    const res = await fetch(`/api/clients/${clientId}/knowledge/rescrape-all`, { method: 'POST' })
    setState({ status: 'idle' })
    if (!res.ok) {
      toast.error('Could not queue re-scrapes')
      return
    }
    const json = (await res.json()) as { queued: number; failed: number }
    if (json.failed > 0) {
      toast.warning(`Queued ${json.queued} re-scrape(s), ${json.failed} failed to queue`)
    } else {
      toast.success(`Queued ${json.queued} re-scrape(s)`)
    }
    router.refresh()
  }

  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={state.status === 'submitting'}
      onClick={() => void onRescrapeAll()}
    >
      <ArrowsClockwise size={14} weight="light" />
      Re-scrape all
    </Button>
  )
}
