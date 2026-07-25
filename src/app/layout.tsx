import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { Inter } from 'next/font/google'
import { GeistMono } from 'geist/font/mono'
import { Toaster } from '@/components/ui/sonner'
import { SITE_DESCRIPTION, SITE_LOCALE, SITE_NAME } from '@/lib/seo/site'
import { SITE_URL } from '@/lib/seo/site-url'
import './globals.css'

const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
})

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

export default function RootLayout({ children }: { children: ReactNode }): React.ReactElement {
  return (
    <html
      lang="en"
      className={`${inter.variable} ${GeistMono.variable}`}
      suppressHydrationWarning
    >
      <head>
        <script dangerouslySetInnerHTML={{ __html: NO_FLASH_THEME }} />
      </head>
      <body>
        {children}
        <Toaster position="bottom-right" />
      </body>
    </html>
  )
}
