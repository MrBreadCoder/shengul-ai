import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { SiteNav } from '@/components/landing/site-nav'
import { Hero } from '@/components/landing/hero'
import { Outcomes } from '@/components/landing/outcomes'
import { TheGrind } from '@/components/landing/the-grind'
import { HowItWorks } from '@/components/landing/how-it-works'
import { Capabilities } from '@/components/landing/capabilities'
import { Safeguards } from '@/components/landing/safeguards'
import { Privacy } from '@/components/landing/privacy'
import { Faq } from '@/components/landing/faq'
import { FAQ_ITEMS } from '@/components/landing/faq-items'
import { ClosingCta } from '@/components/landing/closing-cta'
import { SiteFooter } from '@/components/landing/site-footer'
import { JsonLd } from '@/components/seo/json-ld'
import { buildLandingJsonLd } from '@/lib/seo/json-ld'
import {
  CONTENT_PUBLISHED_AT,
  CONTENT_UPDATED_AT,
  LANDING_DESCRIPTION,
  OG_IMAGE_ALT,
  OG_IMAGE_HEIGHT,
  OG_IMAGE_PATH,
  OG_IMAGE_WIDTH,
  SITE_NAME,
  SITE_TITLE,
} from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'

/** Resolved against `metadataBase` in the root layout. */
const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: OG_IMAGE_ALT,
} as const

export const metadata: Metadata = {
  title: SITE_TITLE,
  description: LANDING_DESCRIPTION,
  alternates: { canonical: '/' },
  openGraph: {
    type: 'website',
    url: '/',
    siteName: SITE_NAME,
    title: `${SITE_NAME} · ${SITE_TITLE}`,
    description: LANDING_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} · ${SITE_TITLE}`,
    description: LANDING_DESCRIPTION,
    images: [OG_IMAGE],
  },
}

const LANDING_JSON_LD = buildLandingJsonLd({
  siteUrl: SITE_URL,
  faqItems: FAQ_ITEMS,
  publishedAt: CONTENT_PUBLISHED_AT,
  updatedAt: CONTENT_UPDATED_AT,
})

/**
 * Public marketing page. A signed-in operator has no use for it, so they are
 * sent straight to the board they actually work in — the same reasoning that
 * made `/` redirect to `/crm` before this page existed.
 */
export default async function MarketingPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (data.user) redirect('/crm')

  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)] text-[var(--l-text)] antialiased">
      <JsonLd data={LANDING_JSON_LD} />
      <SiteNav />
      <main>
        <Hero />
        <Outcomes />
        <TheGrind />
        <HowItWorks />
        <Capabilities />
        <Safeguards />
        <Privacy />
        <Faq />
        <ClosingCta />
      </main>
      <SiteFooter />
    </div>
  )
}
