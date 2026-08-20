import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Integration test: runs against local `supabase start`. Verifies
// recompute_case_status (supabase/migrations/0054_recompute_case_status.sql)
// directly via RPC, independent of the TypeScript wrapper added in Task 5.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

let clientId = ''
let campaignId = ''

beforeAll(async () => {
  const { data: client, error: clientErr } = await admin.from('clients')
    .insert({ name: `Recompute Test Client ${Date.now()}` }).select('id').single()
  if (clientErr || !client) throw new Error(`clients insert failed: ${clientErr?.message}`)
  clientId = client.id

  const { data: campaign, error: campaignErr } = await admin.from('campaigns')
    .insert({ client_id: clientId, name: 'Recompute Test Campaign' }).select('id').single()
  if (campaignErr || !campaign) throw new Error(`campaigns insert failed: ${campaignErr?.message}`)
  campaignId = campaign.id
}, 30_000)

async function createCase(status: Database['public']['Enums']['case_status']): Promise<string> {
  const { data, error } = await admin.from('cases')
    .insert({
      client_id: clientId, campaign_id: campaignId, company_name: 'Recompute Co',
      company_key: `recompute-${Date.now()}-${Math.random()}`, status,
    })
    .select('id').single()
  if (error || !data) throw new Error(`cases insert failed: ${error?.message}`)
  return data.id
}

async function createLead(
  caseId: string,
  stage: Database['public']['Enums']['lead_stage'] | null,
  waitReason: Database['public']['Enums']['case_wait_reason'] | null = null,
): Promise<string> {
  const { data, error } = await admin.from('leads')
    .insert({
      client_id: clientId, campaign_id: campaignId, case_id: caseId,
      full_name: 'Recompute Lead', stage, wait_reason: waitReason,
    })
    .select('id').single()
  if (error || !data) throw new Error(`leads insert failed: ${error?.message}`)
  return data.id
}

async function recompute(caseId: string) {
  const { data, error } = await admin.rpc('recompute_case_status', { p_case_id: caseId })
  if (error) throw new Error(`recompute_case_status failed: ${error.message}`)
  return data
}

describe('recompute_case_status (migration 0054)', () => {
  it('should no-op when no lead on the case has a stage yet', async () => {
    const caseId = await createCase('ready')
    await createLead(caseId, null)
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'ready', did_change: false })
  })

  it('should pick the highest-ranked active stage among mixed contacts', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'waiting', 'awaiting_manual_approval')
    await createLead(caseId, 'in_conversation')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'in_conversation', did_change: true })
  })

  it('should carry the waiting reason from the waiting lead when waiting is the primary stage', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'waiting', 'daily_cap')
    const { data: kase, error } = await admin.from('cases').select('wait_reason').eq('id', caseId).single()
    await recompute(caseId)
    const { data: after } = await admin.from('cases').select('wait_reason').eq('id', caseId).single()
    expect(error).toBeNull()
    expect(kase?.wait_reason).toBeNull()
    expect(after?.wait_reason).toBe('daily_cap')
  })

  it('should not mark the case terminal while any contact has not started', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'dead')
    await createLead(caseId, null)
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'writing', did_change: false })
  })

  it('should mark the case dead only once every contact is terminal, with no lost among them', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'dead')
    await createLead(caseId, 'dead')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'dead', did_change: true })
  })

  it('should prefer lost over dead when the case is fully terminal and mixed', async () => {
    const caseId = await createCase('writing')
    await createLead(caseId, 'lost')
    await createLead(caseId, 'dead')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'lost', did_change: true })
  })

  it('should never modify a case already won', async () => {
    const caseId = await createCase('won')
    await createLead(caseId, 'dead')
    await createLead(caseId, 'dead')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'won', did_change: false })
    const { data: after } = await admin.from('cases').select('status').eq('id', caseId).single()
    expect(after?.status).toBe('won')
  })

  it('should report did_change: false when recomputing lands on the same status again', async () => {
    const caseId = await createCase('contacted')
    await createLead(caseId, 'contacted')
    const result = await recompute(caseId)
    expect(result).toEqual({ status: 'contacted', did_change: false })
  })
})
