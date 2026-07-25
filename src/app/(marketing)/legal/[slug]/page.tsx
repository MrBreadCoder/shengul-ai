import type { Metadata } from 'next'
import { notFound } from 'next/navigation'
import { LegalDocumentView } from '@/components/legal/legal-document-view'
import { LegalHeader } from '@/components/legal/legal-chrome'
import { SiteFooter } from '@/components/landing/site-footer'
import { findLegalDocument, LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'
import { OG_IMAGE_ALT, OG_IMAGE_HEIGHT, OG_IMAGE_PATH, OG_IMAGE_WIDTH, SITE_NAME } from '@/lib/seo/site'

interface LegalPageProps {
  readonly params: Promise<{ readonly slug: string }>
}

/**
 * Every document is known at build time, so all of them are prerendered and the
 * route never needs to run on demand. `dynamicParams: false` turns an unknown
 * slug into a 404 at the routing layer rather than a rendered miss.
 */
export const dynamicParams = false

export function generateStaticParams(): { slug: string }[] {
  return LEGAL_DOCUMENTS.map(({ slug }) => ({ slug }))
}

const OG_IMAGE = {
  url: OG_IMAGE_PATH,
  width: OG_IMAGE_WIDTH,
  height: OG_IMAGE_HEIGHT,
  alt: OG_IMAGE_ALT,
} as const

export async function generateMetadata({ params }: LegalPageProps): Promise<Metadata> {
  const { slug } = await params
  const document = findLegalDocument(slug)
  if (!document) return {}

  const path = legalDocumentPath(document.slug)

  return {
    title: document.title,
    description: document.description,
    alternates: { canonical: path },
    openGraph: {
      type: 'article',
      url: path,
      siteName: SITE_NAME,
      title: `${SITE_NAME} · ${document.title}`,
      description: document.description,
      modifiedTime: document.updatedAt,
      images: [OG_IMAGE],
    },
    twitter: {
      card: 'summary_large_image',
      title: `${SITE_NAME} · ${document.title}`,
      description: document.description,
      images: [OG_IMAGE],
    },
  }
}

export default async function LegalPage({ params }: LegalPageProps): Promise<React.ReactElement> {
  const { slug } = await params
  const document = findLegalDocument(slug)
  if (!document) notFound()

  return (
    <div className="landing min-h-[100dvh] bg-[var(--l-bg)] text-[var(--l-text)] antialiased">
      <LegalHeader />
      <main>
        <LegalDocumentView document={document} />
      </main>
      <SiteFooter />
    </div>
  )
}
