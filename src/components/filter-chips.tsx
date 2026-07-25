import Link from 'next/link'
import { cn } from '@/lib/utils'

export interface FilterOption {
  readonly value: string | null
  readonly label: string
  /** Optional tally shown beside the label. Omit where a count is meaningless. */
  readonly count?: number
  /** Optional swatch, so a status chip carries the same colour as its pill. */
  readonly color?: string
}

interface FilterChipsProps {
  label: string
  /** Query-string key this group writes. `null` value clears the key. */
  param: string
  options: readonly FilterOption[]
  active: string | null
  /** Other query params to carry through so groups compose instead of resetting each other. */
  carry: Readonly<Record<string, string | null>>
  /** Route these chips link back to. */
  pathname: string
  className?: string
}

function hrefFor(
  param: string,
  value: string | null,
  carry: Readonly<Record<string, string | null>>,
  pathname: string,
): string {
  const search = new URLSearchParams()
  for (const [key, carried] of Object.entries(carry)) {
    if (key !== param && carried) search.set(key, carried)
  }
  if (value) search.set(param, value)
  const query = search.toString()
  return query ? `${pathname}?${query}` : pathname
}

/**
 * URL-driven filters rendered as plain links, so filtering works without any
 * client JavaScript and every filtered view is shareable and back-button safe.
 */
export function FilterChips({
  label,
  param,
  options,
  active,
  carry,
  className,
  pathname,
}: FilterChipsProps): React.ReactElement {
  return (
    <div className={cn('flex flex-wrap items-center gap-1.5', className)}>
      <span className="text-faint mr-0.5 text-[11px]">{label}</span>
      {options.map((option) => {
        const isActive = option.value === active
        return (
          <Link
            key={option.value ?? '__all'}
            href={hrefFor(param, option.value, carry, pathname)}
            aria-current={isActive ? 'true' : undefined}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium',
              'transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
              isActive
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {option.color ? (
              <span
                aria-hidden
                className="size-1.5 shrink-0 rounded-full"
                style={{ background: option.color }}
              />
            ) : null}
            {option.label}
            {option.count !== undefined ? (
              <span className={cn('tnum', isActive ? 'opacity-70' : 'text-faint')}>
                {option.count}
              </span>
            ) : null}
          </Link>
        )
      })}
    </div>
  )
}
