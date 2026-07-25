interface ExcludeKeywordCandidate {
  title: string | null
  organizationName: string | null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Apollo's People Search response exposes no server-side keyword-exclude
// filter and no organization keyword/industry text (see "Apollo API
// research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md),
// so exclusion is matched against the only text a candidate actually
// carries: their employer's name and their own title. Matching is
// whole-word (\b...\b) so a short keyword like "agency" doesn't
// false-positive inside an unrelated word like "Emergency"; a multi-word
// keyword like "staffing agency" still matches as a literal phrase.
export function matchesExcludedKeywords(
  candidate: ExcludeKeywordCandidate,
  excludeKeywords: string[],
): boolean {
  const keywords = excludeKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
  if (keywords.length === 0) return false
  const haystack = `${candidate.organizationName ?? ''} ${candidate.title ?? ''}`.toLowerCase()
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(haystack))
}
