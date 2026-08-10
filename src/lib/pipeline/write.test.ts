import { describe, it, expect, vi, beforeEach } from 'vitest'

const listKnowledgeMock = vi.fn()
const listActiveLeadsMock = vi.fn()
const isSuppressedMock = vi.fn()
const claimOutboundEmailMock = vi.fn()
const markEmailSentMock = vi.fn()
const markEmailFailedMock = vi.fn()
const createSequenceMock = vi.fn()
const advanceSequenceMock = vi.fn()
const sendViaMailboxMock = vi.fn()
const generateJsonMock = vi.fn()
const updateCaseStatusMock = vi.fn()
const publishDelayMock = vi.fn()
const logEventMock = vi.fn()
const enqueueCrmSyncMock = vi.fn()
const getClientByIdMock = vi.fn()
const getEmailStyleByIdMock = vi.fn()
const getDefaultEmailStyleMock = vi.fn()

vi.mock('@/lib/db/case-knowledge', () => ({ listKnowledgeForCase: (...a: unknown[]) => listKnowledgeMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ listActiveLeadsForCase: (...a: unknown[]) => listActiveLeadsMock(...a) }))
vi.mock('@/lib/db/suppressions', () => ({ isSuppressed: (...a: unknown[]) => isSuppressedMock(...a) }))
vi.mock('@/lib/db/emails', () => ({
  claimOutboundEmail: (...a: unknown[]) => claimOutboundEmailMock(...a),
  markEmailSent: (...a: unknown[]) => markEmailSentMock(...a),
  markEmailFailed: (...a: unknown[]) => markEmailFailedMock(...a),
}))
vi.mock('@/lib/db/sequences', () => ({
  createSequence: (...a: unknown[]) => createSequenceMock(...a),
  advanceSequence: (...a: unknown[]) => advanceSequenceMock(...a),
}))
vi.mock('@/lib/db/cases', () => ({ updateCaseStatus: (...a: unknown[]) => updateCaseStatusMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/db/email-styles', () => ({
  getEmailStyleById: (...a: unknown[]) => getEmailStyleByIdMock(...a),
  getDefaultEmailStyle: (...a: unknown[]) => getDefaultEmailStyleMock(...a),
}))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({
  generateJson: (...a: unknown[]) => generateJsonMock(...a),
  EMAIL_WRITER_MODEL_ID: 'gemini-3.6-flash',
}))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a), logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))

import { runWriteForCase, buildPrompt, buildSystemPrompt } from './write'
import type { KnowledgeRow } from '@/lib/db/case-knowledge'
import type { LeadRow } from '@/lib/db/leads'

const lead = { id: 'lead1', client_id: 'c1', case_id: 'case1', full_name: 'Jane Doe', title: 'CTO', email: 'jane@acme.com' }
// Full LeadRow shape (unlike `lead` above, which only carries the fields the
// mocked db layer needs) — buildPrompt is called directly in the tests below,
// so its `lead` argument is real-typechecked against LeadRow, not loosened by
// a vi.fn() mock boundary.
const fullLead: LeadRow = {
  ...lead, campaign_id: 'camp1', company_name: 'Acme', company_domain: 'acme.com', linkedin_url: null,
  source: null, source_id: null, raw: null, email_status: 'verified', email_verified_at: null,
  email_verification: null, status: 'active', created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
}
const input = {
  clientId: 'c1', campaignId: 'camp1', caseId: 'case1', replyMode: 'auto_send' as const,
  valueProp: 'We save time', bookingLink: 'https://cal.com/x', mailboxIds: ['m1'], companyName: 'Acme',
}

