import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCampaignsForClient, type CampaignRow } from '@/lib/db/campaigns'
import { listClients } from '@/lib/db/clients'
import { formatRelative } from '@/lib/format'
import { CAMPAIGN_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewCampaignForm } from './new-campaign-form'
import { CampaignRowActions } from './campaign-row-actions'
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
  if (appUser.role !== 'operator') redirect('/crm')
  const t = await getTranslations('campaigns')

  const admin = createAdminClient()
  const [campaigns, clients] = await Promise.all([
    listCampaignsForClient(admin, null),
    listClients(admin),
  ])
  const now = new Date()

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <CampaignsWebMcpTools campaigns={campaigns.map(toWebMcpEntry)} />
      <PageHeader title={t('pageTitle')} description={t('pageDescription')} />

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

      <Section
        title={t('allCampaignsSectionTitle')}
        aside={campaigns.length > 0 ? t('allCampaignsAside', { count: campaigns.length }) : undefined}
      >
        {campaigns.length === 0 ? (
          <EmptyState
            icon={Lightning}
            title={t('noCampaignsTitle')}
            description={t('noCampaignsDescription')}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {campaigns.map((campaign, index) => (
              <li
                key={campaign.id}
                className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4"
                style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
              >
                <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                  <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
                  <StatusPill meta={CAMPAIGN_STATUS[campaign.status]} />
                </div>

                <p className="text-muted-foreground mt-2.5 max-w-[70ch] text-sm leading-relaxed">
                  {campaign.value_prop}
                </p>

                <div className="text-faint mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
                  <span className="tnum">{t('leadsPerDay', { count: campaign.daily_target })}</span>
                  <span className="tnum">{t('mailboxCount', { count: campaign.mailbox_ids.length })}</span>
                  <span className="ml-auto">{t('createdRelative', { relative: formatRelative(campaign.created_at, now) })}</span>
                </div>

                <div className="border-hairline mt-3 flex items-center gap-2 border-t pt-3">
                  <CampaignRowActions campaignId={campaign.id} campaignName={campaign.name} status={campaign.status} />
                </div>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
