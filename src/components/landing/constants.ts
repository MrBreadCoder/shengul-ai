/**
 * Shared constants for the public marketing page (`/`).
 *
 * The booking link is the page's single conversion target: every "Book a
 * meeting" control on the page points here, so it lives in exactly one place.
 */
export const BOOKING_URL = 'https://cal.com/shengul-yavuz'

export interface NavLink {
  readonly href: string
  readonly label: string
}

/** In-page anchors. Kept short so the desktop nav never wraps to a second line. */
export const NAV_LINKS: readonly NavLink[] = [
  { href: '#outcomes', label: 'Outcomes' },
  { href: '#how', label: 'How it works' },
  { href: '#safeguards', label: 'Email reputation' },
]

/** Single motion curve for the whole page. No linear, no ease-in-out. */
export const LANDING_EASE: [number, number, number, number] = [0.16, 1, 0.3, 1]
