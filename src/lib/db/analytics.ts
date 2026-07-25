import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  ZERO_OVERVIEW,
  type OverviewMetrics,
  type DailyMetric,
  type CampaignMetrics,
  type MailboxMetrics,
  type EventCount,
} from '@/types/analytics'

export interface MetricsRange {
  from: string
  to: string
  campaignId: string | null
  clientId: string | null
}

export interface CampaignMetricsRange {
  from: string
  to: string
}

export interface EventCountsInput {
  from: string
  to: string
  limit: number
}

// Every read below is RLS-scoped: the caller must pass a session-bound client
// (createServerClient), never the admin client. The SQL functions are SECURITY
// INVOKER precisely so a client-role viewer aggregates only its own client_id
// (.claude/architecture.md §11).

export async function getOverviewMetrics(
  supabase: SupabaseClient<Database>,
  { from, to, campaignId, clientId }: MetricsRange,
): Promise<OverviewMetrics> {
  const { data, error } = await supabase.rpc('analytics_overview', {
    p_from: from,
    p_to: to,
    p_campaign_id: campaignId,
    p_client_id: clientId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load analytics overview', {
      from,
      to,
      campaignId,
      clientId,
      cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  const row = data && data.length > 0 ? data[0]! : null
  if (!row) return ZERO_OVERVIEW
  return {
    leadsDiscovered: row.leads_discovered,
    leadsVerified: row.leads_verified,
    casesCreated: row.cases_created,
    emailsSent: row.emails_sent,
    firstTouchSent: row.first_touch_sent,
    followupsSent: row.followups_sent,
    emailsBounced: row.emails_bounced,
    emailsFailed: row.emails_failed,
    repliesReceived: row.replies_received,
    leadsContacted: row.leads_contacted,
    leadsReplied: row.leads_replied,
    suppressionsAdded: row.suppressions_added,
    activeSequences: row.active_sequences,
  }
}

export async function getDailyMetrics(
  supabase: SupabaseClient<Database>,
  { from, to, campaignId, clientId }: MetricsRange,
): Promise<DailyMetric[]> {
  const { data, error } = await supabase.rpc('analytics_daily', {
    p_from: from,
    p_to: to,
    p_campaign_id: campaignId,
    p_client_id: clientId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load daily analytics', {
      from,
      to,
      campaignId,
      clientId,
      cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({
    day: row.day,
    leadsDiscovered: row.leads_discovered,
    emailsSent: row.emails_sent,
    repliesReceived: row.replies_received,
  }))
}

export async function getCampaignMetrics(
  supabase: SupabaseClient<Database>,
  { from, to }: CampaignMetricsRange,
): Promise<CampaignMetrics[]> {
  const { data, error } = await supabase.rpc('analytics_by_campaign', { p_from: from, p_to: to })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load campaign analytics', {
      from,
      to,
      cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    clientId: row.client_id,
    campaignStatus: row.campaign_status,
    leadsDiscovered: row.leads_discovered,
    leadsVerified: row.leads_verified,
    casesCreated: row.cases_created,
    emailsSent: row.emails_sent,
    leadsContacted: row.leads_contacted,
    leadsReplied: row.leads_replied,
    casesNew: row.cases_new,
    casesResearching: row.cases_researching,
    casesReady: row.cases_ready,
    casesContacted: row.cases_contacted,
    casesInConversation: row.cases_in_conversation,
    casesHotHandoff: row.cases_hot_handoff,
    casesWon: row.cases_won,
    casesLost: row.cases_lost,
    casesDead: row.cases_dead,
  }))
}

export async function getMailboxMetrics(
  supabase: SupabaseClient<Database>,
): Promise<MailboxMetrics[]> {
  const { data, error } = await supabase.rpc('analytics_mailboxes')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load mailbox analytics', { cause: error.message })
  }
  return (data ?? []).map((row) => ({
    mailboxId: row.mailbox_id,
    clientId: row.client_id,
    emailAddress: row.email_address,
    provider: row.provider,
    health: row.health,
    dailyCap: row.daily_cap,
    sentToday: row.sent_today,
    sentTotal: row.sent_total,
    bouncedTotal: row.bounced_total,
    failedTotal: row.failed_total,
    lastSentAt: row.last_sent_at,
  }))
}

export async function getEventCounts(
  supabase: SupabaseClient<Database>,
  { from, to, limit }: EventCountsInput,
): Promise<EventCount[]> {
  const { data, error } = await supabase.rpc('analytics_event_counts', {
    p_from: from,
    p_to: to,
    p_limit: limit,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load event counts', {
      from,
      to,
      limit,
      cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({ type: row.event_type, count: row.event_count }))
}
