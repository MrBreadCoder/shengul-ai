import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Inter } from 'next/font/google'
import { GeistMono } from 'geist/font/mono'
import { ConsentBanner } from '@/components/consent-banner'
import { Toaster } from '@/components/ui/sonner'
import { publicEnv } from '@/lib/env-public'
import { SITE_DESCRIPTION, SITE_LOCALE, SITE_NAME } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

/**
 * Search-console ownership tokens are optional — most environments (local dev,
 * preview deploys) never set them, and the <meta> tag simply doesn't render.
 */
function buildVerification(): Metadata['verification'] {
  const google = publicEnv.NEXT_PUBLIC_GOOGLE_SITE_VERIFICATION
  const bing = publicEnv.NEXT_PUBLIC_BING_SITE_VERIFICATION
  if (google === undefined && bing === undefined) return undefined
  return {
    ...(google !== undefined ? { google } : {}),
    ...(bing !== undefined ? { other: { 'msvalidate.01': bing } } : {}),
  }
}

export const metadata: Metadata = {
  // Resolves every relative URL below — and each page's `alternates.canonical`
  // — against the real origin. Without it Next emits relative og:url and
  // canonical values, which crawlers resolve inconsistently.
  metadataBase: new URL(SITE_URL),
  title: {
    default: SITE_NAME,
    template: `%s · ${SITE_NAME}`,
  },
  description: SITE_DESCRIPTION,
  applicationName: SITE_NAME,
  alternates: { canonical: '/' },
  verification: buildVerification(),
  openGraph: {
    type: 'website',
    siteName: SITE_NAME,
    locale: SITE_LOCALE,
    url: '/',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
  twitter: {
    card: 'summary_large_image',
    title: SITE_NAME,
    description: SITE_DESCRIPTION,
  },
}

/**
 * Runs before first paint so the stored theme is applied without a flash of the
 * wrong palette. Kept inline and dependency-free on purpose — a React effect
 * would run too late and the user would see the default theme blink.
 */
const NO_FLASH_THEME = `(function(){try{var s=localStorage.getItem('ai-b2b-theme');var d=s?s==='dark':!window.matchMedia('(prefers-color-scheme: light)').matches;document.documentElement.classList.toggle('dark',d)}catch(e){document.documentElement.classList.add('dark')}})()`

// publicEnv validates NEXT_PUBLIC_GTM_ID against /^GTM-[A-Z0-9]+$/ at load time
// (env-public.ts), so it is safe to interpolate directly into the inline script.
const GTM_ID = publicEnv.NEXT_PUBLIC_GTM_ID

/**
 * Google Consent Mode v2 default state, set before GTM's container script
 * loads so no tag can fire un-gated on first paint. Ads consent is hard-denied
 * with no way to grant it — this product runs no advertising. Only
 * `analytics_storage` is ever updated, by the consent banner
 * (`@/lib/consent/consent-mode`) once the visitor makes a choice.
 */
const CONSENT_DEFAULT_SCRIPT = `window.dataLayer=window.dataLayer||[];function gtag(){window.dataLayer.push(arguments)}window.gtag=gtag;gtag('consent','default',{ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied',analytics_storage:'denied'});`

const GTM_SCRIPT = GTM_ID
  ? `(function(w,d,s,l,i){w[l]=w[l]||[];w[l].push({'gtm.start':new Date().getTime(),event:'gtm.js'});var f=d.getElementsByTagName(s)[0],j=d.createElement(s),dl=l!='dataLayer'?'&l='+l:'';j.async=true;j.src='https://www.googletagmanager.com/gtm.js?id='+i+dl;f.parentNode.insertBefore(j,f);})(window,document,'script','dataLayer','${GTM_ID}');`
  : null

export default function RootLayout({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
        {GTM_SCRIPT !== null && (
          <>
            <script dangerouslySetInnerHTML={{ __html: CONSENT_DEFAULT_SCRIPT }} />
            <script dangerouslySetInnerHTML={{ __html: GTM_SCRIPT }} />
          </>
        )}
      </head>
      <body>
        {GTM_ID !== undefined && (
          <noscript>
            <iframe
              src={`https://www.googletagmanager.com/ns.html?id=${GTM_ID}`}
              height="0"
              width="0"
              style={{ display: 'none', visibility: 'hidden' }}
              title="Google Tag Manager"
            />
          </noscript>
        )}
        {children}
        {GTM_ID !== undefined && <ConsentBanner />}
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
