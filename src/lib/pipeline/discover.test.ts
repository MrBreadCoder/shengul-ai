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

describe('runDiscoveryForCampaign', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
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

  it('should fill the daily quota across both search phases: new companies, then a second contact for each', async () => {
    // dailyTarget 4 -> firstPassQuota = ceil(4/2) = 2
    mockSearchPeople
      .mockResolvedValueOnce({ // pass 1, page 1
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ // pass 2, page 1
        totalEntries: 2,
        candidates: [candidate('p3', 'p1.com'), candidate('p4', 'p2.com')],
      })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.firstPassCandidates).toBe(2)
    expect(summary.secondPassCandidates).toBe(2)
    expect(summary.newCandidates).toBe(4)
    const secondCallParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(secondCallParams['q_organization_domains_list[]']).toEqual(['p1.com', 'p2.com'])
  })

  it("should pass each lead's raw Apollo data through to groupVerifiedLead", async () => {
    mockSearchPeople.mockResolvedValueOnce({
      totalEntries: 1,
      candidates: [candidate('p1', 'p1.com')],
    })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    const rawPayload = { organizationIndustry: 'Software', organizationEmployeeCount: 50 }
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      rows.map((r, i) => ({
        id: `lead-${i}`, client_id: 'client1', campaign_id: 'camp1', source_id: r.source_id,
        email_status: 'verified', status: 'active', raw: rawPayload,
      })),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 1, icp })

    // firstPassQuota = ceil(1/2) = 1, so exactly one pick is enriched and
    // grouped, and secondPassQuota (1 - 1 = 0) means no second search call
    expect(mockGroupVerifiedLead).toHaveBeenCalledWith({}, expect.objectContaining({ raw: rawPayload }))
  })

  it('should pick at most 1 person per brand-new company during pass 1, even if two appear on the same page', async () => {
    // dailyTarget 10 -> firstPassQuota = 5, well above 1, so the skip below
    // can only be explained by the per-company cap, not the overall quota.
    mockSearchPeople
      .mockResolvedValueOnce({ // pass 1, page 1: 2 people at the same brand-new company
        totalEntries: 2,
        candidates: [candidate('p1', 'acme.com'), candidate('p2', 'acme.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop pass 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 1: no second person found
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(3)
    expect(summary.firstPassCandidates).toBe(1)
    expect(summary.secondPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p1' })])
  })

  it('should target a company from an earlier day that has exactly 1 verified lead in pass 2', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // pass 2
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    const secondCallParams = mockSearchPeople.mock.calls[1]![0] as Record<string, string | string[]>
    expect(secondCallParams['q_organization_domains_list[]']).toEqual(['acme.com'])
    expect(summary.firstPassCandidates).toBe(0)
    expect(summary.secondPassCandidates).toBe(1)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p5' })])
  })

  it('should not run pass 2 for a company with exactly 1 verified lead but no known domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: null, companyName: 'No Domain Co' }])
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
    expect(summary.secondPassCandidates).toBe(0)
  })

  it('should ignore pass-2 candidates whose company does not match any requested target domain', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p9', 'other.com')] }) // pass 2, page 1: off-target
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 2: empty, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(3)
    expect(summary.secondPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip candidates whose apolloId is already known for the campaign', async () => {
    mockGetKnownSourceIds.mockResolvedValue(new Set(['p1']))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
    expect(summary.newCandidates).toBe(0)
  })

  it('should default the quota to 50 when dailyTarget is 0, splitting the budget across both phases', async () => {
    // firstPassQuota = ceil(50/2) = 25 -- this only passes if the default is
    // really 50 (not, say, 30, which would give firstPassQuota = 15).
    const page1 = Array.from({ length: 25 }, (_, i) => candidate(`c${i}`))
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 25, candidates: page1 }) // pass 1, page 1: exactly fills firstPassQuota
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 1: no second contacts found
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

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 0, icp })

    expect(mockSearchPeople).toHaveBeenCalledTimes(2)
    expect(summary.firstPassCandidates).toBe(25)
    expect(summary.newCandidates).toBe(25)
  })

  it('should log a pipeline.discover.completed event with the summary', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockInsertLeads.mockResolvedValue([])

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp })

    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', type: 'pipeline.discover.completed',
    }))
  })

  it('should log a pipeline.discover.failed event and rethrow when a pipeline step throws', async () => {
    mockSearchPeople.mockRejectedValue(new Error('apollo down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp }),
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
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp }),
    ).resolves.toMatchObject({ campaignId: 'camp1' })
  })

  it('should rethrow the original discovery error even when failure audit logging also throws', async () => {
    mockSearchPeople.mockRejectedValue(new Error('apollo down'))
    mockLogEvent.mockRejectedValue(new Error('audit db down'))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 5, icp }),
    ).rejects.toThrow('apollo down')
  })

  it('should isolate a per-lead grouping failure so the rest of the batch is still grouped', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2: no second contacts
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead
      .mockRejectedValueOnce(new Error('db hiccup'))
      .mockResolvedValueOnce('case2')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp })

    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(2)
    expect(summary.inserted).toBe(2)
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.group_lead_failed' }))
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.discover.completed' }))
  })

  it('should persist pass-1 leads before pass 2 runs, so a pass-2 failure does not lose them', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'p1.com')] }) // pass 1, page 1
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop
      .mockRejectedValueOnce(new Error('apollo down')) // pass 2: search throws
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp }),
    ).rejects.toThrow('apollo down')

    // insertLeads was still called with the pass-1 row even though the whole
    // run ultimately throws — a retried run picks this up via
    // getKnownSourceIds instead of re-discovering and re-enriching it.
    expect(mockInsertLeads).toHaveBeenCalledWith(expect.anything(), [
      expect.objectContaining({ source_id: 'p1' }),
    ])
  })

  it('should skip a pass-1 candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 2,
        candidates: [
          { ...candidate('p1', 'p1.com'), organizationName: 'Acme Staffing Agency' },
          candidate('p2', 'p2.com'),
        ],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2: no second contacts
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.firstPassCandidates).toBe(1)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p2' })])
  })

  it('should skip a pass-1 candidate whose title matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['recruiting'] }
    mockSearchPeople
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'p1.com'), title: 'Recruiting Manager' }],
      })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, page 2: empty, stop
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2: nothing
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.firstPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should skip a pass-2 candidate whose organization name matches an excluded keyword', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p5', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // pass 2, page 1: excluded
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, page 2: empty, stop
    mockInsertLeads.mockResolvedValue([])

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    expect(summary.secondPassCandidates).toBe(0)
    expect(mockBulkMatchPeople).not.toHaveBeenCalled()
  })

  it('should permanently drop a pass-2 target company whose organization name alone matches an excluded keyword, without waiting for page exhaustion', async () => {
    const excludingIcp: ApolloIcpFilters = { ...icp, excludeKeywords: ['staffing'] }
    mockGetVerifiedLeadCompanies.mockResolvedValue([
      { companyDomain: 'acme.com', companyName: 'Acme' },
      { companyDomain: 'other.com', companyName: 'Other' },
    ])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1: nothing new
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [{ ...candidate('p1', 'acme.com'), organizationName: 'Acme Staffing' }],
      }) // pass 2, page 1: acme.com's only candidate is excluded by org name -> dropped immediately
      .mockResolvedValueOnce({
        totalEntries: 1,
        candidates: [candidate('p2', 'other.com')],
      }) // pass 2, page 2: only other.com is still targeted
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: excludingIcp },
    )

    const secondPageParams = mockSearchPeople.mock.calls[2]![0] as Record<string, string | string[]>
    expect(secondPageParams['q_organization_domains_list[]']).toEqual(['other.com'])
    expect(summary.secondPassCandidates).toBe(1)
    expect(mockBulkMatchPeople).toHaveBeenCalledWith([expect.objectContaining({ id: 'p2' })])
  })
})

