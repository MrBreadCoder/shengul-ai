import { describe, expect, it } from 'vitest'
import type { LegalBlock, LegalDocument } from '@/lib/legal/document'
import { isWellFormedTable } from '@/lib/legal/document'
import { findLegalDocument, LEGAL_DOCUMENTS, legalDocumentPath } from '@/lib/legal/registry'
import { META_DESCRIPTION_MAX_LENGTH, META_DESCRIPTION_MIN_LENGTH } from '@/lib/seo/site'

/** Every string a reader can see in a document, flattened for text-level assertions. */
function textOf(block: LegalBlock): readonly string[] {
  switch (block.kind) {
    case 'paragraph':
    case 'callout':
      return [block.text]
    case 'list':
      return block.items
    case 'table':
      return [...block.columns, ...block.rows.flat()]
  }
}

function allText(document: LegalDocument): readonly string[] {
  return document.sections.flatMap((section) => [
    section.heading,
    ...section.blocks.flatMap(textOf),
  ])
}

const CROSS_REFERENCE_PATTERN = /\/legal\/([a-z0-9-]+)/g

describe('LEGAL_DOCUMENTS', () => {
  it('should expose a unique slug for every document', () => {
    const slugs = LEGAL_DOCUMENTS.map((document) => document.slug)

    expect(new Set(slugs).size).toBe(slugs.length)
  })

  it('should use url-safe slugs', () => {
    for (const { slug } of LEGAL_DOCUMENTS) {
      expect(slug, slug).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/)
    }
  })

  it('should hold every meta description inside the window the rest of the site uses', () => {
    for (const { slug, description } of LEGAL_DOCUMENTS) {
      expect(description.length, slug).toBeGreaterThanOrEqual(META_DESCRIPTION_MIN_LENGTH)
      expect(description.length, slug).toBeLessThanOrEqual(META_DESCRIPTION_MAX_LENGTH)
    }
  })

  it('should carry a parseable ISO date on every document', () => {
    for (const { slug, updatedAt } of LEGAL_DOCUMENTS) {
      expect(updatedAt, slug).toMatch(/^\d{4}-\d{2}-\d{2}$/)
      expect(Number.isNaN(Date.parse(updatedAt)), slug).toBe(false)
    }
  })

  it('should give every section a unique anchor within its document', () => {
    for (const { slug, sections } of LEGAL_DOCUMENTS) {
      const ids = sections.map((section) => section.id)
      expect(new Set(ids).size, slug).toBe(ids.length)
    }
  })

  it('should never render an empty section or an empty block', () => {
    for (const document of LEGAL_DOCUMENTS) {
      expect(document.sections.length, document.slug).toBeGreaterThan(0)

      for (const section of document.sections) {
        expect(section.blocks.length, `${document.slug}#${section.id}`).toBeGreaterThan(0)

        for (const block of section.blocks) {
          for (const text of textOf(block)) {
            expect(text.trim(), `${document.slug}#${section.id}`).not.toBe('')
          }
        }
      }
    }
  })

  it('should give every table row one cell per column', () => {
    for (const document of LEGAL_DOCUMENTS) {
      for (const section of document.sections) {
        for (const block of section.blocks) {
          expect(isWellFormedTable(block), `${document.slug}#${section.id}`).toBe(true)
        }
      }
    }
  })

  // These documents cite each other constantly — a DPA that points at a
  // subprocessor list that moved is a compliance gap, not a broken link.
  it('should only cross-reference legal documents that exist', () => {
    for (const document of LEGAL_DOCUMENTS) {
      for (const text of allText(document)) {
        for (const match of text.matchAll(CROSS_REFERENCE_PATTERN)) {
          // The pattern has one capture group, so a match always carries it.
          const slug = match[1] ?? ''
          expect(findLegalDocument(slug), `${document.slug} references ${slug}`).toBeDefined()
        }
      }
    }
  })

  it('should not describe the service the previous documents described', () => {
    // The originals were a different product's boilerplate. These phrases are
    // unambiguous relics of it, so a regression can only mean a paste-back.
    const banned = [/startup co-?founder/i, /emotional support/i, /flash cookie/i]

    for (const document of LEGAL_DOCUMENTS) {
      for (const text of allText(document)) {
        for (const pattern of banned) {
          expect(pattern.test(text), `${document.slug}: ${text.slice(0, 60)}`).toBe(false)
        }
      }
    }
  })
})

describe('findLegalDocument', () => {
  it('should return the document when the slug is known', () => {
    expect(findLegalDocument('privacy-policy')?.title).toBe('Privacy Notice')
  })

  it('should return undefined when the slug is unknown', () => {
    expect(findLegalDocument('not-a-document')).toBeUndefined()
  })
})

describe('legalDocumentPath', () => {
  it('should build the served path for a slug', () => {
    expect(legalDocumentPath('terms-of-service')).toBe('/legal/terms-of-service')
  })
})
