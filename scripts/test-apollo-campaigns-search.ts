// Diagnostic-only run of real Apollo People Search calls against the 8 live
// Uniforms Fashion campaign ICPs (see docs/campaigns/uniforms-fashion-icp.md),
// reusing the exact production building blocks the discovery pipeline uses
// (src/lib/apollo/build-search-params.ts, src/lib/apollo/exclude-keywords.ts)
// so the "kept" counts printed here reflect what pass 1 of
// src/lib/pipeline/discover.ts would actually keep for each ICP.
//
// Calls only Apollo's People Search endpoint (mixed_people/api_search) — no
// bulk_match/enrichment call is made, so no Apollo reveal credits are spent.
// Writes nothing to Supabase; this is audience-quality inspection only.
//
// Global + "at least 50 employees" (2026-08-06 operator request):
//   - organizationLocations is deliberately [] on every campaign below — no
//     country filter, matching src/lib/apollo/build-search-params.ts's
//     documented behavior of omitting organization_locations[] entirely when
//     the array is empty.
//   - employeeRangeMax is set to a high ceiling (--employee-max, default
//     1000000) rather than left null. buildPeopleSearchParams only emits
//     organization_num_employees_ranges[] when BOTH bounds are set
//     (confirmed in build-search-params.test.ts: "should omit the employee
//     range when only one bound is set") — an ICP with employeeRangeMin set
//     and employeeRangeMax left null silently applies no employee filter at
//     all. So "at least 50 employees" only actually reaches Apollo if a
//     ceiling is supplied alongside the floor; this script does that, and
//     the same trick (not literally-null max) is required if this ICP is
//     saved through the real campaign UI.
//
// One real Apollo call is made per (campaign keyword, page) pair — never a
// multi-keyword q_keywords join, which is confirmed broken (see
// scripts/test-apollo-schools-search.ts and src/lib/pipeline/discover.ts's
// searchTargets/icpForTarget for why).
//
// Usage:
//   pnpm test:apollo-campaigns
//   pnpm test:apollo-campaigns -- --campaign=public-safety
//   pnpm test:apollo-campaigns -- --pages=2 --per-page=50
//   pnpm test:apollo-campaigns -- --employee-min=50 --employee-max=5000
//   pnpm test:apollo-campaigns -- --out=scripts/.output/run1.json
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
const DEFAULT_EMPLOYEE_MIN = 50
// Apollo requires both bounds to apply an employee filter at all (see file
// header) — this stands in for "no ceiling" on an open-ended "at least N" ask.
const DEFAULT_EMPLOYEE_MAX = 1_000_000
const MAX_PAGES_PER_KEYWORD = 20 // matches MAX_SEARCH_PAGES in src/lib/pipeline/discover.ts
const MAX_PER_PAGE = 100 // Apollo's documented per_page ceiling
const SAMPLE_KEPT_COUNT = 5
const SAMPLE_EXCLUDED_COUNT = 3
const BREAKDOWN_ROWS = 15

interface CampaignDefinition {
  slug: string
  name: string
  personTitles: string[]
  keywords: string[]
  excludeKeywords: string[]
}

