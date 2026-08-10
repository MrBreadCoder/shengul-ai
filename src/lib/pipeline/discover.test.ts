import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockSearchPeople = vi.hoisted(() => vi.fn())
const mockBulkMatchPeople = vi.hoisted(() => vi.fn())
const mockGetKnownSourceIds = vi.hoisted(() => vi.fn())
const mockInsertLeads = vi.hoisted(() => vi.fn())
const mockGetVerifiedLeadCompanies = vi.hoisted(() => vi.fn())
const mockGroupVerifiedLead = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())
const mockLogError = vi.hoisted(() => vi.fn())
const mockVerifyEmail = vi.hoisted(() => vi.fn())
const mockGetSuppressions = vi.hoisted(() => vi.fn())
const mockCheckCompanyRelevance = vi.hoisted(() => vi.fn())

vi.mock('@/lib/apollo/client', () => ({ searchPeople: mockSearchPeople, bulkMatchPeople: mockBulkMatchPeople }))
vi.mock('@/lib/db/leads', () => ({
  getKnownSourceIds: mockGetKnownSourceIds,
  insertLeads: mockInsertLeads,
  getVerifiedLeadCompanies: mockGetVerifiedLeadCompanies,
}))
vi.mock('./group-lead', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./group-lead')>()
  return { ...actual, groupVerifiedLead: mockGroupVerifiedLead }
})
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent, logError: mockLogError }))
vi.mock('@/lib/emailable/client', () => ({ verifyEmail: mockVerifyEmail }))
vi.mock('@/lib/db/suppressions', () => ({ getSuppressions: mockGetSuppressions }))
vi.mock('./ai-relevance', () => ({ checkCompanyRelevance: mockCheckCompanyRelevance }))

import { runDiscoveryForCampaign } from './discover'
import type { ApolloIcpFilters } from '@/lib/apollo/types'

const icp: ApolloIcpFilters = {
  personTitles: ['vp sales'], organizationLocations: [], employeeRangeMin: null, employeeRangeMax: null, keywords: [],
  personSeniorities: [], contactEmailStatuses: [], excludeOrganizationLocations: [], excludeKeywords: [],
}

function candidate(apolloId: string, domain = `${apolloId}.com`) {
  return {
    apolloId, firstName: 'Jo', lastNamePreview: 'D***e', title: 'VP Sales',
    organizationName: 'Acme', organizationDomain: domain, linkedinUrl: null,
  }
}

function enriched(apolloId: string, emailStatus: string) {
  return {
    apolloId, firstName: 'Jo', lastName: 'Doe', title: 'VP Sales', email: `${apolloId}@acme.com`,
    emailStatus, linkedinUrl: null, organizationName: 'Acme', organizationDomain: 'acme.com',
  }
}

function insertedRows(rows: { source_id: string | null | undefined; email_status?: string; status?: string }[]) {
  return rows.map((r, i) => ({
    id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
    email_status: r.email_status ?? 'verified',
    status: r.status ?? 'active',
  }))
}

function verification(state: string) {
  return { state, reason: 'x', email: 'jo@acme.com', score: state === 'deliverable' ? 100 : 10 }
}

function verificationWithAcceptAll(state: string, reason: string, acceptAll: boolean) {
  return { state, reason, accept_all: acceptAll, email: 'jo@acme.com', score: 60 }
}

// Every test in this file exercises a code path that may reach the AI
// relevance check (it runs on any row eligible for Emailable, which is most
// rows in most tests here) — default it to an unconditional pass, once, at
// the file level, so tests that don't care about AI relevance behavior don't
// have to configure it individually. The dedicated 'AI relevance filter'
// describe block below overrides this per-test with
// mockResolvedValueOnce/mockRejectedValueOnce. Root-level beforeEach hooks
// run before every nested describe's own beforeEach, so this always applies
// first.
beforeEach(() => {
  mockCheckCompanyRelevance.mockReset()
  mockCheckCompanyRelevance.mockResolvedValue({ pass: true, reason: 'ai default pass' })
})

