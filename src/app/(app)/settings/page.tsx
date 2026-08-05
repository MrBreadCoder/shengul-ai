import type { Metadata } from 'next'
import { Envelope, Buildings } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listMailboxesForViewer, type MailboxSummary } from '@/lib/db/mailboxes'
import { getClientById } from '@/lib/db/clients'
import { getCrmConnectionForClient } from '@/lib/db/crm-connections'
import { getLatestCrmSyncAt } from '@/lib/db/case-crm-links'
import { getCrmProvider } from '@/lib/crm/registry'
import { parseCrmTokens } from '@/lib/crm/tokens'
import type { CrmPipeline } from '@/lib/crm/provider'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { ConnectButtons } from './connect-buttons'
import { MailboxRow } from './mailbox-row'
import { MailboxesWebMcpTools } from './mailboxes-webmcp-tools'
import { ReplyModeSection } from './reply-mode-section'
import { FollowupCadenceSection } from './followup-cadence-section'
import { ConnectCrmButtons } from './connect-crm-buttons'
import { PipelinePicker } from './pipeline-picker'
import { ConnectionCard } from './connection-card'
import type { MailboxHealthEntry } from '@/types/webmcp-app'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Settings' }

/**
 * Narrows a row to the fields the `getMailboxHealth` WebMCP tool answers with,
 * renaming the Postgres columns to the `camelCase` the tool's schema declares.
 * Stored credentials never appear in `MailboxSummary`, so none can leak here.
 */
function toWebMcpEntry({
  id,
  provider,
  email_address,
  display_name,
  health,
  health_reason,
  daily_cap,
  sent_today,
  warmup_profile,
  warmup_started_at,
}: MailboxSummary): MailboxHealthEntry {
  return {
    id,
    provider,
    emailAddress: email_address,
    displayName: display_name,
    health,
    healthReason: health_reason,
    dailyCap: daily_cap,
    sentToday: sent_today,
    warmupProfile: warmup_profile,
    warmupStartedAt: warmup_started_at,
  }
}

export default async function SettingsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // RLS-scoped on purpose. The admin client would bypass `mailboxes_select` and
  // show a client-role user every other client's connected addresses.
  const supabase = await createServerClient()
  const connected = await listMailboxesForViewer(supabase)
  // Reply mode is a client-owned preference — an operator viewing their own
  // /settings has no client_id and nothing to scope it to.
  const client = appUser.client_id ? await getClientById(supabase, appUser.client_id) : null

  // CRM connection is likewise client-owned — an operator has no client_id
  // and so no connection to show.
  const crmConnection = appUser.client_id
    ? await getCrmConnectionForClient(supabase, appUser.client_id)
    : null
  const canManageCrm = appUser.role === 'client'

  // Only fetched for the setup-incomplete state — a connected client does not
  // need a live pipeline list on every page load.
  let crmPipelines: CrmPipeline[] = []
  if (crmConnection && crmConnection.status === 'connected' && crmConnection.pipeline_id === null) {
    const provider = getCrmProvider(crmConnection.provider)
    const credentials = parseCrmTokens(crmConnection.oauth, crmConnection.id)
    crmPipelines = (await provider.listPipelines(credentials)).pipelines
  }

  const crmLastSyncedAt = crmConnection ? await getLatestCrmSyncAt(supabase, crmConnection.id) : null

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <MailboxesWebMcpTools mailboxes={connected.map(toWebMcpEntry)} />
      <PageHeader
        title="Settings"
        description={`Signed in as ${appUser.role}. Mailboxes connected here are what the agent sends from.`}
      />

      {client ? (
        <Section title="Reply mode">
          <ReplyModeSection currentMode={client.reply_mode} />
        </Section>
      ) : null}

      {client ? (
        <Section title="Follow-up cadence">
          <FollowupCadenceSection initialDelaysDays={client.followup_delays_days} />
        </Section>
      ) : null}

      <Section title="Connect a mailbox">
        <ConnectButtons />
      </Section>

      <Section
        title="Connected mailboxes"
        aside={connected.length > 0 ? `${connected.length} connected` : undefined}
      >
        {connected.length === 0 ? (
          <EmptyState
            icon={Envelope}
            title="No mailboxes connected"
            description="The agent cannot send until at least one mailbox is connected and assigned to a campaign."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {connected.map((mailbox) => (
              <li key={mailbox.id}>
                <MailboxRow
                  id={mailbox.id}
                  provider={mailbox.provider}
                  emailAddress={mailbox.email_address}
                  displayName={mailbox.display_name}
                  health={mailbox.health}
                  healthReason={mailbox.health_reason}
                  warmupProfile={mailbox.warmup_profile}
                  warmupStartedAt={mailbox.warmup_started_at}
                  warmupStartCap={mailbox.warmup_start_cap}
                  warmupIncrement={mailbox.warmup_increment}
                  warmupTargetCap={mailbox.warmup_target_cap}
                  dailyCap={mailbox.daily_cap}
                  sentToday={mailbox.sent_today}
                  viewerRole={appUser.role}
                  mailreachEnabled={mailbox.mailreach_enabled}
                  mailreachStartedAt={mailbox.mailreach_started_at}
                  mailreachStatus={mailbox.mailreach_status}
                  mailreachReputationScore={mailbox.mailreach_reputation_score}
                />
              </li>
            ))}
          </ul>
        )}
      </Section>

      {crmConnection === null ? (
        <Section title="Connect a CRM">
          <EmptyState
            icon={Buildings}
            title="No CRM connected"
            description="Qualified companies stay in this app until you connect a CRM."
          />
          {canManageCrm ? <div className="mt-4"><ConnectCrmButtons /></div> : null}
        </Section>
      ) : crmConnection.status === 'error' ? (
        <Section title="Reconnect required">
          <div className="border-hairline rounded-lg border border-amber-500/40 bg-amber-500/5 p-4">
            <p className="text-[13px] font-medium">Syncing is paused</p>
            <p className="text-muted-foreground mt-1 text-[12px]">
              Your CRM rejected our access ({crmConnection.status_reason ?? 'unknown reason'}). Reconnect to
              resume pushing qualified companies.
            </p>
          </div>
          {canManageCrm ? <div className="mt-4"><ConnectCrmButtons /></div> : null}
        </Section>
      ) : crmConnection.pipeline_id === null ? (
        <Section title="Choose where CRM deals land">
          {canManageCrm ? (
            <PipelinePicker pipelines={crmPipelines} />
          ) : (
            <p className="text-muted-foreground text-[13px]">
              This client has connected {crmConnection.provider} but has not chosen a pipeline yet.
            </p>
          )}
        </Section>
      ) : (
        <Section title="Connected CRM">
          <ConnectionCard
            provider={crmConnection.provider}
            accountLabel={crmConnection.account_label}
            pipelineLabel={crmConnection.pipeline_label}
            lastSyncedAt={crmLastSyncedAt}
            canManage={canManageCrm}
          />
        </Section>
      )}
    </div>
  )
}
