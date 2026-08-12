import Link from 'next/link'
import { ArrowUpRight, CheckCircle } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { cn } from '@/lib/utils'

interface NeedsActionCardProps {
  draftCount: number
  questionCount: number
  /** Position in the stat-tile bento row, used only to stagger the entrance animation. */
  index?: number
}

// Matches StatTile's cap so this tile never staggers later than its siblings
// despite sitting last in the row.
const MAX_STAGGER_STEPS = 8
const STAGGER_STEP_MS = 40

/**
 * Renders in the same footprint as StatTile (label / value / hint) so it sits
 * flush in the stat bento row instead of breaking into its own full-width
 * banner — one less section stacked below the fold, and the row reads as one
 * coherent "state of the world at a glance" strip.
 */
export async function NeedsActionCard({
  draftCount,
  questionCount,
  index,
}: NeedsActionCardProps): Promise<React.ReactElement> {
  const t = await getTranslations('home')
  const total = draftCount + questionCount
  const isCaughtUp = total === 0
  const style =
    index !== undefined ? { animationDelay: `${Math.min(index, MAX_STAGGER_STEPS) * STAGGER_STEP_MS}ms` } : undefined

  const body = (
    <>
      <div className="flex items-center justify-between gap-2">
        <p className="text-muted-foreground truncate text-xs">{t('sectionNeedsAction')}</p>
        {isCaughtUp ? (
          <CheckCircle size={14} weight="light" className="text-faint shrink-0" />
        ) : (
          <ArrowUpRight
            size={14}
            weight="light"
            className="text-primary shrink-0 transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5"
          />
        )}
      </div>
      <p
        className={cn(
          'tnum mt-2 text-2xl font-semibold tracking-tight',
          isCaughtUp ? 'text-faint' : 'text-primary',
        )}
      >
        {total}
      </p>
      <p className="text-faint mt-1 truncate text-[11px] leading-snug">
        {isCaughtUp ? (
          t('allCaughtUpDescription')
        ) : (
          <>
            {draftCount > 0 ? t('draftsCount', { count: draftCount }) : null}
            {draftCount > 0 && questionCount > 0 ? ' · ' : null}
            {questionCount > 0 ? t('questionsCount', { count: questionCount }) : null}
          </>
        )}
      </p>
    </>
  )

  if (isCaughtUp) {
    return (
      <div className="border-hairline bg-surface animate-rise flex min-w-0 flex-col rounded-lg border p-4" style={style}>
        {body}
      </div>
    )
  }

  return (
    <Link
      href="/inbox"
      className="group border-hairline bg-surface card-interactive animate-rise border-l-primary/60 flex min-w-0 flex-col rounded-lg border border-l-2 p-4"
      style={style}
    >
      {body}
    </Link>
  )
}
