'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Paperclip, Trash } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { EmptyState } from '@/components/empty-state'
import { formatBytes } from '@/lib/format/bytes'
import type { ResourceContentStatus } from '@/lib/db/client-resources'

export interface ResourceSummary {
  id: string
  clientId: string
  title: string
  description: string | null
  fileName: string
  mimeType: string
  byteSize: number
  contentStatus: ResourceContentStatus
  /** The agent-derived one-liner. Null until the read succeeds. */
  contentSummary: string | null
  /** Whether the viewing user may remove this row (operator, or its uploader). */
  canManage: boolean
}

interface ResourceListProps {
  resources: readonly ResourceSummary[]
  /** Supplied only on the cross-client operator view; omitted when the page is already scoped to one client. */
  clientNameById?: Record<string, string>
}

export function ResourceList({ resources, clientNameById }: ResourceListProps): React.ReactElement {
  const router = useRouter()
  const [deletingIds, setDeletingIds] = useState<readonly string[]>([])
  const [removedIds, setRemovedIds] = useState<readonly string[]>([])
  const [rereadingIds, setRereadingIds] = useState<readonly string[]>([])

  const visible = resources.filter((resource) => !removedIds.includes(resource.id))

  async function onDelete(resource: ResourceSummary): Promise<void> {
    setDeletingIds((ids) => [...ids, resource.id])
    try {
      const res = await fetch(`/api/clients/${resource.clientId}/resources/${resource.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        toast.error('Could not remove the resource', { description: 'Please try again.' })
        return
      }
      // Optimistic removal, then refresh so any other view of the same list
      // (the client detail page, the pickers in /inbox) catches up.
      setRemovedIds((ids) => [...ids, resource.id])
      toast.success('Resource removed', { description: `${resource.title} is no longer sendable.` })
      router.refresh()
    } catch {
      toast.error('Could not remove the resource', {
        description: 'Network request failed. Check your connection and retry.',
      })
    } finally {
      setDeletingIds((ids) => ids.filter((id) => id !== resource.id))
    }
  }

  async function onReread(resource: ResourceSummary): Promise<void> {
    setRereadingIds((ids) => [...ids, resource.id])
    try {
      const res = await fetch(
        `/api/clients/${resource.clientId}/resources/${resource.id}/read`,
        { method: 'POST' },
      )
      // 409 means another tab or operator already started one. Refreshing shows
      // the pending state, which is what the click was asking for anyway.
      if (res.status === 409) {
        toast.info('Already reading this file', { description: 'A read is already in progress.' })
        router.refresh()
        return
      }
      if (!res.ok) {
        toast.error('Could not re-read the file', { description: 'Please try again.' })
        return
      }
      toast.success('Reading the file', { description: `${resource.title} will be read again shortly.` })
      router.refresh()
    } catch {
      toast.error('Could not re-read the file', {
        description: 'Network request failed. Check your connection and retry.',
      })
    } finally {
      setRereadingIds((ids) => ids.filter((id) => id !== resource.id))
    }
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Paperclip}
        title="No resources yet"
        description="Add collateral the agent can send when a lead asks to see something — a portfolio deck, design concepts, a one-pager."
      />
    )
  }

  return (
    <ul className="flex flex-col gap-2">
      {visible.map((resource) => {
        const isDeleting = deletingIds.includes(resource.id)
        const clientName = clientNameById?.[resource.clientId]
        return (
          <li
            key={resource.id}
            className="border-hairline bg-surface flex items-start gap-3 rounded-lg border px-4 py-3"
          >
            <span aria-hidden className="text-muted-foreground mt-0.5 shrink-0">
              <Paperclip size={15} weight="light" />
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[13px] font-medium">{resource.title}</p>
              {resource.description ? (
                <p className="text-muted-foreground max-w-[70ch] text-xs leading-relaxed">
                  {resource.description}
                </p>
              ) : null}
              {resource.contentStatus === 'ready' && resource.contentSummary ? (
                <p className="text-faint mt-1 max-w-[70ch] text-[11px] leading-relaxed">
                  Agent reads: {resource.contentSummary}
                </p>
              ) : null}
              {resource.contentStatus === 'pending' ? (
                <p className="text-faint mt-1 text-[11px]">Reading this file…</p>
              ) : null}
              {resource.contentStatus === 'unsupported' ? (
                <p className="text-faint mt-1 max-w-[70ch] text-[11px] leading-relaxed">
                  This format can’t be analysed — the agent will go on the title and description.
                </p>
              ) : null}
              {resource.contentStatus === 'failed' ? (
                <p className="mt-1 text-[11px]" style={{ color: 'var(--status-lost)' }}>
                  Couldn’t read this file.{' '}
                  {resource.canManage ? (
                    <button
                      type="button"
                      className="underline"
                      disabled={rereadingIds.includes(resource.id)}
                      onClick={() => void onReread(resource)}
                    >
                      {rereadingIds.includes(resource.id) ? 'Re-reading…' : 'Re-read'}
                    </button>
                  ) : null}
                </p>
              ) : null}
              <p className="text-faint tnum mt-1 truncate text-[11px]">
                {resource.fileName} · {formatBytes(resource.byteSize)}
                {clientName ? ` · ${clientName}` : ''}
              </p>
            </div>
            {resource.canManage ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={isDeleting}
                onClick={() => void onDelete(resource)}
                aria-label={`Remove ${resource.title}`}
              >
                <Trash size={14} weight="light" />
                {isDeleting ? 'Removing…' : 'Remove'}
              </Button>
            ) : null}
          </li>
        )
      })}
    </ul>
  )
}
