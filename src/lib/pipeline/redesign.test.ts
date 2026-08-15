import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const getEmailByIdMock = vi.fn()
const listThreadEmailsMock = vi.fn()
const listKnowledgeMock = vi.fn()
const getClientByIdMock = vi.fn()
const generateJsonMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/db/emails', () => ({
  getEmailById: (...a: unknown[]) => getEmailByIdMock(...a),
  listThreadEmails: (...a: unknown[]) => listThreadEmailsMock(...a),
}))
vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/llm/client', () => ({
  generateJson: (...a: unknown[]) => generateJsonMock(...a),
  EMAIL_WRITER_MODEL_ID: 'gemini-3.7-flash',
}))
vi.mock('@/lib/events/log-event', () => ({ logEventSafe: (...a: unknown[]) => logEventMock(...a) }))

import { regenerateDraftContent } from './redesign'

function draftEmail(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1',
    subject: 'Old subject', body: 'Old body', status: 'draft', direction: 'outbound',
    in_reply_to_email_id: null,
    ...overrides,
  }
}

beforeEach(() => {
  for (const m of [
    getEmailByIdMock, listThreadEmailsMock, listKnowledgeMock, getClientByIdMock,
    generateJsonMock, logEventMock,
  ]) m.mockReset()
  listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])
  getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: null })
  generateJsonMock.mockResolvedValue({ subject: 'New subject', body: 'New body' })
})

describe('regenerateDraftContent', () => {
  it('should throw VALIDATION_ERROR when the email is missing', async () => {
    getEmailByIdMock.mockResolvedValue(null)
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should throw VALIDATION_ERROR when the email is not a draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ status: 'sent' }))
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should throw VALIDATION_ERROR when the draft is missing case_id or lead_id', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ case_id: null }))
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
  })

  it('should not load a thread for a first-touch draft and should return the rewrite', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    const result = await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(result).toEqual({ subject: 'New subject', body: 'New body' })
    expect(listThreadEmailsMock).not.toHaveBeenCalled()
  })

  it('should load the thread for a reply draft', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail({ in_reply_to_email_id: 'inbound1' }))
    listThreadEmailsMock.mockResolvedValue([{ direction: 'inbound', subject: 'Re: hi', body: 'thanks' }])
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'be more direct' })
    expect(listThreadEmailsMock).toHaveBeenCalledWith({}, 'lead1')
  })

  it('should log the redesign request with the instruction', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({
      type: 'inbox.draft_regenerated',
      payload: { emailId: 'e1', instruction: 'make it shorter' },
    }))
  })

  it('should use medium thinking with a token ceiling that keeps the JSON draft from truncating', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ thinkingLevel: 'low', maxOutputTokens: 2_600 }),
    )
  })

  it('should regenerate the draft with the gemini-3.7-flash override', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelId: 'gemini-3.7-flash' }),
    )
  })

  it('should inject the client\'s company info as "About our company" when set', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', company_info: 'Acme builds inventory software.' })
    await regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' })
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ prompt: expect.stringContaining('About our company:\nAcme builds inventory software.') }),
    )
  })

  it('should propagate an LLM failure', async () => {
    getEmailByIdMock.mockResolvedValue(draftEmail())
    generateJsonMock.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'LLM generateObject failed'))
    await expect(
      regenerateDraftContent({} as never, { emailId: 'e1', instruction: 'make it shorter' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })
})
