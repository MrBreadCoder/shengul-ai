import type { Metadata } from 'next'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import { listCampaignsForClient, type CampaignRow } from '@/lib/db/campaigns'
import { listClients, type ClientOption } from '@/lib/db/clients'
import { formatRelative } from '@/lib/format'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewCampaignForm } from './new-campaign-form'
import { CampaignRowActions } from './campaign-row-actions'
import { CampaignCard } from './campaign-card'
import { CampaignsWebMcpTools } from './campaigns-webmcp-tools'
import type { CampaignDirectoryEntry } from '@/types/webmcp-app'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Campaigns' }

/**
 * Narrows a row to the fields the `listCampaigns` WebMCP tool answers with. The
 * mailbox ids themselves stay behind — an agent needs to know how many
 * mailboxes a campaign sends from, not which.
 */
function toWebMcpEntry({
  id,
  client_id,
  name,
  status,
  value_prop,
  daily_target,
  mailbox_ids,
  created_at,
}: CampaignRow): CampaignDirectoryEntry {
  return {
    id,
    clientId: client_id,
    name,
    status,
    valueProp: value_prop,
    dailyTarget: daily_target,
    mailboxCount: mailbox_ids.length,
    createdAt: created_at,
  }
}

export default async function CampaignsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  const t = await getTranslations('campaigns')
  const isOperator = appUser.role === 'operator'
  const now = new Date()

  // Operators see every campaign via the admin client (no RLS filtering
  // needed — they're allowed to see all of them) plus the new-campaign form
  // and Edit/Stop/Resume/Delete actions. Clients get a read-only view of only
  // their own campaigns: the session-scoped client lets Postgres RLS
  // (`campaigns_select`) do that filtering, the same pattern already used for
  // reply_mode/mailboxes on /settings.
  let campaigns: CampaignRow[]
  let clients: ClientOption[] = []
  if (isOperator) {
    const admin = createAdminClient()
    ;[campaigns, clients] = await Promise.all([
      listCampaignsForClient(admin, null),
      listClients(admin),
    ])
  } else {
    const supabase = await createServerClient()
    campaigns = await listCampaignsForClient(supabase, null)
  }

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <CampaignsWebMcpTools campaigns={campaigns.map(toWebMcpEntry)} />
      <PageHeader
        title={t('pageTitle')}
        description={isOperator ? t('pageDescription') : t('clientPageDescription')}
      />

      {isOperator ? (
        <Section title={t('newCampaignSectionTitle')}>
          {clients.length === 0 ? (
            <EmptyState
              icon={Lightning}
              title={t('noClientsTitle')}
              description={t('noClientsDescription')}
            />
          ) : (
            <NewCampaignForm clients={clients} />
          )}
        </Section>
      ) : null}

      <Section
        title={t('allCampaignsSectionTitle')}
        aside={campaigns.length > 0 ? t('allCampaignsAside', { count: campaigns.length }) : undefined}
      >
        {campaigns.length === 0 ? (
          <EmptyState
            icon={Lightning}
            title={t('noCampaignsTitle')}
            description={isOperator ? t('noCampaignsDescription') : t('noCampaignsDescriptionClient')}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {campaigns.map((campaign, index) => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                leadsPerDayLabel={t('leadsPerDay', { count: campaign.daily_target })}
                mailboxCountLabel={t('mailboxCount', { count: campaign.mailbox_ids.length })}
                createdRelativeLabel={t('createdRelative', { relative: formatRelative(campaign.created_at, now) })}
                animationDelayMs={Math.min(index, 10) * 30}
                actions={
                  isOperator ? (
                    <CampaignRowActions campaignId={campaign.id} campaignName={campaign.name} status={campaign.status} />
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