describe('runDiscoveryForCampaign', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    // Safe default for any call beyond what a test explicitly queues via
    // mockResolvedValueOnce — most tests only care about round 1's breadth
    // phase, and the round loop (runDiscoveryForCampaign) always fires at
    // least one more searchPeople call whenever the target isn't met and a
    // round made progress. Without this, an unconfigured extra call
    // resolves to undefined and crashes runBreadthSearch's destructure.
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
  })

  it('should search breadth (no domain restriction) in round 1 when there are no existing 1-lead companies to target', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ // round 1 breadth, page 1
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: both targets exhausted
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing left
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp })

    const firstCallParams = mockSearchPeople.mock.calls[0]![0] as Record<string, string | string[]>
    expect(firstCallParams['q_organization_domains_list[]']).toBeUndefined()
    expect(summary.breadthCandidates).toBe(2)
    expect(summary.depthCandidates).toBe(0)
    expect(summary.rounds).toBe(2)
    expect(summary.verified).toBe(2)
  })

  it('should use the depth phase to close the remaining shortfall in round 2, skipping breadth once the target is met', async () => {
    // contactsPerCompany: 2 reserves only 1 new-company slot for round 1
    // breadth (ceil(2 remaining / 2 per company) = 1), so breadth stops as
    // soon as that single pick lands — no page-2 probe needed — leaving the
    // other half of quota for round 2's depth phase to fill at the same
    // company.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'a.com')] }) // round 1 breadth: found, quota (1) met, stop
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p3', 'a.com')] }) // round 2 depth: second contact, fills remaining quota
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    const depthCallParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(depthCallParams['q_organization_domains_list[]']).toEqual(['a.com'])
    expect(depthCallParams.q_keywords).toBeUndefined()
    expect(summary.depthCandidates).toBe(1)
    expect(summary.breadthCandidates).toBe(1)
    expect(summary.rounds).toBe(2)
    expect(summary.verified).toBe(2)
  })

  it('should reach daily_target as N/contactsPerCompany companies with contactsPerCompany people each, not N companies with 1 lead each', async () => {
    // Regression test for the reported production bug: daily_target 4 with
    // contactsPerCompany 2 returned 4 different companies with 1 lead each
    // instead of 2 companies with 2 people each.
    mockSearchPeople
      // round 1 breadth: reserves ceil(4/2)=2 new-company slots, fills both
      // from a single page, stops without a page-2 probe.
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [candidate('p1', 'a.com'), candidate('p2', 'b.com')],
      })
      // round 2 depth: targets both companies (each sitting at 1 verified
      // lead), finds a second contact at each in a single page.
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [candidate('p3', 'a.com'), candidate('p4', 'b.com')],
      })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.breadthCandidates).toBe(2)
    expect(summary.depthCandidates).toBe(2)
    expect(summary.verified).toBe(4)
    expect(summary.rounds).toBe(2)
  })

  it('should fall back to breadth in a later round when depth finds no second contact, still reaching daily_target', async () => {
    // Regression test for the reported production bug: daily_target 15
    // returned only 9 companies, each with 1 lead, because the depth phase
    // never found a second contact and nothing retried the shortfall.
    // contactsPerCompany: 2 reserves only 1 new-company slot for round 1
    // breadth, so it stops after its single pick with no page-2 probe.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'a.com')] }) // round 1 breadth: found, quota (1) met, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: a.com has no second contact
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p2', 'b.com')] }) // round 2 breadth: fresh company
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(summary.depthCandidates).toBe(0)
    expect(summary.breadthCandidates).toBe(2)
    expect(summary.verified).toBe(2)
    expect(summary.inserted).toBe(2)
  })

  it('should not re-query an exhausted target domain in a later round', async () => {
    // Round 1 breadth reserves ceil(3/2)=2 new-company slots, so it still
    // needs its page-2 probe (only 1 real candidate arrives on page 1) —
    // unaffected by the contactsPerCompany fix. Round 2 breadth reserves
    // only ceil(2/2)=1 slot, so — unlike round 1 — it stops right after its
    // single pick with no page-2 probe.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'a.com')] }) // round 1 breadth, page 1: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth (targets [a.com]): exhausted
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p2', 'b.com')] }) // round 2 breadth: found, quota (1) met, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 3 depth (targets [b.com] only): exhausted
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 3 breadth: nothing left, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 3, contactsPerCompany: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(6)
    const round3DepthParams = mockSearchPeople.mock.calls[4]![0] as Record<string, string | string[]>
    expect(round3DepthParams['q_organization_domains_list[]']).toEqual(['b.com'])
    expect(summary.verified).toBe(2) // short of daily_target 3 — Apollo genuinely ran dry
    expect(summary.rounds).toBe(3)
  })

  it('should stop without reaching daily_target when a round finds nothing at all', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, contactsPerCompany: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary.verified).toBe(0)
    expect(summary.rounds).toBe(1)
    expect(summary.inserted).toBe(0)
  })

  it('should pick at most 1 person per brand-new company during a breadth phase, even if two appear on the same page', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ // round 1 breadth, page 1: 2 people at the same brand-new company
        totalEntries: 2,
        candidates: [candidate('p1', 'acme.com'), candidate('p2', 'acme.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: no second contact
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp })

    expect(summary.breadthCandidates).toBe(1)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p1' })])
  })

  it('should target a company from an earlier day that already has exactly 1 verified lead, starting with depth in round 1', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // round 1 depth: found
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing new
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp })

    const firstCallParams = mockSearchPeople.mock.calls[0]![0] as Record<string, string | string[]>
    expect(firstCallParams['q_organization_domains_list[]']).toEqual(['acme.com'])
    expect(firstCallParams.q_keywords).toBeUndefined()
    expect(summary.depthCandidates).toBe(1)
    expect(summary.breadthCandidates).toBe(0)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p5' })])
  })

  it('should not target a company with exactly 1 verified lead but no known domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: null, companyName: 'No Domain Co' }])
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary.depthCandidates).toBe(0)
  })

  it('should ignore depth-phase candidates whose company does not match any requested target domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p9', 'other.com')] }) // round 1 depth, page 1: off-target
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 depth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp })

    expect(summary.depthCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip candidates whose apolloId is already known for the client', async () => {
    mockGetKnownSourceIds.mockResolvedValue(new Set(['p1']))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, contactsPerCompany: 2, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
    expect(summary.newCandidates).toBe(0)
  })

  it('should default the quota to 50 when dailyTarget is 0, filling it entirely via breadth across two pages', async () => {
    const page1 = Array.from({ length: 25 }, (_, i) => candidate(`c${i}`))
    const page2 = Array.from({ length: 25 }, (_, i) => candidate(`d${i}`))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 25, candidates: page1 })
      .mockResolvedValueOnce({ totalEntries: 25, candidates: page2 })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
        email_status: 'verified', status: 'active',
      })),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    // contactsPerCompany: 1 — this test is about the DEFAULT_DAILY_QUOTA
    // fallback filling entirely via breadth in one round, not the
    // per-company reservation math (covered by its own tests above).
    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 0, contactsPerCompany: 1, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.breadthCandidates).toBe(50)
    expect(summary.newCandidates).toBe(50)
    expect(summary.rounds).toBe(1)
  })

  it('should log a pipeline.discover.completed event with the summary', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, contactsPerCompany: 2, icp })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', type: 'pipeline.discover.completed',
    }))
  })

  it('should log a pipeline.discover.failed event and rethrow when a pipeline step throws', async () => {
    mockSearchPeople.mockRejectedValue(new Error('apollo down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, contactsPerCompany: 2, icp }),
    ).rejects.toThrow('apollo down')

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.failed',
      payload: expect.objectContaining({ campaignId: 'camp1', error: 'apollo down' }),
    }))
    expect(mockLogEvent).not.toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.completed' }))
  })

  it('should still return the summary when the completion audit log throws', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])
    mockLogEvent.mockRejectedValue(new Error('audit db down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, contactsPerCompany: 2, icp }),
    ).resolves.toMatchObject({ campaignId: 'camp1' })
  })

  it('should rethrow the original discovery error even when failure audit logging also throws', async () => {
    mockSearchPeople.mockRejectedValue(new Error('apollo down'))
    mockLogEvent.mockRejectedValue(new Error('audit db down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 5, contactsPerCompany: 2, icp }),
    ).rejects.toThrow('apollo down')
  })

  it('should isolate a per-lead grouping failure so the rest of the batch is still grouped', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce('case2')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp })

    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(2)
    expect(summary.inserted).toBe(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.group_lead_failed' }))
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.completed' }))
  })

  it('should persist round-1 leads before a later round throws, so they are not lost', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'p1.com')] }) // round 1 breadth, page 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockRejectedValueOnce(new Error('apollo down')) // round 2 depth: search throws
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp }),
    ).rejects.toThrow('apollo down')

    // insertLeads was still called with the round-1 row even though the
    // whole run ultimately throws — a retried run picks this up via
    // getKnownSourceIds instead of re-discovering and re-enriching it.
    expect(mockInsertLeads).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ source_id: 'p1' }),
    ])
  })

  it('should skip a breadth candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [
          { ...candidate('p1', 'p1.com'), organizationName: 'Acme Staffing Agency' },
          candidate('p2', 'p2.com'),
        ],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth: nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp: excludingIcp },
    )

    expect(summary.breadthCandidates).toBe(1)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p2' })])
  })

  it('should skip a breadth candidate whose title matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['recruiting'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'p1.com'), title: 'Recruiting Manager' }],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: empty, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp: excludingIcp },
    )

    expect(summary.breadthCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip a depth-phase candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p5', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // round 1 depth: excluded by org name, target dropped immediately
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp: excludingIcp },
    )

    expect(summary.depthCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should permanently drop a depth target company whose organization name alone matches an excluded keyword, without waiting for page exhaustion of the other target', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([
      { companyDomain: 'acme.com', companyName: 'Acme' },
      { companyDomain: 'other.com', companyName: 'Other' },
    ])
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // round 1 depth, page 1: acme.com's only candidate excluded by org name -> dropped immediately
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [candidate('p2', 'other.com')],
      }) // round 1 depth, page 2: only other.com is still targeted (page reset — see the narrowed domain filter below)
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth: nothing, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 depth (targets [acme.com]): exhausted
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth: nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp: excludingIcp },
    )

    const secondPageParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(secondPageParams['q_organization_domains_list[]']).toEqual(['other.com'])
    expect(summary.depthCandidates).toBe(1)
    expect(mockBulkMatchPeople.mock.calls[0]![0]).toEqual([expect.objectContaining({ id: 'p2' })])
  })
})

