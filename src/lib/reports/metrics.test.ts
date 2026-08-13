import { describe, it, expect, vi, beforeEach } from 'vitest'

const getOverviewMetricsMock = vi.fn()
const getDailyMetricsMock = vi.fn()
const listWeeklyReportsInRangeMock = vi.fn()
const getClientByIdMock = vi.fn()
const listMailreachConnectedMailboxesMock = vi.fn()

vi.mock('@/lib/db/analytics', () => ({
  getOverviewMetrics: (...a: unknown[]) => getOverviewMetricsMock(...a),
  getDailyMetrics: (...a: unknown[]) => getDailyMetricsMock(...a),
}))
vi.mock('@/lib/db/reports', () => ({
  listWeeklyReportsInRange: (...a: unknown[]) => listWeeklyReportsInRangeMock(...a),
}))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
}))
vi.mock('@/lib/db/mailboxes', () => ({
  listMailreachConnectedMailboxes: (...a: unknown[]) => listMailreachConnectedMailboxesMock(...a),
}))

import { buildReportMetrics } from './metrics'

const overview = { leadsDiscovered: 5 } as never
const daily = [{ day: '2026-08-04', leadsDiscovered: 1, emailsSent: 2, repliesReceived: 0 }]
const now = new Date('2026-08-11T00:00:00.000Z')

// Full 13-field overview, required because buildReportMetrics's monthly
// branch validates each weekly report's stored metrics against
// reportMetricsSnapshotSchema before copying its overview into
// weeklyBreakdown — a partial object like `{ leadsDiscovered: 3 }` would
// fail that validation.
const fullWeeklyOverview = {
  leadsDiscovered: 3,
  leadsVerified: 3,
  casesCreated: 1,
  emailsSent: 6,
  firstTouchSent: 4,
  followupsSent: 2,
  emailsBounced: 0,
  emailsFailed: 0,
  repliesReceived: 1,
  leadsContacted: 6,
  leadsReplied: 1,
  suppressionsAdded: 0,
  activeSequences: 2,
}

beforeEach(() => {
  getOverviewMetricsMock.mockReset().mockResolvedValue(overview)
  getDailyMetricsMock.mockReset().mockResolvedValue(daily)
  listWeeklyReportsInRangeMock.mockReset().mockResolvedValue([])
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'c1', mailreach_enabled: true })
  listMailreachConnectedMailboxesMock.mockReset().mockResolvedValue([])
})

describe('buildReportMetrics', () => {
  it('should build a weekly snapshot with no weeklyBreakdown', async () => {
    const result = await buildReportMetrics({} as never, { clientId: 'c1', type: 'weekly', periodStart: 'a', periodEnd: 'b', now })
    expect(result).toEqual({ overview, daily })
    expect(listWeeklyReportsInRangeMock).not.toHaveBeenCalled()
  })

  it('should call the analytics RPCs with the client scoped and no campaign filter', async () => {
    await buildReportMetrics({} as never, { clientId: 'c1', type: 'weekly', periodStart: 'a', periodEnd: 'b', now })
    expect(getOverviewMetricsMock).toHaveBeenCalledWith({}, { from: 'a', to: 'b', campaignId: null, clientId: 'c1' })
    expect(getDailyMetricsMock).toHaveBeenCalledWith({}, { from: 'a', to: 'b', campaignId: null, clientId: 'c1' })
  })

  it('should include a warmup snapshot when the client has an enrolled, connected mailbox', async () => {
    listMailreachConnectedMailboxesMock.mockResolvedValue([
      {
        id: 'm1',
        email_address: 'sales@acme.com',
        mailreach_enabled: true,
        mailreach_started_at: '2026-08-04T00:00:00.000Z',
        mailreach_status: 'connected',
        mailreach_reputation_score: 70,
        mailreach_total_messages_sent: 10,
        mailreach_total_messages_received: 8,
        mailreach_total_spam: 0,
        mailreach_current_conversations: 2,
      },
    ])
    const result = await buildReportMetrics({} as never, { clientId: 'c1', type: 'weekly', periodStart: 'a', periodEnd: 'b', now })
    expect(result.warmup).toHaveLength(1)
    expect(result.warmup?.[0]).toMatchObject({ mailboxId: 'm1', isGated: true, elapsedDays: 7 })
  })

  it('should build a monthly snapshot with weeklyBreakdown from prior weekly reports', async () => {
    listWeeklyReportsInRangeMock.mockResolvedValue([
      {
        id: 'w1',
        period_start: '2026-07-07T00:00:00.000Z',
        period_end: '2026-07-14T00:00:00.000Z',
        metrics: { overview: fullWeeklyOverview, daily: [] },
      },
    ])
    const result = await buildReportMetrics({} as never, { clientId: 'c1', type: 'monthly', periodStart: 'a', periodEnd: 'b', now })
    expect(result.weeklyBreakdown).toEqual([
      { reportId: 'w1', periodStart: '2026-07-07T00:00:00.000Z', periodEnd: '2026-07-14T00:00:00.000Z', overview: fullWeeklyOverview },
    ])
  })
})
