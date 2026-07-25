import type { Database } from '@/types/database'

export interface OverviewMetrics {
  leadsDiscovered: number
  leadsVerified: number
  casesCreated: number
  emailsSent: number
  firstTouchSent: number
  followupsSent: number
  emailsBounced: number
  emailsFailed: number
  repliesReceived: number
  leadsContacted: number
  leadsReplied: number
  suppressionsAdded: number
  activeSequences: number
}

// Returned when the window contains no rows at all, so the page always has a
// complete object to render instead of a partially-undefined one.
export const ZERO_OVERVIEW: OverviewMetrics = {
  leadsDiscovered: 0,
  leadsVerified: 0,
  casesCreated: 0,
  emailsSent: 0,
  firstTouchSent: 0,
  followupsSent: 0,
  emailsBounced: 0,
  emailsFailed: 0,
  repliesReceived: 0,
  leadsContacted: 0,
  leadsReplied: 0,
  suppressionsAdded: 0,
  activeSequences: 0,
}

export interface DailyMetric {
  day: string
  leadsDiscovered: number
  emailsSent: number
  repliesReceived: number
}

export interface CampaignMetrics {
  campaignId: string
  campaignName: string
  clientId: string
  campaignStatus: Database['public']['Enums']['campaign_status']
  leadsDiscovered: number
  leadsVerified: number
  casesCreated: number
  emailsSent: number
  leadsContacted: number
  leadsReplied: number
  casesNew: number
  casesResearching: number
  casesReady: number
  casesContacted: number
  casesInConversation: number
  casesHotHandoff: number
  casesWon: number
  casesLost: number
  casesDead: number
}

export interface MailboxMetrics {
  mailboxId: string
  clientId: string
  emailAddress: string
  provider: Database['public']['Enums']['mailbox_provider']
  health: Database['public']['Enums']['mailbox_health']
  dailyCap: number
  sentToday: number
  sentTotal: number
  bouncedTotal: number
  failedTotal: number
  lastSentAt: string | null
}

export interface EventCount {
  type: string
  count: number
}
