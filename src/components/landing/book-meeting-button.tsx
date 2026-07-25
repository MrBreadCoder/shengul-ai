import { ArrowUpRight } from '@phosphor-icons/react/dist/ssr'
import { cn } from '@/lib/utils'
import { BOOKING_URL } from './constants'

interface BookMeetingButtonProps {
  size?: 'md' | 'lg'
  className?: string
}

const SIZE_CLASSES: Record<'md' | 'lg', string> = {
  md: 'py-1.5 pr-1.5 pl-5 text-sm',
  lg: 'py-2 pr-2 pl-7 text-[15px]',
}

const NESTED_SIZE_CLASSES: Record<'md' | 'lg', string> = {
  md: 'size-8',
  lg: 'size-10',
}

/**
 * The page's one conversion control. The label is fixed on purpose: the same
 * words appear in the nav, the hero and the closing band, so a visitor never
 * has to work out that three differently-named buttons do the same thing.
 *
 * Opens the scheduler in a new tab, so a half-read page is never lost.
 */
export function BookMeetingButton({
  size = 'md',
  className,
}: BookMeetingButtonProps): React.ReactElement {
  return (
    <a
      href={BOOKING_URL}
      target="_blank"
      rel="noreferrer"
      className={cn(
        'group inline-flex items-center gap-3 rounded-full font-medium whitespace-nowrap',
        'bg-[var(--l-accent)] text-[var(--l-accent-ink)]',
        'transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
        'hover:-translate-y-px active:scale-[0.98]',
        SIZE_CLASSES[size],
        className,
      )}
    >
      Book a meeting
      <span
        aria-hidden
        className={cn(
          'grid shrink-0 place-items-center rounded-full',
          'bg-[color-mix(in_oklch,var(--l-accent-ink)_16%,transparent)]',
          'transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
          'group-hover:translate-x-0.5 group-hover:-translate-y-px group-hover:scale-105',
          NESTED_SIZE_CLASSES[size],
        )}
      >
        <ArrowUpRight weight="light" className="size-4" />
      </span>
    </a>
  )
}