describe('runDiscoveryForCampaign — Emailable deliverability guard', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    // Safe default for any call beyond what a test explicitly queues via
    // mockResolvedValueOnce — most tests only care about pass 1/pass 2, and
    // the top-up pass (runDiscoveryForCampaign, fills quota shortfall left
    // by pass 2) always fires at least one more searchPeople call whenever
    // quota remains. Without this, an unconfigured extra call resolves to
    // undefined and crashes runFirstPass's destructure.
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGroupVerifiedLead.mockResolvedValue('case1')
    mockGetSuppressions.mockResolvedValue(new Set())
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  // One brand-new company on pass 1, nothing on pass 2 — the smallest run that
  // still exercises both passes.
  function singleCandidateRun(apolloEmailStatus = 'verified') {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, apolloEmailStatus)),
    )
  }

  function insertedRow(): Record<string, unknown> {
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    // insertLeads is called once per pass (pass-1 leads persist before pass 2
    // runs — see discover.ts). Every test using this helper only produces a
    // pass-1 candidate, so the first call always holds it.
    return rows[0]!
  }

  it('should activate the lead when Emailable says deliverable', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'verified', status: 'active' })
    expect(insertedRow().email_verified_at).toEqual(expect.any(String))
    expect(insertedRow().email_verification).toMatchObject({ provider: 'emailable', outcome: 'checked', state: 'deliverable' })
    expect(summary.emailableChecked).toBe(1)
    expect(summary.emailableDeliverable).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.emailableFailedOpen).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should park the lead as invalid and never group it when Emailable says undeliverable', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verification('undeliverable'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'invalid', status: 'parked', email_verified_at: null })
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    expect(summary.emailableRejected).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it.each([
    ['risky', 'risky'],
    ['unknown', 'unverified'],
  ])('should park the lead when Emailable says %s', async (state, expectedStatus) => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verification(state))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: expectedStatus, status: 'parked' })
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    expect(summary.emailableRejected).toBe(1)
  })

  it('should activate the lead when Emailable says risky but the domain is an unconfirmable catch-all', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_deliverability', true))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'risky', status: 'active' })
    expect(insertedRow().email_verified_at).toEqual(expect.any(String))
    expect(summary.emailableDeliverable).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should count an activated catch-all lead separately from a clean deliverable one', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_deliverability', true))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(summary.emailableAcceptAllActivated).toBe(1)
  })

  it('should still park a risky lead when the domain is not accept_all', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_deliverability', false))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'risky', status: 'parked' })
    expect(summary.emailableRejected).toBe(1)
  })

  it('should still park a risky/low_quality lead even when the domain is accept_all', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verificationWithAcceptAll('risky', 'low_quality', true))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'risky', status: 'parked' })
    expect(summary.emailableRejected).toBe(1)
  })

  it('should fail open and activate the lead when the Emailable call throws', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'verified', status: 'active' })
    expect(insertedRow().email_verification).toMatchObject({ outcome: 'failed', error: 'HTTP 402' })
    expect(summary.emailableFailedOpen).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should log a client-attributed error event when the Emailable call throws', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockLogError).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'emailable.verify.failed',
      source: 'emailable',
    }))
  })

  it('should never send a full email address to the logs, only the company domain', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    const logged = JSON.stringify(mockLogError.mock.calls[0]?.[0])
    expect(logged).toContain('acme.com')
    expect(logged).not.toContain('p1@acme.com')
  })

  it('should not call Emailable for a lead Apollo did not mark verified', async () => {
    singleCandidateRun('unverified')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(insertedRow()).toMatchObject({ email_status: 'unverified', status: 'parked', email_verification: null })
    expect(summary.emailableChecked).toBe(0)
  })

  it('should not call Emailable when Apollo returned a verified status but no email address', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => ({ ...enriched(d.id, 'verified'), email: null })),
    )

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(insertedRow()).toMatchObject({ status: 'parked' })
  })

  it('should give every lead its own verdict when one verification in a batch fails', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 2, candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockVerifyEmail
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(verification('undeliverable'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp })

    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ status: 'active' })
    expect(rows[1]).toMatchObject({ status: 'parked', email_status: 'invalid' })
    expect(summary.emailableFailedOpen).toBe(1)
    expect(summary.emailableRejected).toBe(1)
    expect(summary.emailableChecked).toBe(2)
  })
})

