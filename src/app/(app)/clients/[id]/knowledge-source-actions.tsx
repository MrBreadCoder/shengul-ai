'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ArrowClockwise, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { Database } from '@/types/database'

interface KnowledgeSourceActionsProps {
  clientId: string
  sourceId: string
  // Taken from the enum rather than spelled out, so adding a source type is a
  // typecheck failure here instead of a silently unhandled branch below.
  sourceType: Database['public']['Enums']['knowledge_source_type']
}

type ActionState = { status: 'idle' } | { status: 'submitting' }

export function KnowledgeSourceActions({ clientId, sourceId, sourceType }: KnowledgeSourceActionsProps): React.ReactElement {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({ status: 'idle' })
  const isSubmitting = state.status === 'submitting'

  async function onRescrape(): Promise<void> {
    setState({ status: 'submitting' })
    const res = await fetch(`/api/clients/${clientId}/knowledge/${sourceId}/rescrape`, { method: 'POST' })
    setState({ status: 'idle' })
    if (!res.ok) {
      toast.error('Could not re-scrape this page')
      return
    }
    toast.success('Re-scrape queued')
    router.refresh()
  }

  async function onDelete(): Promise<void> {
    if (!window.confirm('Remove this from the knowledge base?')) return
    setState({ status: 'submitting' })
    const res = await fetch(`/api/clients/${clientId}/knowledge/${sourceId}`, { method: 'DELETE' })
    setState({ status: 'idle' })
    if (!res.ok) {
      toast.error('Could not delete this source')
      return
    }
    toast.success('Removed from the knowledge base')
    router.refresh()
  }

  return (
    <div className="flex items-center gap-1">
      {sourceType === 'website_page' ? (
        <Button type="button" variant="ghost" size="sm" aria-label="Re-scrape" disabled={isSubmitting} onClick={() => void onRescrape()}>
          <ArrowClockwise size={14} weight="light" />
        </Button>
      ) : null}
      <Button type="button" variant="ghost" size="sm" aria-label="Delete" disabled={isSubmitting} onClick={() => void onDelete()}>
        <Trash size={14} weight="light" />
      </Button>
    </div>
  )
}
