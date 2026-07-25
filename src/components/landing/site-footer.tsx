import Link from 'next/link'
import { LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'
import { BOOKING_URL } from './constants'

const LINK_CLASS =
  'text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]'

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

          {/* Root-relative anchors, not bare fragments: this footer renders on
              the legal pages too, where `#how` would scroll to nothing. */}
          <nav aria-label="Footer" className="flex flex-wrap items-center gap-x-7 gap-y-3 text-[13px]">
            <Link href="/#how" className={LINK_CLASS}>
              How it works
            </Link>
            <Link href="/#privacy" className={LINK_CLASS}>
              Privacy and security
            </Link>
            <Link href="/login" className={LINK_CLASS}>
              Sign in
            </Link>
            <a href={BOOKING_URL} target="_blank" rel="noreferrer" className={LINK_CLASS}>
              Book a meeting
            </a>
          </nav>
        </div>

        <nav
          aria-label="Legal"
          className="mt-10 flex flex-wrap items-center gap-x-6 gap-y-3 border-t border-[var(--l-hairline)] pt-8 text-[12px]"
        >
          {LEGAL_DOCUMENTS.map((document) => (
            <Link key={document.slug} href={legalDocumentPath(document.slug)} className={LINK_CLASS}>
              {document.title}
            </Link>
          ))}
        </nav>

        <p className="mt-8 text-[12px] text-[var(--l-faint)]">
          {year} Shengul AI. Outbound, handled.
        </p>
      </div>
    </footer>
  )
}
