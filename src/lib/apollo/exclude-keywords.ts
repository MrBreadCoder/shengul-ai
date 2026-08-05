interface ExcludeKeywordCandidate {
  title: string | null
  organizationName: string | null
  /** Only available after Apollo's enrich call (bulk_match) — absent on pre-enrich search candidates. */
  organizationIndustry?: string | null
  /** Only available after Apollo's enrich call (bulk_match) — absent on pre-enrich search candidates. */
  organizationDescription?: string | null
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// Apollo's People Search response exposes no server-side keyword-exclude
// filter and no organization keyword/industry text (see "Apollo API
// research" in docs/superpowers/plans/2026-07-21-apollo-exclude-filters.md),
// so pre-enrich exclusion is matched against the only text a search
// candidate carries: their employer's name and their own title. The enrich
// call (bulk_match) later exposes organizationIndustry/organizationDescription
// too — callers that have already enriched a candidate should pass those in
// as well, so a company the thinner pre-enrich text let through can still be
// caught (see src/lib/pipeline/discover.ts's post-enrich check).
//
// Matching is whole-word (\b...\b) so a short keyword like "agency" doesn't
// false-positive inside an unrelated word like "Emergency"; a multi-word
// keyword like "staffing agency" still matches as a literal phrase.
export function matchesExcludedKeywords(
  candidate: ExcludeKeywordCandidate,
  excludeKeywords: string[],
): boolean {
  const keywords = excludeKeywords.map((keyword) => keyword.trim().toLowerCase()).filter(Boolean)
  if (keywords.length === 0) return false
  const haystack = [
    candidate.organizationName,
    candidate.title,
    candidate.organizationIndustry,
    candidate.organizationDescription,
  ]
    .filter((part): part is string => Boolean(part))
    .join(' ')
    .toLowerCase()
  return keywords.some((keyword) => new RegExp(`\\b${escapeRegExp(keyword)}\\b`).test(haystack))
}
