import { describe, it, expect, vi, beforeEach } from 'vitest'

const getWeeklyPeriodMock = vi.fn()
const getMonthlyPeriodMock = vi.fn()
const buildReportMetricsMock = vi.fn()
const generateReportCommentaryMock = vi.fn()
const buildFallbackCommentaryMock = vi.fn()
const pickTemplateMock = vi.fn()
const renderTemplateMock = vi.fn()
const buildWarmupTemplateContextMock = vi.fn()
const sendReportEmailMock = vi.fn()
const upsertReportMock = vi.fn()
const getPreviousReportMock = vi.fn()
const countPriorReportsForClientMock = vi.fn()
const insertReportDeliveryMock = vi.fn()
const listClientRoleAppUsersForClientMock = vi.fn()
const getClientByIdMock = vi.fn()
const getAuthUserEmailsMock = vi.fn()
const logEventSafeMock = vi.fn()
const logErrorMock = vi.fn()

vi.mock('./period', () => ({
  getWeeklyPeriod: (...a: unknown[]) => getWeeklyPeriodMock(...a),
  getMonthlyPeriod: (...a: unknown[]) => getMonthlyPeriodMock(...a),
}))
vi.mock('./metrics', () => ({ buildReportMetrics: (...a: unknown[]) => buildReportMetricsMock(...a) }))
vi.mock('./commentary', () => ({
  generateReportCommentary: (...a: unknown[]) => generateReportCommentaryMock(...a),
  buildFallbackCommentary: (...a: unknown[]) => buildFallbackCommentaryMock(...a),
}))
vi.mock('./email-templates', () => ({
  pickTemplate: (...a: unknown[]) => pickTemplateMock(...a),
  renderTemplate: (...a: unknown[]) => renderTemplateMock(...a),
  buildWarmupTemplateContext: (...a: unknown[]) => buildWarmupTemplateContextMock(...a),
}))
vi.mock('./mailer', () => ({ sendReportEmail: (...a: unknown[]) => sendReportEmailMock(...a) }))
vi.mock('@/lib/db/reports', () => ({
  upsertReport: (...a: unknown[]) => upsertReportMock(...a),
  getPreviousReport: (...a: unknown[]) => getPreviousReportMock(...a),
  countPriorReportsForClient: (...a: unknown[]) => countPriorReportsForClientMock(...a),
  insertReportDelivery: (...a: unknown[]) => insertReportDeliveryMock(...a),
}))
vi.mock('@/lib/db/clients', () => ({
  listClientRoleAppUsersForClient: (...a: unknown[]) => listClientRoleAppUsersForClientMock(...a),
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
}))
vi.mock('@/lib/supabase/auth-admin', () => ({ getAuthUserEmails: (...a: unknown[]) => getAuthUserEmailsMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
}))
vi.mock('@/lib/env', () => ({ env: { APP_URL: 'https://app.example.com' } }))

import { generateReport } from './generate'

const period = { periodStart: '2026-08-04T00:00:00.000Z', periodEnd: '2026-08-11T00:00:00.000Z', periodLabel: 'this week' as const }
// Full 13-field overview: generate.ts validates the metrics snapshot via the
// real (unmocked) reportMetricsSnapshotSchema before persisting it, so a
// partial object here would fail that parse and break every happy-path test.
const overview = {
  leadsDiscovered: 5,
  leadsVerified: 5,
  casesCreated: 1,
  emailsSent: 10,
  firstTouchSent: 6,
  followupsSent: 4,
  emailsBounced: 0,
  emailsFailed: 0,
  repliesReceived: 1,
  leadsContacted: 10,
  leadsReplied: 1,
  suppressionsAdded: 0,
  activeSequences: 2,
}
const snapshot = { overview, daily: [] }
const commentary = { headline: 'H', summary: 'S', highlights: ['a', 'b'] }
const rendered = { subject: 'Subj', text: 'Text', html: '<p>Text</p>' }

function reportRow(status: string) {
  return { id: 'r1', client_id: 'c1', type: 'weekly', status }
}

beforeEach(() => {
  getWeeklyPeriodMock.mockReset().mockReturnValue(period)
  getMonthlyPeriodMock.mockReset()
  buildReportMetricsMock.mockReset().mockResolvedValue(snapshot)
  generateReportCommentaryMock.mockReset().mockResolvedValue(commentary)
  buildFallbackCommentaryMock.mockReset().mockReturnValue(commentary)
  pickTemplateMock.mockReset().mockReturnValue('template')
  renderTemplateMock.mockReset().mockReturnValue(rendered)
  buildWarmupTemplateContextMock.mockReset().mockReturnValue(null)
  sendReportEmailMock.mockReset().mockResolvedValue(undefined)
  upsertReportMock.mockReset().mockResolvedValue(reportRow('generating'))
  getPreviousReportMock.mockReset().mockResolvedValue(null)
  countPriorReportsForClientMock.mockReset().mockResolvedValue(0)
  insertReportDeliveryMock.mockReset().mockResolvedValue(undefined)
  listClientRoleAppUsersForClientMock.mockReset().mockResolvedValue([{ id: 'u1' }])
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1', name: 'Acme' })
  getAuthUserEmailsMock.mockReset().mockResolvedValue([{ userId: 'u1', email: 'a@acme.com' }])
  logEventSafeMock.mockReset().mockResolvedValue(undefined)
  logErrorMock.mockReset().mockResolvedValue(undefined)
})

