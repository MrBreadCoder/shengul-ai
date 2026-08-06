// Diagnostic-only run of a real Apollo People Search against the private
// K-12 school ICP (person titles + organization keywords + client-side
// exclude keywords), reusing the exact production building blocks the
// discovery pipeline uses (src/lib/apollo/build-search-params.ts,
// src/lib/apollo/exclude-keywords.ts) so the "kept" count printed here
// reflects what pass 1 of src/lib/pipeline/discover.ts would actually keep
// for this ICP.
//
// Calls only Apollo's People Search endpoint (mixed_people/api_search) — no
// bulk_match/enrichment call is made, so no Apollo reveal credits are spent.
// Writes nothing to Supabase; this is audience-quality inspection only.
//
// IMPORTANT — why this runs one Apollo call per organization keyword rather
// than one call with all keywords joined (which is what
// buildPeopleSearchParams does for `icp.keywords` today, sending
// `q_keywords: icp.keywords.join(' ')`): live testing against this account's
// key on 2026-08-06 confirmed Apollo's `q_keywords` is a single free-text
// field, not an OR-list —
//   - two short phrases joined ("private school independent school")
//     returned total_entries: 0
//   - the full 33-phrase join for this ICP returned HTTP 422
//     {"error":"Value too long"}
//   - each phrase sent alone (e.g. "academy", "montessori school") returns
//     normal, large result counts
// So a multi-keyword ICP saved through the real campaign UI today would
// silently return zero (or error) results via the current
// buildPeopleSearchParams — this script works around that at the
// orchestration layer (one real, unmodified buildPeopleSearchParams call per
// keyword, results merged and de-duplicated) rather than replicating the
// bug, since the point of this run is to see actual audience quality. The
// per-keyword breakdown printed below is itself evidence for fixing
// build-search-params.ts.
//
// Usage:
//   pnpm test:apollo-schools
//   pnpm test:apollo-schools -- --pages=2 --per-page=50
//   pnpm test:apollo-schools -- --out=scripts/.output/run1.json
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { buildPeopleSearchParams } from '../src/lib/apollo/build-search-params'
import { matchesExcludedKeywords } from '../src/lib/apollo/exclude-keywords'
import { apolloIcpSchema, type ApolloIcpFilters, type ApolloSearchCandidate } from '../src/lib/apollo/types'
import { withRetry } from '../src/lib/http/with-retry'
import { AppError, isAppError } from '../src/lib/errors/app-error'

const DEFAULT_PAGES_PER_KEYWORD = 1
const DEFAULT_PER_PAGE = 25
const MAX_PAGES_PER_KEYWORD = 20 // matches MAX_SEARCH_PAGES in src/lib/pipeline/discover.ts
const MAX_PER_PAGE = 100 // Apollo's documented per_page ceiling
const SAMPLE_KEPT_COUNT = 15
const SAMPLE_EXCLUDED_COUNT = 10
const BREAKDOWN_ROWS = 25

const PERSON_TITLES = [
  'principal', 'vice principal', 'head of school', 'school director', 'executive director',
  'business manager', 'bursar', 'operations manager', 'director of operations',
  'administrative manager', 'procurement manager', 'procurement officer', 'purchasing manager',
  'purchasing officer', 'finance manager', 'finance director', 'facilities manager',
  'campus manager', 'school administrator', 'superintendent', 'assistant superintendent',
]

const ORGANIZATION_KEYWORDS = [
  'private school', 'independent school', 'charter school', 'k-12 school', 'K12',
  'elementary school', 'primary school', 'middle school', 'junior high school',
  'secondary school', 'high school', 'international school', 'boarding school', 'day school',
  'academy', 'preparatory school', 'prep school', 'grammar school', 'faith-based school',
  'religious school', 'catholic school', 'christian school', 'islamic school', 'jewish school',
  'montessori school', 'IB school', 'bilingual school', 'magnet school',
  'public school district', 'school district', 'education trust', 'education group',
  'educational institution',
]

const EXCLUDE_KEYWORDS = [
  'college', 'university', 'higher education', 'tutoring', 'tutoring center', 'online school',
  'virtual school', 'edtech', 'education software', 'software', 'saas', 'recruiting', 'staffing',
  'consulting', 'language school', 'driving school', 'music school', 'dance school',
  'coding bootcamp', 'training center', 'test prep', 'coaching institute',
]

const argsSchema = z.object({
  pages: z.number().int().min(1).max(MAX_PAGES_PER_KEYWORD),
  perPage: z.number().int().min(1).max(MAX_PER_PAGE),
  outPath: z.string().min(1),
})

type Args = z.infer<typeof argsSchema>

