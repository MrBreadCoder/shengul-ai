import type { Metadata } from 'next'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { canManageOwnRow } from '@/lib/auth/can-manage-client'
import { listActiveResourcesForVisibleClients } from '@/lib/db/client-resources'
import { listClients } from '@/lib/db/clients'
import { PageHeader } from '@/components/page-header'
import { ResourceList, type ResourceSummary } from '@/components/resource-list'
import { ResourceUpload } from '@/components/resource-upload'
import { KnowledgeTabs } from '../knowledge-tabs'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Resources' }

// Generous ceiling for a page that renders one row per resource; the AI's menu
// is capped separately at MAX_RESOURCE_MENU.
const PAGE_SIZE = 200

export default async function ResourcesPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  const supabase = await createServerClient()

  const [resources, clients] = await Promise.all([
    listActiveResourcesForVisibleClients(supabase, PAGE_SIZE),
    listClients(supabase),
  ])

  // An operator has no single client to scope an upload to, so they upload from
  // /clients/[id] instead and get a client column here rather than a control.
  const isOperator = appUser.role === 'operator'
  const uploadClientId = !isOperator ? appUser.client_id : null

  const summaries: ResourceSummary[] = resources.map((resource) => ({
    id: resource.id,
    clientId: resource.client_id,
    title: resource.title,
    description: resource.description,
    fileName: resource.file_name,
    mimeType: resource.mime_type,
    byteSize: resource.byte_size,
    contentStatus: resource.content_status,
    contentSummary: resource.content_summary,
    canManage: canManageOwnRow(appUser, resource),
  }))

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title="Resources"
        description="Files the agent can send to a lead who asks to see something. The agent reads the ones whose format it can read, so it can also answer from what is inside."
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {summaries.length} {summaries.length === 1 ? 'resource' : 'resources'}
          </span>
        }
      />

      <KnowledgeTabs />

      {uploadClientId ? <ResourceUpload clientId={uploadClientId} /> : null}

      <ResourceList
        resources={summaries}
        {...(isOperator
          ? { clientNameById: Object.fromEntries(clients.map((client) => [client.id, client.name])) }
          : {})}
      />
    </div>
  )
}
