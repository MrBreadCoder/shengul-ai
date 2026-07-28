'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Files, Trash } from '@phosphor-icons/react'
import type { Database } from '@/types/database'
import { KNOWLEDGE_SOURCE_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'

// Keyed by the enum so a new source type cannot reach the table as a blank or
// mislabelled cell. 'pdf' is the legacy value; 'file' covers pdf/txt/md uploads.
// 'resource' is the companion row behind a sendable file — filtered out of this
// list, and labelled here only so the map stays total over the enum.
const SOURCE_TYPE_LABEL: Record<Database['public']['Enums']['knowledge_source_type'], string> = {
  website_page: 'Web page',
  pdf: 'PDF',
  file: 'File',
  resource: 'Resource file',
}

export interface KnowledgeSourceSummary {
  id: string
  clientId: string
  title: string
  sourceType: Database['public']['Enums']['knowledge_source_type']
  status: Database['public']['Enums']['knowledge_source_status']
  charCount: number | null
  /** Whether the viewing user may remove this row (operator, or its uploader). */
  canManage: boolean
}

interface KnowledgeSourcesTableProps {
  sources: readonly KnowledgeSourceSummary[]
  /** Supplied only on the cross-client operator view. */
  clientNameById?: Record<string, string>
}

// A sibling of the client-detail list rather than a variant of it: this view is
// cross-client, per-row permissioned, and deliberately has no re-scrape control
// (re-scraping spends Brightdata credits, so it stays on /clients/[id]).
export function KnowledgeSourcesTable({
  sources,
  clientNameById,
}: KnowledgeSourcesTableProps): React.ReactElement {
  const router = useRouter()
  const [deletingIds, setDeletingIds] = useState<readonly string[]>([])
  const [removedIds, setRemovedIds] = useState<readonly string[]>([])

  const visible = sources.filter((source) => !removedIds.includes(source.id))

  async function onDelete(source: KnowledgeSourceSummary): Promise<void> {
    if (!window.confirm('Remove this from the knowledge base?')) return
    setDeletingIds((ids) => [...ids, source.id])
    try {
      const res = await fetch(`/api/clients/${source.clientId}/knowledge/${source.id}`, {
        method: 'DELETE',
      })
      if (!res.ok) {
        toast.error('Could not delete this source')
        return
      }
      setRemovedIds((ids) => [...ids, source.id])
      toast.success('Removed from the knowledge base')
      router.refresh()
    } catch {
      toast.error('Could not delete this source', {
        description: 'Network request failed. Check your connection and retry.',
      })
    } finally {
      setDeletingIds((ids) => ids.filter((id) => id !== source.id))
    }
  }

  if (visible.length === 0) {
    return (
      <EmptyState
        icon={Files}
        title="No knowledge sources yet"
        description="Upload a PDF, .txt or .md file so the agent can answer from it. Web pages are added by an operator from the client page."
      />
    )
  }

  return (
    <div className="border-hairline overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">Source</TableHead>
            <TableHead scope="col">Type</TableHead>
            {clientNameById ? <TableHead scope="col">Client</TableHead> : null}
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col" className="text-right">Characters</TableHead>
            <TableHead scope="col" className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {visible.map((source) => {
            const isDeleting = deletingIds.includes(source.id)
            return (
              <TableRow key={source.id}>
                <TableCell className="max-w-xs truncate text-[13px]">{source.title}</TableCell>
                <TableCell className="text-muted-foreground text-[13px]">
                  {SOURCE_TYPE_LABEL[source.sourceType]}
                </TableCell>
                {clientNameById ? (
                  <TableCell className="text-muted-foreground text-[13px]">
                    {clientNameById[source.clientId] ?? '—'}
                  </TableCell>
                ) : null}
                <TableCell>
                  <StatusPill meta={KNOWLEDGE_SOURCE_STATUS[source.status]} />
                </TableCell>
                <TableCell className="text-muted-foreground tnum text-right text-[13px]">
                  {source.charCount === null ? '—' : source.charCount.toLocaleString()}
                </TableCell>
                <TableCell className="text-right">
                  {source.canManage ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${source.title}`}
                      disabled={isDeleting}
                      onClick={() => void onDelete(source)}
                    >
                      <Trash size={14} weight="light" />
                    </Button>
                  ) : null}
                </TableCell>
              </TableRow>
            )
          })}
        </TableBody>
      </Table>
    </div>
  )
}