describe('runDiscoveryForCampaign — Emailable deliverability guard', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
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

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

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

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

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

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: expectedStatus, status: 'parked' })
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    expect(summary.emailableRejected).toBe(1)
  })

  it('should fail open and activate the lead when the Emailable call throws', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'verified', status: 'active' })
    expect(insertedRow().email_verification).toMatchObject({ outcome: 'failed', error: 'HTTP 402' })
    expect(summary.emailableFailedOpen).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should log a client-attributed error event when the Emailable call throws', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockLogError).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'emailable.verify.failed',
      source: 'emailable',
    }))
  })

  it('should never send a full email address to the logs, only the company domain', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    const logged = JSON.stringify(mockLogError.mock.calls[0]?.[0])
    expect(logged).toContain('acme.com')
    expect(logged).not.toContain('p1@acme.com')
  })

  it('should not call Emailable for a lead Apollo did not mark verified', async () => {
    singleCandidateRun('unverified')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

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

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

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

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp })

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
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp }),
    ).rejects.toBeInstanceOf(AppError)

    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.search.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', pass: 1, page: 1 },
    })
  })

  it('should log an apollo.enrich.failed event when bulk enrichment throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockSearchPeople.mockResolvedValue({ totalEntries: 1, candidates: [candidate('p1', 'p1.com')] })
    mockBulkMatchPeople.mockRejectedValue(new AppError('RATE_LIMITED', 'quota exhausted', {}))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp }),
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

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

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

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

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
      { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp: icpWithExclude },
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
      { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp: icpWithExclude },
    )

    // Post-enrich exclude runs first and already parks the row, so the
    // suppression check (scoped to not-yet-skipped rows) never re-checks it.
    expect(summary.excludedPostEnrich).toBe(1)
    expect(summary.suppressedSkipped).toBe(0)
    expect(mockGetSuppressions).not.toHaveBeenCalled()
  })

  it('should never call getSuppressions with an empty email list', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockGetSuppressions).not.toHaveBeenCalled()
  })

  it('should still activate and group a lead that is neither suppressed nor excluded', async () => {
    singleCandidateRun()
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockVerifyEmail).toHaveBeenCalledTimes(1)
    expect(mockGroupVerifiedLead).toHaveBeenCalledTimes(1)
    expect(summary.suppressedSkipped).toBe(0)
    expect(summary.excludedPostEnrich).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should pass campaign.clientId, not campaign.id, to getKnownSourceIds', async () => {
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 0, candidates: [] })

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockGetKnownSourceIds).toHaveBeenCalledWith({}, 'client1')
  })
})

