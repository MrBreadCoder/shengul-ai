import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Integration test: runs against local `supabase start`. Verifies the
// trigger + FK behavior added in
// supabase/migrations/0045_case_knowledge_lead_attribution_integrity.sql.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

let clientId = ''
let campaignId = ''
let caseAId = ''
let caseBId = ''
let leadInCaseAId = ''

beforeAll(async () => {
  const { data: client, error: clientErr } = await admin.from('clients')
    .insert({ name: `Attribution Test Client ${Date.now()}` }).select('id').single()
  if (clientErr || !client) throw new Error(`clients insert failed: ${clientErr?.message}`)
  clientId = client.id

  const { data: campaign, error: campaignErr } = await admin.from('campaigns')
    .insert({ client_id: clientId, name: 'Attribution Test Campaign' }).select('id').single()
  if (campaignErr || !campaign) throw new Error(`campaigns insert failed: ${campaignErr?.message}`)
  campaignId = campaign.id

  const { data: caseA, error: caseAErr } = await admin.from('cases')
    .insert({ client_id: clientId, campaign_id: campaignId, company_name: 'Case A Co', company_key: `case-a-${Date.now()}` })
    .select('id').single()
  if (caseAErr || !caseA) throw new Error(`cases (A) insert failed: ${caseAErr?.message}`)
  caseAId = caseA.id

  const { data: caseB, error: caseBErr } = await admin.from('cases')
    .insert({ client_id: clientId, campaign_id: campaignId, company_name: 'Case B Co', company_key: `case-b-${Date.now()}` })
    .select('id').single()
  if (caseBErr || !caseB) throw new Error(`cases (B) insert failed: ${caseBErr?.message}`)
  caseBId = caseB.id

  const { data: lead, error: leadErr } = await admin.from('leads')
    .insert({ client_id: clientId, campaign_id: campaignId, case_id: caseAId, full_name: 'Jane Lead' })
    .select('id').single()
  if (leadErr || !lead) throw new Error(`leads insert failed: ${leadErr?.message}`)
  leadInCaseAId = lead.id
}, 30_000)

describe('case_knowledge lead attribution integrity (migration 0045)', () => {
  it('should accept a lead_id that belongs to the same case and client', async () => {
    const { error } = await admin.from('case_knowledge').insert({
      client_id: clientId, case_id: caseAId, kind: 'person', content: 'Same-case fact', lead_id: leadInCaseAId,
    })
    expect(error).toBeNull()
  })

  it('should reject attribution to a lead that belongs to a different case', async () => {
    const { error } = await admin.from('case_knowledge').insert({
      client_id: clientId, case_id: caseBId, kind: 'person', content: 'Cross-case fact', lead_id: leadInCaseAId,
    })
    expect(error).not.toBeNull()
    expect(error?.message).toContain('lead_id')
  })

  it('should delete the case_knowledge row (cascade) when its attributed lead is deleted, never null the attribution', async () => {
    const { data: lead, error: leadErr } = await admin.from('leads')
      .insert({ client_id: clientId, campaign_id: campaignId, case_id: caseAId, full_name: 'Cascade Lead' })
      .select('id').single()
    if (leadErr || !lead) throw new Error(`leads insert failed: ${leadErr?.message}`)

    const { data: knowledge, error: knowledgeErr } = await admin.from('case_knowledge')
      .insert({ client_id: clientId, case_id: caseAId, kind: 'person', content: 'Cascade fact', lead_id: lead.id })
      .select('id').single()
    if (knowledgeErr || !knowledge) throw new Error(`case_knowledge insert failed: ${knowledgeErr?.message}`)

    const { error: deleteErr } = await admin.from('leads').delete().eq('id', lead.id)
    expect(deleteErr).toBeNull()

    const { data: remaining } = await admin.from('case_knowledge').select('id').eq('id', knowledge.id)
    expect(remaining).toEqual([])
  })
})
