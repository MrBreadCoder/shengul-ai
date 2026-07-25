import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { SITE_NAME } from '@/lib/seo/site'

/**
 * The login page is a Client Component and so cannot export `metadata` itself.
 * This layout exists purely to carry it: a sign-in form has nothing to offer a
 * search result, so it is `noindex` while still passing link equity through
 * (`follow`), and it declares its own canonical so the marketing page's URL is
 * never attributed to it.
 */
export const metadata: Metadata = {
  title: 'Sign in',
  description: `Sign in to the ${SITE_NAME} console to review drafts, replies and booked meetings for your campaigns.`,
  alternates: { canonical: '/login' },
  robots: { index: false, follow: true },
}

export default function LoginLayout({ children }: { children: ReactNode }): React.ReactElement {
  return <>{children}</>
}
