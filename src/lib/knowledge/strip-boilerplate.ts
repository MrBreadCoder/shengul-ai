function normalizeParagraph(paragraph: string): string {
  return paragraph.trim().replace(/\s+/g, ' ')
}

function splitParagraphs(content: string): string[] {
  return content.split(/\n\s*\n/)
}

// A paragraph shared across enough of a client's other already-scraped pages
// is site chrome (nav, footer, cookie banner), not page content — strip it
// before chunking so it doesn't dilute the embedding signal or occupy a
// chunk slot. Needs at least 2 siblings to have anything to compare against;
// a client's first scraped page is left untouched (nothing to compare yet).
export function stripBoilerplateParagraphs(content: string, siblingContents: string[]): string {
  if (siblingContents.length < 2) return content

  // At least 2 occurrences required regardless of sibling count (avoids
  // stripping content two pages coincidentally share), capped at 3 so a
  // large site doesn't require unanimous repetition.
  const threshold = Math.max(2, Math.min(3, Math.ceil(siblingContents.length / 2)))
  const siblingParagraphSets = siblingContents.map(
    (sibling) => new Set(splitParagraphs(sibling).map(normalizeParagraph)),
  )

  const kept = splitParagraphs(content).filter((paragraph) => {
    const key = normalizeParagraph(paragraph)
    if (key.length === 0) return false
    const occurrences = siblingParagraphSets.filter((set) => set.has(key)).length
    return occurrences < threshold
  })

  return kept.join('\n\n')
}