// searchPeople is dynamically imported (see main()), so its type is
// re-declared here rather than pulled in statically — see the comment on
// that import for why.
type SearchPeopleFn = (
  params: Record<string, string | string[]>,
) => Promise<{ totalEntries: number; candidates: ApolloSearchCandidate[] }>

interface KeywordFetchResult {
  keyword: string
  totalEntries: number
  candidates: ApolloSearchCandidate[]
  pagesFetched: number
}

interface DedupedCandidate {
  candidate: ApolloSearchCandidate
  matchedOrgKeywords: string[]
}

interface AggregatedFetch {
  perKeyword: KeywordFetchResult[]
  uniqueCandidates: Map<string, DedupedCandidate>
}

interface ExcludedCandidate {
  candidate: ApolloSearchCandidate
  matchedOrgKeywords: string[]
  matchedExcludeKeywords: string[]
}

interface ClassifyResult {
  kept: DedupedCandidate[]
  excluded: ExcludedCandidate[]
}

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`)
}

function loadEnvFile(): void {
  // Convenience for local runs; a shell-exported environment works too.
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
}

function parseArgs(argv: readonly string[]): Args {
  const values = new Map(
    argv
      .filter((arg) => arg.startsWith('--') && arg.includes('='))
      .map((arg) => {
        const separator = arg.indexOf('=')
        return [arg.slice(2, separator), arg.slice(separator + 1)] as const
      }),
  )
  const defaultOut = join('scripts', '.output', `apollo-schools-search-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const parsed = argsSchema.safeParse({
    pages: values.has('pages') ? Number(values.get('pages')) : DEFAULT_PAGES_PER_KEYWORD,
    perPage: values.has('per-page') ? Number(values.get('per-page')) : DEFAULT_PER_PAGE,
    outPath: values.get('out') ?? defaultOut,
  })
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `Invalid arguments: ${parsed.error.issues.map((issue) => `${issue.path.join('.')} ${issue.message}`).join(', ')}`,
      {},
    )
  }
  return parsed.data
}

// keywords is deliberately empty here — each Apollo call fills in exactly
// one organization keyword at a time (see fetchForKeyword), because a
// multi-keyword q_keywords join is confirmed broken (see file header).
function buildBaseIcp(): ApolloIcpFilters {
  return apolloIcpSchema.parse({
    personTitles: PERSON_TITLES,
    organizationLocations: [],
    employeeRangeMin: null,
    employeeRangeMax: null,
    keywords: [],
    personSeniorities: [],
    contactEmailStatuses: [],
    excludeOrganizationLocations: [],
    excludeKeywords: EXCLUDE_KEYWORDS,
  })
}

async function fetchForKeyword(
  baseIcp: ApolloIcpFilters,
  keyword: string,
  pages: number,
  perPage: number,
  searchPeople: SearchPeopleFn,
): Promise<KeywordFetchResult> {
  const icp: ApolloIcpFilters = { ...baseIcp, keywords: [keyword] }
  const candidates: ApolloSearchCandidate[] = []
  let totalEntries = 0
  let pagesFetched = 0
  for (let page = 1; page <= pages; page++) {
    const params = buildPeopleSearchParams(icp, page, perPage)
    const result = await withRetry(() => searchPeople(params))
    pagesFetched += 1
    if (page === 1) totalEntries = result.totalEntries
    candidates.push(...result.candidates)
    if (result.candidates.length === 0) break
  }
  return { keyword, totalEntries, candidates, pagesFetched }
}

async function fetchAllKeywords(
  baseIcp: ApolloIcpFilters,
  keywords: string[],
  pages: number,
  perPage: number,
  searchPeople: SearchPeopleFn,
): Promise<AggregatedFetch> {
  const perKeyword: KeywordFetchResult[] = []
  const uniqueCandidates = new Map<string, DedupedCandidate>()
  for (const keyword of keywords) {
    const result = await fetchForKeyword(baseIcp, keyword, pages, perPage, searchPeople)
    perKeyword.push(result)
    log(`  "${keyword}": total_entries=${result.totalEntries}, fetched=${result.candidates.length}`)
    for (const candidate of result.candidates) {
      const existing = uniqueCandidates.get(candidate.apolloId)
      if (existing) existing.matchedOrgKeywords.push(keyword)
      else uniqueCandidates.set(candidate.apolloId, { candidate, matchedOrgKeywords: [keyword] })
    }
  }
  return { perKeyword, uniqueCandidates }
}

// Reuses the production predicate (src/lib/apollo/exclude-keywords.ts) one
// keyword at a time purely for reporting which keyword(s) triggered a match
// — matchesExcludedKeywords itself only returns a boolean.
function findMatchedExcludeKeywords(candidate: ApolloSearchCandidate, excludeKeywords: string[]): string[] {
  return excludeKeywords.filter((keyword) => matchesExcludedKeywords(candidate, [keyword]))
}

