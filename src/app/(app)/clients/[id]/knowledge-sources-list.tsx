import { Files } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
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
// 'resource' is the companion row behind a sendable file — filtered out of this
// list, and labelled here only so the map stays total over the enum.
const SOURCE_TYPE_KEY: Record<Database['public']['Enums']['knowledge_source_type'], string> = {
  website_page: 'sourcesList.typeWebPage',
  pdf: 'sourcesList.typePdf',
  file: 'sourcesList.typeFile',
  resource: 'sourcesList.typeResource',
}

interface KnowledgeSourcesListProps {
  clientId: string
  sources: KnowledgeSourceRow[]
  now: Date
}

export async function KnowledgeSourcesList({ clientId, sources, now }: KnowledgeSourcesListProps): Promise<React.ReactElement> {
  const t = await getTranslations('clients')

  if (sources.length === 0) {
    return (
      <EmptyState
        icon={Files}
        title={t('sourcesList.emptyTitle')}
        description={t('sourcesList.emptyDescription')}
      />
    )
  }

  return (
    <div className="border-hairline overflow-x-auto rounded-lg border">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('sourcesList.source')}</TableHead>
            <TableHead scope="col">{t('sourcesList.type')}</TableHead>
            <TableHead scope="col">{t('sourcesList.status')}</TableHead>
            <TableHead scope="col">{t('sourcesList.added')}</TableHead>
            <TableHead scope="col" className="text-right">{t('sourcesList.actions')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sources.map((source) => (
            <TableRow key={source.id}>
              <TableCell className="max-w-xs truncate text-[13px]" title={source.error_message ?? undefined}>
                {source.title}
              </TableCell>
              <TableCell className="text-muted-foreground text-[13px]">
                {t(SOURCE_TYPE_KEY[source.source_type] as 'sourcesList.typeWebPage')}
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
