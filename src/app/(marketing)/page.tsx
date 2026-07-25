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
import { ClosingCta } from '@/components/landing/closing-cta'
import { SiteFooter } from '@/components/landing/site-footer'

export const metadata: Metadata = {
  title: 'Outbound, handled',
  description:
    'Leads found, emails sent, replies answered, meetings booked. You describe the buyer, we do the outbound, and you take the meetings. Book a call to see what your first month would look like.',
  openGraph: {
    title: 'Beacon · More meetings, none of the outbound',
    description:
      'Four numbers we report on: leads found, emails sent, replies, meetings booked. You close the fifth.',
    type: 'website',
  },
}

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
