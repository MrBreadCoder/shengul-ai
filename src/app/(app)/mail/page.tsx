import type { Metadata } from 'next'
import Link from 'next/link'
import { z } from 'zod'
import { Envelope } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listEmailsForClient } from '@/lib/db/emails'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { EmailMessage } from '@/components/email-message'
import { FilterChips, type FilterOption } from '@/components/filter-chips'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Mail' }

const PAGE_SIZE = 100

const DIRECTION_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'All' },
  { value: 'outbound', label: 'Outbound' },
  { value: 'inbound', label: 'Replies' },
]

const STATUS_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'Any' },
  { value: 'draft', label: 'Draft' },
  { value: 'sent', label: 'Sent' },
  { value: 'delivered', label: 'Delivered' },
  { value: 'bounced', label: 'Bounced' },
  { value: 'failed', label: 'Failed' },
]

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
      <PageHeader
        title="Mail"
        description="Every message the agent has sent and every reply it has received, newest first."
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {emails.length === PAGE_SIZE
              ? `Latest ${PAGE_SIZE}`
              : `${emails.length} ${emails.length === 1 ? 'message' : 'messages'}`}
          </span>
        }
      />

      <div className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label="Direction"
          param="direction"
          pathname="/mail"
          options={DIRECTION_OPTIONS}
          active={direction}
          carry={carry}
        />
        <FilterChips
          label="Status"
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
          title="No mail matches this view"
          description="Clear the filters above, or wait for the writer agent to draft its next batch."
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
                    {company ?? 'Unknown company'}
                  </Link>
                ) : (
                  <span className="text-faint text-[11px]">Not linked to a case</span>
                )}
                <EmailMessage
                  direction={email.direction}
                  status={email.status}
                  subject={email.subject}
                  body={email.body}
                  sequenceStep={email.sequence_step}
                  timestamp={email.sent_at ?? email.created_at}
                  now={now}
                />
              </li>
            )
          })}
        </ul>
      )}
    </div>
  )
}
