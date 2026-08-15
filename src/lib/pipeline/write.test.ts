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
const getEmailTemplateByIdMock = vi.fn()
const getDefaultEmailTemplateMock = vi.fn()

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
vi.mock('@/lib/db/email-templates', () => ({
  getEmailTemplateById: (...a: unknown[]) => getEmailTemplateByIdMock(...a),
  getDefaultEmailTemplate: (...a: unknown[]) => getDefaultEmailTemplateMock(...a),
}))
vi.mock('@/lib/mailbox/sender', () => ({ sendViaMailbox: (...a: unknown[]) => sendViaMailboxMock(...a) }))
vi.mock('@/lib/llm/client', () => ({
  generateJson: (...a: unknown[]) => generateJsonMock(...a),
  EMAIL_WRITER_MODEL_ID: 'gemini-3.7-flash',
}))
vi.mock('@/lib/qstash/client', () => ({ publishJsonWithDelay: (...a: unknown[]) => publishDelayMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a), logEventSafe: (...a: unknown[]) => logEventMock(...a) }))
vi.mock('@/lib/crm/sync', () => ({ enqueueCrmSync: (...a: unknown[]) => enqueueCrmSyncMock(...a) }))

import { runWriteForCase, buildPrompt, buildSystemPrompt, resolveEmailTemplate } from './write'
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
  signatureName: null, signatureTitle: null, signaturePhone: null, signatureAddress: null,
  campaignEmailTemplateId: null,
}

beforeEach(() => {
  for (const m of [listKnowledgeMock, listActiveLeadsMock, isSuppressedMock, claimOutboundEmailMock,
    markEmailSentMock, markEmailFailedMock, createSequenceMock, advanceSequenceMock, sendViaMailboxMock,
    generateJsonMock, updateCaseStatusMock, publishDelayMock, logEventMock, enqueueCrmSyncMock,
    getClientByIdMock, getEmailTemplateByIdMock, getDefaultEmailTemplateMock]) m.mockReset()
  listKnowledgeMock.mockResolvedValue([{ kind: 'company', content: 'builds widgets' }])
  isSuppressedMock.mockResolvedValue(false)
  generateJsonMock.mockResolvedValue({ subject: 'Quick idea for Acme', body: 'Hi Jane...' })
  // scheduleFirstFollowup's DEFAULT_FOLLOWUP_DELAYS_DAYS fallback covers a
  // null client lookup, so this default keeps every existing test's timing
  // assertions (3-day first follow-up) unchanged.
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null, company_info: null, email_template_id: null })
  getDefaultEmailTemplateMock.mockResolvedValue({ id: 'default-template', name: 'Concise (default)', template_text: 'Default voice text.', is_default: true })
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
      expect.objectContaining({ thinkingLevel: 'medium', maxOutputTokens: 2_600 }),
    )
  })

  it('should generate first-touch emails with the gemini-3.7-flash override', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    await runWriteForCase({} as never, input)
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ modelId: 'gemini-3.7-flash' }),
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

  it("should override the client's phone with the campaign's own phone override", async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: 'acme.com',
      phone: '+1 555 000 0000', address: null, signature_name: null, signature_title: null,
    })

    await runWriteForCase({} as never, { ...input, signaturePhone: '+1 555 999 9999' })

    const expectedBody = 'Hi Jane...\n\nBest regards,\n\nAcme\n\n+1 555 999 9999\nacme.com'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it('should use the campaign phone override even when the client has none on file', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase(
      {} as never,
      { ...input, signatureName: 'John Smith', signaturePhone: '+1 555 999 9999', signatureAddress: '2 Campaign Ave' },
    )

    const expectedBody = 'Hi Jane...\n\nBest regards,\n\nJohn Smith\nAcme\n\n+1 555 999 9999\n2 Campaign Ave'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it("should look up the client's configured template and use its text when email_template_id is set", async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Uniforms Fashion', domain: null, phone: null,
      address: null, signature_name: 'Cihat Bozkurt', signature_title: null, email_template_id: 'formal-template',
    })
    getEmailTemplateByIdMock.mockResolvedValue({ id: 'formal-template', name: 'Formal introduction', template_text: 'Five paragraphs, formal.', is_default: false })

    await runWriteForCase({} as never, input)

    expect(getEmailTemplateByIdMock).toHaveBeenCalledWith(expect.anything(), 'formal-template')
    expect(getDefaultEmailTemplateMock).not.toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Five paragraphs, formal.') }),
    )
  })

  it("should prefer the campaign's own template over the client's when campaignEmailTemplateId is set", async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Uniforms Fashion', domain: null, phone: null,
      address: null, signature_name: 'Cihat Bozkurt', signature_title: null, email_template_id: 'client-template',
    })
    getEmailTemplateByIdMock.mockImplementation((_supabase: unknown, id: string) =>
      Promise.resolve(
        id === 'campaign-template'
          ? { id: 'campaign-template', name: 'Hospitality & Travel', template_text: 'Dear [Name], we design...', is_default: false }
          : { id: 'client-template', name: 'Formal introduction', template_text: 'Five paragraphs, formal.', is_default: false },
      ),
    )

    await runWriteForCase({} as never, { ...input, campaignEmailTemplateId: 'campaign-template' })

    expect(getEmailTemplateByIdMock).toHaveBeenCalledWith(expect.anything(), 'campaign-template')
    expect(getEmailTemplateByIdMock).not.toHaveBeenCalledWith(expect.anything(), 'client-template')
    expect(getDefaultEmailTemplateMock).not.toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Dear [Name], we design...') }),
    )
  })

  it('should fall back to the default template when the client has no email_template_id', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(getEmailTemplateByIdMock).not.toHaveBeenCalled()
    expect(getDefaultEmailTemplateMock).toHaveBeenCalled()
    expect(generateJsonMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ instructions: buildSystemPrompt('Default voice text.') }),
    )
  })

  it('should fall back to the default template when the client has no row at all', async () => {
    getClientByIdMock.mockResolvedValue(null)
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(getDefaultEmailTemplateMock).toHaveBeenCalled()
  })

  it('should only include a lead_id-tagged knowledge row in the prompt for the lead it belongs to', async () => {
    const leadA = { ...lead, id: 'lead-a', full_name: 'Jane Doe', email: 'jane@acme.com' }
    const leadB = { ...lead, id: 'lead-b', full_name: 'Sam Lee', email: 'sam@acme.com' }
    listActiveLeadsMock.mockResolvedValue([leadA, leadB])
    listKnowledgeMock.mockResolvedValue([
      { kind: 'company', content: 'Acme builds workflow automation.', lead_id: null },
      { kind: 'news', content: "Jane's LinkedIn post about hiring", lead_id: 'lead-a' },
      { kind: 'news', content: "Sam's LinkedIn post about a new role", lead_id: 'lead-b' },
    ])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(generateJsonMock).toHaveBeenCalledTimes(2)
    // Non-null: toHaveBeenCalledTimes(2) above guarantees both indices exist.
    const [janeCall, samCall] = generateJsonMock.mock.calls as [unknown, { prompt: string }][]
    expect(janeCall![1].prompt).toContain("Jane's LinkedIn post about hiring")
    expect(janeCall![1].prompt).not.toContain("Sam's LinkedIn post about a new role")
    expect(janeCall![1].prompt).toContain('Acme builds workflow automation.')
    expect(samCall![1].prompt).toContain("Sam's LinkedIn post about a new role")
    expect(samCall![1].prompt).not.toContain("Jane's LinkedIn post about hiring")
    expect(samCall![1].prompt).toContain('Acme builds workflow automation.')
  })
})