describe('runDiscoveryForCampaign — multi-keyword organization search', () => {
  // Apollo's q_keywords field only accepts one free-text phrase at a time —
  // joining multiple organization keywords into one q_keywords string
  // returns 0 results (or HTTP 422 "Value too long" once long enough),
  // confirmed live against Apollo 2026-08-06. An ICP with more than one
  // keyword must search once per keyword instead of joining them.
  const multiKeywordIcp: ApolloIcpFilters = { ...icp, keywords: ['private school', 'academy'] }

  beforeEach(() => {
    mockSearchPeople.mockReset()
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

  it('should search Apollo once per organization keyword during pass 1, moving to the next keyword when one returns nothing', async () => {
    // dailyTarget 2 -> firstPassQuota = ceil(2/2) = 1, so the single
    // "academy" pick fills pass 1 immediately.
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] }) // pass 1, "academy": found, fills quota
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, "private school": no second contact
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, "academy": no second contact either
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp: multiKeywordIcp },
    )

    expect(mockSearchPeople.mock.calls[0]![0]).toMatchObject({ q_keywords: 'private school' })
    expect(mockSearchPeople.mock.calls[1]![0]).toMatchObject({ q_keywords: 'academy' })
    expect(summary.firstPassCandidates).toBe(1)
  })

  it('should stop calling Apollo once the pass-1 quota is met, without searching remaining keywords', async () => {
    // dailyTarget 1 -> firstPassQuota = ceil(1/2) = 1, filled by "private
    // school" alone; secondPassQuota (1 - 1 = 0) means pass 2 never runs.
    mockSearchPeople.mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 1, icp: multiKeywordIcp },
    )

    // Only the one call that met quota — "academy" is never searched.
    expect(mockSearchPeople).toHaveBeenCalledTimes(1)
  })

  it('should cycle through organization keywords during pass 2 as well, alongside the domain filter', async () => {
    mockGetVerifiedLeadCompanies.mockResolvedValue([{ companyDomain: 'acme.com', companyName: 'Acme' }])
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, "private school": nothing new
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 1, "academy": nothing new
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] }) // pass 2, "private school": nothing
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p5', 'acme.com')] }) // pass 2, "academy": found
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockGroupVerifiedLead.mockResolvedValue('case1')

    const summary = await runDiscoveryForCampaign(
      {} as never,
      { id: 'camp1', clientId: 'client1', dailyTarget: 10, icp: multiKeywordIcp },
    )

    const pass2SecondCallParams = mockSearchPeople.mock.calls[3]![0] as Record<string, string | string[]>
    expect(pass2SecondCallParams).toMatchObject({ q_keywords: 'academy', 'q_organization_domains_list[]': ['acme.com'] })
    expect(summary.secondPassCandidates).toBe(1)
  })
})
