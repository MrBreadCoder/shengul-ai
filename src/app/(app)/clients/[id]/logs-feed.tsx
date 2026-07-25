import Link from 'next/link'
import { ListMagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import type { EventRow } from '@/lib/db/events'
import type { LogSeverityFilter, LogSource } from '@/types/logs'
import { LOG_SEVERITY_FILTERS, LOG_SOURCES } from '@/types/logs'
import { LOG_SEVERITY_FILTER_LABEL, LOG_SEVERITY_META, LOG_SOURCE_META, describeEvent } from '@/lib/ui/log'
import { formatAbsolute, formatRelative } from '@/lib/format'
import { StatusPill } from '@/components/status-dot'
import { EmptyState } from '@/components/empty-state'
import { FilterChips, type FilterOption } from '@/components/filter-chips'

interface LogsFeedProps {
  clientId: string
  events: EventRow[]
  severityFilter: LogSeverityFilter
  source: LogSource | null
  /** Cursor for the next (older) page, or null when this is the last page. */
  nextCursor: string | null
  now: Date
}

const SEVERITY_OPTIONS: readonly FilterOption[] = LOG_SEVERITY_FILTERS.map((value) => ({
  value,
  label: LOG_SEVERITY_FILTER_LABEL[value],
}))

const SOURCE_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'All sources' },
  ...LOG_SOURCES.map((value) => ({
    value,
    label: LOG_SOURCE_META[value].label,
    color: LOG_SOURCE_META[value].color,
  })),
]

export function LogsFeed({
  clientId,
  events,
  severityFilter,
  source,
  nextCursor,
  now,
}: LogsFeedProps): React.ReactElement {
  const pathname = `/clients/${clientId}`
  // `logBefore` is deliberately absent from `carry`: changing a filter must
  // start a fresh page rather than resume from the previous page's cursor.
  const carry = { tab: 'logs', logSeverity: severityFilter, logSource: source }

  return (
    <div className="flex flex-col gap-5">
      <div className="border-hairline flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label="Show"
          param="logSeverity"
          options={SEVERITY_OPTIONS}
          active={severityFilter}
          carry={carry}
          pathname={pathname}
        />
        <FilterChips
          label="Source"
          param="logSource"
          options={SOURCE_OPTIONS}
          active={source}
          carry={carry}
          pathname={pathname}
        />
      </div>

      {events.length === 0 ? (
        <EmptyState
          icon={ListMagnifyingGlass}
          title="Nothing logged here"
          description={
            severityFilter === 'all'
              ? 'This client has no activity yet. Logs appear as soon as a campaign runs.'
              : 'No problems recorded for this client. Switch to "Everything" to see normal activity.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {events.map((event) => (
            <li
              key={event.id}
              className="border-hairline bg-surface flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border p-3"
            >
              <time
                dateTime={event.created_at}
                title={formatAbsolute(event.created_at)}
                className="text-faint tnum w-16 shrink-0 pt-0.5 text-[11px]"
              >
                {formatRelative(event.created_at, now)}
              </time>
              <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
                {describeEvent(event.type, event.payload)}
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusPill meta={LOG_SOURCE_META[event.source]} />
                <StatusPill meta={LOG_SEVERITY_META[event.severity]} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <Link
          href={buildCursorHref(pathname, severityFilter, source, nextCursor)}
          className="border-hairline text-muted-foreground hover:bg-accent hover:text-foreground self-center rounded-full border px-4 py-1.5 text-[11px] font-medium transition-colors duration-200"
        >
          Load older
        </Link>
      ) : null}
    </div>
  )
}

function buildCursorHref(
  pathname: string,
  severityFilter: LogSeverityFilter,
  source: LogSource | null,
  cursor: string,
): string {
  const params = new URLSearchParams({ tab: 'logs', logSeverity: severityFilter, logBefore: cursor })
  if (source) params.set('logSource', source)
  return `${pathname}?${params.toString()}`
}
