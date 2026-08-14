import { describe, it, expect, vi, beforeEach } from 'vitest'

const runResearchAgentMock = vi.fn()
const insertKnowledgeMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const logEventMock = vi.fn()
const logWarnMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const publishJsonMock = vi.fn()
const collectSocialKnowledgeMock = vi.fn()

vi.mock('@/lib/research/agent', () => ({ runResearchAgent: (...a: unknown[]) => runResearchAgentMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertKnowledge: (...a: unknown[]) => insertKnowledgeMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  logEventSafe: (...a: unknown[]) => logEventMock(...a),
  logWarn: (...a: unknown[]) => logWarnMock(...a),
}))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))
vi.mock('@/lib/qstash/client', () => ({ publishJson: (...a: unknown[]) => publishJsonMock(...a) }))
vi.mock('@/lib/pipeline/social-knowledge', () => ({ collectSocialKnowledge: (...a: unknown[]) => collectSocialKnowledgeMock(...a) }))

import { runResearchForCase } from './research'

const research = { search: vi.fn(), scrape: vi.fn() }
const input = {
  clientId: 'c1', caseId: 'case1', companyName: 'Acme', companyDomain: 'acme.com',
  companyFirmographics: null,
  companySocials: { linkedinUrl: null, twitterUrl: null },
  leads: [{ id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: null, twitterUrl: null }],
  seller: { name: 'Seller Co', companyInfo: 'Makes widgets.', valueProp: 'Custom widgets' },
}

beforeEach(() => {
  runResearchAgentMock.mockReset(); insertKnowledgeMock.mockReset()
  updateCaseStatusMock.mockReset(); logEventMock.mockReset()
  enqueueCrmSyncMock.mockReset()
  logWarnMock.mockReset(); publishJsonMock.mockReset()
  collectSocialKnowledgeMock.mockReset().mockResolvedValue([])
})

describe('runResearchForCase', () => {
  it('should run only the company agent, write its entries, and mark the case ready', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(runResearchAgentMock).toHaveBeenCalledTimes(1)
    expect(insertKnowledgeMock).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([
      expect.objectContaining({ case_id: 'case1', kind: 'company', content: 'Builds widgets' }),
    ]))
    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 1 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should skip person research even when the case has leads (ENABLE_PERSON_RESEARCH is off)', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'x', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, input)

    expect(runResearchAgentMock).toHaveBeenCalledTimes(1)
    expect(runResearchAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ role: expect.objectContaining({ kind: 'company' }) }),
    )
  })

  it('should pass the seller context through to the research agent', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'x', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, input)

    expect(runResearchAgentMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.objectContaining({ seller: input.seller }),
    )
  })

  it('should mark the case ready with zero knowledge when the company agent succeeds but finds nothing', async () => {
    runResearchAgentMock.mockResolvedValueOnce([])
    insertKnowledgeMock.mockResolvedValue([])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should NOT mark ready and should not insert when the company agent fails', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('down'))

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.research.agent_failed' }))
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.completed',
      payload: expect.objectContaining({ knowledgeCount: 0, agentsFailed: 1 }),
    }))
  })

  it('should run only the company agent when the case has no leads', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'x', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, { ...input, leads: [] })

    expect(runResearchAgentMock).toHaveBeenCalledTimes(1)
  })

  it('should enqueue a CRM sync once the case is marked ready', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, input)

    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'qualified')
  })

  it('should not enqueue a CRM sync when the case never reaches ready', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('down'))

    await runResearchForCase({} as never, { research }, input)

    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })

  it('should trigger the writer immediately once the case is marked ready', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])
    publishJsonMock.mockResolvedValue('msg1')

    await runResearchForCase({} as never, { research }, input)

    expect(publishJsonMock).toHaveBeenCalledWith('/api/pipeline/write', { caseId: 'case1' })
  })

  it('should not trigger the writer when the case never reaches ready', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('down'))

    await runResearchForCase({} as never, { research }, input)

    expect(publishJsonMock).not.toHaveBeenCalled()
  })

  it('should still return the result and log a warning when the write-trigger publish fails', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])
    publishJsonMock.mockRejectedValue(new Error('qstash unreachable'))

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 1 })
    expect(logWarnMock).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1', caseId: 'case1', type: 'pipeline.write_trigger_failed',
    }))
  })

  it('should insert social candidates with lead_id and event_date alongside agent entries', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
    collectSocialKnowledgeMock.mockResolvedValueOnce([{
      kind: 'news', content: 'Jane posted about hiring', sourceUrl: 'https://linkedin.com/posts/1',
      citation: 'LinkedIn post, 2026-08-10', leadId: 'lead1', eventDate: '2026-08-10T00:00:00Z',
    }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(insertKnowledgeMock).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([
      expect.objectContaining({ kind: 'company', lead_id: null, event_date: null }),
      expect.objectContaining({
        kind: 'news', content: 'Jane posted about hiring', lead_id: 'lead1', event_date: '2026-08-10T00:00:00Z',
      }),
    ]))
    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 2 })
  })

  it('should still mark the case ready and insert when every agent fails but social scraping finds something', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('agent down'))
    collectSocialKnowledgeMock.mockResolvedValueOnce([{
      kind: 'news', content: 'Company posted news', sourceUrl: 'https://linkedin.com/posts/co',
      citation: 'LinkedIn post, 2026-08-10', leadId: null, eventDate: '2026-08-10T00:00:00Z',
    }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 1 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should NOT mark ready when every agent fails and social scraping also finds nothing', async () => {
    runResearchAgentMock.mockRejectedValueOnce(new Error('agent down'))
    collectSocialKnowledgeMock.mockResolvedValueOnce([])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should pass company socials and per-lead id/linkedinUrl/twitterUrl through to collectSocialKnowledge', async () => {
    runResearchAgentMock.mockResolvedValueOnce([{ kind: 'company', content: 'x', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])
    const leadInput = {
      ...input,
      companySocials: { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
      leads: [{ id: 'lead1', fullName: 'Jane Doe', title: 'CTO', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
    }

    await runResearchForCase({} as never, { research }, leadInput)

    expect(collectSocialKnowledgeMock).toHaveBeenCalledWith(
      { clientId: 'c1', caseId: 'case1' },
      { linkedinUrl: 'https://linkedin.com/company/acme', twitterUrl: 'https://x.com/acme' },
      [{ leadId: 'lead1', linkedinUrl: 'https://linkedin.com/in/janedoe', twitterUrl: 'https://x.com/janedoe' }],
    )
  })
})
