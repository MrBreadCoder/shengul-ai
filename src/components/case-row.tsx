import Link from 'next/link'
import { CaretRight, Users } from '@phosphor-icons/react/dist/ssr'
import { CompanyMark } from '@/components/company-mark'
import { StatusPill } from '@/components/status-dot'
import { CASE_STATUS } from '@/lib/ui/status'
import { formatAbsolute, formatRelative, truncate } from '@/lib/format'
import type { Database } from '@/types/database'
import { cn } from '@/lib/utils'

type CaseStatus = Database['public']['Enums']['case_status']

interface CaseRowLead {
  id: string
  full_name: string
  title: string | null
}

interface CaseRowProps {
  id: string
  companyName: string
  companyDomain: string | null
  status: CaseStatus
  summary: string | null
  leads: readonly CaseRowLead[]
  updatedAt: string
  /** Passed in from the Server Component so relative time never re-computes on the client. */
  now: Date
  /** Terminal cases sit at the bottom and read dimmer than live ones. */
  isMuted?: boolean
}

/**
 * Full-width case row. Reads left-to-right as company, context, stage,
 * contacts, age — so a long list stays scannable down a single column of
 * company names, with stage carried as a tag rather than by grouping.
 */
export function CaseRow({
  id,
  companyName,
  companyDomain,
  status,
  summary,
  leads,
  updatedAt,
  now,
  isMuted = false,
}: CaseRowProps): React.ReactElement {
  const lead = leads[0]

  return (
    <Link
      href={`/cases/${id}`}
      className={cn(
        'group hover:bg-surface-raised flex items-center gap-4 px-4 py-3',
        'transition-[background-color,opacity] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
        isMuted && 'opacity-55 hover:opacity-100',
      )}
    >
      <CompanyMark name={companyName} domain={companyDomain} />

      <div className="min-w-0 shrink-0 basis-[190px]">
        <p className="truncate text-[13px] font-medium">{companyName}</p>
        {companyDomain ? (
          <p className="text-faint truncate text-[11px]">{companyDomain}</p>
        ) : null}
      </div>

      {/* Summary is the first thing to go when space runs out. */}
      <p className="text-muted-foreground hidden min-w-0 flex-1 truncate text-xs xl:block">
        {summary ? truncate(summary, 140) : ''}
      </p>

      <StatusPill meta={CASE_STATUS[status]} className="ml-auto shrink-0 xl:ml-0" />

      <span className="text-faint hidden shrink-0 items-center gap-1.5 text-[11px] lg:flex">
        <Users size={12} weight="light" />
        {leads.length === 0 ? (
          'No contacts'
        ) : (
          <span className="max-w-[150px] truncate">
            {leads.length > 1 ? `${lead?.full_name} +${leads.length - 1}` : lead?.full_name}
          </span>
        )}
      </span>

      <time
        dateTime={updatedAt}
        title={formatAbsolute(updatedAt)}
        className="text-faint w-16 shrink-0 text-right text-[11px]"
      >
        {formatRelative(updatedAt, now)}
      </time>

      <CaretRight
        size={13}
        weight="light"
        aria-hidden
        className="text-faint group-hover:text-foreground shrink-0 transition-[color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-0.5"
      />
    </Link>
  )
}