describe('apollo failure attribution', () => {
  // Own setup rather than leaning on the sibling describe's beforeEach: these
  // tests must not depend on residual mock state from the tests above.
  beforeEach(() => {
    mockSearchPeople.mockReset()
    // Safe default for any call beyond what a test explicitly queues via
    // mockResolvedValueOnce — most tests only care about pass 1/pass 2, and
    // the top-up pass (runDiscoveryForCampaign, fills quota shortfall left
    // by pass 2) always fires at least one more searchPeople call whenever
    // quota remains. Without this, an unconfigured extra call resolves to
    // undefined and crashes runFirstPass's destructure.
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
  })

  it('should log an apollo.search.failed event against the client when the search throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockSearchPeople.mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'HTTP request failed', {}))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp }),
    ).rejects.toBeInstanceOf(AppError)

    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.search.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', phase: 'breadth', round: 1, page: 1 },
    })
  })

  it('should log an apollo.enrich.failed event when bulk enrichment throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockSearchPeople.mockResolvedValue({ totalEntries: 1, candidates: [candidate('p1', 'p1.com')] })
    mockBulkMatchPeople.mockRejectedValue(new AppError('RATE_LIMITED', 'quota exhausted', {}))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 4, contactsPerCompany: 2, icp }),
    ).rejects.toBeInstanceOf(AppError)

    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.enrich.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', batchSize: 1 },
    })
  })
})

