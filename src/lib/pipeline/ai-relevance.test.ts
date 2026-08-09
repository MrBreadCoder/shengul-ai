import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGenerateJson = vi.hoisted(() => vi.fn())
vi.mock('@/lib/llm/client', () => ({ generateJson: mockGenerateJson }))

import { checkCompanyRelevance, type CampaignRelevanceContext, type CompanySnapshot } from './ai-relevance'

const context = { clientId: 'client1', actor: 'system' }

const campaign: CampaignRelevanceContext = {
  name: 'School Outreach',
  valueProp: 'We help schools hire faster.',
  keywords: ['private school'],
  excludeKeywords: ['staffing agency'],
}

const company: CompanySnapshot = {
  companyName: 'Acme Academy',
  companyDomain: 'acmeacademy.edu',
  industry: 'Education',
  employeeCount: 120,
  foundedYear: 1998,
  description: 'A K-12 private school.',
  city: 'Austin',
  state: 'TX',
  country: 'US',
}

describe('checkCompanyRelevance', () => {
  beforeEach(() => {
    mockGenerateJson.mockReset()
  })

  it('should return the model verdict when it approves', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'Matches target: K-12 private school.' })
    const verdict = await checkCompanyRelevance(context, campaign, company)
    expect(verdict).toEqual({ pass: true, reason: 'Matches target: K-12 private school.' })
  })

  it('should return the model verdict when it rejects', async () => {
    mockGenerateJson.mockResolvedValue({ pass: false, reason: 'This is a staffing agency, not a school.' })
    const verdict = await checkCompanyRelevance(context, campaign, company)
    expect(verdict).toEqual({ pass: false, reason: 'This is a staffing agency, not a school.' })
  })

  it('should propagate an error when generateJson throws', async () => {
    mockGenerateJson.mockRejectedValue(new Error('gemini down'))
    await expect(checkCompanyRelevance(context, campaign, company)).rejects.toThrow('gemini down')
  })

  it('should call generateJson with the lite model id and the caller-supplied context', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    expect(mockGenerateJson).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ modelId: 'gemini-3.1-flash-lite' }),
    )
  })

  it('should pin thinking to minimal so it never eats the 200-token classification budget', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    expect(mockGenerateJson).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ thinkingLevel: 'minimal' }),
    )
  })

  it('should cap maxOutputTokens for a small classification response', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { maxOutputTokens: number }
    expect(call.maxOutputTokens).toBeLessThanOrEqual(200)
  })

  it('should include the campaign name, value prop, keywords, exclude keywords, and company firmographics in the prompt', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    await checkCompanyRelevance(context, campaign, company)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { prompt: string }
    expect(call.prompt).toContain('School Outreach')
    expect(call.prompt).toContain('We help schools hire faster.')
    expect(call.prompt).toContain('private school')
    expect(call.prompt).toContain('staffing agency')
    expect(call.prompt).toContain('Acme Academy')
    expect(call.prompt).toContain('acmeacademy.edu')
    expect(call.prompt).toContain('Education')
    expect(call.prompt).toContain('120')
    expect(call.prompt).toContain('1998')
    expect(call.prompt).toContain('K-12 private school')
    expect(call.prompt).toContain('Austin')
  })

  it('should omit null company firmographic fields from the prompt instead of printing "null"', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    const sparseCompany: CompanySnapshot = {
      companyName: 'Acme',
      companyDomain: null,
      industry: null,
      employeeCount: null,
      foundedYear: null,
      description: null,
      city: null,
      state: null,
      country: null,
    }
    await checkCompanyRelevance(context, campaign, sparseCompany)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { prompt: string }
    expect(call.prompt).not.toContain('null')
    expect(call.prompt).toContain('Acme')
  })

  it('should omit the keyword lines from the prompt when the campaign has none', async () => {
    mockGenerateJson.mockResolvedValue({ pass: true, reason: 'ok' })
    const noKeywordCampaign: CampaignRelevanceContext = {
      name: 'Generic Outreach', valueProp: null, keywords: [], excludeKeywords: [],
    }
    await checkCompanyRelevance(context, noKeywordCampaign, company)
    const call = mockGenerateJson.mock.calls[0]?.[1] as { prompt: string }
    expect(call.prompt).not.toContain('Target keywords')
    expect(call.prompt).not.toContain('Excluded keywords')
    expect(call.prompt).not.toContain('Value proposition')
  })
})
