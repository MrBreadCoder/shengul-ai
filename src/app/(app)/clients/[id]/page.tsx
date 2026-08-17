import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { ArrowLeft, Books, ChartLineUp, Lightning, ListMagnifyingGlass, Thermometer, UsersThree } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, listClientRoleAppUsers } from '@/lib/db/clients'
import { listEmailTemplates, getDefaultEmailTemplate } from '@/lib/db/email-templates'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listMailboxesForClient, listMailboxOptionsForClient } from '@/lib/db/mailboxes'
import { listEventsForClient } from '@/lib/db/events'
import { listSourcesForClient } from '@/lib/db/client-knowledge'
import { SEVERITIES_FOR_FILTER } from '@/types/logs'
import type { LogSeverityFilter, LogSource } from '@/types/logs'
import { LogsFeed } from './logs-feed'
import { listAllAuthUsers } from '@/lib/supabase/list-auth-users'
import { formatRelative } from '@/lib/format'
import { CLIENT_STATUS, CAMPAIGN_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { CompanyMark } from '@/components/company-mark'
import { EmptyState } from '@/components/empty-state'
import { KnowledgeSourcesRealtimeRefresher } from '@/components/knowledge-sources-realtime-refresher'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AnalyticsView } from '../../analytics/analytics-view'
import { NewCampaignForm } from '../../campaigns/new-campaign-form'
import { CampaignRowActions } from '../../campaigns/campaign-row-actions'
import { InviteUserDialog } from '../invite-user-dialog'
import { RemoveUserDialog } from '../remove-user-dialog'
import { RenameClientDialog } from './rename-client-dialog'
import { EditDomainDialog } from './edit-domain-dialog'
import { EditSignatureDialog } from './edit-signature-dialog'
import { EditCompanyInfoDialog } from './edit-company-info-dialog'
import { LogoUpload } from './logo-upload'
import { ClientLifecycleActions } from './client-lifecycle-actions'
import { DeleteClientDialog } from './delete-client-dialog'
import { WarmupProfileSelect } from './warmup-profile-select'
import { MailreachToggle } from './mailreach-toggle'
import { DefaultLocaleSelect } from './default-locale-select'
import { EmailTemplateSelect } from './email-template-select'
import { ScheduleSettings } from './schedule-settings'
import { WarmupTab } from './warmup-tab'
import { KnowledgeSitemapPicker } from './knowledge-sitemap-picker'
import { KnowledgeFileUpload } from './knowledge-file-upload'
import { KnowledgeSourcesList } from './knowledge-sources-list'
import { KnowledgeRescrapeAllButton } from './knowledge-rescrape-all-button'
import { ResourcesSection } from './resources-section'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.string().uuid() })
const tabSchema = z.enum(['campaigns', 'warmup', 'analytics', 'users', 'knowledge', 'logs'])

// Spelled out as literals rather than derived from the LOG_* arrays because
// z.enum requires a non-empty tuple, and casting a readonly array into one
// would hide drift instead of catching it. The LogSeverityFilter / LogSource
// annotations on the parse results below are what catch it: if a schema ever
// produces a value outside the shared union, that assignment fails to compile.
const logSeveritySchema = z.enum(['problems', 'errors', 'all'])
const logSourceSchema = z.enum(['app', 'pipeline', 'gemini', 'apollo', 'brightdata', 'mailbox', 'qstash', 'db'])
const logBeforeSchema = z.string().datetime()

// One extra row is fetched to decide whether a "Load older" link is needed,
// then dropped before rendering — cheaper than a separate count query.
const LOGS_PAGE_SIZE = 50

interface ClientDetailPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: ClientDetailPageProps): Promise<Metadata> {
  const parsed = paramsSchema.safeParse(await params)
  if (!parsed.success) return { title: 'Client' }
  const admin = createAdminClient()
  const client = await getClientById(admin, parsed.data.id)
  return { title: client?.name ?? 'Client' }
}

