import { describe, it, expect, vi, beforeEach } from 'vitest'

const embedTextsMock = vi.fn()
const matchClientKnowledgeChunksMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ embedTexts: (...a: unknown[]) => embedTextsMock(...a) }))
vi.mock('@/lib/db/client-knowledge', () => ({
  matchClientKnowledgeChunks: (...a: unknown[]) => matchClientKnowledgeChunksMock(...a),
}))

import { retrieveClientKnowledge } from './client-context'

beforeEach(() => {
  embedTextsMock.mockReset()
  matchClientKnowledgeChunksMock.mockReset()
})

describe('retrieveClientKnowledge', () => {
  it('should return an empty string when no chunks match', async () => {
    embedTextsMock.mockResolvedValue([[0.1, 0.2]])
    matchClientKnowledgeChunksMock.mockResolvedValue([])
    const result = await retrieveClientKnowledge({} as never, 'c1', 'prospect facts')
    expect(result).toBe('')
  })

  it('should format matched chunks with their source titles', async () => {
    embedTextsMock.mockResolvedValue([[0.1, 0.2]])
    matchClientKnowledgeChunksMock.mockResolvedValue([
      { sourceId: 's1', sourceTitle: 'Pricing', content: 'Starts at $99/mo.', similarity: 0.9 },
      { sourceId: 's2', sourceTitle: 'About', content: 'Founded in 2019.', similarity: 0.8 },
    ])
    const result = await retrieveClientKnowledge({} as never, 'c1', 'prospect facts')
    expect(result).toBe('- (Pricing) Starts at $99/mo.\n- (About) Founded in 2019.')
  })

  it('should embed the query with RETRIEVAL_QUERY task type and pass the limit through', async () => {
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockResolvedValue([])
    await retrieveClientKnowledge({} as never, 'c1', 'q', 3)
    expect(embedTextsMock).toHaveBeenCalledWith(
      { clientId: 'c1', actor: 'client_knowledge_retrieval' },
      { values: ['q'], taskType: 'RETRIEVAL_QUERY' },
    )
    expect(matchClientKnowledgeChunksMock).toHaveBeenCalledWith(expect.anything(), 'c1', [0.1], 3)
  })

  it('should return an empty string and swallow the error when embedding fails', async () => {
    embedTextsMock.mockRejectedValue(new Error('quota exceeded'))
    const result = await retrieveClientKnowledge({} as never, 'c1', 'q')
    expect(result).toBe('')
  })

  it('should return an empty string and swallow the error when the match query fails', async () => {
    embedTextsMock.mockResolvedValue([[0.1]])
    matchClientKnowledgeChunksMock.mockRejectedValue(new Error('db down'))
    const result = await retrieveClientKnowledge({} as never, 'c1', 'q')
    expect(result).toBe('')
  })

  it('should return an empty string without calling anything when queryText is blank', async () => {
    const result = await retrieveClientKnowledge({} as never, 'c1', '   ')
    expect(result).toBe('')
    expect(embedTextsMock).not.toHaveBeenCalled()
  })

  it('should drop chunks whose similarity is below the floor', async () => {
    embedTextsMock.mockResolvedValue([[0.1, 0.2]])
    matchClientKnowledgeChunksMock.mockResolvedValue([
      { sourceId: 's1', sourceTitle: 'Pricing', content: 'Starts at $99/mo.', similarity: 0.9 },
      { sourceId: 's2', sourceTitle: 'Unrelated', content: 'Off-topic filler.', similarity: 0.2 },
    ])
    const result = await retrieveClientKnowledge({} as never, 'c1', 'prospect facts')
    expect(result).toBe('- (Pricing) Starts at $99/mo.')
  })

  it('should return an empty string when every matched chunk is below the floor', async () => {
    embedTextsMock.mockResolvedValue([[0.1, 0.2]])
    matchClientKnowledgeChunksMock.mockResolvedValue([
      { sourceId: 's1', sourceTitle: 'Unrelated', content: 'Off-topic filler.', similarity: 0.3 },
    ])
    const result = await retrieveClientKnowledge({} as never, 'c1', 'prospect facts')
    expect(result).toBe('')
  })
})
