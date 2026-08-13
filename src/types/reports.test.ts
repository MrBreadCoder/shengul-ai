import { describe, it, expect } from 'vitest'
import { reportMetricsSnapshotSchema } from './reports'

const validOverview = {
  leadsDiscovered: 10,
  leadsVerified: 9,
  casesCreated: 3,
  emailsSent: 20,
  firstTouchSent: 12,
  followupsSent: 8,
  emailsBounced: 1,
  emailsFailed: 0,
  repliesReceived: 4,
  leadsContacted: 20,
  leadsReplied: 4,
  suppressionsAdded: 1,
  activeSequences: 5,
}

describe('reportMetricsSnapshotSchema', () => {
  it('should accept a weekly snapshot with no weeklyBreakdown', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [{ day: '2026-08-04', leadsDiscovered: 2, emailsSent: 5, repliesReceived: 1 }],
    })
    expect(result.success).toBe(true)
  })

  it('should accept a monthly snapshot with a weeklyBreakdown', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [],
      weeklyBreakdown: [
        { reportId: '11111111-1111-4111-8111-111111111111', periodStart: '2026-08-04T00:00:00.000Z', periodEnd: '2026-08-11T00:00:00.000Z', overview: validOverview },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('should reject a snapshot missing a required overview field', () => {
    const { leadsDiscovered: _drop, ...incomplete } = validOverview
    const result = reportMetricsSnapshotSchema.safeParse({ overview: incomplete, daily: [] })
    expect(result.success).toBe(false)
  })

  it('should reject a daily entry with a non-numeric field', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [{ day: '2026-08-04', leadsDiscovered: 'two', emailsSent: 5, repliesReceived: 1 }],
    })
    expect(result.success).toBe(false)
  })

  it('should accept a snapshot with a warmup array', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [],
      warmup: [
        {
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
        },
      ],
    })
    expect(result.success).toBe(true)
  })

  it('should accept a snapshot with no warmup key at all', () => {
    const result = reportMetricsSnapshotSchema.safeParse({ overview: validOverview, daily: [] })
    expect(result.success).toBe(true)
  })

  it('should reject a warmup entry missing a required field', () => {
    const result = reportMetricsSnapshotSchema.safeParse({
      overview: validOverview,
      daily: [],
      warmup: [{ mailboxId: '11111111-1111-4111-8111-111111111111', emailAddress: 'sales@acme.com' }],
    })
    expect(result.success).toBe(false)
  })
})
