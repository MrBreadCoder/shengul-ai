// One-off diagnostic (not wired into package.json) to isolate exactly which
// filter is responsible for the low total_entries counts seen in
// scripts/test-apollo-campaigns-search.ts — run the same keyword through
// Apollo with filters added one at a time and print total_entries at each
// step. Search-only, no reveal credits spent, nothing written anywhere.
import { buildPeopleSearchParams } from '../src/lib/apollo/build-search-params'
import { apolloIcpSchema, type ApolloIcpFilters } from '../src/lib/apollo/types'

function loadEnvFile(): void {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // fall through
  }
}

const CASES: Array<{ label: string; keyword: string; personTitles: string[] }> = [
  {
    label: 'campaign 1 — county jail',
    keyword: 'county jail',
    personTitles: [
      'procurement officer', 'procurement manager', 'procurement director', 'purchasing manager',
      'purchasing agent', 'purchasing officer', 'purchasing coordinator', 'supply chain manager',
      'quartermaster', 'supply officer', 'uniform coordinator', 'uniform program manager', 'support services manager',
    ],
  },
  {
    label: 'campaign 1 — police department',
    keyword: 'police department',
    personTitles: [
      'procurement officer', 'procurement manager', 'procurement director', 'purchasing manager',
      'purchasing agent', 'purchasing officer', 'purchasing coordinator', 'supply chain manager',
      'quartermaster', 'supply officer', 'uniform coordinator', 'uniform program manager', 'support services manager',
    ],
  },
  {
    label: 'campaign 2 — port authority',
    keyword: 'port authority',
    personTitles: [
      'procurement director', 'procurement manager', 'procurement officer', 'purchasing manager',
      'purchasing officer', 'purchasing coordinator', 'supply chain manager', 'contracts manager',
      'contracting officer', 'quartermaster', 'uniform program manager', 'uniform coordinator',
    ],
  },
  {
    label: 'campaign 3 — military apparel supplier',
    keyword: 'military apparel supplier',
    personTitles: [
      'procurement director', 'procurement manager', 'purchasing manager', 'contracting officer',
      'contracts manager', 'supply chain director', 'materiel manager', 'quartermaster',
      'sustainment manager', 'uniform program manager', 'acquisition manager',
    ],
  },
]

function baseIcp(personTitles: string[], employeeMin: number | null, employeeMax: number | null): ApolloIcpFilters {
  return apolloIcpSchema.parse({
    personTitles,
    organizationLocations: [],
    employeeRangeMin: employeeMin,
    employeeRangeMax: employeeMax,
    keywords: [],
    personSeniorities: [],
    contactEmailStatuses: [],
    excludeOrganizationLocations: [],
    excludeKeywords: [],
  })
}

async function main(): Promise<void> {
  loadEnvFile()
  if (!process.env.APOLLO_API_KEY) throw new Error('APOLLO_API_KEY is not set')
  const { searchPeople } = await import('../src/lib/apollo/client')

  for (const testCase of CASES) {
    process.stdout.write(`\n=== ${testCase.label} ("${testCase.keyword}") ===\n`)

    const noFilters = { ...baseIcp([], null, null), keywords: [testCase.keyword] }
    const r1 = await searchPeople(buildPeopleSearchParams(noFilters, 1, 1))
    process.stdout.write(`  keyword only, no title/employee filter:              total_entries=${r1.totalEntries}\n`)

    const withEmployee = { ...baseIcp([], 50, 1_000_000), keywords: [testCase.keyword] }
    const r2 = await searchPeople(buildPeopleSearchParams(withEmployee, 1, 1))
    process.stdout.write(`  + employees >= 50:                                    total_entries=${r2.totalEntries}\n`)

    const withTitles = { ...baseIcp(testCase.personTitles, null, null), keywords: [testCase.keyword] }
    const r3 = await searchPeople(buildPeopleSearchParams(withTitles, 1, 1))
    process.stdout.write(`  + our narrow person_titles[] (no employee filter):    total_entries=${r3.totalEntries}\n`)

    const withBoth = { ...baseIcp(testCase.personTitles, 50, 1_000_000), keywords: [testCase.keyword] }
    const r4 = await searchPeople(buildPeopleSearchParams(withBoth, 1, 1))
    process.stdout.write(`  + person_titles[] AND employees >= 50 (our test run): total_entries=${r4.totalEntries}\n`)
  }
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`)
  process.exit(1)
})
