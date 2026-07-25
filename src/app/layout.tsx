import type { Metadata } from 'next'
import type { ReactNode } from 'react'
import { GeistSans } from 'geist/font/sans'
import { GeistMono } from 'geist/font/mono'
import { Toaster } from '@/components/ui/sonner'
import './globals.css'

export const metadata: Metadata = {
  title: {
    default: 'Beacon',
    template: '%s · Beacon',
  },
  description: 'Outreach pipeline, mail and case knowledge in one console.',
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
      className={`${GeistSans.variable} ${GeistMono.variable}`}
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
