import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockFindOrCreateCase = vi.hoisted(() => vi.fn())
const mockUpdateLeadCase = vi.hoisted(() => vi.fn())
const mockLogEvent = vi.hoisted(() => vi.fn())
const mockLogWarn = vi.hoisted(() => vi.fn())
const mockInsertCompanyKnowledgeIfMissing = vi.hoisted(() => vi.fn())
const mockPublishJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/db/cases', () => ({ findOrCreateCase: mockFindOrCreateCase }))
vi.mock('@/lib/db/leads', () => ({ updateLeadCase: mockUpdateLeadCase }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent, logWarn: mockLogWarn }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertCompanyKnowledgeIfMissing: mockInsertCompanyKnowledgeIfMissing }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: mockPublishJson }))

import { computeCompanyKey, groupVerifiedLead } from './group-lead'

describe('computeCompanyKey', () => {
  it('should use the lowercased domain when present', () => {
    expect(computeCompanyKey('Acme.COM', 'Acme Inc')).toBe('acme.com')
  })

  it('should fall back to the normalized company name when domain is null', () => {
    expect(computeCompanyKey(null, 'Acme Inc.')).toBe('acme')
  })
})

describe('groupVerifiedLead', () => {
  beforeEach(() => {
    mockFindOrCreateCase.mockReset()
    mockUpdateLeadCase.mockReset()
    mockLogEvent.mockReset()
    mockLogWarn.mockReset()
    mockInsertCompanyKnowledgeIfMissing.mockReset()
    mockPublishJson.mockReset()
  })

  it('should find-or-create a case keyed by domain, attach the lead, log the event, and return the case id', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case1' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead1', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(caseId).toBe('case1')
    expect(mockFindOrCreateCase).toHaveBeenCalledWith({}, {
      clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', companyKey: 'acme.com',
    })
    expect(mockUpdateLeadCase).toHaveBeenCalledWith({}, 'lead1', 'case1')
    expect(mockLogEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case1', type: 'pipeline.lead_grouped',
    }))
  })

  it('should still return the case id when the audit logEvent call fails', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case3' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockRejectedValue(new Error('audit write failed'))

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead3', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(caseId).toBe('case3')
    expect(mockUpdateLeadCase).toHaveBeenCalledWith({}, 'lead3', 'case3')
  })

  it('should use the domain as the display company name when companyName is blank', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case2' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    await groupVerifiedLead({} as never, {
      id: 'lead2', clientId: 'client1', campaignId: 'camp1', companyName: null, companyDomain: 'beta.io', raw: null,
    })

    expect(mockFindOrCreateCase).toHaveBeenCalledWith({}, expect.objectContaining({ companyName: 'beta.io' }))
  })

  it('should write a company-knowledge row when raw carries firmographics', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case4' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockInsertCompanyKnowledgeIfMissing.mockResolvedValue({ id: 'k1' })

    await groupVerifiedLead({} as never, {
      id: 'lead4', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com',
      raw: { organizationIndustry: 'Software', organizationEmployeeCount: 120 },
    })

    expect(mockInsertCompanyKnowledgeIfMissing).toHaveBeenCalledWith({}, {
      clientId: 'client1',
      caseId: 'case4',
      content: 'Acme Inc. — Software industry, ~120 employees.',
      sourceUrl: 'https://acme.com',
    })
  })

  it('should not write a company-knowledge row when raw carries no firmographic fields', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case5' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    await groupVerifiedLead({} as never, {
      id: 'lead5', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(mockInsertCompanyKnowledgeIfMissing).not.toHaveBeenCalled()
  })

  it('should not write a company-knowledge row when the lead has no company domain', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case7' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockInsertCompanyKnowledgeIfMissing.mockResolvedValue({ id: 'k2' })

    await groupVerifiedLead({} as never, {
      id: 'lead7', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: null,
      raw: { organizationIndustry: 'Software' },
    })

    expect(mockInsertCompanyKnowledgeIfMissing).toHaveBeenCalledWith({}, expect.objectContaining({ sourceUrl: null }))
  })

  it('should still return the case id when insertCompanyKnowledgeIfMissing rejects', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case6' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockInsertCompanyKnowledgeIfMissing.mockRejectedValue(new Error('db write failed'))

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead6', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com',
      raw: { organizationIndustry: 'Software' },
    })

    expect(caseId).toBe('case6')
    expect(mockLogWarn).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case6', type: 'pipeline.company_knowledge_failed',
    }))
  })

  it('should trigger research immediately when the grouped case is new', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case8', status: 'new' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockPublishJson.mockResolvedValue('msg1')

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead8', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(caseId).toBe('case8')
    expect(mockPublishJson).toHaveBeenCalledWith('/api/pipeline/research', { caseId: 'case8' })
  })

  it('should not trigger research when the case already moved past new (e.g. a second contact joining an already-researched company)', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case9', status: 'contacted' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)

    await groupVerifiedLead({} as never, {
      id: 'lead9', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(mockPublishJson).not.toHaveBeenCalled()
  })

  it('should still return the case id and log a warning when the research-trigger publish fails', async () => {
    mockFindOrCreateCase.mockResolvedValue({ id: 'case10', status: 'new' })
    mockUpdateLeadCase.mockResolvedValue(undefined)
    mockLogEvent.mockResolvedValue(undefined)
    mockPublishJson.mockRejectedValue(new Error('qstash unreachable'))

    const caseId = await groupVerifiedLead({} as never, {
      id: 'lead10', clientId: 'client1', campaignId: 'camp1', companyName: 'Acme Inc.', companyDomain: 'acme.com', raw: null,
    })

    expect(caseId).toBe('case10')
    expect(mockLogWarn).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1', caseId: 'case10', type: 'pipeline.research_trigger_failed',
    }))
  })
})
