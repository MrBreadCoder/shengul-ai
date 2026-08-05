import type { Metadata } from 'next'
import { z } from 'zod'
import { Kanban } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listCasesWithLeads } from '@/lib/db/crm'
import { CASE_STATUS } from '@/lib/ui/status'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { CaseRow } from '@/components/case-row'
import { FilterChips, type FilterOption } from '@/components/filter-chips'
import type { Database } from '@/types/database'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Pipeline' }

type CaseStatus = Database['public']['Enums']['case_status']

/** Terminal stages sink below live work; nothing else is reordered. */
const SUNK_STATUSES = new Set<CaseStatus>(['dead', 'lost'])

/** Chip order, funnel-first. Terminal stages sit last, matching the list. */
const STATUS_FILTERS = [
  'new',
  'researching',
  'ready',
  'contacted',
  'in_conversation',
  'hot_handoff',
  'won',
  'lost',
  'dead',
] as const satisfies readonly CaseStatus[]

// Untrusted query input, whitelisted against the database enum.
const searchParamsSchema = z.object({
  status: z.enum(STATUS_FILTERS).optional(),
})

interface CrmPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function CrmPage({ searchParams }: CrmPageProps): Promise<React.ReactElement> {
  await requireUser()
  const supabase = await createServerClient()
  const cases = await listCasesWithLeads(supabase)
  const now = new Date()
  const t = await getTranslations('crm')

  const parsed = searchParamsSchema.safeParse(await searchParams)
  const status = parsed.success ? (parsed.data.status ?? null) : null

  // Counts come from the unfiltered set so every chip keeps showing the true
  // size of its stage, not the size of whatever is currently on screen.
  const countByStatus = new Map<CaseStatus, number>()
  for (const kase of cases) {
    countByStatus.set(kase.status, (countByStatus.get(kase.status) ?? 0) + 1)
  }

  // CASE_STATUS[value].label (from @/lib/ui/status) stays English even in
  // Turkish — it is shared, untranslated, unmodified infrastructure across
  // every already-shipped namespace that renders a case/campaign/client
  // status pill (see Tasks 11-13). Threading translation through it is out of
  // this task's scope; flagged here per the plan rather than left silent.
  const options: FilterOption[] = [
    { value: null, label: t('allLabel'), count: cases.length },
    ...STATUS_FILTERS.map((value) => ({
      value,
      label: CASE_STATUS[value].label,
      count: countByStatus.get(value) ?? 0,
      color: CASE_STATUS[value].color,
    })),
  ]

  const visible = status ? cases.filter((kase) => kase.status === status) : cases

  // One flat list, stage carried as a tag on each row. The query already
  // returns newest-first, so a stable partition preserves that inside each
  // half rather than imposing a second sort.
  const live = visible.filter((kase) => !SUNK_STATUSES.has(kase.status))
  const closed = visible.filter((kase) => SUNK_STATUSES.has(kase.status))
  const ordered = [...live, ...closed]

  return (
    <div className="flex flex-col gap-8">
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {status
              ? t('caseCount', { count: ordered.length })
              : t('liveClosedCount', { live: live.length, closed: closed.length, hasClosed: closed.length > 0 ? 1 : 0 })}
          </span>
        }
      />

      {cases.length > 0 ? (
        <div className="border-hairline rounded-lg border p-3">
          <FilterChips
            label={t('stageLabel')}
            param="status"
            pathname="/crm"
            options={options}
            active={status}
            carry={{ status }}
          />
        </div>
      ) : null}

      {cases.length === 0 ? (
        <EmptyState
          icon={Kanban}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : ordered.length === 0 ? (
        <EmptyState
          icon={Kanban}
          title={status ? t('emptyStageTitle', { stage: CASE_STATUS[status].label.toLowerCase() }) : t('emptyStageTitleGeneric')}
          description={t('emptyStageDescription')}
        />
      ) : (
        <div className="border-hairline divide-hairline bg-surface animate-rise divide-y overflow-hidden rounded-lg border">
          {ordered.map((kase) => (
            <CaseRow
              key={kase.id}
              id={kase.id}
              companyName={kase.company_name}
              companyDomain={kase.company_domain}
              status={kase.status}
              summary={kase.summary}
              leads={kase.leads}
              updatedAt={kase.updated_at}
              now={now}
              isMuted={!status && SUNK_STATUSES.has(kase.status)}
            />
          ))}
        </div>
      )}
    </div>
  )
}