beforeEach(() => {
  for (const m of [listKnowledgeMock, listActiveLeadsMock, isSuppressedMock, claimOutboundEmailMock,
    markEmailSentMock, markEmailFailedMock, createSequenceMock, advanceSequenceMock, sendViaMailboxMock,
    generateJsonMock, updateCaseStatusMock, publishDelayMock, logEventMock, enqueueCrmSyncMock,
    getClientByIdMock, getEmailStyleByIdMock, getDefaultEmailStyleMock]) m.mockReset()
  listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])
  isSuppressedMock.mockResolvedValue(false)
  generateJsonMock.mockResolvedValue({ subject: 'Quick idea for Acme', body: 'Hi Jane...' })
  // scheduleFirstFollowup's DEFAULT_FOLLOWUP_DELAYS_DAYS fallback covers a
  // null client lookup, so this default keeps every existing test's timing
  // assertions (3-day first follow-up) unchanged.
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null, company_info: null, email_style_id: null })
  getDefaultEmailStyleMock.mockResolvedValue({ id: 'default-style', name: 'Concise (default)', voice_instructions: 'Default voice text.', is_default: true })
})

describe('runWriteForCase', () => {
  it('should write, send, create a sequence, and enqueue the first follow-up on auto_send', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 1 })
    expect(markEmailSentMock).toHaveBeenCalled()
    expect(publishDelayMock).toHaveBeenCalled()
    expect(advanceSequenceMock).toHaveBeenCalledWith(
      expect.anything(),
      'seq1',
      expect.objectContaining({ qstashMessageId: 'qmsg1' }),
    )
    expect(updateCaseStatusMock).toHaveBeenCalledWith(expect.anything(), 'case1', 'contacted')
  })

  it('should use medium thinking with a token ceiling that keeps the JSON draft from truncating', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    await runWriteForCase({} as never, input)
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ thinkingLevel: 'low', maxOutputTokens: 2_600 }),
    )
  })

  it('should generate first-touch emails with the gemini-3.6-flash override', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    await runWriteForCase({} as never, input)
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelId: 'gemini-3.6-flash' }),
    )
  })

  it('should draft (not send) when reply_mode is human_approve', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    const result = await runWriteForCase({} as never, { ...input, replyMode: 'human_approve' })
    expect(result).toEqual({ caseId: 'case1', drafted: 1, sent: 0 })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should skip a suppressed lead', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    isSuppressedMock.mockResolvedValue(true)
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(claimOutboundEmailMock).not.toHaveBeenCalled()
  })

  it('should skip a lead whose email slot is already claimed (idempotent retry)', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue(null) // already claimed
    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(sendViaMailboxMock).not.toHaveBeenCalled()
  })

  it('should not mark the email failed when the send succeeded but markEmailSent throws', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    markEmailSentMock.mockRejectedValue(new Error('db unreachable'))

    await expect(runWriteForCase({} as never, input)).rejects.toThrow('db unreachable')
    expect(markEmailFailedMock).not.toHaveBeenCalled()
  })

  it('should mark the email failed and skip when every mailbox is rate limited', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockRejectedValue(new AppError('RATE_LIMITED', 'no mailbox available'))

    const result = await runWriteForCase({} as never, input)
    expect(result).toEqual({ caseId: 'case1', drafted: 0, sent: 0 })
    expect(markEmailFailedMock).toHaveBeenCalledWith(expect.anything(), 'e1')
    expect(markEmailSentMock).not.toHaveBeenCalled()
  })

  it('should append the phone signature to the email body when the client has a phone on file', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: 'acme.com',
      phone: '+1 555 123 4567', address: null, signature_name: null, signature_title: null,
    })

    await runWriteForCase({} as never, input)

    const expectedBody = 'Hi Jane...\n\nBest regards,\n\nAcme\n\n+1 555 123 4567\nacme.com'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
    expect(sendViaMailboxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it('should not append a signature when the client has no phone on file', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: 'Hi Jane...' }))
  })

  it('should look up the client\'s configured style and use its voice text when email_style_id is set', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Uniforms Fashion', domain: null, phone: null,
      address: null, signature_name: 'Cihat Bozkurt', signature_title: null, email_style_id: 'formal-style',
    })
    getEmailStyleByIdMock.mockResolvedValue({ id: 'formal-style', name: 'Formal introduction', voice_instructions: 'Five paragraphs, formal.', is_default: false })

    await runWriteForCase({} as never, input)

    expect(getEmailStyleByIdMock).toHaveBeenCalledWith(expect.anything(), 'formal-style')
    expect(getDefaultEmailStyleMock).not.toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Five paragraphs, formal.') }),
    )
  })

  it('should fall back to the default style when the client has no email_style_id', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(getEmailStyleByIdMock).not.toHaveBeenCalled()
    expect(getDefaultEmailStyleMock).toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Default voice text.') }),
    )
  })

  it('should fall back to the default style when the client has no row at all', async () => {
    getClientByIdMock.mockResolvedValue(null)
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(getDefaultEmailStyleMock).toHaveBeenCalled()
  })
})

