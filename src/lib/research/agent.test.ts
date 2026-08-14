import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateWithToolsMock = vi.fn()
const generateJsonMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({
  generateWithTools: (...a: unknown[]) => generateWithToolsMock(...a),
  generateJson: (...a: unknown[]) => generateJsonMock(...a),
}))
vi.mock('./tools', () => ({ buildResearchTools: () => ({}) }))

import { runResearchAgent } from './agent'

const context = { clientId: 'c1', caseId: 'case1', actor: 'research_agent' }
const research = { search: vi.fn(), scrape: vi.fn() }
const seller = { name: 'Acme Seller', companyInfo: 'Acme Seller makes widgets.', valueProp: 'Custom widgets for factories' }

beforeEach(() => { generateWithToolsMock.mockReset(); generateJsonMock.mockReset() })

describe('runResearchAgent', () => {
  it('should gather notes then extract entries for a company role', async () => {
    generateWithToolsMock.mockResolvedValue('Acme builds widgets. Series B in 2026.')
    generateJsonMock.mockResolvedValue({
      entries: [{ kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: 'site' }],
    })
    const entries = await runResearchAgent(context, { research }, {
      seller,
      role: { kind: 'company', companyName: 'Acme', companyDomain: 'acme.com', firmographics: null },
    })
    expect(entries).toEqual([
      { kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: 'site' },
    ])
    // The mock was just asserted as called above, so calls[0] is guaranteed to exist.
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).toContain('Acme')
  })

  it('should request medium thinking for the gather step', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: { kind: 'company', companyName: 'Acme', companyDomain: null, firmographics: null },
    })
    expect(generateWithToolsMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ thinkingLevel: 'medium' }),
    )
  })

  it('should include the person name in the gather prompt for a person role', async () => {
    generateWithToolsMock.mockResolvedValue('Jane Doe is CTO, spoke at a conference.')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: {
        kind: 'person',
        lead: { id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: null, twitterUrl: null },
        companyName: 'Acme',
        companyDomain: 'acme.com',
      },
    })
    // generateWithTools is awaited inside runResearchAgent above, so calls[0] exists.
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).toContain('Jane Doe')
  })

  it('should route extraction to the lighter flash-lite model, not the gather model', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: { kind: 'company', companyName: 'Acme', companyDomain: null, firmographics: null },
    })
    expect(generateJsonMock).toHaveBeenCalledWith(
      context,
      expect.objectContaining({ modelId: 'gemini-3.1-flash-lite' }),
    )
  })

  it('should return an empty array when extraction yields no entries', async () => {
    generateWithToolsMock.mockResolvedValue('nothing notable')
    generateJsonMock.mockResolvedValue({ entries: [] })
    const entries = await runResearchAgent(context, { research }, {
      seller,
      role: { kind: 'company', companyName: 'Acme', companyDomain: null, firmographics: null },
    })
    expect(entries).toEqual([])
  })

  it('should surface Apollo firmographics in the company gather prompt as background context', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: {
        kind: 'company',
        companyName: 'Acme',
        companyDomain: 'acme.com',
        firmographics: {
          industry: 'hospital & health care', employeeCount: 150, foundedYear: 1913,
          description: null, city: 'Lakeview', state: 'Oregon', country: 'United States',
        },
      },
    })
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).toContain('background context')
    expect(gatherPrompt).toContain('Lakeview, Oregon, United States')
  })

  it('should omit the Apollo context section when no firmographics are given', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: { kind: 'company', companyName: 'Acme', companyDomain: null, firmographics: null },
    })
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).not.toContain("Apollo's own match")
  })

  it('should hand the agent a known LinkedIn profile as its starting point', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: {
        kind: 'person',
        lead: { id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: null },
        companyName: 'Acme',
        companyDomain: 'acme.com',
      },
    })
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).toContain('https://linkedin.com/in/janedoe')
    expect(gatherPrompt).toContain('start here')
  })

  it('should tell the agent who it is researching for and what they sell', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller,
      role: { kind: 'company', companyName: 'Acme', companyDomain: null, firmographics: null },
    })
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).toContain('Acme Seller')
    expect(gatherPrompt).toContain('Custom widgets for factories')
    expect(gatherPrompt).toContain('Acme Seller makes widgets.')
  })

  it('should omit the seller-context section when the seller has told us nothing', async () => {
    generateWithToolsMock.mockResolvedValue('notes')
    generateJsonMock.mockResolvedValue({ entries: [] })
    await runResearchAgent(context, { research }, {
      seller: { name: null, companyInfo: null, valueProp: null },
      role: { kind: 'company', companyName: 'Acme', companyDomain: null, firmographics: null },
    })
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).not.toContain('researching this subject on behalf of')
  })
})
