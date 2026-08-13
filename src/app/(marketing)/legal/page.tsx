import type { Metadata } from 'next'
import Link from 'next/link'
import { LegalContact, LegalHeader } from '@/components/legal/legal-chrome'
import { SiteFooter } from '@/components/landing/site-footer'
import { formatLegalDate } from '@/lib/legal/format-date'
import { LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'
import { OG_IMAGE_ALT, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH, SITE_NAME } from '@/lib/seo/site'

const INDEX_TITLE = 'Legal'

const INDEX_DESCRIPTION =
  'Every policy and agreement governing Shengul AI — privacy, cookies, terms, acceptable use, data processing and the list of our subprocessors.'

const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: OG_IMAGE_ALT,
} as const

export const metadata: Metadata = {
  title: INDEX_TITLE,
  description: INDEX_DESCRIPTION,
  alternates: { canonical: '/legal' },
  openGraph: {
    type: 'website',
    url: '/legal',
    siteName: SITE_NAME,
    title: `${SITE_NAME} · ${INDEX_TITLE}`,
    description: INDEX_DESCRIPTION,
    images: [OG_IMAGE],
  },
  twitter: {
    card: 'summary_large_image',
    title: `${SITE_NAME} · ${INDEX_TITLE}`,
    description: INDEX_DESCRIPTION,
    images: [OG_IMAGE],
  },
}

/**
 * Index of the published documents.
 *
 * Each row leads with the document's own one-line summary rather than its
 * title alone, because the titles are legal-sounding and the summaries are the
 * part that tells somebody whether it is the page they need.
 */
export default function LegalIndexPage(): React.ReactElement {
  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)] text-[var(--l-text)] antialiased">
      <LegalHeader />

      <main>
        <div className="mx-auto max-w-[46rem] px-4 pt-20 pb-24">
          <h1 className="text-[2rem] leading-[1.1] font-medium tracking-tight text-balance sm:text-[2.5rem]">
            {INDEX_TITLE}
          </h1>

          <p className="mt-6 text-[16px] leading-[1.7] text-[var(--l-muted)]">
            The documents below govern how {SITE_NAME} is used and how we handle personal
            information. If you received an email from a campaign we run and want it to stop, the
            page written for you is{' '}
            <Link
              href={legalDocumentPath('outreach-privacy-notice')}
              className="underline decoration-[var(--l-hairline-strong)] underline-offset-4 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] hover:decoration-[var(--l-text)]"
            >
              If you received an email from us
            </Link>
            .
          </p>

          <ul className="mt-14 border-t border-[var(--l-hairline)]">
            {LEGAL_DOCUMENTS.map((document) => (
              <li key={document.slug} className="border-b border-[var(--l-hairline)]">
                <Link
                  href={legalDocumentPath(document.slug)}
                  className="group flex flex-col gap-2 py-7 transition-opacity duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:opacity-80"
                >
                  <span className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
                    <span className="text-lg font-medium tracking-tight">{document.title}</span>
                    <span className="text-[12px] text-[var(--l-faint)]">
                      Updated {formatLegalDate(document.updatedAt)}
                    </span>
                  </span>
                  <span className="max-w-[52ch] text-[14px] leading-relaxed text-[var(--l-muted)]">
                    {document.summary}
                  </span>
                </Link>
              </li>
            ))}
          </ul>

          <LegalContact />
        </div>
      </main>

      <SiteFooter locale="en" />
    </div>
  )
}