describe('runDiscoveryForCampaign — suppression and post-enrich exclude filters', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    // Safe default for any call beyond what a test explicitly queues via
    // mockResolvedValueOnce — most tests only care about pass 1/pass 2, and
    // the top-up pass (runDiscoveryForCampaign, fills quota shortfall left
    // by pass 2) always fires at least one more searchPeople call whenever
    // quota remains. Without this, an unconfigured extra call resolves to
    // undefined and crashes runFirstPass's destructure.
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  function singleCandidateRun() {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
  }

  it('should park a suppressed lead without calling Emailable, and never group it', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ email_status: 'verified', status: 'parked' })
    expect(summary.suppressedSkipped).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it('should log a pipeline.discover.suppressed_skipped event for a suppressed lead', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.suppressed_skipped',
      source: 'pipeline',
      payload: expect.objectContaining({ campaignId: 'camp1', leadSourceId: 'p1' }),
    }))
  })

  it('should park a lead that only matches an exclude keyword in post-enrich firmographics, without calling Emailable', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => ({ ...enriched(d.id, 'verified'), organizationIndustry: 'Staffing & Recruiting' })),
    )
    const icpWithExclude: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp: icpWithExclude },
    )

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ email_status: 'verified', status: 'parked' })
    expect(summary.excludedPostEnrich).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it('should not double-count a lead that is both suppressed and post-enrich excluded', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => ({ ...enriched(d.id, 'verified'), organizationIndustry: 'Staffing & Recruiting' })),
    )
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))
    const icpWithExclude: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp: icpWithExclude },
    )

    // Post-enrich exclude runs first and already parks the row, so the
    // suppression check (scoped to not-yet-skipped rows) never re-checks it.
    expect(summary.excludedPostEnrich).toBe(1)
    expect(summary.suppressedSkipped).toBe(0)
    expect(mockGetSuppressions).not.toHaveBeenCalled()
  })

  it('should never call getSuppressions with an empty email list', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockGetSuppressions).not.toHaveBeenCalled()
  })

  it('should still activate and group a lead that is neither suppressed nor excluded', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.suppressedSkipped).toBe(0)
    expect(summary.excludedPostEnrich).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should pass campaign.clientId, not campaign.id, to getKnownSourceIds', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp })

    expect(mockGetKnownSourceIds).toHaveBeenCalledWith({}, 'client1')
  })
})

