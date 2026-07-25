import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getOverviewMetrics, getCampaignMetrics } from './analytics'

// Integration test: runs against local `supabase start`.
// Run with: set -a; . ./.env.local; set +a; pnpm test:integration
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

const stamp = Date.now()
const password = 'test-password-123'
const clientAEmail = `analytics-a-${stamp}@test.local`
const clientBEmail = `analytics-b-${stamp}@test.local`

const RANGE = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' }

let clientAId = ''
let clientBId = ''
let campaignAId = ''

async function makeUser(email: string, clientId: string | null, role: 'operator' | 'client') {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: insErr } = await admin
    .from('app_users')
    .insert({ id: data.user.id, role, client_id: clientId })
  if (insErr) throw new Error(`app_users insert failed: ${insErr.message}`)
}

async function signedInClient(email: string) {
  const supabase = createClient<Database>(url, anon, { auth: { persistSession: false } })
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn failed: ${error.message}`)
  return supabase
}

beforeAll(async () => {
  const { data: clientA, error: aErr } = await admin
    .from('clients')
    .insert({ name: `Analytics A ${stamp}` })
    .select('id')
    .single()
  if (aErr || !clientA) throw new Error(`client A insert failed: ${aErr?.message}`)
  clientAId = clientA.id

  const { data: clientB, error: bErr } = await admin
    .from('clients')
    .insert({ name: `Analytics B ${stamp}` })
    .select('id')
    .single()
  if (bErr || !clientB) throw new Error(`client B insert failed: ${bErr?.message}`)
  clientBId = clientB.id

  const { data: campaignA, error: caErr } = await admin
    .from('campaigns')
    .insert({ client_id: clientAId, name: `Campaign A ${stamp}` })
    .select('id')
    .single()
  if (caErr || !campaignA) throw new Error(`campaign A insert failed: ${caErr?.message}`)
  campaignAId = campaignA.id

  const { data: campaignB, error: cbErr } = await admin
    .from('campaigns')
    .insert({ client_id: clientBId, name: `Campaign B ${stamp}` })
    .select('id')
    .single()
  if (cbErr || !campaignB) throw new Error(`campaign B insert failed: ${cbErr?.message}`)

  // 3 leads for client A, 1 for client B.
  const { error: leadErr } = await admin.from('leads').insert([
    { client_id: clientAId, campaign_id: campaignAId, full_name: 'A One', email_status: 'verified' },
    { client_id: clientAId, campaign_id: campaignAId, full_name: 'A Two', email_status: 'verified' },
    {
      client_id: clientAId,
      campaign_id: campaignAId,
      full_name: 'A Three',
      email_status: 'unverified',
    },
    {
      client_id: clientBId,
      campaign_id: campaignB.id,
      full_name: 'B One',
      email_status: 'verified',
    },
  ])
  if (leadErr) throw new Error(`leads insert failed: ${leadErr.message}`)

  await makeUser(clientAEmail, clientAId, 'client')
  await makeUser(clientBEmail, null, 'operator')
}, 30_000)

describe('analytics_overview RLS scoping', () => {
  it("should count only the caller's own client rows for a client-role user", async () => {
    const supabase = await signedInClient(clientAEmail)
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: null, clientId: null })
    expect(overview.leadsDiscovered).toBe(3)
    expect(overview.leadsVerified).toBe(2)
  })

  it('should count across every client for an operator', async () => {
    const supabase = await signedInClient(clientBEmail)
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: null, clientId: null })
    expect(overview.leadsDiscovered).toBeGreaterThanOrEqual(4)
  })

  it("should honour a campaign filter within the caller's own client", async () => {
    const supabase = await signedInClient(clientAEmail)
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: campaignAId, clientId: null })
    expect(overview.leadsDiscovered).toBe(3)
  })

  it('should let an operator scope the overview to a single client', async () => {
    const supabase = await signedInClient(clientBEmail) // clientBEmail is seeded as an operator
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: null, clientId: clientAId })
    expect(overview.leadsDiscovered).toBe(3)
    expect(overview.leadsVerified).toBe(2)
  })

  it('should return zero rows for an operator scoped to a client with no matching data in range', async () => {
    const supabase = await signedInClient(clientBEmail)
    const overview = await getOverviewMetrics(supabase, {
      from: '1990-01-01T00:00:00.000Z',
      to: '1990-01-02T00:00:00.000Z',
      campaignId: null,
      clientId: clientAId,
    })
    expect(overview.leadsDiscovered).toBe(0)
  })
})

describe('analytics_by_campaign RLS scoping', () => {
  it("should list only the caller's own campaigns for a client-role user", async () => {
    const supabase = await signedInClient(clientAEmail)
    const rows = await getCampaignMetrics(supabase, RANGE)
    expect(rows.every((row) => row.clientId === clientAId)).toBe(true)
    expect(rows.find((row) => row.campaignId === campaignAId)?.leadsDiscovered).toBe(3)
  })

  it('should list campaigns from multiple clients for an operator', async () => {
    const supabase = await signedInClient(clientBEmail)
    const rows = await getCampaignMetrics(supabase, RANGE)
    const clientIds = new Set(rows.map((row) => row.clientId))
    expect(clientIds.size).toBeGreaterThanOrEqual(2)
  })
})
