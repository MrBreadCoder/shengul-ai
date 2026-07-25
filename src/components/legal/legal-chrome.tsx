import Link from 'next/link'
import { BookMeetingButton } from '@/components/landing/book-meeting-button'
import {
  CONTACT_ADDRESS_LINES,
  CONTACT_EMAIL,
  CONTACT_PHONE,
  PRODUCT_NAME,
} from '@/lib/legal/contact'

/**
 * Header for a legal page.
 *
 * Deliberately not the marketing `SiteNav`: that nav is a row of in-page
 * anchors that exist only on `/`, so reusing it here would give a reader four
 * links that quietly do nothing. A document page needs a way home, a way in,
 * and nothing else.
 */
export function LegalHeader(): React.ReactElement {
  return (
    <header className="px-4 pt-8">
      <div className="mx-auto flex max-w-[1180px] items-center justify-between gap-6">
        <Link href="/" className="text-sm font-semibold tracking-tight">
          {PRODUCT_NAME}
        </Link>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden rounded-full px-3 py-2 text-[13px] text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] sm:inline-flex"
          >
            Sign in
          </Link>
          <BookMeetingButton />
        </div>
      </div>
    </header>
  )
}

/**
 * The contact block every document ends with.
 *
 * Several documents tell the reader that "full contact details are at the foot
 * of this page", so this is not decoration — it is the address by which someone
 * exercises a right, and it renders on every legal page for that reason.
 */
export function LegalContact(): React.ReactElement {
  return (
    <section
      aria-label="Contact details"
      className="mt-20 border-t border-[var(--l-hairline)] pt-10"
    >
      <h2 className="text-[13px] font-medium tracking-tight">Contact</h2>

      <address className="mt-4 flex flex-col gap-1 text-[14px] leading-relaxed text-[var(--l-muted)] not-italic">
        {CONTACT_ADDRESS_LINES.map((line) => (
          <span key={line}>{line}</span>
        ))}
        <span className="mt-3">
          <a href={`mailto:${CONTACT_EMAIL}`} className="hover:text-[var(--l-text)]">
            {CONTACT_EMAIL}
          </a>
        </span>
        <span>{CONTACT_PHONE}</span>
      </address>
    </section>
  )
}
