'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { LANDING_EASE } from './constants'

export interface SiteNavLink {
  readonly href: string
  readonly label: string
}

export interface SiteNavCopy {
  readonly ariaLabel: string
  readonly links: readonly SiteNavLink[]
  readonly signIn: string
  readonly openMenu: string
  readonly closeMenu: string
}

interface SiteNavProps {
  readonly copy: SiteNavCopy
  /**
   * Pre-rendered by the server parent (`landing-page.tsx`), not imported and
   * rendered here directly: `BookMeetingButton` is an async Server Component
   * that calls `getTranslations`, and next-intl's server-only runtime cannot
   * run in a Client Component. Importing its module into this `'use client'`
   * file — even just to render it — pulls that call into the client bundle
   * and throws "`getTranslations` is not supported in Client Components" at
   * render time. Receiving it as an opaque `ReactNode` prop is the supported
   * way to compose a Server Component inside a Client Component.
   */
  readonly bookMeetingButtonDesktop: React.ReactNode
  readonly bookMeetingButtonMobile: React.ReactNode
}

/**
 * Floating navigation for the marketing page. Detached glass pill on desktop,
 * full-screen overlay on mobile. Fixed position, so the backdrop blur is
 * composited once instead of repainting a scrolling subtree.
 *
 * Translated strings arrive pre-resolved via `copy` rather than this
 * component calling into next-intl itself: it is the only client component
 * on the marketing page, and resolving server-side keeps next-intl's message
 * catalog (and its client runtime) out of the browser bundle entirely.
 */
export function SiteNav({
  copy,
  bookMeetingButtonDesktop,
  bookMeetingButtonMobile,
}: SiteNavProps): React.ReactElement {
  const [isMenuOpen, setIsMenuOpen] = useState(false)
  const prefersReducedMotion = useReducedMotion()

  const closeMenu = useCallback(() => setIsMenuOpen(false), [])

  // Escape closes the overlay, and the page behind it must not scroll while a
  // full-screen menu is covering it.
  useEffect(() => {
    if (!isMenuOpen) return
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setIsMenuOpen(false)
    }
    const previousOverflow = document.body.style.overflow
    document.body.style.overflow = 'hidden'
    window.addEventListener('keydown', onKeyDown)
    return () => {
      document.body.style.overflow = previousOverflow
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [isMenuOpen])

  return (
    <header className="fixed inset-x-0 top-0 z-40 flex justify-center px-4 pt-5">
      <nav
        aria-label={copy.ariaLabel}
        className={cn(
          'flex h-14 w-full max-w-[980px] items-center justify-between gap-6 rounded-full',
          'border border-[var(--l-hairline-strong)] bg-[color-mix(in_oklch,var(--l-bg)_72%,transparent)]',
          'pr-1.5 pl-5 backdrop-blur-2xl',
          'shadow-[inset_0_1px_0_color-mix(in_oklch,white_10%,transparent)]',
        )}
      >
        <Link href="/" className="flex items-center" onClick={closeMenu}>
          <span className="text-sm font-semibold tracking-tight">Shengul AI</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {copy.links.map(({ href, label }) => (
            <a
              key={href}
              href={href}
              className="text-[13px] text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)]"
            >
              {label}
            </a>
          ))}
        </div>

        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="hidden rounded-full px-3 py-2 text-[13px] text-[var(--l-muted)] transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] md:inline-flex"
          >
            {copy.signIn}
          </Link>
          {bookMeetingButtonDesktop}

          <button
            type="button"
            aria-expanded={isMenuOpen}
            aria-controls="landing-menu"
            aria-label={isMenuOpen ? copy.closeMenu : copy.openMenu}
            onClick={() => setIsMenuOpen((open) => !open)}
            className="relative grid size-11 place-items-center rounded-full md:hidden"
          >
            <span
              aria-hidden
              className={cn(
                'absolute h-px w-5 bg-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
                isMenuOpen ? 'translate-y-0 rotate-45' : '-translate-y-1',
              )}
            />
            <span
              aria-hidden
              className={cn(
                'absolute h-px w-5 bg-[var(--l-text)] transition-transform duration-500 ease-[cubic-bezier(0.32,0.72,0,1)]',
                isMenuOpen ? 'translate-y-0 -rotate-45' : 'translate-y-1',
              )}
            />
          </button>
        </div>
      </nav>

      <AnimatePresence>
        {isMenuOpen ? (
          <motion.div
            id="landing-menu"
            key="landing-menu"
            initial={prefersReducedMotion ? false : { opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={prefersReducedMotion ? { opacity: 1 } : { opacity: 0 }}
            transition={{ duration: 0.35, ease: LANDING_EASE }}
            className="fixed inset-0 -z-10 flex flex-col justify-end bg-[color-mix(in_oklch,var(--l-bg-deep)_88%,transparent)] px-6 pt-28 pb-14 backdrop-blur-3xl md:hidden"
          >
            <div className="flex flex-col gap-6">
              {copy.links.map(({ href, label }, index) => (
                <motion.a
                  key={href}
                  href={href}
                  onClick={closeMenu}
                  initial={prefersReducedMotion ? false : { opacity: 0, y: 26 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.55, delay: 0.06 * index, ease: LANDING_EASE }}
                  className="text-3xl tracking-tight"
                >
                  {label}
                </motion.a>
              ))}
              <motion.div
                initial={prefersReducedMotion ? false : { opacity: 0, y: 26 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.55, delay: 0.18, ease: LANDING_EASE }}
                className="mt-4 flex flex-col items-start gap-5"
              >
                {bookMeetingButtonMobile}
                <Link href="/login" onClick={closeMenu} className="text-sm text-[var(--l-muted)]">
                  {copy.signIn}
                </Link>
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  )
}
