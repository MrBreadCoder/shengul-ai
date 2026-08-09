import type { Database } from '@/types/database'

type CaseStatus = Database['public']['Enums']['case_status']
type EmailStatus = Database['public']['Enums']['email_status']
type LeadEmailStatus = Database['public']['Enums']['lead_email_status']
type MailboxHealth = Database['public']['Enums']['mailbox_health']
type KnowledgeKind = Database['public']['Enums']['knowledge_kind']
type KnowledgeReqStatus = Database['public']['Enums']['knowledge_req_status']
type KnowledgeSourceStatus = Database['public']['Enums']['knowledge_source_status']
type ClientStatus = Database['public']['Enums']['client_status']
type CampaignStatus = Database['public']['Enums']['campaign_status']
type UserRole = Database['public']['Enums']['user_role']

export interface StatusMeta {
  /** Human label shown to the operator. */
  readonly label: string
  /** CSS colour expression. Drives both the dot and the tinted text. */
  readonly color: string
}

export const CASE_STATUS: Record<CaseStatus, StatusMeta> = {
  new: { label: 'New', color: 'var(--status-new)' },
  researching: { label: 'Researching', color: 'var(--status-researching)' },
  ready: { label: 'Ready', color: 'var(--status-ready)' },
  contacted: { label: 'Contacted', color: 'var(--status-contacted)' },
  in_conversation: { label: 'In conversation', color: 'var(--status-in-conversation)' },
  hot_handoff: { label: 'Hot handoff', color: 'var(--status-hot-handoff)' },
  won: { label: 'Won', color: 'var(--status-won)' },
  lost: { label: 'Lost', color: 'var(--status-lost)' },
  dead: { label: 'Dead', color: 'var(--status-dead)' },
}

export const EMAIL_STATUS: Record<EmailStatus, StatusMeta> = {
  draft: { label: 'Draft', color: 'var(--status-researching)' },
  queued: { label: 'Queued', color: 'var(--status-ready)' },
  sent: { label: 'Sent', color: 'var(--status-contacted)' },
  delivered: { label: 'Delivered', color: 'var(--status-won)' },
  bounced: { label: 'Bounced', color: 'var(--status-lost)' },
  failed: { label: 'Failed', color: 'var(--status-lost)' },
}

export const LEAD_EMAIL_STATUS: Record<LeadEmailStatus, StatusMeta> = {
  unverified: { label: 'Unverified', color: 'var(--status-new)' },
  verified: { label: 'Verified', color: 'var(--status-won)' },
  invalid: { label: 'Invalid', color: 'var(--status-lost)' },
  risky: { label: 'Risky', color: 'var(--status-hot-handoff)' },
  not_found: { label: 'Not found', color: 'var(--status-dead)' },
}

// Client-facing view of a lead's email status. A 'risky' lead is Emailable's
// accept-all catch-all carve-out (src/lib/emailable/map-verification.ts) —
// Apollo verified the address, the domain just accepts all mail so Emailable
// can't individually confirm it, and we send to it anyway (status: 'active').
// That nuance is an internal deliverability signal, not something a client
// needs to see the word "risky" over — it reads as "we're emailing risky
// people," which isn't true and isn't actionable for them. Operators keep the
// real 'risky' label (via LEAD_EMAIL_STATUS directly) for diagnosis; every
// other status is unaffected and passes through unchanged for both roles.
export function leadEmailStatusMetaFor(status: LeadEmailStatus, role: UserRole): StatusMeta {
  if (role === 'client' && status === 'risky') return LEAD_EMAIL_STATUS.verified
  return LEAD_EMAIL_STATUS[status]
}

export const MAILBOX_HEALTH: Record<MailboxHealth, StatusMeta> = {
  ok: { label: 'Healthy', color: 'var(--status-won)' },
  warning: { label: 'Warning', color: 'var(--status-hot-handoff)' },
  blocked: { label: 'Blocked', color: 'var(--status-lost)' },
}

export const CLIENT_STATUS: Record<ClientStatus, StatusMeta> = {
  active: { label: 'Active', color: 'var(--status-won)' },
  paused: { label: 'Paused', color: 'var(--status-hot-handoff)' },
  archived: { label: 'Archived', color: 'var(--status-dead)' },
}

export const CAMPAIGN_STATUS: Record<CampaignStatus, StatusMeta> = {
  active: { label: 'Active', color: 'var(--status-won)' },
  paused: { label: 'Paused', color: 'var(--status-researching)' },
  archived: { label: 'Archived', color: 'var(--status-dead)' },
}

export const KNOWLEDGE_KIND: Record<KnowledgeKind, StatusMeta> = {
  company: { label: 'Company', color: 'var(--status-ready)' },
  person: { label: 'Person', color: 'var(--status-contacted)' },
  news: { label: 'News', color: 'var(--status-researching)' },
  pain_point: { label: 'Pain point', color: 'var(--status-hot-handoff)' },
  answer: { label: 'Answer', color: 'var(--status-in-conversation)' },
}

export const KNOWLEDGE_REQ_STATUS: Record<KnowledgeReqStatus, StatusMeta> = {
  open: { label: 'Open', color: 'var(--status-hot-handoff)' },
  answered: { label: 'Answered', color: 'var(--status-won)' },
  dismissed: { label: 'Dismissed', color: 'var(--status-dead)' },
}

export const KNOWLEDGE_SOURCE_STATUS: Record<KnowledgeSourceStatus, StatusMeta> = {
  pending: { label: 'Pending', color: 'var(--status-researching)' },
  ready: { label: 'Ready', color: 'var(--status-won)' },
  failed: { label: 'Failed', color: 'var(--status-lost)' },
}
