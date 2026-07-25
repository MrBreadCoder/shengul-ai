/**
 * The shape of a published legal document.
 *
 * Legal copy lives here as typed data rather than as prose in a page component
 * or a loose text file, for one reason: a policy that exists in two places
 * drifts, and a privacy notice that disagrees with itself is worse than none at
 * all. Everything served at `/legal/*` is built from this module, so the
 * document a regulator reads is the document the code contains.
 *
 * Blocks are deliberately few. A legal document is headings, prose, lists and
 * the occasional table; anything richer is a sign the copy is doing a job the
 * copy should not be doing.
 */

export type LegalBlock =
  | { readonly kind: 'paragraph'; readonly text: string }
  | { readonly kind: 'list'; readonly items: readonly string[] }
  | {
      readonly kind: 'table'
      readonly columns: readonly string[]
      readonly rows: readonly (readonly string[])[]
    }
  /** Set apart from the surrounding prose. For statements a reader must not skim past. */
  | { readonly kind: 'callout'; readonly text: string }

export interface LegalSection {
  /** Anchor target and table-of-contents key. Unique within a document. */
  readonly id: string
  readonly heading: string
  readonly blocks: readonly LegalBlock[]
}

export interface LegalDocument {
  /** URL segment under `/legal/`. Unique across all documents. */
  readonly slug: string
  readonly title: string
  /** Meta description. Held to the same 50–160 character window as the rest of the site. */
  readonly description: string
  /** One-paragraph lede, rendered above the table of contents. */
  readonly summary: string
  /** ISO 8601 date the document last changed in substance. */
  readonly updatedAt: string
  readonly sections: readonly LegalSection[]
}

/**
 * The date every current document was rewritten. Bump per document, not here,
 * once they start changing independently.
 */
export const LEGAL_UPDATED_AT = '2026-07-25'

/**
 * A table row is only meaningful if it has a cell per column. Enforced at build
 * time by the registry test rather than at render time, so a malformed table is
 * a failing test rather than a ragged page in production.
 */
export function isWellFormedTable(block: LegalBlock): boolean {
  if (block.kind !== 'table') return true
  return block.rows.every((row) => row.length === block.columns.length)
}
