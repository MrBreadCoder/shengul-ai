import type { LegalDocument } from '@/lib/legal/document'
import { acceptableUsePolicy } from '@/lib/legal/documents/acceptable-use-policy'
import { cookiePolicy } from '@/lib/legal/documents/cookie-policy'
import { dataProcessingAddendum } from '@/lib/legal/documents/data-processing-addendum'
import { outreachPrivacyNotice } from '@/lib/legal/documents/outreach-privacy-notice'
import { privacyPolicy } from '@/lib/legal/documents/privacy-policy'
import { subprocessors } from '@/lib/legal/documents/subprocessors'
import { termsOfService } from '@/lib/legal/documents/terms-of-service'

/**
 * Every published legal document, in the order they are listed at `/legal`.
 *
 * Ordered by who needs them: the two notices anyone might arrive at first, then
 * the contract documents, then the annex-style references. A visitor who
 * received a cold email should not have to read past a subprocessor table to
 * find the page written for them.
 */
export const LEGAL_DOCUMENTS: readonly LegalDocument[] = [
  privacyPolicy,
  outreachPrivacyNotice,
  cookiePolicy,
  termsOfService,
  acceptableUsePolicy,
  dataProcessingAddendum,
  subprocessors,
]

/** URL prefix every legal document is served under. */
export const LEGAL_PATH_PREFIX = '/legal'

export function legalDocumentPath(slug: string): string {
  return `${LEGAL_PATH_PREFIX}/${slug}`
}

export function findLegalDocument(slug: string): LegalDocument | undefined {
  return LEGAL_DOCUMENTS.find((document) => document.slug === slug)
}