function classifyCandidates(deduped: DedupedCandidate[], excludeKeywords: string[]): ClassifyResult {
  const kept: DedupedCandidate[] = []
  const excluded: ExcludedCandidate[] = []
  for (const entry of deduped) {
    const matchedExcludeKeywords = findMatchedExcludeKeywords(entry.candidate, excludeKeywords)
    if (matchedExcludeKeywords.length > 0) {
      excluded.push({ ...entry, matchedExcludeKeywords })
    } else {
      kept.push(entry)
    }
  }
  return { kept, excluded }
}

function countBy<T>(items: readonly T[], keyFn: (item: T) => string | null): Map<string, number> {
  const counts = new Map<string, number>()
  for (const item of items) {
    const key = keyFn(item) ?? '(unknown)'
    counts.set(key, (counts.get(key) ?? 0) + 1)
  }
  return counts
}

function formatCounts(counts: Map<string, number>, limit: number): string {
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, limit)
  if (rows.length === 0) return '  (none)'
  return rows.map(([key, count]) => `  ${String(count).padStart(4)}  ${key}`).join('\n')
}

function formatCandidate(candidate: ApolloSearchCandidate): string {
  const name = [candidate.firstName, candidate.lastNamePreview].filter(Boolean).join(' ') || '(name withheld)'
  const org = candidate.organizationName ?? '(no organization)'
  const domain = candidate.organizationDomain ? ` (${candidate.organizationDomain})` : ''
  const title = candidate.title ?? '(no title)'
  return `${name} — ${title} @ ${org}${domain}`
}

function printQuerySummary(baseIcp: ApolloIcpFilters, aggregated: AggregatedFetch, args: Args): void {
  const rawFetched = aggregated.perKeyword.reduce((sum, k) => sum + k.candidates.length, 0)
  const pagesFetched = aggregated.perKeyword.reduce((sum, k) => sum + k.pagesFetched, 0)
  const zeroResultKeywords = aggregated.perKeyword.filter((k) => k.totalEntries === 0).map((k) => k.keyword)
  log('')
  log('=== Apollo People Search — private K-12 school ICP test ===')
  log(`person_titles[]: ${baseIcp.personTitles.length} titles`)
  log(`organization keywords: ${ORGANIZATION_KEYWORDS.length} phrases, each run as its own q_keywords call (see file header for why)`)
  log(`exclude keywords (client-side only, not sent to Apollo): ${baseIcp.excludeKeywords.length}`)
  log('no organization_locations[] filter was supplied — results are global')
  log('')
  log(`Apollo calls made: ${pagesFetched} (${ORGANIZATION_KEYWORDS.length} keywords × up to ${args.pages} page(s) each)`)
  log(`Raw candidates fetched (before de-dup across keywords): ${rawFetched}`)
  log(`Unique candidates after de-dup: ${aggregated.uniqueCandidates.size}`)
  if (zeroResultKeywords.length > 0) {
    log('')
    warn(`${zeroResultKeywords.length} organization keyword(s) returned total_entries: 0 — Apollo has no match for the exact phrase:`)
    warn(zeroResultKeywords.map((k) => `  - "${k}"`).join('\n'))
  }
}

function printKeywordBreakdown(aggregated: AggregatedFetch): void {
  log('')
  log('Per-keyword Apollo totals (sorted by total_entries):')
  const rows = [...aggregated.perKeyword].sort((a, b) => b.totalEntries - a.totalEntries)
  log(rows.map((k) => `  ${String(k.totalEntries).padStart(9)}  ${k.keyword}  (fetched ${k.candidates.length})`).join('\n'))
}

function printBreakdowns(classified: ClassifyResult): void {
  log('')
  log(`Kept (passed exclude-keyword filter): ${classified.kept.length}`)
  log(`Excluded (matched an exclude keyword): ${classified.excluded.length}`)

  if (classified.excluded.length > 0) {
    const excludeCounts = countBy(classified.excluded.flatMap((entry) => entry.matchedExcludeKeywords), (keyword) => keyword)
    log('')
    log('Exclude-keyword breakdown:')
    log(formatCounts(excludeCounts, BREAKDOWN_ROWS))
  }

  if (classified.kept.length > 0) {
    const titleCounts = countBy(classified.kept, (entry) => entry.candidate.title)
    log('')
    log('Title breakdown (kept):')
    log(formatCounts(titleCounts, BREAKDOWN_ROWS))

    const orgCounts = countBy(classified.kept, (entry) => entry.candidate.organizationDomain ?? entry.candidate.organizationName)
    log('')
    log('Top organizations (kept):')
    log(formatCounts(orgCounts, BREAKDOWN_ROWS))
  }
}

