import { describe, it, expect, vi, beforeEach } from 'vitest'

const runResearchAgentMock = vi.fn()
const insertKnowledgeMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const logEventMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()

vi.mock('@/lib/research/agent', () => ({ runResearchAgent: (...a: unknown[]) => runResearchAgentMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ insertKnowledge: (...a: unknown[]) => insertKnowledgeMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  logEventSafe: (...a: unknown[]) => logEventMock(...a),
}))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))

import { runResearchForCase } from './research'

const research = { search: vi.fn(), scrape: vi.fn() }
const input = {
  clientId: 'c1', caseId: 'case1', companyName: 'Acme', companyDomain: 'acme.com',
  valueProp: 'We save you time', leads: [{ fullName: 'Jane Doe', title: 'CTO' }],
}

beforeEach(() => {
  runResearchAgentMock.mockReset(); insertKnowledgeMock.mockReset()
  updateCaseStatusMock.mockReset(); logEventMock.mockReset()
  enqueueCrmSyncMock.mockReset()
})

describe('runResearchForCase', () => {
  it('should merge entries from all agents, write them, and mark the case ready', async () => {
    // company agent then person agent
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: 'https://acme.com', citation: null }])
      .mockResolvedValueOnce([{ kind: 'person', content: 'Jane spoke at a conf', sourceUrl: null, citation: null }])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }, { id: 'k2' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(runResearchAgentMock).toHaveBeenCalledTimes(2)
    expect(insertKnowledgeMock).toHaveBeenCalledWith(expect.anything(), expect.arrayContaining([
      expect.objectContaining({ case_id: 'case1', kind: 'company', content: 'Builds widgets' }),
      expect.objectContaining({ case_id: 'case1', kind: 'person', content: 'Jane spoke at a conf' }),
    ]))
    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 2 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should proceed to ready with a partial dossier when one agent fails', async () => {
    runResearchAgentMock
      .mockResolvedValueOnce([{ kind: 'company', content: 'Builds widgets', sourceUrl: null, citation: null }])
      .mockRejectedValueOnce(new Error('llm timeout'))
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result).toEqual({ caseId: 'case1', knowledgeCount: 1 })
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'pipeline.research.agent_failed' }))
  })

  it('should mark the case ready with zero knowledge when agents succeed but find nothing', async () => {
    runResearchAgentMock.mockResolvedValueOnce([]).mockResolvedValueOnce([])
    insertKnowledgeMock.mockResolvedValue([])

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
  })

  it('should NOT mark ready and should not insert when every agent fails', async () => {
    runResearchAgentMock
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))

    const result = await runResearchForCase({} as never, { research }, input)

    expect(result.knowledgeCount).toBe(0)
    expect(insertKnowledgeMock).not.toHaveBeenCalled()
    expect(updateCaseStatusMock).not.toHaveBeenCalledWith(expect.anything(), 'case1', 'ready')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'pipeline.research.completed',
      payload: expect.objectContaining({ knowledgeCount: 0, agentsFailed: 2 }),
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
      .mockResolvedValueOnce([])
    insertKnowledgeMock.mockResolvedValue([{ id: 'k1' }])

    await runResearchForCase({} as never, { research }, input)

    expect(enqueueCrmSyncMock).toHaveBeenCalledWith('case1', 'qualified')
  })

  it('should not enqueue a CRM sync when the case never reaches ready', async () => {
    runResearchAgentMock
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'))

    await runResearchForCase({} as never, { research }, input)

    expect(enqueueCrmSyncMock).not.toHaveBeenCalled()
  })
})
