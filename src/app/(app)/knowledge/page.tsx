import type { Metadata } from 'next'
import { z } from 'zod'
import { Brain } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listKnowledgeForClient } from '@/lib/db/case-knowledge'
import { listCaseCompanyNames } from '@/lib/db/crm'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { KnowledgeItem } from '@/components/knowledge-item'
import { FilterChips, type FilterOption } from '@/components/filter-chips'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Knowledge' }

const PAGE_SIZE = 100

const KIND_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'All' },
  { value: 'company', label: 'Company' },
  { value: 'person', label: 'Person' },
  { value: 'news', label: 'News' },
  { value: 'pain_point', label: 'Pain point' },
  { value: 'answer', label: 'Answer' },
]

const AUTHOR_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'Anyone' },
  { value: 'agent', label: 'Agent' },
  { value: 'human', label: 'Human' },
]

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
      <PageHeader
        title="Knowledge"
        description="Everything the agent knows, across every case. Research it gathered itself, and answers your operators supplied."
        actions={
          <span className="text-muted-foreground tnum text-sm">
            {knowledge.length === PAGE_SIZE
              ? `Latest ${PAGE_SIZE}`
              : `${knowledge.length} ${knowledge.length === 1 ? 'fact' : 'facts'}`}
          </span>
        }
      />

      <div className="border-hairline flex flex-wrap items-center gap-x-6 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label="Kind"
          param="kind"
          pathname="/knowledge"
          options={KIND_OPTIONS}
          active={kind}
          carry={carry}
        />
        <FilterChips
          label="Author"
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
          title="No knowledge matches this view"
          description="Clear the filters above, or run research on a case to start building the library."
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
