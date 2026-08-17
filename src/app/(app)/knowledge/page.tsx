import type { Metadata } from 'next'
import { z } from 'zod'
import { Brain } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listKnowledgeForClient } from '@/lib/db/case-knowledge'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { PageHeader } from '@/components/page-header'
import { CaseKnowledgeRealtimeRefresher } from '@/components/case-knowledge-realtime-refresher'
import { EmptyState } from '@/components/empty-state'
import { KnowledgeItem } from '@/components/knowledge-item'
import { FilterChips, type FilterOption } from '@/components/filter-chips'
import { KnowledgeTabs } from './knowledge-tabs'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Knowledge' }

const PAGE_SIZE = 100

// Untrusted query input reaches an `.eq()` filter, so it is whitelisted against
// the database enums rather than passed through.
const searchParamsSchema = z.object({
  kind: z.enum(['company', 'person', 'news', 'pain_point', 'answer']).optional(),
  author: z.enum(['agent', 'human']).optional(),
})

interface KnowledgePageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function KnowledgePage({
  searchParams,
}: KnowledgePageProps): Promise<React.ReactElement> {
  await requireUser()
  const supabase = await createServerClient()
  const t = await getTranslations('knowledge')

  const KIND_OPTIONS: readonly FilterOption[] = [
    { value: null, label: t('kindAll') },
    { value: 'company', label: t('kindCompany') },
    { value: 'person', label: t('kindPerson') },
    { value: 'news', label: t('kindNews') },
    { value: 'pain_point', label: t('kindPainPoint') },
    { value: 'answer', label: t('kindAnswer') },
  ]

  const AUTHOR_OPTIONS: readonly FilterOption[] = [
    { value: null, label: t('authorAnyone') },
    { value: 'agent', label: t('authorAgent') },
    { value: 'human', label: t('authorHuman') },
  ]

  const parsed = searchParamsSchema.safeParse(await searchParams)
  const kind = parsed.success ? (parsed.data.kind ?? null) : null
  const author = parsed.success ? (parsed.data.author ?? null) : null

  const [knowledge, cases] = await Promise.all([
    listKnowledgeForClient(supabase, {
      ...(kind ? { kind } : {}),
      ...(author ? { createdBy: author } : {}),
      limit: PAGE_SIZE,
    }),
    listCaseCompanyNames(supabase),
  ])

  const companyByCaseId = new Map(cases.map((kase) => [kase.id, kase.companyName]))
  const now = new Date()
  const carry = { kind, author }

  return (
    <div className="flex flex-col gap-8">
      <CaseKnowledgeRealtimeRefresher />
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
              {knowledge.length === PAGE_SIZE
                ? t('latestCount', { count: PAGE_SIZE })
                : t('factCount', { count: knowledge.length })}
            </span>
          </>
        }
      />

      <KnowledgeTabs />

      <div className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label={t('kindLabel')}
          param="kind"
          pathname="/knowledge"
          options={KIND_OPTIONS}
          active={kind}
          carry={carry}
        />
        <FilterChips
          label={t('authorLabel')}
          param="author"
          pathname="/knowledge"
          options={AUTHOR_OPTIONS}
          active={author}
          carry={carry}
        />
      </div>

      {knowledge.length === 0 ? (
        <EmptyState
          icon={Brain}
          title={t('emptyTitle')}
          description={t('emptyDescription')}
        />
      ) : (
        <div className="flex max-w-[80ch] flex-col gap-3">
          {knowledge.map((fact) => {
            const companyName = companyByCaseId.get(fact.case_id)
            return (
              <KnowledgeItem
                key={fact.id}
                kind={fact.kind}
                content={fact.content}
                sourceUrl={fact.source_url}
                citation={fact.citation}
                createdBy={fact.created_by}
                createdAt={fact.created_at}
                now={now}
                {...(companyName ? { caseLink: { id: fact.case_id, companyName } } : {})}
              />
            )
          })}
        </div>
      )}
    </div>
  )
}
