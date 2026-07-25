import type { LegalDocument } from '@/lib/legal/document'
import { formatLegalDate } from '@/lib/legal/format-date'
import { LegalBlockView } from '@/components/legal/legal-prose'
import { LegalContact } from '@/components/legal/legal-chrome'

interface LegalDocumentViewProps {
  readonly document: LegalDocument
}

/**
 * Renders one legal document.
 *
 * Measure is capped near 78 characters and the type is a step larger than the
 * marketing page's body copy, because these are read start to finish rather
 * than scanned. The table of contents is a real list of anchors rather than a
 * sticky rail: it has to work on a phone, and a reader who arrives from a
 * footnote in an email lands on it before the prose.
 */
export function LegalDocumentView({ document }: LegalDocumentViewProps): React.ReactElement {
  return (
    <article className="mx-auto max-w-[46rem] px-4 pt-20 pb-24">
      <p className="text-[13px] text-[var(--l-faint)]">
        Last updated {formatLegalDate(document.updatedAt)}
      </p>

      <h1 className="mt-4 text-[2rem] leading-[1.1] font-medium tracking-tight text-balance sm:text-[2.5rem]">
        {document.title}
      </h1>

      <p className="mt-6 text-[16px] leading-[1.7] text-[var(--l-text)]">{document.summary}</p>

      <nav
        aria-label="On this page"
        className="mt-12 border-t border-[var(--l-hairline)] pt-8"
      >
        <h2 className="text-[13px] font-medium tracking-tight">On this page</h2>
        <ol className="mt-4 flex flex-col gap-2">
          {document.sections.map((section) => (
            <li key={section.id}>
              <a
                href={`#${section.id}`}
                className="text-[14px] text-[var(--l-muted)] underline decoration-transparent underline-offset-4 transition-colors duration-300 ease-[cubic-bezier(0.32,0.72,0,1)] hover:text-[var(--l-text)] hover:decoration-[var(--l-hairline-strong)]"
              >
                {section.heading}
              </a>
            </li>
          ))}
        </ol>
      </nav>

      {document.sections.map((section) => (
        <section key={section.id} id={section.id} className="mt-14 scroll-mt-8">
          <h2 className="text-[1.2rem] leading-snug font-medium tracking-tight">
            {section.heading}
          </h2>
          {section.blocks.map((block, index) => (
            <LegalBlockView key={index} block={block} />
          ))}
        </section>
      ))}

      <LegalContact />
    </article>
  )
}
