import { describe, it, expect, vi, beforeEach } from 'vitest'

const getKrMock = vi.fn()
const getEmailByIdMock = vi.fn()
const getLeadByIdMock = vi.fn()
const getCampaignForCaseMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const listKnowledgeMock = vi.fn()
const generateTextMock = vi.fn()
const sendOrDraftReplyMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/knowledge-requests', () => ({ getKnowledgeRequestById: (...a: unknown[]) => getKrMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
}))
vi.mock('@/lib/db/leads', () => ({ getLeadById: (...a: unknown[]) => getLeadByIdMock(...a) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignForCase: (...a: unknown[]) => getCampaignForCaseMock(...a) }))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/llm/client', () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }))
vi.mock('@/lib/pipeline/reply', () => ({
  sendOrDraftReply: (...a: unknown[]) => sendOrDraftReplyMock(...a),
  replyDisposition: () => 'send',
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/knowledge/client-context', () => ({ retrieveClientKnowledge: vi.fn().mockResolvedValue('') }))

import { runKnowledgeAnswer } from './knowledge-answer'

beforeEach(() => {
  for (const m of [getKrMock, getEmailByIdMock, getLeadByIdMock, getCampaignForCaseMock, listThreadEmailsMock, listKnowledgeMock, generateTextMock, sendOrDraftReplyMock, logEventMock]) m.mockReset()
  getKrMock.mockResolvedValue({ id: 'kr1', status: 'answered', email_id: 'in1', human_answer: 'Our SLA is 99.9%', client_id: 'c1', case_id: 'case1' })
  getEmailByIdMock.mockResolvedValue({ id: 'in1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', direction: 'inbound', thread_id: 't1', provider_message_id: 'g1' })
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', email: 'jane@acme.com' })
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', reply_mode: 'auto_send' })
  listThreadEmailsMock.mockResolvedValue([{ direction: 'outbound', subject: 'Quick idea' }])
  listKnowledgeMock.mockResolvedValue([{ kind: 'answer', content: 'Our SLA is 99.9%' }])
  generateTextMock.mockResolvedValue('Great question — our SLA is 99.9%.')
})

describe('runKnowledgeAnswer', () => {
  it('should generate and send a reply grounded on the human answer', async () => {
    const result = await runKnowledgeAnswer({} as never, { knowledgeRequestId: 'kr1' })
    expect(generateTextMock).toHaveBeenCalled()
    expect(sendOrDraftReplyMock).toHaveBeenCalledWith({}, expect.objectContaining({ disposition: 'send', body: 'Great question — our SLA is 99.9%.' }))
    expect(result.action).toBe('sent')
  })

  it('should skip when the request is not answered yet', async () => {
    getKrMock.mockResolvedValue({ id: 'kr1', status: 'open', email_id: 'in1', human_answer: null })
    const result = await runKnowledgeAnswer({} as never, { knowledgeRequestId: 'kr1' })
    expect(sendOrDraftReplyMock).not.toHaveBeenCalled()
    expect(result.action).toBe('skipped')
  })
})
