import { describe, it, expect, vi, beforeEach } from 'vitest'

const generateJsonMock = vi.fn()
vi.mock('@/lib/llm/client', () => ({ generateJson: (...a: unknown[]) => generateJsonMock(...a) }))

import { generateReportCommentary, buildFallbackCommentary } from './commentary'

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

beforeEach(() => {
  generateJsonMock.mockReset().mockResolvedValue({ headline: 'x', summary: 'y', highlights: ['a', 'b'] })
})

describe('generateReportCommentary', () => {
  it('should include both periods in the prompt when a previous period is given', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: overview },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).toContain('Current period')
    expect(call.prompt).toContain('Previous period')
  })

  it('should omit the previous-period comparison when none exists', async () => {
    await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null },
    )
    const call = generateJsonMock.mock.calls[0]![1] as { prompt: string }
    expect(call.prompt).not.toContain('Previous period')
    expect(call.prompt).toContain('first report')
  })

  it('should return the model output unchanged', async () => {
    const result = await generateReportCommentary(
      { clientId: 'c1', actor: 'test' },
      { clientName: 'Acme', type: 'weekly', periodLabel: 'this week', current: overview, previous: null },
    )
    expect(result).toEqual({ headline: 'x', summary: 'y', highlights: ['a', 'b'] })
  })
})

describe('buildFallbackCommentary', () => {
  it('should build a deterministic summary from the raw numbers with 2+ highlights', () => {
    const result = buildFallbackCommentary('this week', overview)
    expect(result.summary).toContain('12')
    expect(result.summary).toContain('40')
    expect(result.summary).toContain('3')
    expect(result.highlights.length).toBeGreaterThanOrEqual(2)
    expect(result.highlights.length).toBeLessThanOrEqual(4)
  })
})
