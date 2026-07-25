import { cn } from '@/lib/utils'

interface PageSkeletonProps {
  /** Number of placeholder rows below the header block. */
  rows?: number
  /** Matches the real content shape so nothing shifts when content arrives. */
  variant?: 'list' | 'tiles' | 'rows'
}

function Bar({ className }: { className?: string }): React.ReactElement {
  return <div className={cn('skeleton rounded-md', className)} />
}

/**
 * Mirrors the layout of the page it stands in for, so the transition to real
 * content does not shift anything. A generic spinner would not do that.
 */
export function PageSkeleton({ rows = 4, variant = 'list' }: PageSkeletonProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-8" aria-busy="true" aria-live="polite">
      <span className="sr-only">Loading</span>

      <div className="flex flex-col gap-3">
        <Bar className="h-7 w-44" />
        <Bar className="h-4 w-full max-w-[52ch]" />
      </div>

      {variant === 'tiles' ? (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
          {Array.from({ length: 8 }, (_, index) => (
            <Bar key={index} className="h-[92px]" />
          ))}
        </div>
      ) : variant === 'rows' ? (
        <Bar className="h-[420px] w-full" />
      ) : (
        <div className="flex max-w-[80ch] flex-col gap-3">
          {Array.from({ length: rows }, (_, index) => (
            <Bar key={index} className="h-32" />
          ))}
        </div>
      )}
    </div>
  )
}
