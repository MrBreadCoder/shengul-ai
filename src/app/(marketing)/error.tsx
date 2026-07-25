'use client'

import { BOOKING_URL } from '@/components/landing/constants'

interface MarketingErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * The marketing page has one job, so its failure state keeps the conversion
 * path open: retry, or go straight to the scheduler.
 */
export default function MarketingError({ reset }: MarketingErrorProps): React.ReactElement {
  return (
    <div className="landing grid min-h-[100dvh] place-items-center bg-[var(--l-bg)] px-4 text-[var(--l-text)]">
      <div className="max-w-[46ch] text-center">
        <h1 className="text-2xl font-medium tracking-tight">This page did not load.</h1>
        <p className="mt-4 text-[15px] leading-relaxed text-[var(--l-muted)]">
          Something failed on our side. Try again, or book a time directly and we will walk you
          through it.
        </p>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-[var(--l-accent)] px-5 py-2.5 text-sm font-medium text-[var(--l-accent-ink)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
          >
            Try again
          </button>
          <a
            href={BOOKING_URL}
            target="_blank"
            rel="noreferrer"
            className="rounded-full border border-[var(--l-hairline-strong)] px-5 py-2.5 text-sm transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
          >
            Book a meeting
          </a>
        </div>
      </div>
    </div>
  )
}
