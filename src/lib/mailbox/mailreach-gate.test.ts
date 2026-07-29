import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { MAILREACH_CAMPAIGN_GATE_DAYS, mailreachElapsedDays, isEligibleForCampaignSend } from './mailreach-gate'

const DAY_MS = 86_400_000

describe('mailreachElapsedDays', () => {
  it('should return 0 when startedAt is now', () => {
    const now = new Date('2026-07-29T00:00:00Z')
    expect(mailreachElapsedDays(now.toISOString(), now)).toBe(0)
  })

  it('should return the number of whole days elapsed', () => {
    const startedAt = new Date('2026-07-01T00:00:00Z').toISOString()
    const now = new Date('2026-07-15T12:00:00Z')
    expect(mailreachElapsedDays(startedAt, now)).toBe(14)
  })

  it('should clamp to 0 when startedAt is in the future', () => {
    const now = new Date('2026-07-01T00:00:00Z')
    const startedAt = new Date('2026-07-05T00:00:00Z').toISOString()
    expect(mailreachElapsedDays(startedAt, now)).toBe(0)
  })

  it('should throw AppError when startedAt is not a valid timestamp', () => {
    expect(() => mailreachElapsedDays('not-a-date', new Date())).toThrow(AppError)
  })
})

describe('isEligibleForCampaignSend', () => {
  const now = new Date('2026-07-29T00:00:00Z')

  it('should be eligible when mailreach is not enabled', () => {
    expect(
      isEligibleForCampaignSend({ mailreachEnabled: false, clientMailreachEnabled: true, mailreachStartedAt: null, now }),
    ).toBe(true)
  })

  it('should be eligible when enabled but never started', () => {
    expect(
      isEligibleForCampaignSend({ mailreachEnabled: true, clientMailreachEnabled: true, mailreachStartedAt: null, now }),
    ).toBe(true)
  })

  it('should be ineligible before day 14', () => {
    const startedAt = new Date(now.getTime() - 13 * DAY_MS).toISOString()
    expect(
      isEligibleForCampaignSend({ mailreachEnabled: true, clientMailreachEnabled: true, mailreachStartedAt: startedAt, now }),
    ).toBe(false)
  })

  it('should be eligible exactly at day 14', () => {
    const startedAt = new Date(now.getTime() - MAILREACH_CAMPAIGN_GATE_DAYS * DAY_MS).toISOString()
    expect(
      isEligibleForCampaignSend({ mailreachEnabled: true, clientMailreachEnabled: true, mailreachStartedAt: startedAt, now }),
    ).toBe(true)
  })

  it('should stay eligible well past day 14', () => {
    const startedAt = new Date(now.getTime() - 90 * DAY_MS).toISOString()
    expect(
      isEligibleForCampaignSend({ mailreachEnabled: true, clientMailreachEnabled: true, mailreachStartedAt: startedAt, now }),
    ).toBe(true)
  })

  it('should be eligible regardless of enrollment timing when the client has disabled mailreach', () => {
    const startedAt = new Date(now.getTime() - 3 * DAY_MS).toISOString()
    expect(
      isEligibleForCampaignSend({ mailreachEnabled: true, clientMailreachEnabled: false, mailreachStartedAt: startedAt, now }),
    ).toBe(true)
  })
})
