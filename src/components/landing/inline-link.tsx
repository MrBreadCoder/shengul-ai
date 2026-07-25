import type { ReactNode } from 'react'
import Link from 'next/link'

interface InlineLinkProps {
  readonly href: string
  readonly children: ReactNode
}

const INLINE_LINK_CLASS =
  'underline decoration-[var(--l-hairline-strong)] underline-offset-4 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] hover:decoration-[var(--l-text)]'

/**
 * A link inside body copy, as opposed to the nav and footer.
 *
 * Crawlers and AEO audits weigh in-prose links differently from chrome links:
 * chrome is repeated on every page and says nothing about the page it sits on,
 * so only these count as a real signal about how the content connects.
 *
 * Same-page anchors render as a plain `<a>` — `next/link` would set up client
 * navigation for a scroll that never leaves the route.
 */
export function InlineLink({ href, children }: InlineLinkProps): React.ReactElement {
  if (href.startsWith('#')) {
    return (
      <a href={href} className={INLINE_LINK_CLASS}>
        {children}
      </a>
    )
  }

  return (
    <Link href={href} className={INLINE_LINK_CLASS}>
      {children}
    </Link>
  )
}
