'use client'

import Link from 'next/link'
import { CONTACT_EMAIL } from '@/lib/legal/contact'

interface LegalErrorProps {
  error: Error & { digest?: string }
  reset: () => void
}

/**
 * A legal page failing to load is different from a marketing page failing: the
 * reader may be here to exercise a right, and a retry button is not an answer
 * if the page stays broken. So the fallback carries the contact address, which
 * is the route that actually has to keep working.
 */
export default function LegalError({ reset }: LegalErrorProps): React.ReactElement {
  return (
    <div className="landing grid min-h-[100dvh] place-items-center bg-[var(--l-bg)] px-4 text-[var(--l-text)]">
      <div className="max-w-[48ch] text-center">
        <h1 className="text-2xl font-medium tracking-tight">This page did not load.</h1>

        <p className="mt-4 text-[15px] leading-relaxed text-[var(--l-muted)]">
          Something failed on our side. If you came here to ask us to stop contacting you, or to
          exercise a privacy right, you do not need this page — email{' '}
          <a href={`mailto:${CONTACT_EMAIL}`} className="underline underline-offset-4">
            {CONTACT_EMAIL}
          </a>{' '}
          and we will act on it either way.
        </p>

        <div className="mt-8 flex flex-wrap justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="rounded-full bg-[var(--l-accent)] px-5 py-2.5 text-sm font-medium text-[var(--l-accent-ink)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
          >
            Try again
          </button>
          <Link
            href="/legal"
            className="rounded-full border border-[var(--l-hairline-strong)] px-5 py-2.5 text-sm transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)] hover:-translate-y-px active:scale-[0.98]"
          >
            All documents
          </Link>
        </div>
      </div>
    </div>
  )
}
