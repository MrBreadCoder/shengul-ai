import { cn } from '@/lib/utils'
import type { StatusMeta } from '@/lib/ui/status'

interface StatusDotProps {
  meta: StatusMeta
  className?: string
}

/**
 * Semantic state indicator. Never decorative — every dot in this product maps
 * to a real enum value from the database. Only ever rendered inside a pill.
 */
function StatusDot({ meta, className }: StatusDotProps): React.ReactElement {
  return (
    <span
      aria-hidden
      className={cn('size-1.5 shrink-0 rounded-full', className)}
      style={{ background: meta.color }}
    />
  )
}

interface StatusPillProps {
  /**
   * Accepts `undefined` deliberately. Every caller looks this up as
   * `SOME_MAP[row.status]`, which TypeScript treats as total — but the maps are
   * keyed off generated enum types, so a migration that adds an enum value
   * before `src/types/database.ts` is regenerated yields `undefined` at
   * runtime. Degrading to a neutral chip keeps one unmapped row from taking
   * down the whole page.
   */
  meta: StatusMeta | undefined
  className?: string
}

const UNMAPPED: StatusMeta = { label: 'Unknown', color: 'var(--status-dead)' }

export function StatusPill({ meta, className }: StatusPillProps): React.ReactElement {
  const safe = meta ?? UNMAPPED
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2 py-0.5',
        'text-[11px] font-medium whitespace-nowrap',
        className,
      )}
      style={{
        color: safe.color,
        background: `color-mix(in oklch, ${safe.color} 14%, transparent)`,
      }}
    >
      <StatusDot meta={safe} />
      {safe.label}
    </span>
  )
}