export default async function ClientDetailPage({ params, searchParams }: ClientDetailPageProps): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') notFound()

  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) notFound()
  const clientId = parsedParams.data.id

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) notFound()
  const emailTemplates = await listEmailTemplates(admin)
  // A client's email_template_id can be null (never explicitly set, or reset
  // by a template deletion) — the dropdown always needs a real, resolved
  // selection to display, so fall back to whichever template is default.
  const selectedEmailTemplate =
    emailTemplates.find((template) => template.id === client.email_template_id) ?? (await getDefaultEmailTemplate(admin))
  const t = await getTranslations('clients')

  const [campaigns, clientAppUsers, authUsers, mailboxOptions] = await Promise.all([
    listCampaignsForClient(admin, clientId),
    listClientRoleAppUsers(admin),
    listAllAuthUsers(admin),
    // Unconditional like `campaigns` above: the New Campaign form renders
    // regardless of which tab is active, so its mailbox picker needs this
    // client's options up front rather than gated behind tab === 'campaigns'.
    listMailboxOptionsForClient(admin, clientId),
  ])
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]))
  const users = clientAppUsers
    .filter((row) => row.client_id === clientId)
    .map((row) => ({ id: row.id, email: emailById.get(row.id) ?? t('detail.unknownEmail') }))

  const rawSearchParams = await searchParams
  const requestedTab = tabSchema.safeParse(rawSearchParams.tab)
  const tab = requestedTab.success ? requestedTab.data : 'campaigns'

  const severityFilter = logSeveritySchema.safeParse(rawSearchParams.logSeverity)
  const logSeverity: LogSeverityFilter = severityFilter.success ? severityFilter.data : 'problems'
  const sourceFilter = logSourceSchema.safeParse(rawSearchParams.logSource)
  const logSource: LogSource | null = sourceFilter.success ? sourceFilter.data : null
  const beforeFilter = logBeforeSchema.safeParse(rawSearchParams.logBefore)
  const logBefore = beforeFilter.success ? beforeFilter.data : null

  // Only queried when the tab is actually open: the feed is the most expensive
  // read on this page and the other three tabs never show it.
  const logRows =
    tab === 'logs'
      ? await listEventsForClient(admin, {
          clientId,
          severities: SEVERITIES_FOR_FILTER[logSeverity],
          source: logSource,
          limit: LOGS_PAGE_SIZE + 1,
          before: logBefore,
        })
      : []
  const hasOlderLogs = logRows.length > LOGS_PAGE_SIZE
  const logs = hasOlderLogs ? logRows.slice(0, LOGS_PAGE_SIZE) : logRows
  const nextLogCursor = hasOlderLogs ? (logs[logs.length - 1]?.created_at ?? null) : null

  const knowledgeSources = tab === 'knowledge' ? await listSourcesForClient(admin, clientId) : []
  const mailboxes = tab === 'warmup' ? await listMailboxesForClient(admin, clientId) : []

  const now = new Date()

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5">
        <Link
          href="/clients"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs transition-colors duration-200"
        >
          <ArrowLeft size={13} weight="light" />
          {t('pageTitle')}
        </Link>

        <div className="flex flex-wrap items-start gap-4">
          <CompanyMark
            name={client.name}
            domain={client.domain}
            logoUrl={client.logo_url}
            className="size-11 rounded-lg text-sm"
          />
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{client.name}</h1>
              <RenameClientDialog clientId={client.id} currentName={client.name} />
              <EditDomainDialog clientId={client.id} currentDomain={client.domain} />
              <EditSignatureDialog
                clientId={client.id}
                currentSignatureName={client.signature_name}
                currentSignatureTitle={client.signature_title}
                currentPhone={client.phone}
                currentAddress={client.address}
              />
              <EditCompanyInfoDialog clientId={client.id} currentCompanyInfo={client.company_info} />
              <LogoUpload clientId={client.id} hasLogo={Boolean(client.logo_url)} />
            </div>
            <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>{t('createdRelative', { relative: formatRelative(client.created_at, now) })}</span>
              <span>{t('detail.campaignCount', { count: campaigns.length })}</span>
              <span>{t('detail.loginCount', { count: users.length })}</span>
            </div>
          </div>
          <StatusPill meta={CLIENT_STATUS[client.status]} className="mt-1 px-2.5 py-1 text-xs" />
        </div>

        <div className="border-hairline flex flex-wrap items-center justify-between gap-3 border-t pt-5">
          <div className="flex flex-wrap items-center gap-3">
            <ClientLifecycleActions clientId={client.id} status={client.status} />
            <WarmupProfileSelect clientId={client.id} value={client.warmup_profile} />
            <MailreachToggle clientId={client.id} enabled={client.mailreach_enabled} />
            <DefaultLocaleSelect clientId={client.id} value={client.default_locale} />
            <EmailTemplateSelect clientId={client.id} templates={emailTemplates} selectedTemplateId={selectedEmailTemplate.id} />
            <ScheduleSettings
              clientId={client.id}
              timezone={client.timezone}
              defaultDiscoverTime={client.default_discover_time}
            />
          </div>
          <DeleteClientDialog
            clientId={client.id}
            clientName={client.name}
            campaignCount={campaigns.length}
            userCount={users.length}
          />
        </div>
      </header>

      <Tabs value={tab} className="gap-5">
        <TabsList>
          <TabsTrigger value="campaigns" asChild>
            <Link href={`/clients/${clientId}?tab=campaigns`}>
              <Lightning size={14} weight="light" />
              {t('detail.tabCampaigns')}
              <span className="tnum text-faint">{campaigns.length}</span>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="warmup" asChild>
            <Link href={`/clients/${clientId}?tab=warmup`}>
              <Thermometer size={14} weight="light" />
              {t('detail.tabWarmup')}
            </Link>
          </TabsTrigger>
          <TabsTrigger value="analytics" asChild>
            <Link href={`/clients/${clientId}?tab=analytics`}>
              <ChartLineUp size={14} weight="light" />
              {t('detail.tabAnalytics')}
            </Link>
          </TabsTrigger>
          <TabsTrigger value="users" asChild>
            <Link href={`/clients/${clientId}?tab=users`}>
              <UsersThree size={14} weight="light" />
              {t('detail.tabUsers')}
              <span className="tnum text-faint">{users.length}</span>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="knowledge" asChild>
            <Link href={`/clients/${clientId}?tab=knowledge`}>
              <Books size={14} weight="light" />
              {t('detail.tabKnowledge')}
              <span className="tnum text-faint">{knowledgeSources.length}</span>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="logs" asChild>
            <Link href={`/clients/${clientId}?tab=logs`}>
              <ListMagnifyingGlass size={14} weight="light" />
              {t('detail.tabLogs')}
            </Link>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns">
          <div className="flex max-w-3xl flex-col gap-6">
            <NewCampaignForm
              fixedClientId={client.id}
              fixedClientName={client.name}
              mailboxes={mailboxOptions}
              emailTemplates={emailTemplates}
            />
            {campaigns.length === 0 ? (
              <EmptyState icon={Lightning} title={t('detail.noCampaignsTitle')} description={t('detail.noCampaignsDescription')} />
            ) : (
              <ul className="flex flex-col gap-2">
                {campaigns.map((campaign) => (
                  <li key={campaign.id} className="border-hairline bg-surface rounded-lg border p-4">
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                      <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
                      <StatusPill meta={CAMPAIGN_STATUS[campaign.status]} />
                    </div>
                    <p className="text-muted-foreground mt-1 text-sm">{campaign.value_prop}</p>
                    <div className="border-hairline mt-3 flex items-center gap-2 border-t pt-3">
                      <CampaignRowActions campaignId={campaign.id} campaignName={campaign.name} status={campaign.status} />
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="warmup">
          <WarmupTab mailboxes={mailboxes} />
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsView searchParams={searchParams} scope={{ kind: 'client', clientId: client.id }} />
        </TabsContent>

        <TabsContent value="users">
          <div className="flex max-w-2xl flex-col gap-3">
            <InviteUserDialog clientId={client.id} />
            {users.length === 0 ? (
              <EmptyState icon={UsersThree} title={t('detail.noLoginsTitle')} description={t('detail.noLoginsDescription')} />
            ) : (
              <ul className="flex flex-col gap-2">
                {users.map((user) => (
                  <li
                    key={user.id}
                    className="border-hairline bg-surface flex items-center gap-3 rounded-lg border p-3 text-sm"
                  >
                    <span className="min-w-0 flex-1 truncate">{user.email}</span>
                    <RemoveUserDialog clientId={client.id} userId={user.id} email={user.email} />
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="knowledge">
          <div className="flex flex-col gap-4">
            <KnowledgeSourcesRealtimeRefresher clientId={client.id} />
            <div className="flex flex-wrap items-center justify-between gap-3">
              <p className="text-muted-foreground max-w-[60ch] text-[13px]">{t('detail.knowledgeIntro')}</p>
              <div className="flex items-center gap-2">
                <KnowledgeRescrapeAllButton
                  clientId={client.id}
                  websitePageCount={knowledgeSources.filter((s) => s.source_type === 'website_page').length}
                />
                <KnowledgeFileUpload clientId={client.id} />
              </div>
            </div>
            <KnowledgeSitemapPicker clientId={client.id} />
            <KnowledgeSourcesList clientId={client.id} sources={knowledgeSources} now={now} />
            <ResourcesSection clientId={client.id} />
          </div>
        </TabsContent>

        <TabsContent value="logs">
          <LogsFeed
            clientId={client.id}
            events={logs}
            severityFilter={logSeverity}
            source={logSource}
            nextCursor={nextLogCursor}
            now={now}
          />
        </TabsContent>
      </Tabs>
    </div>
  )
}