// Kept in sync with docs/campaigns/uniforms-fashion-icp.md as of 2026-08-06
// (post client strikethrough update — campaign 7, Industrial Sector, was
// cancelled entirely and is not included here).
const CAMPAIGNS: CampaignDefinition[] = [
  {
    slug: 'public-safety',
    name: '1. Public Safety Agencies',
    personTitles: [
      'procurement officer', 'procurement manager', 'procurement director', 'purchasing manager',
      'purchasing agent', 'purchasing officer', 'purchasing coordinator', 'supply chain manager',
      'quartermaster', 'supply officer', 'uniform coordinator', 'uniform program manager', 'support services manager',
    ],
    keywords: [
      'police department', 'county jail', 'correctional facility', 'department of corrections',
      'detention center', 'juvenile detention center', 'private security company', 'security guard company',
      'security services company', 'law enforcement agency', 'public safety department', 'correctional officer academy',
    ],
    excludeKeywords: [
      'security software', 'cybersecurity', 'cyber security', 'it security', 'managed security services',
      'security systems installation', 'alarm company', 'camera systems', 'video surveillance software',
      'staffing agency', 'recruiting agency', 'executive search', 'law firm', 'attorney', 'bail bonds',
      'background check company', 'security consulting', 'security training software',
    ],
  },
  {
    slug: 'border-transit-security',
    name: '2. Border & Transit Security',
    personTitles: [
      'procurement director', 'procurement manager', 'procurement officer', 'purchasing manager',
      'purchasing officer', 'purchasing coordinator', 'supply chain manager', 'contracts manager',
      'contracting officer', 'quartermaster', 'uniform program manager', 'uniform coordinator',
    ],
    keywords: [
      'customs and border protection', 'border patrol', 'border security agency', 'airport police',
      'airport authority', 'airport security', 'transit police department', 'transportation security',
      'university police department', 'campus security department', 'port authority', 'harbor patrol',
      'seaport security', 'marine police', 'government security agency', 'federal law enforcement agency',
      'immigration enforcement agency', 'customs agency', 'checkpoint security', 'transportation authority',
      'rail transit police', 'metro transit authority',
    ],
    excludeKeywords: [
      'security software', 'cybersecurity', 'border security software', 'biometric software vendor',
      'staffing agency', 'recruiting agency', 'consulting', 'travel agency', 'freight forwarder',
      'customs brokerage software', 'logistics software', 'insurance broker', 'law firm',
      'immigration law firm', 'visa services', 'security systems installation',
    ],
  },
  {
    slug: 'defense-military',
    name: '3. Defense & Military',
    personTitles: [
      'procurement director', 'procurement manager', 'purchasing manager', 'contracting officer',
      'contracts manager', 'supply chain director', 'materiel manager', 'quartermaster',
      'sustainment manager', 'uniform program manager', 'acquisition manager',
    ],
    keywords: [
      'defense contractor', 'military contractor', 'aerospace and defense company', 'coast guard supplier',
      'armed forces supplier', 'military apparel supplier', 'tactical gear manufacturer', 'defense logistics company',
      'government contractor', 'military outfitter', 'uniform contractor', 'defense equipment supplier',
      'shipbuilding defense contractor', 'army surplus supplier', 'veteran affairs contractor',
      'homeland security contractor', 'defense procurement agency', 'military base contractor', 'defense sustainment company',
    ],
    excludeKeywords: [
      'defense software', 'cybersecurity', 'weapons manufacturer', 'ammunition manufacturer', 'firearms retailer',
      'video game developer', 'defense consulting', 'staffing agency', 'recruiting agency', 'veteran non-profit',
      'veteran charity', 'insurance broker', 'law firm', 'government relations firm', 'lobbying firm', 'think tank',
    ],
  },
  {
    slug: 'transport-utilities',
    name: '4. Private Sector — Transport & Utilities',
    personTitles: [
      'procurement director', 'procurement manager', 'purchasing manager', 'purchasing director',
      'supply chain director', 'supply chain manager', 'uniform program manager', 'employee uniform program manager',
      'fleet manager', 'facilities manager',
    ],
    keywords: [
      'airline', 'ground handling company', 'airport operator', 'airport ground services', 'railroad company',
      'rail operator', 'freight railway', 'public transit company', 'transit authority', 'bus transit company',
      'electric utility company', 'water utility company', 'natural gas utility', 'public utility company',
      'municipal utility', 'energy distribution company', 'gas distribution company',
    ],
    excludeKeywords: [
      'logistics software', 'transportation software', 'fleet management software', 'staffing agency',
      'recruiting agency', 'freight brokerage', 'consulting firm', 'insurance broker', 'law firm', 'travel agency',
      'ride sharing app', 'delivery app', 'e-commerce marketplace', 'financial services', 'media company',
      'market research firm',
    ],
  },
  {
    slug: 'hospitality-tourism',
    name: '5. Hospitality & Tourism',
    personTitles: [
      'uniform manager', 'uniform coordinator', 'director of purchasing', 'purchasing manager',
      'procurement manager', 'procurement director', 'executive housekeeper', 'director of housekeeping', 'hr manager',
    ],
    keywords: [
      'hotel', 'resort', 'luxury resort', 'boutique hotel', 'hotel chain', 'hospitality group', 'casino',
      'casino resort', 'gaming resort', 'cruise line', 'cruise ship operator', 'tourism company', 'tour operator',
      'hospitality management company', 'hotel management company', 'spa resort', 'golf resort', 'ski resort',
    ],
    excludeKeywords: [
      'travel agency', 'booking platform', 'hotel software', 'property management software', 'staffing agency',
      'recruiting agency', 'consulting firm', 'hospitality training school', 'hospitality school',
      'event planning software', 'marketing agency', 'review platform', 'vacation rental platform', 'timeshare',
    ],
  },
  {
    slug: 'healthcare',
    name: '6. Healthcare Sector',
    personTitles: [
      'procurement manager', 'procurement director', 'purchasing manager', 'purchasing director',
      'supply chain manager', 'supply chain director', 'materials manager', 'uniform coordinator',
      'environmental services director', 'director of support services',
    ],
    keywords: ['hospital', 'health system'],
    excludeKeywords: [
      'health insurance', 'medical billing software', 'healthcare software', 'electronic health records',
      'telehealth platform', 'pharmaceutical company', 'biotech company', 'medical device manufacturer',
      'staffing agency', 'recruiting agency', 'healthcare consulting', 'medical school', 'nursing school',
      'health non-profit', 'patient advocacy', 'health research institute',
    ],
  },
  {
    slug: 'retail-service',
    name: '8. Retail & Service',
    personTitles: [
      'procurement manager', 'procurement director', 'purchasing manager', 'purchasing director',
      'supply chain manager', 'uniform program manager', 'brand standards manager', 'route operations manager',
      'fleet manager',
    ],
    keywords: [
      'supermarket chain', 'grocery store chain', 'restaurant chain', 'fast food chain', 'quick service restaurant',
      'casual dining chain', 'facilities management company', 'delivery company', 'last mile delivery company',
      'courier company', 'parcel delivery company', 'package delivery service', 'messenger service',
      'food delivery logistics', 'grocery delivery service', 'retail chain', 'convenience store chain',
      'franchise restaurant group', 'catering company', 'food service company',
    ],
    excludeKeywords: [
      'delivery app', 'food delivery app', 'gig economy platform', 'e-commerce platform', 'staffing agency',
      'recruiting agency', 'marketing agency', 'consulting firm', 'point of sale software', 'restaurant software',
      'inventory software', 'insurance broker', 'law firm', 'franchise consulting', 'real estate firm',
      'media company', 'advertising agency', 'retail analytics software',
    ],
  },
  {
    slug: 'k12-schools',
    name: '9. K-12 Schools',
    personTitles: [
      'business manager', 'bursar', 'purchasing manager', 'purchasing officer', 'purchasing coordinator',
      'procurement manager', 'procurement officer', 'finance manager', 'finance director', 'facilities manager',
      'operations manager',
    ],
    keywords: [
      'private school', 'independent school', 'charter school', 'k-12 school', 'K12', 'elementary school',
      'primary school', 'middle school', 'junior high school', 'secondary school', 'high school',
      'international school', 'boarding school', 'day school', 'academy', 'preparatory school', 'prep school',
      'grammar school', 'faith-based school', 'religious school', 'catholic school', 'christian school',
      'islamic school', 'jewish school', 'montessori school', 'IB school', 'bilingual school', 'magnet school',
      'public school district', 'school district', 'education trust', 'education group', 'educational institution',
    ],
    excludeKeywords: [
      'college', 'university', 'higher education', 'tutoring', 'tutoring center', 'online school', 'virtual school',
      'edtech', 'education software', 'software', 'saas', 'recruiting', 'staffing', 'consulting', 'language school',
      'driving school', 'music school', 'dance school', 'coding bootcamp', 'training center', 'test prep',
      'coaching institute',
    ],
  },
]

