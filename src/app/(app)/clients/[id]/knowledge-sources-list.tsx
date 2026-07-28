import { Files } from '@phosphor-icons/react/dist/ssr'
import type { Database } from '@/types/database'
import type { KnowledgeSourceRow } from '@/lib/db/client-knowledge'
import { KNOWLEDGE_SOURCE_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { EmptyState } from '@/components/empty-state'
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table'
import { formatRelative } from '@/lib/format'
import { KnowledgeSourceActions } from './knowledge-source-actions'

// Keyed by the enum so a new source type cannot reach the table as a blank or
// mislabelled cell. 'pdf' is the legacy value; 'file' covers pdf/txt/md uploads.
const SOURCE_TYPE_LABEL: Record<Database['public']['Enums']['knowledge_source_type'], string> = {
  website_page: 'Web page',
  pdf: 'PDF',
  file: 'File',
}

interface KnowledgeSourcesListProps {
  clientId: string
  sources: KnowledgeSourceRow[]
  now: Date
}

export function KnowledgeSourcesList({ clientId, sources, now }: KnowledgeSourcesListProps): React.ReactElement {
  if (sources.length === 0) {
    return (
      <EmptyState
        icon={Files}
        title="No knowledge sources yet"
        description="Discover a website above or upload a PDF to start building this client's knowledge base."
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
            <TableHead scope="col">Status</TableHead>
            <TableHead scope="col">Added</TableHead>
            <TableHead scope="col" className="text-right">Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((source) => (
            <TableRow key={source.id}>
              <TableCell className="max-w-xs truncate text-[13px]" title={source.error_message ?? undefined}>
                {source.title}
              </TableCell>
              <TableCell className="text-muted-foreground text-[13px]">
                {SOURCE_TYPE_LABEL[source.source_type]}
              </TableCell>
              <TableCell>
                <StatusPill meta={KNOWLEDGE_SOURCE_STATUS[source.status]} />
              </TableCell>
              <TableCell className="text-muted-foreground text-[13px]">{formatRelative(source.created_at, now)}</TableCell>
              <TableCell className="text-right">
                <KnowledgeSourceActions clientId={clientId} sourceId={source.id} sourceType={source.source_type} />
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  )
}
