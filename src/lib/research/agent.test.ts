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

beforeEach(() => { generateWithToolsMock.mockReset(); generateJsonMock.mockReset() })

describe('runResearchAgent', () => {
  it('should gather notes then extract entries for a company role', async () => {
    generateWithToolsMock.mockResolvedValue('Acme builds widgets. Series B in 2026.')
    generateJsonMock.mockResolvedValue({
      entries: [{ kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: 'site' }],
    })
    const entries = await runResearchAgent(context, { research }, {
      role: { kind: 'company', companyName: 'Acme', companyDomain: 'acme.com' },
      valueProp: 'save time',
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
      role: { kind: 'company', companyName: 'Acme', companyDomain: null },
      valueProp: null,
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
      role: { kind: 'person', lead: { fullName: 'Jane Doe', title: 'CTO' }, companyName: 'Acme', companyDomain: 'acme.com' },
      valueProp: null,
    })
    // generateWithTools is awaited inside runResearchAgent above, so calls[0] exists.
    const gatherPrompt = generateWithToolsMock.mock.calls[0]?.[1].prompt as string
    expect(gatherPrompt).toContain('Jane Doe')
  })

  it('should return an empty array when extraction yields no entries', async () => {
    generateWithToolsMock.mockResolvedValue('nothing notable')
    generateJsonMock.mockResolvedValue({ entries: [] })
    const entries = await runResearchAgent(context, { research }, {
      role: { kind: 'company', companyName: 'Acme', companyDomain: null },
      valueProp: null,
    })
    expect(entries).toEqual([])
  })
})
