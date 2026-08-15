import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { listMailboxOptionsForClient } from '@/lib/db/mailboxes'
import { listEmailTemplates } from '@/lib/db/email-templates'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { PageHeader } from '@/components/page-header'
import { EditCampaignForm } from './edit-campaign-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Edit campaign' }

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>
}): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') redirect('/crm')
  const t = await getTranslations('campaigns')

  const { campaignId } = await params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) notFound()

  const [client, mailboxes, emailTemplates] = await Promise.all([
    getClientById(admin, campaign.client_id),
    listMailboxOptionsForClient(admin, campaign.client_id),
    listEmailTemplates(admin),
  ])
  // Every row's icp column was written by this same schema (POST /api/campaigns
  // and this route's own PATCH both validate through it before insert/update),
  // so re-parsing it back to typed fields should never fail in practice.
  const icp = apolloIcpSchema.parse(campaign.icp)

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader title={t('editCampaignForm.pageTitle')} description={t('editCampaignForm.pageDescription')} />
      <EditCampaignForm
        campaignId={campaign.id}
        clientName={client?.name ?? t('editCampaignForm.unknownClient')}
        name={campaign.name}
        valueProp={campaign.value_prop ?? ''}
        bookingLink={campaign.booking_link}
        dailyTarget={campaign.daily_target}
        contactsPerCompany={campaign.contacts_per_company}
        icp={icp}
        discoverTime={campaign.discover_time}
        discoverTimezone={campaign.discover_timezone}
        mailboxes={mailboxes}
        mailboxIds={campaign.mailbox_ids}
        signatureName={campaign.signature_name}
        signatureTitle={campaign.signature_title}
        phone={campaign.phone}
        address={campaign.address}
        emailTemplates={emailTemplates}
        emailTemplateId={campaign.email_template_id}
      />
    </div>
  )
}
