import type { Database } from '@/types/database'

/**
 * Serialisable projections handed from a Server Component to the client
 * component that registers the authenticated app's read-only WebMCP tools.
 *
 * A `WebMcpTool` carries an `execute` function, so the descriptors cannot cross
 * the server/client boundary — only the data they answer from can. These shapes
 * are that data: already RLS-scoped by the page that fetched them, mapped from
 * the database's `snake_case` columns to `camelCase`, and narrowed to the fields
 * an agent has any business reading.
 */

type ClientStatus = Database['public']['Enums']['client_status']
type CampaignStatus = Database['public']['Enums']['campaign_status']
type MailboxProvider = Database['public']['Enums']['mailbox_provider']
type MailboxHealth = Database['public']['Enums']['mailbox_health']
type WarmupProfile = Database['public']['Enums']['warmup_profile']

export interface ClientDirectoryEntry {
  readonly id: string
  readonly name: string
  readonly status: ClientStatus
  /** The client's own website, or `null` when none was recorded. */
  readonly domain: string | null
  readonly createdAt: string
}

export interface CampaignDirectoryEntry {
  readonly id: string
  readonly clientId: string
  readonly name: string
  readonly status: CampaignStatus
  /**
   * The promise every first email is grounded on. Operator-authored, and
   * nullable in Postgres — a seeded campaign can exist without one.
   */
  readonly valueProp: string | null
  /** Records discovery pulls per day. */
  readonly dailyTarget: number
  readonly mailboxCount: number
  readonly createdAt: string
}

export interface MailboxHealthEntry {
  readonly id: string
  readonly provider: MailboxProvider
  readonly emailAddress: string
  readonly displayName: string | null
  readonly health: MailboxHealth
  /** Why the health is not `ok`, when the pipeline recorded a reason. */
  readonly healthReason: string | null
  readonly dailyCap: number
  readonly sentToday: number
  readonly warmupProfile: WarmupProfile
  readonly warmupStartedAt: string | null
}
