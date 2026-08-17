import type { Metadata } from 'next'
import Link from 'next/link'
import { z } from 'zod'
import { Envelope } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listEmailsForClient } from '@/lib/db/emails'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { PageHeader } from '@/components/page-header'
import { RealtimeRefresher } from '@/components/realtime-refresher'
import { EmptyState } from '@/components/empty-state'
import { EmailMessage } from '@/components/email-message'
import { FilterChips, type FilterOption } from '@/components/filter-chips'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Mail' }

const PAGE_SIZE = 100

// Untrusted query input reaches an `.eq()` filter, so it is whitelisted against
// the database enums rather than passed through.
const searchParamsSchema = z.object({
  direction: z.enum(['outbound', 'inbound']).optional(),
  status: z.enum(['draft', 'queued', 'sent', 'delivered', 'bounced', 'failed']).optional(),
})

interface MailPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function MailPage({ searchParams }: MailPageProps): Promise<React.ReactElement> {
  await requireUser()
  const supabase = await createServerClient()
  const t = await getTranslations('mail')

  const DIRECTION_OPTIONS: readonly FilterOption[] = [
    { value: null, label: t('directionAll') },
    { value: 'outbound', label: t('directionOutbound') },
    { value: 'inbound', label: t('directionReplies') },
  ]
  const STATUS_OPTIONS: readonly FilterOption[] = [
    { value: null, label: t('statusAny') },
    { value: 'draft', label: t('statusDraft') },
    { value: 'sent', label: t('statusSent') },
    { value: 'delivered', label: t('statusDelivered') },
    { value: 'bounced', label: t('statusBounced') },
    { value: 'failed', label: t('statusFailed') },
  ]

  const parsed = searchParamsSchema.safeParse(await searchParams)
  const direction = parsed.success ? (parsed.data.direction ?? null) : null
  const status = parsed.success ? (parsed.data.status ?? null) : null

  const [emails, cases] = await Promise.all([
    listEmailsForClient(supabase, {
      ...(direction ? { direction } : {}),
      ...(status ? { status } : {}),
      limit: PAGE_SIZE,
    }),
    listCaseCompanyNames(supabase),
  ])

  const companyByCaseId = new Map(cases.map((kase) => [kase.id, kase.companyName]))
  const now = new Date()
  const carry = { direction, status }

  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresher channel="mail-messages" />
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <>
            <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
              <span aria-hidden className="bg-primary size-1.5 animate-pulse rounded-full" style={{ animationDuration: '2.4s' }} />
              {t('live')}
            </span>
            <span className="text-muted-foreground tnum text-sm">
              {emails.length === PAGE_SIZE ? t('latestCount', { count: PAGE_SIZE }) : t('messageCount', { count: emails.length })}
            </span>
          </>
        }
      />

      <div className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label={t('directionLabel')}
          param="direction"
          pathname="/mail"
          options={DIRECTION_OPTIONS}
          active={direction}
          carry={carry}
        />
        <FilterChips
          label={t('statusLabel')}
          param="status"
          pathname="/mail"
          options={STATUS_OPTIONS}
          active={status}
          carry={carry}
        />
      </div>

      {emails.length === 0 ? (
        <EmptyState
          icon={Envelope}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : (
        <ul className="flex max-w-[80ch] flex-col gap-3">
          {emails.map((email) => {
            const company = email.case_id ? companyByCaseId.get(email.case_id) : undefined
            return (
              <li key={email.id} className="flex flex-col gap-1.5">
                {email.case_id ? (
                  <Link
                    href={`/cases/${email.case_id}`}
                    className="text-muted-foreground hover:text-foreground w-fit text-[11px] transition-colors duration-200"
                  >
                    {company ?? t('unknownCompany')}
                  </Link>
                ) : (
                  <span className="text-faint text-[11px]">{t('notLinkedToCase')}</span>
                )}
                <EmailMessage
                  direction={email.direction}
                  status={email.status}
                  subject={email.subject}
                  body={email.body}
                  sequenceStep={email.sequence_step}
                  timestamp={email.sent_at ?? email.created_at}
                  now={now}
                  sentByHuman={email.sent_by !== null}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
