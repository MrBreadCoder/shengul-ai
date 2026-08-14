// Runs the REAL production discovery pipeline (src/lib/pipeline/discover.ts
// runDiscoveryForCampaign, unmodified — the exact function
// /api/pipeline/discover invokes) against a real campaign, using real
// credentials: real Apollo search + bulk_match (enrich credits spent for
// net-new candidates only), real Emailable verification, and real Supabase
// writes (leads/cases) under that campaign's actual client. Bypasses the
// campaign.status === 'active' gate that the QStash route enforces — this is
// a deliberate manual run, not the cron path — but only for a campaign whose
// status is 'paused' (enforced below), since an 'active' campaign is also
// eligible for the scheduled discover-fanout cron and could run
// concurrently with this script. Never touches the campaign row itself, so
// status is unchanged after this exits.
//
// Prints a before/after snapshot of the campaign's leads + cases so the
// diff (what got created/attached this run) is visible directly, alongside
// the DiscoverySummary the real function returns.
//
// Usage:
//   pnpm tsx scripts/run-discovery-live.ts --campaign=<campaign-uuid>
import { z } from 'zod'
import { apolloIcpSchema } from '../src/lib/apollo/types'
import { AppError, isAppError } from '../src/lib/errors/app-error'

const argsSchema = z.object({ campaignId: z.string().uuid() })

function log(message: string): void {
  process.stdout.write(`${message}\n`)
}

function warn(message: string): void {
  process.stderr.write(`${message}\n`)
}

function loadEnvFile(): void {
  try {
    process.loadEnvFile('.env.local')
  } catch {
    // No .env.local — fall through to whatever is already in process.env.
  }
}

function parseArgs(argv: readonly string[]): { campaignId: string } {
  const values = new Map(
    argv
      .filter((arg) => arg.startsWith('--') && arg.includes('='))
      .map((arg) => {
        const separator = arg.indexOf('=')
        return [arg.slice(2, separator), arg.slice(separator + 1)] as const
      }),
  )
  const parsed = argsSchema.safeParse({ campaignId: values.get('campaign') })
  if (!parsed.success) {
    throw new AppError(
      'VALIDATION_ERROR',
      `--campaign=<uuid> is required. ${parsed.error.issues.map((i) => i.message).join(', ')}`,
      {},
    )
  }
  return { campaignId: parsed.data.campaignId }
}

interface LeadSnapshotRow {
  id: string
  company_domain: string | null
  company_name: string | null
  case_id: string | null
  status: string
}

interface CaseSnapshotRow {
  id: string
  company_name: string
  status: string
}

// Supabase/PostgREST caps a single response at up to 1000 rows by default —
// same reasoning as PAGE_SIZE in src/lib/supabase/list-auth-users.ts. A
// campaign accumulates leads day over day, so a long-running one can exceed
// that cap; without paging through every page here, the before/after diff
// this script prints would silently miss rows past the first page and
// misreport what this run actually created.
const SNAPSHOT_PAGE_SIZE = 1000

async function fetchAllLeads(
  admin: ReturnType<typeof import('../src/lib/supabase/admin')['createAdminClient']>,
  campaignId: string,
): Promise<LeadSnapshotRow[]> {
  const rows: LeadSnapshotRow[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await admin
      .from('leads')
      .select('id, company_domain, company_name, case_id, status')
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true })
      .range(offset, offset + SNAPSHOT_PAGE_SIZE - 1)
    if (error) throw new AppError('DB_ERROR', 'Failed to snapshot leads', { cause: error.message })
    const page = data ?? []
    rows.push(...page)
    if (page.length < SNAPSHOT_PAGE_SIZE) break
    offset += SNAPSHOT_PAGE_SIZE
  }
  return rows
}

async function fetchAllCases(
  admin: ReturnType<typeof import('../src/lib/supabase/admin')['createAdminClient']>,
  campaignId: string,
): Promise<CaseSnapshotRow[]> {
  const rows: CaseSnapshotRow[] = []
  let offset = 0
  for (;;) {
    const { data, error } = await admin
      .from('cases')
      .select('id, company_name, status')
      .eq('campaign_id', campaignId)
      .order('id', { ascending: true })
      .range(offset, offset + SNAPSHOT_PAGE_SIZE - 1)
    if (error) throw new AppError('DB_ERROR', 'Failed to snapshot cases', { cause: error.message })
    const page = data ?? []
    rows.push(...page)
    if (page.length < SNAPSHOT_PAGE_SIZE) break
    offset += SNAPSHOT_PAGE_SIZE
  }
  return rows
}

