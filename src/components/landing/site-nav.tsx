'use client'

import { useCallback, useEffect, useState } from 'react'
import Link from 'next/link'
import { AnimatePresence, motion, useReducedMotion } from 'motion/react'
import { cn } from '@/lib/utils'
import { BookMeetingButton } from './book-meeting-button'
import { LANDING_EASE, NAV_LINKS } from './constants'

/**
 * Floating navigation for the marketing page. Detached glass pill on desktop,
 * full-screen overlay on mobile. Fixed position, so the backdrop blur is
 * composited once instead of repainting a scrolling subtree.
 */
export function SiteNav(): React.ReactElement {
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
        aria-label="Primary"
        className={cn(
          'flex h-14 w-full max-w-[980px] items-center justify-between gap-6 rounded-full',
          'border border-[var(--l-hairline-strong)] bg-[color-mix(in_oklch,var(--l-bg)_72%,transparent)]',
          'pr-1.5 pl-5 backdrop-blur-2xl',
          'shadow-[inset_0_1px_0_color-mix(in_oklch,white_10%,transparent)]',
        )}
      >
        <Link href="/" className="flex items-center gap-2.5" onClick={closeMenu}>
          <span
            aria-hidden
            className="grid size-7 place-items-center rounded-full bg-[var(--l-accent-soft)] text-[13px] font-semibold text-[var(--l-accent)]"
          >
            B
          </span>
          <span className="text-sm font-semibold tracking-tight">Beacon</span>
        </Link>

        <div className="hidden items-center gap-7 md:flex">
          {NAV_LINKS.map(({ href, label }) => (
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
            Sign in
          </Link>
          <BookMeetingButton className="hidden md:inline-flex" />

          <button
            type="button"
            aria-expanded={isMenuOpen}
            aria-controls="landing-menu"
            aria-label={isMenuOpen ? 'Close menu' : 'Open menu'}
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
              {NAV_LINKS.map(({ href, label }, index) => (
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
                <BookMeetingButton size="lg" />
                <Link href="/login" onClick={closeMenu} className="text-sm text-[var(--l-muted)]">
                  Sign in
                </Link>
              </motion.div>
            </div>
          </motion.div>
        ) : null}
      </AnimatePresence>
    </header>
  )
}
