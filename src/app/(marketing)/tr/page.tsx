import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { LandingPage } from '@/components/landing/landing-page'
import { createServerClient } from '@/lib/supabase/server'
import {
  LANDING_DESCRIPTION_TR,
  LANDING_TITLE_TR,
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_NAME,
} from '@/lib/seo/site'

const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: OG_IMAGE_ALT,
} as const

export const metadata: Metadata = {
  title: LANDING_TITLE_TR,
  description: LANDING_DESCRIPTION_TR,
  alternates: { canonical: '/tr', languages: { en: '/', tr: '/tr' } },
  openGraph: {
    type: 'website',
    url: '/tr',
    siteName: SITE_NAME,
    title: `${SITE_NAME} · ${LANDING_TITLE_TR}`,
    description: LANDING_DESCRIPTION_TR,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} · ${LANDING_TITLE_TR}`,
    description: LANDING_DESCRIPTION_TR,
    images: [OG_IMAGE],
  },
}

/**
 * Turkish mirror of `/` — see `src/app/(marketing)/page.tsx` for the shared
 * composition and the landing i18n design doc for why this is a second
 * static route rather than a `[locale]` dynamic segment.
 */
export default async function MarketingPageTurkish(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (data.user) redirect('/crm')

  return <LandingPage locale="tr" />
}
