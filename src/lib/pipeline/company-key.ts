const LEGAL_SUFFIXES = new Set([
  'inc', 'incorporated', 'llc', 'ltd', 'limited', 'corp', 'corporation',
  'co', 'company', 'gmbh', 'sa', 'srl', 'bv', 'plc', 'llp', 'pty',
])

// Deterministic company-key fallback (.claude/architecture.md §6 Stage 2) used when
// Apollo doesn't return a company_domain: lowercase, strip punctuation, drop
// trailing legal-entity suffix words, collapse whitespace.
export function normalizeCompanyName(name: string): string {
  const words = name
    .toLowerCase()
    .trim()
    .replace(/[.,]/g, '')
    .split(/\s+/)
    .filter((word) => word.length > 0)
  // words[words.length - 1] is safe: the loop condition guarantees length > 0
  while (words.length > 0 && LEGAL_SUFFIXES.has(words[words.length - 1]!)) {
    words.pop()
  }
  return words.join(' ')
}
