import Link from 'next/link'
import { BOOKING_URL } from './constants'

export function SiteFooter(): React.ReactElement {
  // Read per render, not at module scope: a long-lived server process would
  // otherwise keep printing the year it booted in.
  const year = new Date().getFullYear()

  return (
    <footer className="px-4 pb-12">
      <div className="mx-auto max-w-[1180px] border-t border-[var(--l-hairline)] pt-10">
        <div className="flex flex-col gap-8 sm:flex-row sm:items-center sm:justify-between">
          <div className="flex items-center">
            <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
          </div>

          <nav aria-label="Footer" className="flex items-center gap-7 text-[13px]">
            <a href="#how" className="text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]">
              How it works
            </a>
            <a
              href="#privacy"
              className="text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]"
            >
              Privacy and security
            </a>
            <Link
              href="/login"
              className="text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]"
            >
              Sign in
            </Link>
            <a
              href={BOOKING_URL}
              target="_blank"
              rel="noreferrer"
              className="text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]"
            >
              Book a meeting
            </a>
          </nav>
        </div>

        <p className="mt-10 text-[12px] text-[var(--l-faint)]">
          {year} Shengul AI. Outbound, handled.
        </p>
      </div>
    </footer>
  )
}