describe('runDiscoveryForCampaign — multi-keyword organization search', () => {
  // Apollo's q_keywords field only accepts one free-text phrase at a time —
  // joining multiple organization keywords into one q_keywords string
  // returns 0 results (or HTTP 422 "Value too long" once long enough),
  // confirmed live against Apollo 2026-08-06. An ICP with more than one
  // keyword must search once per keyword instead of joining them. This only
  // applies to the breadth phase — the depth phase drops q_keywords
  // entirely (see the dedicated test below).
  const multiKeywordIcp: ApolloIcpFilters = { ...icp, keywords: ['private school', 'academy'] }

  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  it('should search Apollo once per organization keyword during a breadth phase, moving to the next keyword when one returns nothing', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] }) // "academy": found, fills quota
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 1, contactsPerCompany: 2, icp: multiKeywordIcp },
    )

    expect(mockSearchPeople.mock.calls[0]![0]).toMatchObject({ q_keywords: 'private school' })
    expect(mockSearchPeople.mock.calls[1]![0]).toMatchObject({ q_keywords: 'academy' })
    expect(summary.breadthCandidates).toBe(1)
  })

  it('should stop calling Apollo once the breadth quota is met, without searching remaining keywords', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 1, contactsPerCompany: 2, icp: multiKeywordIcp },
    )

    // Only the one call that met quota — "academy" is never searched.
    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
  })

  it('should NOT cycle through organization keywords during the depth phase — it searches once per page with no q_keywords', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // round 1 depth: found, no keyword cycling
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, "academy": nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth, "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 2 breadth, "academy": nothing, stop
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp: multiKeywordIcp },
    )

    const depthCallParams = mockSearchPeople.mock.calls[0]![0] as Record<string, string | string[]>
    expect(depthCallParams.q_keywords).toBeUndefined()
    expect(depthCallParams['q_organization_domains_list[]']).toEqual(['acme.com'])
    expect(summary.depthCandidates).toBe(1)
  })
})