describe('buildSystemPrompt', () => {
  it('should include every fixed guardrail plus the given voice text', () => {
    const result = buildSystemPrompt('Write like a friendly consultant.')
    expect(result).toContain('Always write in English')
    expect(result).toContain('No bulk markers, no unsubscribe footer, no tracking language.')
    expect(result).toContain('Use only facts present in the provided dossier')
    expect(result).toContain('Subject line: 2-5 words')
    expect(result).toContain('Write like a friendly consultant.')
  })

  it('should place the voice text after the fixed guardrails', () => {
    const result = buildSystemPrompt('UNIQUE_VOICE_MARKER')
    const guardrailIndex = result.indexOf('Always write in English')
    const voiceIndex = result.indexOf('UNIQUE_VOICE_MARKER')
    expect(guardrailIndex).toBeGreaterThanOrEqual(0)
    expect(voiceIndex).toBeGreaterThan(guardrailIndex)
  })
})

function knowledgeRow(kind: KnowledgeRow['kind'], content: string): KnowledgeRow {
  return {
    id: `k-${kind}`, client_id: 'c1', case_id: 'case1', kind, content,
    source_url: null, citation: null, created_by: 'agent', created_at: '2026-01-01T00:00:00Z',
  }
}

describe('buildPrompt', () => {
  it('should surface pain_point and news dossier facts before generic company facts', () => {
    const knowledge = [
      knowledgeRow('company', 'Acme — widgets industry, ~50 employees, founded 2001.'),
      knowledgeRow('pain_point', 'Struggling with slow onboarding for new hires.'),
      knowledgeRow('news', 'Just raised a Series B and is expanding to a second site.'),
    ]

    const prompt = buildPrompt(input, fullLead, knowledge, null)
    const dossierSection = prompt.split('Dossier:\n')[1] ?? ''
    const companyIndex = dossierSection.indexOf('(company)')
    const painPointIndex = dossierSection.indexOf('(pain_point)')
    const newsIndex = dossierSection.indexOf('(news)')

    expect(painPointIndex).toBeGreaterThanOrEqual(0)
    expect(newsIndex).toBeGreaterThanOrEqual(0)
    expect(painPointIndex).toBeLessThan(companyIndex)
    expect(newsIndex).toBeLessThan(companyIndex)
  })

  it('should include the sender name and company name when a client row is passed', () => {
    const client = {
      id: 'c1', name: 'Uniforms Fashion', signature_name: 'Cihat Bozkurt',
    } as never
    const prompt = buildPrompt(input, fullLead, [], client)
    expect(prompt).toContain('Our company name: Uniforms Fashion')
    expect(prompt).toContain('Sender name: Cihat Bozkurt')
  })

  it('should omit the sender/company lines when no client row is available', () => {
    const prompt = buildPrompt(input, fullLead, [], null)
    expect(prompt).not.toContain('Our company name:')
    expect(prompt).not.toContain('Sender name:')
  })

  it('should include the operator-entered company info as "About our company" when set', () => {
    const client = { id: 'c1', name: 'Acme', company_info: 'Acme builds inventory software for retailers.' } as never
    const prompt = buildPrompt(input, fullLead, [], client)
    expect(prompt).toContain('About our company:\nAcme builds inventory software for retailers.')
  })

  it('should omit the "About our company" line when the client has no company info on file', () => {
    const client = { id: 'c1', name: 'Acme', company_info: null } as never
    const prompt = buildPrompt(input, fullLead, [], client)
    expect(prompt).not.toContain('About our company:')
  })
})
