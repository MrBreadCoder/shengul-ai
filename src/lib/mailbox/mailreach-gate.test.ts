import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  MAILREACH_CAMPAIGN_GATE_DAYS,
  mailreachElapsedDays,
  isEligibleForCampaignSend,
  summarizeMailboxWarmup,
  closestToReady,
  totalMessagesExchanged,
  type MailboxWarmupSource,
  type MailboxWarmupInfo,
} from './mailreach-gate'

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

function mailboxRow(overrides: Partial<MailboxWarmupSource> = {}): MailboxWarmupSource {
  return {
    id: 'm1',
    email_address: 'sales@acme.com',
    mailreach_enabled: true,
    mailreach_started_at: '2026-07-15T00:00:00Z',
    mailreach_status: 'connected',
    mailreach_reputation_score: 82,
    mailreach_total_messages_sent: 120,
    mailreach_total_messages_received: 95,
    mailreach_total_spam: 2,
    mailreach_current_conversations: 8,
    ...overrides,
  }
}

describe('summarizeMailboxWarmup', () => {
  const now = new Date('2026-07-29T00:00:00Z')

  it('should return an empty array for no mailboxes', () => {
    expect(summarizeMailboxWarmup([], true, now)).toEqual([])
  })

  it('should exclude a mailbox with mailreach_enabled false', () => {
    expect(summarizeMailboxWarmup([mailboxRow({ mailreach_enabled: false })], true, now)).toEqual([])
  })

  it('should exclude every mailbox when the client switch is off', () => {
    expect(summarizeMailboxWarmup([mailboxRow()], false, now)).toEqual([])
  })

  it('should exclude a mailbox that is not currently connected', () => {
    expect(summarizeMailboxWarmup([mailboxRow({ mailreach_status: 'error' })], true, now)).toEqual([])
  })

  it('should exclude a mailbox with no mailreach_started_at even if enabled and connected', () => {
    expect(summarizeMailboxWarmup([mailboxRow({ mailreach_started_at: null })], true, now)).toEqual([])
  })

  it('should mark a mailbox gated before day 14', () => {
    const [result] = summarizeMailboxWarmup([mailboxRow({ mailreach_started_at: '2026-07-20T00:00:00Z' })], true, now)
    expect(result).toMatchObject({ elapsedDays: 9, gateDays: 14, isGated: true })
  })

  it('should mark a mailbox warm at exactly day 14', () => {
    const [result] = summarizeMailboxWarmup([mailboxRow({ mailreach_started_at: '2026-07-15T00:00:00Z' })], true, now)
    expect(result).toMatchObject({ elapsedDays: 14, isGated: false })
  })

  it('should pass reputation and message-volume fields through unchanged, including null', () => {
    const [result] = summarizeMailboxWarmup(
      [mailboxRow({ mailreach_reputation_score: null, mailreach_total_messages_sent: null })],
      true,
      now,
    )
    expect(result).toMatchObject({
      mailboxId: 'm1',
      emailAddress: 'sales@acme.com',
      reputationScore: null,
      totalMessagesSent: null,
      totalMessagesReceived: 95,
      totalSpam: 2,
      currentConversations: 8,
    })
  })
})

describe('closestToReady', () => {
  it('should return null for an empty array', () => {
    expect(closestToReady([])).toBeNull()
  })

  it('should return the mailbox with the most elapsed days', () => {
    const a = { mailboxId: 'a', elapsedDays: 3 } as MailboxWarmupInfo
    const b = { mailboxId: 'b', elapsedDays: 9 } as MailboxWarmupInfo
    const c = { mailboxId: 'c', elapsedDays: 1 } as MailboxWarmupInfo
    expect(closestToReady([a, b, c])).toBe(b)
  })
})

describe('totalMessagesExchanged', () => {
  it('should return 0 for an empty array', () => {
    expect(totalMessagesExchanged([])).toBe(0)
  })

  it('should sum sent and received across mailboxes, treating null as 0', () => {
    const mailboxes = [
      { totalMessagesSent: 10, totalMessagesReceived: 5 } as MailboxWarmupInfo,
      { totalMessagesSent: null, totalMessagesReceived: 3 } as MailboxWarmupInfo,
    ]
    expect(totalMessagesExchanged(mailboxes)).toBe(18)
  })
})
