import Link from 'next/link'
import type { LegalBlock } from '@/lib/legal/document'
import { splitLegalReferences } from '@/lib/legal/linkify'

const LINK_CLASS =
  'underline decoration-[var(--l-hairline-strong)] underline-offset-4 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] hover:decoration-[var(--l-text)]'

/**
 * Renders one string of legal copy, turning any `/legal/...` path inside it into
 * a link. Split out from the block renderer because every block kind — prose,
 * list item, table cell — needs the same treatment.
 */
function LegalText({ text }: { readonly text: string }): React.ReactElement {
  const segments = splitLegalReferences(text)

  return (
    <>
      {segments.map((segment, index) =>
        segment.kind === 'link' ? (
          <Link key={index} href={segment.href} className={LINK_CLASS}>
            {segment.value}
          </Link>
        ) : (
          <span key={index}>{segment.value}</span>
        ),
      )}
    </>
  )
}

/**
 * A single block of a legal document.
 *
 * Tables scroll inside their own container rather than widening the page: a
 * retention schedule with long cells must not be the reason a phone scrolls
 * sideways.
 */
export function LegalBlockView({ block }: { readonly block: LegalBlock }): React.ReactElement {
  switch (block.kind) {
    case 'paragraph':
      return (
        <p className="mt-5 text-[15px] leading-[1.75] text-[var(--l-muted)]">
          <LegalText text={block.text} />
        </p>
      )

    case 'callout':
      return (
        <p className="mt-6 border-l border-[var(--l-hairline-strong)] py-1 pl-5 text-[15px] leading-[1.75] text-[var(--l-text)]">
          <LegalText text={block.text} />
        </p>
      )

    case 'list':
      return (
        <ul className="mt-5 flex flex-col gap-3">
          {block.items.map((item, index) => (
            <li
              key={index}
              className="relative pl-6 text-[15px] leading-[1.75] text-[var(--l-muted)] before:absolute before:top-[0.75em] before:left-1 before:size-1 before:rounded-full before:bg-[var(--l-hairline-strong)]"
            >
              <LegalText text={item} />
            </li>
          ))}
        </ul>
      )

    case 'table':
      return (
        <div className="mt-6 -mx-4 overflow-x-auto px-4">
          <table className="w-full min-w-[34rem] border-collapse text-left text-[14px]">
            <thead>
              <tr className="border-b border-[var(--l-hairline-strong)]">
                {block.columns.map((column) => (
                  <th
                    key={column}
                    scope="col"
                    className="py-3 pr-6 align-bottom font-medium text-[var(--l-text)] last:pr-0"
                  >
                    {column}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {block.rows.map((row, rowIndex) => (
                <tr key={rowIndex} className="border-b border-[var(--l-hairline)] align-top">
                  {row.map((cell, cellIndex) => (
                    <td
                      key={cellIndex}
                      className="py-3 pr-6 leading-relaxed text-[var(--l-muted)] last:pr-0"
                    >
                      <LegalText text={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )
  }
}
