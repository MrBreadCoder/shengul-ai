import { getTranslations } from 'next-intl/server'
import { JsonLd } from '@/components/seo/json-ld'
import { buildLandingJsonLd, type FaqEntry } from '@/lib/seo/json-ld'
import { CONTENT_PUBLISHED_AT, CONTENT_UPDATED_AT, SITE_SUMMARY, SITE_SUMMARY_TR } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'
import type { AppLocale } from '@/types/i18n'
import { Capabilities } from './capabilities'
import { ClosingCta } from './closing-cta'
import { NAV_LINKS } from './constants'
import { Faq } from './faq'
import { Hero } from './hero'
import { HowItWorks } from './how-it-works'
import { Outcomes } from './outcomes'
import { Privacy } from './privacy'
import { Safeguards } from './safeguards'
import { SiteFooter } from './site-footer'
import { SiteNav, type SiteNavCopy } from './site-nav'
import { TheGrind } from './the-grind'
import { MarketingWebMcpTools } from './webmcp-tools'

const PAGE_PATH_BY_LOCALE: Record<AppLocale, string> = { en: '/', tr: '/tr' }
const SUMMARY_BY_LOCALE: Record<AppLocale, string> = { en: SITE_SUMMARY, tr: SITE_SUMMARY_TR }

async function buildSiteNavCopy(locale: AppLocale): Promise<SiteNavCopy> {
  const t = await getTranslations({ locale, namespace: 'marketing.nav' })
  return {
    ariaLabel: t('ariaLabel'),
    signIn: t('signIn'),
    openMenu: t('openMenu'),
    closeMenu: t('closeMenu'),
    links: NAV_LINKS.map(({ href, labelKey }) => ({ href, label: t(labelKey) })),
  }
}

/**
 * The full marketing page composition, shared by `/` and `/tr`
 * (`src/app/(marketing)/page.tsx` and `.../tr/page.tsx`). Every section
 * resolves its own copy server-side from `locale` — see the landing i18n
 * design doc for why there is no `NextIntlClientProvider` anywhere here.
 */
export async function LandingPage({ locale }: { locale: AppLocale }): Promise<React.ReactElement> {
  const [navCopy, faqT] = await Promise.all([
    buildSiteNavCopy(locale),
    getTranslations({ locale, namespace: 'marketing.faq' }),
  ])

  const jsonLd = buildLandingJsonLd({
    siteUrl: SITE_URL,
    pagePath: PAGE_PATH_BY_LOCALE[locale],
    locale,
    summary: SUMMARY_BY_LOCALE[locale],
    faqItems: faqT.raw('items') as readonly FaqEntry[],
    publishedAt: CONTENT_PUBLISHED_AT,
    updatedAt: CONTENT_UPDATED_AT,
  })

  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)] text-[var(--l-text)] antialiased">
      <JsonLd data={jsonLd} />
      <MarketingWebMcpTools />
      <SiteNav copy={navCopy} locale={locale} />
      <main>
        <Hero locale={locale} />
        <Outcomes locale={locale} />
        <TheGrind locale={locale} />
        <HowItWorks locale={locale} />
        <Capabilities locale={locale} />
        <Safeguards locale={locale} />
        <Privacy locale={locale} />
        <Faq locale={locale} />
        <ClosingCta locale={locale} />
      </main>
      <SiteFooter locale={locale} showLanguageSwitcher />
    </div>
  )
}
