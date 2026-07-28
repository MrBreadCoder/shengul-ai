import { createAdminClient } from '@/lib/supabase/admin'
import { listActiveResourcesForClient } from '@/lib/db/client-resources'
import { ResourceList, type ResourceSummary } from '@/components/resource-list'
import { ResourceUpload } from '@/components/resource-upload'

// Generous ceiling for a page that renders one row per resource; the AI's menu
// is capped separately at MAX_RESOURCE_MENU.
const PAGE_SIZE = 200

interface ResourcesSectionProps {
  clientId: string
}

export async function ResourcesSection({ clientId }: ResourcesSectionProps): Promise<React.ReactElement> {
  const admin = createAdminClient()
  const resources = await listActiveResourcesForClient(admin, clientId, PAGE_SIZE)

  // This page is operator-only, and an operator manages every row.
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
    canManage: true,
  }))

  return (
    <div className="flex flex-col gap-4">
      <p className="text-muted-foreground max-w-[60ch] text-[13px]">
        Resources — files the agent can send to a lead who asks to see something. The agent
        reads the ones whose format it can read, so it can answer from what is inside as well
        as attach it.
      </p>
      <ResourceUpload clientId={clientId} />
      <ResourceList resources={summaries} />
    </div>
  )
}
