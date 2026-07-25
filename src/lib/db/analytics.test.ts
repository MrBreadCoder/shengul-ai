import { describe, it, expect, vi } from 'vitest'
import {
  getOverviewMetrics,
  getDailyMetrics,
  getCampaignMetrics,
  getMailboxMetrics,
  getEventCounts,
} from './analytics'
import { AppError } from '@/lib/errors/app-error'
import { ZERO_OVERVIEW } from '@/types/analytics'

function mockRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(result))
  return { supabase: { rpc } as never, rpc }
}

const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-21T00:00:00.000Z', campaignId: null, clientId: null }

const overviewRow = {
  leads_discovered: 120,
  leads_verified: 80,
  cases_created: 40,
  emails_sent: 200,
  first_touch_sent: 60,
  followups_sent: 140,
  emails_bounced: 4,
  emails_failed: 2,
  replies_received: 15,
  leads_contacted: 55,
  leads_replied: 11,
  suppressions_added: 7,
  active_sequences: 22,
}

describe('getOverviewMetrics', () => {
  it('should map the row to camelCase when the rpc succeeds', async () => {
    const { supabase } = mockRpc({ data: [overviewRow], error: null })
    const result = await getOverviewMetrics(supabase, RANGE)
    expect(result.leadsDiscovered).toBe(120)
    expect(result.activeSequences).toBe(22)
    expect(result.leadsReplied).toBe(11)
  })

  it('should pass the window and campaign filter to the rpc', async () => {
    const { supabase, rpc } = mockRpc({ data: [overviewRow], error: null })
    await getOverviewMetrics(supabase, { ...RANGE, campaignId: 'camp-1' })
    expect(rpc).toHaveBeenCalledWith('analytics_overview', {
      p_from: RANGE.from,
      p_to: RANGE.to,
      p_campaign_id: 'camp-1',
      p_client_id: null,
    })
  })

  it('should pass the client filter through to the rpc call', async () => {
    const { supabase, rpc } = mockRpc({ data: [overviewRow], error: null })
    await getOverviewMetrics(supabase, { ...RANGE, clientId: 'client-1' })
    expect(rpc).toHaveBeenCalledWith('analytics_overview', {
      p_from: RANGE.from,
      p_to: RANGE.to,
      p_campaign_id: null,
      p_client_id: 'client-1',
    })
  })

  it('should return zeroed metrics when the rpc returns no rows', async () => {
    const { supabase } = mockRpc({ data: [], error: null })
    expect(await getOverviewMetrics(supabase, RANGE)).toEqual(ZERO_OVERVIEW)
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(getOverviewMetrics(supabase, RANGE)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getDailyMetrics', () => {
  it('should map each day row to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [{ day: '2026-07-20', leads_discovered: 5, emails_sent: 9, replies_received: 1 }],
      error: null,
    })
    const result = await getDailyMetrics(supabase, RANGE)
    expect(result).toEqual([
      { day: '2026-07-20', leadsDiscovered: 5, emailsSent: 9, repliesReceived: 1 },
    ])
  })

  it('should return an empty array when the rpc returns null data', async () => {
    const { supabase } = mockRpc({ data: null, error: null })
    expect(await getDailyMetrics(supabase, RANGE)).toEqual([])
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(getDailyMetrics(supabase, RANGE)).rejects.toBeInstanceOf(AppError)
  })

  it('should pass the client filter through to the rpc call', async () => {
    const { supabase, rpc } = mockRpc({ data: [], error: null })
    await getDailyMetrics(supabase, { ...RANGE, clientId: 'client-1' })
    expect(rpc).toHaveBeenCalledWith('analytics_daily', {
      p_from: RANGE.from,
      p_to: RANGE.to,
      p_campaign_id: null,
      p_client_id: 'client-1',
    })
  })
})

describe('getCampaignMetrics', () => {
  it('should map campaign rows to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [
        {
          campaign_id: 'camp-1',
          campaign_name: 'Q3 SaaS',
          client_id: 'client-1',
          campaign_status: 'active',
          leads_discovered: 10,
          leads_verified: 6,
          cases_created: 3,
          emails_sent: 12,
          leads_contacted: 5,
          leads_replied: 2,
          cases_new: 1,
          cases_researching: 0,
          cases_ready: 1,
          cases_contacted: 2,
          cases_in_conversation: 1,
          cases_hot_handoff: 0,
          cases_won: 0,
          cases_lost: 0,
          cases_dead: 1,
        },
      ],
      error: null,
    })
    const [row] = await getCampaignMetrics(supabase, { from: RANGE.from, to: RANGE.to })
    expect(row?.campaignName).toBe('Q3 SaaS')
    expect(row?.casesInConversation).toBe(1)
    expect(row?.leadsReplied).toBe(2)
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(
      getCampaignMetrics(supabase, { from: RANGE.from, to: RANGE.to }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getMailboxMetrics', () => {
  it('should map mailbox rows to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [
        {
          mailbox_id: 'mb-1',
          client_id: 'client-1',
          email_address: 'sales@acme.com',
          provider: 'gmail',
          health: 'ok',
          daily_cap: 20,
          sent_today: 8,
          sent_total: 340,
          bounced_total: 3,
          failed_total: 1,
          last_sent_at: '2026-07-21T09:00:00.000Z',
        },
      ],
      error: null,
    })
    const [row] = await getMailboxMetrics(supabase)
    expect(row?.emailAddress).toBe('sales@acme.com')
    expect(row?.sentTotal).toBe(340)
    expect(row?.lastSentAt).toBe('2026-07-21T09:00:00.000Z')
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(getMailboxMetrics(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getEventCounts', () => {
  it('should map event rows to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [{ event_type: 'pipeline.research.completed', event_count: 9 }],
      error: null,
    })
    expect(await getEventCounts(supabase, { from: RANGE.from, to: RANGE.to, limit: 12 })).toEqual([
      { type: 'pipeline.research.completed', count: 9 },
    ])
  })

  it('should pass the limit to the rpc', async () => {
    const { supabase, rpc } = mockRpc({ data: [], error: null })
    await getEventCounts(supabase, { from: RANGE.from, to: RANGE.to, limit: 5 })
    expect(rpc).toHaveBeenCalledWith('analytics_event_counts', {
      p_from: RANGE.from,
      p_to: RANGE.to,
      p_limit: 5,
    })
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(
      getEventCounts(supabase, { from: RANGE.from, to: RANGE.to, limit: 12 }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