describe('generateReport', () => {
  it('should send to every recipient and mark the report sent on the happy path', async () => {
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    const result = await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(sendReportEmailMock).toHaveBeenCalledWith({ to: 'a@acme.com', subject: 'Subj', text: 'Text', html: '<p>Text</p>' })
    expect(insertReportDeliveryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'sent', email: 'a@acme.com' }))
    expect(result.status).toBe('sent')
  })

  it('should skip sending and keep status ready when there are no recipients', async () => {
    listClientRoleAppUsersForClientMock.mockResolvedValue([])
    getAuthUserEmailsMock.mockResolvedValue([])
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready'))
    const result = await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(sendReportEmailMock).not.toHaveBeenCalled()
    expect(result.status).toBe('ready')
    expect(logEventSafeMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'reports.no_recipients' }))
  })

  it('should mark send_failed when every recipient send fails', async () => {
    sendReportEmailMock.mockRejectedValue(new Error('smtp down'))
    upsertReportMock
      .mockResolvedValueOnce(reportRow('generating'))
      .mockResolvedValueOnce(reportRow('ready'))
      .mockResolvedValueOnce(reportRow('send_failed'))
    const result = await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(insertReportDeliveryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ status: 'failed' }))
    expect(result.status).toBe('send_failed')
  })

  it('should mark sent when one of two recipients succeeds', async () => {
    listClientRoleAppUsersForClientMock.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }])
    getAuthUserEmailsMock.mockResolvedValue([{ userId: 'u1', email: 'a@acme.com' }, { userId: 'u2', email: 'b@acme.com' }])
    sendReportEmailMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('bounced'))
    upsertReportMock
      .mockResolvedValueOnce(reportRow('generating'))
      .mockResolvedValueOnce(reportRow('ready'))
      .mockResolvedValueOnce(reportRow('sent'))
    const result = await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(insertReportDeliveryMock).toHaveBeenCalledTimes(2)
    expect(result.status).toBe('sent')
  })

  it('should fall back to the deterministic commentary when the AI call fails', async () => {
    generateReportCommentaryMock.mockRejectedValue(new Error('rate limited'))
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(logErrorMock).toHaveBeenCalledWith(expect.objectContaining({ type: 'reports.commentary_failed' }))
    expect(buildFallbackCommentaryMock).toHaveBeenCalled()
  })

  it('should throw NOT_FOUND when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    await expect(generateReport({} as never, { clientId: 'missing', type: 'weekly', now: new Date() })).rejects.toMatchObject({
      code: 'NOT_FOUND',
    })
  })

  it('should use getMonthlyPeriod for a monthly report', async () => {
    getMonthlyPeriodMock.mockReturnValue({ ...period, periodLabel: 'this month' })
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'monthly', now: new Date() })
    expect(getMonthlyPeriodMock).toHaveBeenCalled()
    expect(getWeeklyPeriodMock).not.toHaveBeenCalled()
  })

  it('should pass an empty warmup array to the commentary call when no mailboxes are enrolled', async () => {
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(generateReportCommentaryMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ warmup: [] }))
  })

  it('should use the warmup template when there were zero sends and a mailbox is still gated', async () => {
    const gatedMailbox = {
      mailboxId: '11111111-1111-4111-8111-111111111111',
      emailAddress: 'sales@acme.com',
      elapsedDays: 6,
      gateDays: 14,
      isGated: true,
      reputationScore: 70,
      totalMessagesSent: 10,
      totalMessagesReceived: 8,
      totalSpam: 0,
      currentConversations: 2,
    }
    buildReportMetricsMock.mockResolvedValue({ overview: { ...overview, emailsSent: 0 }, daily: [], warmup: [gatedMailbox] })
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(pickTemplateMock).toHaveBeenCalledWith(0, true)
  })

  it('should use the normal rotating template when sends happened even with a mailbox still gated', async () => {
    const gatedMailbox = {
      mailboxId: '11111111-1111-4111-8111-111111111111',
      emailAddress: 'sales@acme.com',
      elapsedDays: 6,
      gateDays: 14,
      isGated: true,
      reputationScore: 70,
      totalMessagesSent: 10,
      totalMessagesReceived: 8,
      totalSpam: 0,
      currentConversations: 2,
    }
    buildReportMetricsMock.mockResolvedValue({ overview, daily: [], warmup: [gatedMailbox] })
    upsertReportMock.mockResolvedValueOnce(reportRow('generating')).mockResolvedValueOnce(reportRow('ready')).mockResolvedValueOnce(reportRow('sent'))
    await generateReport({} as never, { clientId: 'c1', type: 'weekly', now: new Date() })
    expect(pickTemplateMock).toHaveBeenCalledWith(0, false)
  })
})
