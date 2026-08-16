import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateJsonMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))

import { generateReportCommentary, buildFallbackCommentary } from './commentary'
import type { MailboxWarmupInfo } from '@/lib/mailbox/mailreach-gate'

const overview = {
  leadsDiscovered: 12,
  leadsVerified: 11,
  casesCreated: 4,
  emailsSent: 40,
  firstTouchSent: 25,
  followupsSent: 15,
  emailsBounced: 1,
  emailsFailed: 0,
  repliesReceived: 3,
  leadsContacted: 40,
  leadsReplied: 3,
  suppressionsAdded: 0,
  activeSequences: 6,
}

const gatedMailbox: MailboxWarmupInfo = {
  mailboxId: 'm1',
  emailAddress: 'sales@acme.com',
  elapsedDays: 6,
  dayNumber: 7,
  gateDays: 14,
  isGated: true,
  reputationScore: 70,
  totalMessagesSent: 10,
  totalMessagesReceived: 8,
  totalSpam: 0,
  currentConversations: 2,
}

beforeEach(() => {
  generateJsonMock.mockReset().mockResolvedValue({ headline: 'x', summary: 'y', highlights: ['a', 'b'] })
})

describe('generateReportCommentary', () => {
  it('should include both periods in the prompt when a previous period is given', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: overview, warmup: [] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).toContain('Current period')
    expect(call.prompt).toContain('Previous period')
  })

  it('should omit the previous-period comparison when none exists', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).not.toContain('Previous period')
    expect(call.prompt).toContain('first report')
  })

  it('should omit the warmup block from the prompt when warmup is empty', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).not.toContain('Mailbox warmup in progress')
  })

  it('should include the warmup block in the prompt when a mailbox is gated', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [gatedMailbox] },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).toContain('Mailbox warmup in progress')
    expect(call.prompt).toContain('Day 7 of 14')
    expect(call.prompt).toContain('Reputation scores so far: 70')
  })

  it('should return the model output unchanged', async () => {
    const result = await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null, warmup: [] },
    )
    expect(result).toEqual({ headline: 'x', summary: 'y', highlights: ['a', 'b'] })
  })
})

describe('buildFallbackCommentary', () => {
  it('should build a deterministic summary from the raw numbers with 2+ highlights when no mailbox is gated', () => {
    const result = buildFallbackCommentary('this week', overview, [])
    expect(result.summary).toContain('12')
    expect(result.summary).toContain('40')
    expect(result.summary).toContain('3')
    expect(result.highlights.length).toBeGreaterThanOrEqual(2)
    expect(result.highlights.length).toBeLessThanOrEqual(4)
  })

  it('should lead with warmup progress when there were zero sends and a mailbox is gated', () => {
    const result = buildFallbackCommentary('this week', { ...overview, emailsSent: 0 }, [gatedMailbox])
    expect(result.headline).toBe('Building your sending reputation')
    expect(result.summary).toContain('day 7 of 14')
    expect(result.summary).not.toContain('0 leads')
  })

  it('should use the normal fallback when sends happened even with a mailbox gated', () => {
    const result = buildFallbackCommentary('this week', overview, [gatedMailbox])
    expect(result.headline).not.toBe('Building your sending reputation')
    expect(result.summary).toContain('12')
  })
})
