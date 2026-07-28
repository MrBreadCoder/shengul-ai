import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { canManageOwnRow } from '@/lib/auth/can-manage-client'
import { listSourcesForVisibleClients } from '@/lib/db/client-knowledge'
import { listClients } from '@/lib/db/clients'
import { PageHeader } from '@/components/page-header'
import { KnowledgeTabs } from '../knowledge-tabs'
import { KnowledgeSourcesTable, type KnowledgeSourceSummary } from './sources-list'
import { KnowledgeFileUpload } from '@/app/(app)/clients/[id]/knowledge-file-upload'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Knowledge sources' }

export default async function KnowledgeSourcesPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  const supabase = await createServerClient()

  const [sources, clients] = await Promise.all([
    listSourcesForVisibleClients(supabase),
    listClients(supabase),
  ])

  // An operator has no single client to scope an upload to, so they upload from
  // /clients/[id] instead and get a client column here rather than a control.
  const isOperator = appUser.role === 'operator'
  const uploadClientId = !isOperator ? appUser.client_id : null

  const summaries: KnowledgeSourceSummary[] = sources.map((source) => ({
    id: source.id,
    clientId: source.client_id,
    title: source.title,
    sourceType: source.source_type,
    status: source.status,
    charCount: source.char_count,
    canManage: canManageOwnRow(appUser, source),
  }))

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Knowledge sources"
        description="Pages and files the agent reads to answer better. These are never sent to a lead."
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {summaries.length} {summaries.length === 1 ? 'source' : 'sources'}
          </span>
        }
      />

      <KnowledgeTabs />

      {uploadClientId ? <KnowledgeFileUpload clientId={uploadClientId} /> : null}

      <KnowledgeSourcesTable
        sources={summaries}
        {...(isOperator
          ? { clientNameById: Object.fromEntries(clients.map((client) => [client.id, client.name])) }
          : {})}
      />
    </div>
  )
}
