import type { Metadata } from 'next'
import { Buildings } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { getCrmConnectionForClient } from '@/lib/db/crm-connections'
import { getLatestCrmSyncAt } from '@/lib/db/case-crm-links'
import { getCrmProvider } from '@/lib/crm/registry'
import { parseCrmTokens } from '@/lib/crm/tokens'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import type { CrmPipeline } from '@/lib/crm/provider'
import { ConnectCrmButtons } from './connect-crm-buttons'
import { PipelinePicker } from './pipeline-picker'
import { ConnectionCard } from './connection-card'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'CRM' }

export default async function CrmSettingsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // RLS-scoped on purpose: the admin client would show a client-role user
  // another tenant's connection.
  const supabase = await createServerClient()
  const connection = appUser.client_id
    ? await getCrmConnectionForClient(supabase, appUser.client_id)
    : null
  const canManage = appUser.role === 'client'

  // Only fetched for the setup-incomplete state — a connected client does not
  // need a live pipeline list on every page load.
  let pipelines: CrmPipeline[] = []
  if (connection && connection.status === 'connected' && connection.pipeline_id === null) {
    const provider = getCrmProvider(connection.provider)
    const credentials = parseCrmTokens(connection.oauth, connection.id)
    pipelines = (await provider.listPipelines(credentials)).pipelines
  }

  const lastSyncedAt = connection ? await getLatestCrmSyncAt(supabase, connection.id) : null

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader
        title="CRM"
        description="Connect your CRM and qualified companies are pushed to it as deals, with notes as each one progresses."
      />

      {connection === null ? (
        <Section title="Connect a CRM">
          <EmptyState
            icon={Buildings}
            title="No CRM connected"
            description="Qualified companies stay in this app until you connect a CRM."
          />
          {canManage ? <div className="mt-4"><ConnectCrmButtons /></div> : null}
        </Section>
      ) : connection.status === 'error' ? (
        <Section title="Reconnect required">
          <div className="border-hairline rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <p className="text-[13px] font-medium">Syncing is paused</p>
            <p className="text-muted-foreground mt-1 text-[12px]">
              Your CRM rejected our access ({connection.status_reason ?? 'unknown reason'}). Reconnect to
              resume pushing qualified companies.
            </p>
          </div>
          {canManage ? <div className="mt-4"><ConnectCrmButtons /></div> : null}
        </Section>
      ) : connection.pipeline_id === null ? (
        <Section title="Choose where deals land">
          {canManage ? (
            <PipelinePicker pipelines={pipelines} />
          ) : (
            <p className="text-muted-foreground text-[13px]">
              This client has connected {connection.provider} but has not chosen a pipeline yet.
            </p>
          )}
        </Section>
      ) : (
        <Section title="Connected CRM">
          <ConnectionCard
            provider={connection.provider}
            accountLabel={connection.account_label}
            pipelineLabel={connection.pipeline_label}
            lastSyncedAt={lastSyncedAt}
            canManage={canManage}
          />
        </Section>
      )}
    </div>
  )
}