describe('runDiscoveryForCampaign — AI relevance filter', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    // Safe default for any call beyond what a test explicitly queues via
    // mockResolvedValueOnce — most tests only care about pass 1/pass 2, and
    // the top-up pass (runDiscoveryForCampaign, fills quota shortfall left
    // by pass 2) always fires at least one more searchPeople call whenever
    // quota remains. Without this, an unconfigured extra call resolves to
    // undefined and crashes runFirstPass's destructure.
    mockSearchPeople.mockResolvedValue({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetSuppressions.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGetSuppressions.mockResolvedValue(new Set())
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGroupVerifiedLead.mockResolvedValue('case1')
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  function singleCandidateRun() {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
  }

  it('should park a lead the AI rejects, without calling Emailable, and never group it', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockResolvedValueOnce({ pass: false, reason: 'Wrong industry for this campaign.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ email_status: 'verified', status: 'parked' })
    expect(summary.aiChecked).toBe(1)
    expect(summary.aiRejected).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it('should log a pipeline.discover.ai_rejected event with the model reason', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockResolvedValueOnce({ pass: false, reason: 'Wrong industry for this campaign.' })

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.ai_rejected',
      source: 'pipeline',
      payload: expect.objectContaining({
        campaignId: 'camp1', leadSourceId: 'p1', companyKey: 'acme.com', reason: 'Wrong industry for this campaign.',
      }),
    }))
  })

  it('should still activate and group a lead the AI approves', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockResolvedValueOnce({ pass: true, reason: 'Matches target profile.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.aiChecked).toBe(1)
    expect(summary.aiRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should call checkCompanyRelevance only once for two eligible rows at the same company in one run', async () => {
    // Round 1 breadth finds a brand-new company (p1 @ acme.com); it
    // verifies, so round 2's depth phase targets acme.com for a second
    // contact (p5) — both share a company_key within one discovery run,
    // the exact scenario the cache exists for.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] }) // round 1 breadth, page 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // round 1 breadth, page 2: stop
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // round 2 depth: second contact
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockCheckCompanyRelevance.mockResolvedValue({ pass: true, reason: 'Matches target profile.' })

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 10, contactsPerCompany: 2, icp },
    )

    expect(mockCheckCompanyRelevance).toHaveBeenCalledTimes(1)
    expect(summary.aiChecked).toBe(2)
    expect(summary.depthCandidates).toBe(1)
  })

  it('should not call checkCompanyRelevance for a lead already parked by suppression', async () => {
    singleCandidateRun()
    mockGetSuppressions.mockResolvedValue(new Set(['p1@acme.com']))

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockCheckCompanyRelevance).not.toHaveBeenCalled()
    expect(summary.aiChecked).toBe(0)
  })

  it('should not call checkCompanyRelevance for a lead Apollo did not mark verified', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'unverified')),
    )

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockCheckCompanyRelevance).not.toHaveBeenCalled()
    expect(summary.aiChecked).toBe(0)
  })

  it('should fail open and still activate the lead when the AI check throws', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockRejectedValueOnce(new Error('gemini down'))

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.aiFailedOpen).toBe(1)
    expect(summary.aiRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should log a pipeline.discover.ai_check_failed event when the AI check throws', async () => {
    singleCandidateRun()
    mockCheckCompanyRelevance.mockRejectedValueOnce(new Error('gemini down'))

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', name: 'Test Campaign', valueProp: 'We help teams do X.', dailyTarget: 2, contactsPerCompany: 2, icp },
    )

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'pipeline.discover.ai_check_failed',
      source: 'pipeline',
      payload: expect.objectContaining({ campaignId: 'camp1', companyKey: 'acme.com', error: 'gemini down' }),
    }))
  })

  it('should pass the campaign name, value prop, and ICP keywords to checkCompanyRelevance', async () => {
    singleCandidateRun()
    const keywordIcp: ApolloIcpFilters = { ...icp, keywords: ['private school'], excludeKeywords: ['staffing'] }

    await runDiscoveryForCampaign(
      {} as never,
      {
        id: 'camp1', clientId: 'client1', name: 'School Outreach', valueProp: 'We help schools hire.',
        dailyTarget: 2, contactsPerCompany: 2, icp: keywordIcp,
      },
    )

    expect(mockCheckCompanyRelevance).toHaveBeenCalledWith(
      { clientId: 'client1', actor: 'system' },
      { name: 'School Outreach', valueProp: 'We help schools hire.', keywords: ['private school'], excludeKeywords: ['staffing'] },
      expect.objectContaining({ companyName: 'Acme', companyDomain: 'acme.com' }),
    )
  })
})