describe('resolveEmailTemplate', () => {
  beforeEach(() => {
    getEmailTemplateByIdMock.mockReset()
    getDefaultEmailTemplateMock.mockReset()
  })

  it("should prefer the campaign's template over the client's when both are set", async () => {
    getEmailTemplateByIdMock.mockResolvedValue({ id: 'campaign-template', name: 'X', template_text: 'x', is_default: false })
    const client = { id: 'c1', email_template_id: 'client-template' } as never
    const result = await resolveEmailTemplate({} as never, 'campaign-template', client)
    expect(getEmailTemplateByIdMock).toHaveBeenCalledWith(expect.anything(), 'campaign-template')
    expect(result.id).toBe('campaign-template')
  })

  it("should fall back to the client's template when no campaign template id is given", async () => {
    getEmailTemplateByIdMock.mockResolvedValue({ id: 'client-template', name: 'X', template_text: 'x', is_default: false })
    const client = { id: 'c1', email_template_id: 'client-template' } as never
    const result = await resolveEmailTemplate({} as never, null, client)
    expect(getEmailTemplateByIdMock).toHaveBeenCalledWith(expect.anything(), 'client-template')
    expect(result.id).toBe('client-template')
  })

  it('should fall back to the default template when neither campaign nor client has one set', async () => {
    getDefaultEmailTemplateMock.mockResolvedValue({ id: 'default', name: 'X', template_text: 'x', is_default: true })
    const client = { id: 'c1', email_template_id: null } as never
    const result = await resolveEmailTemplate({} as never, null, client)
    expect(getEmailTemplateByIdMock).not.toHaveBeenCalled()
    expect(result.id).toBe('default')
  })

  it('should fall back to the default template when the campaign template id no longer resolves to a row', async () => {
    getEmailTemplateByIdMock.mockResolvedValue(null)
    getDefaultEmailTemplateMock.mockResolvedValue({ id: 'default', name: 'X', template_text: 'x', is_default: true })
    const result = await resolveEmailTemplate({} as never, 'deleted-template', null)
    expect(result.id).toBe('default')
  })
})

describe('buildSystemPrompt', () => {
  it('should include every fixed guardrail plus the given template text', () => {
    const result = buildSystemPrompt('Write like a friendly consultant.')
    expect(result).toContain('Always write in English')
    expect(result).toContain('No bulk markers, no unsubscribe footer, no tracking language.')
    expect(result).toContain('Use only facts present in the provided dossier')
    expect(result).toContain('Subject line: 2-5 words')
    expect(result).toContain('Write like a friendly consultant.')
  })

  it('should place the template text after the fixed guardrails', () => {
    const result = buildSystemPrompt('UNIQUE_TEMPLATE_MARKER')
    const guardrailIndex = result.indexOf('Always write in English')
    const templateIndex = result.indexOf('UNIQUE_TEMPLATE_MARKER')
    expect(guardrailIndex).toBeGreaterThanOrEqual(0)
    expect(templateIndex).toBeGreaterThan(guardrailIndex)
  })

  it('should instruct the model to personalize, not copy, and to resolve bracketed placeholders', () => {
    const result = buildSystemPrompt('Dear [Name], ...')
    expect(result).toContain('Never copy it verbatim')
    expect(result).toContain('never leave a')
    expect(result).toContain('[Name]')
  })
})

function knowledgeRow(kind: KnowledgeRow['kind'], content: string): KnowledgeRow {
  return {
    id: `k-${kind}`, client_id: 'c1', case_id: 'case1', kind, content,
    source_url: null, citation: null, created_by: 'agent', created_at: '2026-01-01T00:00:00Z',
    lead_id: null, event_date: null,
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