async function snapshot(
  admin: ReturnType<typeof import('../src/lib/supabase/admin')['createAdminClient']>,
  campaignId: string,
): Promise<{ leads: LeadSnapshotRow[]; cases: CaseSnapshotRow[] }> {
  const [leads, cases] = await Promise.all([fetchAllLeads(admin, campaignId), fetchAllCases(admin, campaignId)])
  return { leads, cases }
}

function diffLeads(before: LeadSnapshotRow[], after: LeadSnapshotRow[]): LeadSnapshotRow[] {
  const beforeIds = new Set(before.map((row) => row.id))
  return after.filter((row) => !beforeIds.has(row.id))
}

function diffCaseStatuses(before: CaseSnapshotRow[], after: CaseSnapshotRow[]): void {
  const beforeById = new Map(before.map((row) => [row.id, row.status]))
  for (const row of after) {
    const priorStatus = beforeById.get(row.id)
    if (priorStatus === undefined) {
      log(`  + NEW case: ${row.company_name} -> ${row.status}`)
    } else if (priorStatus !== row.status) {
      log(`  ~ ${row.company_name}: ${priorStatus} -> ${row.status}`)
    }
  }
}

async function main(): Promise<void> {
  loadEnvFile()
  const args = parseArgs(process.argv.slice(2))

  // Deferred imports: these pull in src/lib/env, whose top-level
  // loadEnv(process.env) call must run *after* loadEnvFile() above.
  const { createAdminClient } = await import('../src/lib/supabase/admin')
  const { getCampaignById } = await import('../src/lib/db/campaigns')
  const { runDiscoveryForCampaign } = await import('../src/lib/pipeline/discover')

  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, args.campaignId)
  if (!campaign) throw new AppError('NOT_FOUND', `Campaign ${args.campaignId} not found`, {})

  // Scheduled discovery (discover-fanout, every 5 minutes) only ever fires
  // campaigns with status: 'active' (see listCampaignsDueForDiscovery), and
  // serializes reruns of the SAME campaign by pushing next_discover_at
  // forward as soon as it publishes — there is no separate lease to reuse
  // here. This script bypasses the /api/pipeline/discover route's own
  // status==='active' gate so it can run against a paused campaign for
  // manual testing, but that only stays safe as long as the campaign can
  // never ALSO be picked up by the cron at the same time: requiring
  // 'paused' here guarantees that, since an active campaign run live could
  // race the scheduled run and double-write against the same
  // contactsPerCompany capacity and known-lead state.
  if (campaign.status !== 'paused') {
    throw new AppError(
      'VALIDATION_ERROR',
      `Campaign ${args.campaignId} must be paused before a live discovery run (current status: "${campaign.status}"). An 'active' campaign is eligible for the scheduled discover-fanout cron and could run concurrently with this script. Pause the campaign, run this script, then resume it.`,
      { campaignId: args.campaignId, status: campaign.status },
    )
  }

  log(`=== Live discovery run: "${campaign.name}" (${campaign.status}) ===`)
  log(`daily_target=${campaign.daily_target}  contacts_per_company=${campaign.contacts_per_company}  reply_mode=${campaign.reply_mode}`)

  const before = await snapshot(admin, args.campaignId)
  log(`Before: ${before.leads.length} leads, ${before.cases.length} cases`)
  log(before.cases.map((c) => `  - ${c.company_name}: ${c.status}`).join('\n') || '  (none)')

  const icp = apolloIcpSchema.parse(campaign.icp)
  const summary = await runDiscoveryForCampaign(admin, {
    id: campaign.id,
    clientId: campaign.client_id,
    name: campaign.name,
    valueProp: campaign.value_prop,
    dailyTarget: campaign.daily_target,
    contactsPerCompany: campaign.contacts_per_company,
    icp,
  })

  log('')
  log('=== DiscoverySummary ===')
  log(JSON.stringify(summary, null, 2))

  const after = await snapshot(admin, args.campaignId)
  const newLeads = diffLeads(before.leads, after.leads)

  log('')
  log(`=== Diff: ${after.leads.length - before.leads.length} new lead row(s), ${after.cases.length - before.cases.length} new case(s) ===`)
  for (const lead of newLeads) {
    log(`  + lead: ${lead.company_name ?? '(no name)'} (${lead.company_domain ?? 'no domain'})  status=${lead.status}  case_id=${lead.case_id ?? '(ungrouped)'}`)
  }
  diffCaseStatuses(before.cases, after.cases)

  log('')
  log(`Campaign status after run: ${(await getCampaignById(admin, args.campaignId))?.status} (should be unchanged: ${campaign.status})`)
}

main().catch((error: unknown) => {
  if (isAppError(error)) {
    warn(`${error.code}: ${error.message}`)
    process.exit(1)
  }
  warn(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