const argsSchema = z.object({
  campaign: z.string().min(1),
  pages: z.number().int().min(1).max(MAX_PAGES_PER_KEYWORD),
  perPage: z.number().int().min(1).max(MAX_PER_PAGE),
  employeeMin: z.number().int().nonnegative(),
  employeeMax: z.number().int().positive(),
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
  matchedKeywords: string[]
}

interface AggregatedFetch {
  perKeyword: KeywordFetchResult[]
  uniqueCandidates: Map<string, DedupedCandidate>
}

interface ExcludedCandidate {
  candidate: ApolloSearchCandidate
  matchedKeywords: string[]
  matchedExcludeKeywords: string[]
}

interface ClassifyResult {
  kept: DedupedCandidate[]
  excluded: ExcludedCandidate[]
}

interface CampaignRunResult {
  campaign: CampaignDefinition
  baseIcp: ApolloIcpFilters
  aggregated: AggregatedFetch
  classified: ClassifyResult
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
  const defaultOut = join('scripts', '.output', `apollo-campaigns-search-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)
  const parsed = argsSchema.safeParse({
    campaign: values.get('campaign') ?? 'all',
    pages: values.has('pages') ? Number(values.get('pages')) : DEFAULT_PAGES_PER_KEYWORD,
    perPage: values.has('per-page') ? Number(values.get('per-page')) : DEFAULT_PER_PAGE,
    employeeMin: values.has('employee-min') ? Number(values.get('employee-min')) : DEFAULT_EMPLOYEE_MIN,
    employeeMax: values.has('employee-max') ? Number(values.get('employee-max')) : DEFAULT_EMPLOYEE_MAX,
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

function selectCampaigns(slug: string): CampaignDefinition[] {
  if (slug === 'all') return CAMPAIGNS
  const match = CAMPAIGNS.find((campaign) => campaign.slug === slug)
  if (!match) {
    const known = CAMPAIGNS.map((campaign) => campaign.slug).join(', ')
    throw new AppError('VALIDATION_ERROR', `Unknown --campaign "${slug}". Known slugs: ${known}, or "all".`, { slug })
  }
  return [match]
}

// keywords is deliberately empty here — each Apollo call fills in exactly
// one campaign keyword at a time (see fetchForKeyword), because a
// multi-keyword q_keywords join is confirmed broken (see file header).
// organizationLocations is deliberately empty — global, no country filter.
function buildBaseIcp(campaign: CampaignDefinition, args: Args): ApolloIcpFilters {
  return apolloIcpSchema.parse({
    personTitles: campaign.personTitles,
    organizationLocations: [],
    employeeRangeMin: args.employeeMin,
    employeeRangeMax: args.employeeMax,
    keywords: [],
    personSeniorities: [],
    contactEmailStatuses: [],
    excludeOrganizationLocations: [],
    excludeKeywords: campaign.excludeKeywords,
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
    log(`    "${keyword}": total_entries=${result.totalEntries}, fetched=${result.candidates.length}`)
    for (const candidate of result.candidates) {
      const existing = uniqueCandidates.get(candidate.apolloId)
      if (existing) existing.matchedKeywords.push(keyword)
      else uniqueCandidates.set(candidate.apolloId, { candidate, matchedKeywords: [keyword] })
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
  if (rows.length === 0) return '    (none)'
  return rows.map(([key, count]) => `    ${String(count).padStart(4)}  ${key}`).join('\n')
}

function formatCandidate(candidate: ApolloSearchCandidate): string {
  const name = [candidate.firstName, candidate.lastNamePreview].filter(Boolean).join(' ') || '(name withheld)'
  const org = candidate.organizationName ?? '(no organization)'
  const domain = candidate.organizationDomain ? ` (${candidate.organizationDomain})` : ''
  const title = candidate.title ?? '(no title)'
  return `${name} — ${title} @ ${org}${domain}`
}

async function runCampaign(
  campaign: CampaignDefinition,
  args: Args,
  searchPeople: SearchPeopleFn,
): Promise<CampaignRunResult> {
  log('')
  log(`=== ${campaign.name} ===`)
  log(`  person_titles[]: ${campaign.personTitles.length} titles`)
  log(`  keywords: ${campaign.keywords.length} phrases, each run as its own q_keywords call`)
  log(`  exclude keywords (client-side only): ${campaign.excludeKeywords.length}`)
  log(`  organization_locations[]: none (global) — employees >= ${args.employeeMin} (capped at ${args.employeeMax} to make the floor apply, see file header)`)

  const baseIcp = buildBaseIcp(campaign, args)
  const aggregated = await fetchAllKeywords(baseIcp, campaign.keywords, args.pages, args.perPage, searchPeople)
  const classified = classifyCandidates([...aggregated.uniqueCandidates.values()], campaign.excludeKeywords)

  const rawFetched = aggregated.perKeyword.reduce((sum, k) => sum + k.candidates.length, 0)
  const zeroResultKeywords = aggregated.perKeyword.filter((k) => k.totalEntries === 0).map((k) => k.keyword)
  log(`  Raw candidates fetched: ${rawFetched} | Unique: ${aggregated.uniqueCandidates.size} | Kept: ${classified.kept.length} | Excluded: ${classified.excluded.length}`)
  if (zeroResultKeywords.length > 0) {
    warn(`  ${zeroResultKeywords.length} keyword(s) returned total_entries: 0: ${zeroResultKeywords.map((k) => `"${k}"`).join(', ')}`)
  }

  if (classified.excluded.length > 0) {
    const excludeCounts = countBy(classified.excluded.flatMap((e) => e.matchedExcludeKeywords), (k) => k)
    log('  Exclude-keyword breakdown:')
    log(formatCounts(excludeCounts, BREAKDOWN_ROWS))
  }

  if (classified.kept.length > 0) {
    const orgCounts = countBy(classified.kept, (e) => e.candidate.organizationDomain ?? e.candidate.organizationName)
    log('  Top organizations (kept):')
    log(formatCounts(orgCounts, BREAKDOWN_ROWS))

    log(`  Sample kept (first ${SAMPLE_KEPT_COUNT}):`)
    classified.kept.slice(0, SAMPLE_KEPT_COUNT).forEach((e, i) => log(`    ${i + 1}. ${formatCandidate(e.candidate)}`))
  }

  if (classified.excluded.length > 0) {
    log(`  Sample excluded (first ${SAMPLE_EXCLUDED_COUNT}):`)
    classified.excluded
      .slice(0, SAMPLE_EXCLUDED_COUNT)
      .forEach((e, i) => log(`    ${i + 1}. ${formatCandidate(e.candidate)}  [matched: ${e.matchedExcludeKeywords.join(', ')}]`))
  }

  return { campaign, baseIcp, aggregated, classified }
}

function printOverallSummary(results: CampaignRunResult[]): void {
  log('')
  log('=== Overall summary ===')
  const totalCalls = results.reduce((sum, r) => sum + r.aggregated.perKeyword.reduce((s, k) => s + k.pagesFetched, 0), 0)
  log(`Apollo calls made across ${results.length} campaign(s): ${totalCalls}`)
  const rows = results.map((r) => ({
    name: r.campaign.name,
    unique: r.aggregated.uniqueCandidates.size,
    kept: r.classified.kept.length,
    excluded: r.classified.excluded.length,
    zeroResult: r.aggregated.perKeyword.filter((k) => k.totalEntries === 0).length,
  }))
  const nameWidth = Math.max(...rows.map((r) => r.name.length))
  log(`${'campaign'.padEnd(nameWidth)}  unique  kept  excluded  zero-result-keywords`)
  for (const row of rows) {
    log(
      `${row.name.padEnd(nameWidth)}  ${String(row.unique).padStart(6)}  ${String(row.kept).padStart(4)}  ${String(row.excluded).padStart(8)}  ${String(row.zeroResult).padStart(20)}`,
    )
  }
}

interface ResultsFile {
  generatedAt: string
  args: Args
  campaigns: Array<{
    slug: string
    name: string
    personTitles: string[]
    keywords: string[]
    excludeKeywords: string[]
    perKeywordTotals: Array<{ keyword: string; totalEntries: number; fetched: number; pagesFetched: number }>
    totals: { rawFetched: number; uniqueCandidates: number; kept: number; excluded: number }
    kept: DedupedCandidate[]
    excluded: ExcludedCandidate[]
  }>
}

function writeResultsFile(args: Args, results: CampaignRunResult[]): void {
  const file: ResultsFile = {
    generatedAt: new Date().toISOString(),
    args,
    campaigns: results.map((r) => {
      const rawFetched = r.aggregated.perKeyword.reduce((sum, k) => sum + k.candidates.length, 0)
      return {
        slug: r.campaign.slug,
        name: r.campaign.name,
        personTitles: r.campaign.personTitles,
        keywords: r.campaign.keywords,
        excludeKeywords: r.campaign.excludeKeywords,
        perKeywordTotals: r.aggregated.perKeyword.map((k) => ({
          keyword: k.keyword,
          totalEntries: k.totalEntries,
          fetched: k.candidates.length,
          pagesFetched: k.pagesFetched,
        })),
        totals: {
          rawFetched,
          uniqueCandidates: r.aggregated.uniqueCandidates.size,
          kept: r.classified.kept.length,
          excluded: r.classified.excluded.length,
        },
        kept: r.classified.kept,
        excluded: r.classified.excluded,
      }
    }),
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
  const campaigns = selectCampaigns(args.campaign)

  // Deferred import: src/lib/apollo/client.ts pulls in src/lib/env, whose
  // top-level `loadEnv(process.env)` call must run *after* loadEnvFile()
  // above has populated process.env — a static import at the top of this
  // file would evaluate (and fail) before main() ever runs.
  const { searchPeople } = await import('../src/lib/apollo/client')

  log(`Running ${campaigns.length} campaign(s), global, employees >= ${args.employeeMin} (capped at ${args.employeeMax}), up to ${args.pages} page(s) of ${args.perPage} per keyword.`)

  const results: CampaignRunResult[] = []
  for (const campaign of campaigns) {
    results.push(await runCampaign(campaign, args, searchPeople))
  }

  printOverallSummary(results)
  writeResultsFile(args, results)
  log('')
  log(`Full results (raw + classified, per campaign) written to: ${args.outPath}`)
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
