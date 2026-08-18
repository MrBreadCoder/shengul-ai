import { describe, it, expect } from 'vitest'
import { getOutreachEligibility } from './eligibility'
import type { MailboxRow } from '@/lib/db/mailboxes'

function mailbox(overrides: Partial<MailboxRow> = {}): MailboxRow {
  return {
    id: 'm1', client_id: 'c1', provider: 'gmail', email_address: 'a@x.com',
    display_name: null, first_name: null, last_name: null, oauth: {},
    daily_cap: 30, sent_today: 0,
    warmup_profile: 'none', warmup_started_at: null, warmup_start_cap: 5, warmup_increment: 2, warmup_target_cap: 30,
    health: 'ok', health_reason: null, health_changed_at: null,
    mailreach_enabled: false, mailreach_started_at: null, mailreach_account_id: null, mailreach_status: 'disconnected',
    mailreach_reputation_score: null, mailreach_total_messages_sent: null, mailreach_total_messages_received: null,
    mailreach_total_spam: null, mailreach_current_conversations: null, mailreach_stats_synced_at: null,
    inbound_cursor: null, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z',
    ...overrides,
  }
}

function mockSupabaseMailboxes(rows: MailboxRow[]) {
  return {
    from: () => ({ select: () => ({ in: () => Promise.resolve({ data: rows, error: null }) }) }),
  } as never
}

const NOW = new Date('2026-08-17T12:00:00Z')

describe('getOutreachEligibility', () => {
  it('should return no_healthy_mailbox when mailboxIds is empty', async () => {
    const result = await getOutreachEligibility(mockSupabaseMailboxes([]), {
      mailboxIds: [], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({ eligible: false, reason: 'no_healthy_mailbox' })
  })

  it('should return no_healthy_mailbox when every mailbox is blocked', async () => {
    const rows = [mailbox({ id: 'm1', health: 'blocked' }), mailbox({ id: 'm2', health: 'blocked' })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1', 'm2'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({ eligible: false, reason: 'no_healthy_mailbox' })
  })

  it('should return mailreach_gate with the earliest lift time when every healthy mailbox is still gated', async () => {
    const rows = [
      mailbox({ id: 'm1', mailreach_enabled: true, mailreach_started_at: '2026-08-10T00:00:00Z' }), // day 7, lifts 2026-08-24
      mailbox({ id: 'm2', mailreach_enabled: true, mailreach_started_at: '2026-08-05T00:00:00Z' }), // day 12, lifts 2026-08-19 (earlier)
    ]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1', 'm2'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({
      eligible: false, reason: 'mailreach_gate', retryAfter: new Date('2026-08-19T00:00:00Z'),
    })
  })

  it('should return daily_cap with next UTC midnight when every gate-cleared mailbox is at its cap', async () => {
    const rows = [mailbox({ id: 'm1', daily_cap: 10, sent_today: 10 })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({
      eligible: false, reason: 'daily_cap', retryAfter: new Date('2026-08-18T00:00:00Z'),
    })
  })

  it('should return eligible: true when at least one mailbox is healthy, gate-cleared, and under cap', async () => {
    const rows = [
      mailbox({ id: 'm1', health: 'blocked' }),
      mailbox({ id: 'm2', mailreach_enabled: true, mailreach_started_at: '2026-08-01T00:00:00Z' }), // day 16, cleared
      mailbox({ id: 'm3', daily_cap: 10, sent_today: 10 }), // capped
    ]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1', 'm2', 'm3'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result).toEqual({ eligible: true })
  })

  it('should treat sent_today === effective cap as not ready (boundary, matches claim_mailbox_send)', async () => {
    const rows = [mailbox({ id: 'm1', daily_cap: 10, sent_today: 10, warmup_profile: 'none' })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1'], clientMailreachEnabled: true, now: NOW,
    })
    expect(result.eligible).toBe(false)
  })

  it('should treat a mailbox as gate-cleared when the client mailreach switch is off, even mid-warmup', async () => {
    const rows = [mailbox({ id: 'm1', mailreach_enabled: true, mailreach_started_at: '2026-08-16T00:00:00Z' })]
    const result = await getOutreachEligibility(mockSupabaseMailboxes(rows), {
      mailboxIds: ['m1'], clientMailreachEnabled: false, now: NOW,
    })
    expect(result).toEqual({ eligible: true })
  })
})