function printSamples(classified: ClassifyResult): void {
  log('')
  log(`Sample kept candidates (first ${SAMPLE_KEPT_COUNT}):`)
  const keptLines = classified.kept
    .slice(0, SAMPLE_KEPT_COUNT)
    .map((e, i) => `  ${i + 1}. ${formatCandidate(e.candidate)}  [via: ${e.matchedOrgKeywords.join(', ')}]`)
  log(keptLines.length > 0 ? keptLines.join('\n') : '  (none)')

  log('')
  log(`Sample excluded candidates (first ${SAMPLE_EXCLUDED_COUNT}):`)
  const excludedLines = classified.excluded
    .slice(0, SAMPLE_EXCLUDED_COUNT)
    .map((e, i) => `  ${i + 1}. ${formatCandidate(e.candidate)}  [matched exclude: ${e.matchedExcludeKeywords.join(', ')}]`)
  log(excludedLines.length > 0 ? excludedLines.join('\n') : '  (none)')
}

interface ResultsFile {
  generatedAt: string
  query: {
    personTitles: string[]
    organizationKeywords: string[]
    excludeKeywords: string[]
    pagesPerKeyword: number
    perPage: number
  }
  perKeywordTotals: Array<{ keyword: string; totalEntries: number; fetched: number; pagesFetched: number }>
  totals: {
    rawFetched: number
    uniqueCandidates: number
    kept: number
    excluded: number
  }
  kept: DedupedCandidate[]
  excluded: ExcludedCandidate[]
}

function writeResultsFile(args: Args, baseIcp: ApolloIcpFilters, aggregated: AggregatedFetch, classified: ClassifyResult): void {
  const rawFetched = aggregated.perKeyword.reduce((sum, k) => sum + k.candidates.length, 0)
  const file: ResultsFile = {
    generatedAt: new Date().toISOString(),
    query: {
      personTitles: baseIcp.personTitles,
      organizationKeywords: ORGANIZATION_KEYWORDS,
      excludeKeywords: baseIcp.excludeKeywords,
      pagesPerKeyword: args.pages,
      perPage: args.perPage,
    },
    perKeywordTotals: aggregated.perKeyword.map((k) => ({
      keyword: k.keyword,
      totalEntries: k.totalEntries,
      fetched: k.candidates.length,
      pagesFetched: k.pagesFetched,
    })),
    totals: {
      rawFetched,
      uniqueCandidates: aggregated.uniqueCandidates.size,
      kept: classified.kept.length,
      excluded: classified.excluded.length,
    },
    kept: classified.kept,
    excluded: classified.excluded,
  }
  mkdirSync(dirname(args.outPath), { recursive: true })
  writeFileSync(args.outPath, JSON.stringify(file, null, 2), 'utf8')
}

async function main(): Promise<void> {
  loadEnvFile()
  const args = parseArgs(process.argv.slice(2))
  if (!process.env.APOLLO_API_KEY) {
    throw new AppError('CONFIG_ERROR', 'APOLLO_API_KEY is not set — add it to .env.local', {})
  }

  // Deferred import: src/lib/apollo/client.ts pulls in src/lib/env, whose
  // top-level `loadEnv(process.env)` call must run *after* loadEnvFile()
  // above has populated process.env — a static import at the top of this
  // file would evaluate (and fail) before main() ever runs.
  const { searchPeople } = await import('../src/lib/apollo/client')

  const baseIcp = buildBaseIcp()
  log(
    `Fetching up to ${args.pages} page(s) of ${args.perPage} per organization keyword ` +
      `(${ORGANIZATION_KEYWORDS.length} keywords)…`,
  )
  const aggregated = await fetchAllKeywords(baseIcp, ORGANIZATION_KEYWORDS, args.pages, args.perPage, searchPeople)
  const classified = classifyCandidates([...aggregated.uniqueCandidates.values()], baseIcp.excludeKeywords)

  printQuerySummary(baseIcp, aggregated, args)
  printKeywordBreakdown(aggregated)
  printBreakdowns(classified)
  printSamples(classified)
  writeResultsFile(args, baseIcp, aggregated, classified)
  log('')
  log(`Full results (raw + classified) written to: ${args.outPath}`)
}

main().catch((error: unknown) => {
  if (isAppError(error)) {
    warn(`${error.code}: ${error.message}`)
    const status = error.context.status
    if (status === 401) warn('Apollo returned 401 — APOLLO_API_KEY is likely invalid or revoked.')
    if (status === 429) warn('Apollo returned 429 — rate limited even after retries; try again shortly.')
    process.exit(1)
  }
  warn(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
