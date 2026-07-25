import { describe, it, expect } from 'vitest'
import { generateSeedData, type SeedDataset } from '@/lib/seed/generate'
import { CLIENT_FIXTURES, CAMPAIGN_FIXTURES, MAILBOX_FIXTURES } from '@/lib/seed/fixtures'

const OPERATOR_USER_ID = '11111111-2222-4333-8444-555555555555'
const TODAY = new Date('2026-07-21T12:34:56.000Z')
const HISTORY_DAYS = 60
const MS_PER_DAY = 86_400_000
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/

function build(seed = 42): SeedDataset {
  return generateSeedData({ seed, today: TODAY, operatorUserId: OPERATOR_USER_ID })
}

/** Counts duplicates of a composite key across rows. */
function duplicateKeys<T>(rows: readonly T[], keyOf: (row: T) => string | null): string[] {
  const seen = new Set<string>()
  const duplicates: string[] = []
  for (const row of rows) {
    const key = keyOf(row)
    if (key === null) continue
    if (seen.has(key)) duplicates.push(key)
    seen.add(key)
  }
  return duplicates
}

describe('generateSeedData', () => {
  it('should produce an identical dataset when given the same seed', () => {
    // Arrange
    const first = build(7)
    // Act
    const second = build(7)
    // Assert
    expect(JSON.stringify(second)).toBe(JSON.stringify(first))
  })

  it('should produce a different dataset when given a different seed', () => {
    // Arrange
    const first = build(7)
    // Act
    const second = build(8)
    // Assert
    expect(JSON.stringify(second)).not.toBe(JSON.stringify(first))
  })

  it('should emit valid v4 uuids for every primary key', () => {
    // Arrange
    const data = build()
    // Act
    const ids = [
      ...data.clients, ...data.campaigns, ...data.mailboxes, ...data.cases, ...data.leads,
      ...data.caseKnowledge, ...data.emails, ...data.sequences, ...data.knowledgeRequests,
      ...data.suppressions, ...data.events,
    ].map((row) => row.id)
    // Assert
    expect(ids.length).toBeGreaterThan(0)
    expect(ids.filter((id) => !UUID_PATTERN.test(id))).toEqual([])
  })

  it('should build every fixture client, campaign, and mailbox', () => {
    // Arrange & Act
    const data = build()
    // Assert
    expect(data.clients).toHaveLength(CLIENT_FIXTURES.length)
    expect(data.campaigns).toHaveLength(CAMPAIGN_FIXTURES.length)
    expect(data.mailboxes).toHaveLength(MAILBOX_FIXTURES.length)
    expect(data.demoClientId).toBe(data.clients[0]?.id)
  })
})

describe('generateSeedData — unique index compliance', () => {
  it('should never place two outbound emails on the same (lead_id, sequence_step)', () => {
    // Arrange
    const data = build()
    // Act — nulls are distinct in Postgres, so only non-null steps can collide.
    const duplicates = duplicateKeys(
      data.emails.filter((e) => e.direction === 'outbound' && e.sequence_step !== null),
      (e) => `${e.lead_id}:${e.sequence_step}`,
    )
    // Assert
    expect(duplicates).toEqual([])
  })

  it('should keep provider_message_id and in_reply_to_email_id unique', () => {
    // Arrange
    const data = build()
    // Act
    const messageIds = duplicateKeys(data.emails, (e) => e.provider_message_id ?? null)
    const replyTargets = duplicateKeys(data.emails, (e) => e.in_reply_to_email_id ?? null)
    // Assert
    expect(messageIds).toEqual([])
    expect(replyTargets).toEqual([])
  })

  it('should create at most one sequence per lead', () => {
    // Arrange
    const data = build()
    // Act
    const duplicates = duplicateKeys(data.sequences, (s) => s.lead_id)
    // Assert
    expect(duplicates).toEqual([])
  })

  it('should keep (campaign_id, source_id) and (campaign_id, company_key) unique', () => {
    // Arrange
    const data = build()
    // Act
    const leadDuplicates = duplicateKeys(data.leads, (l) => (l.source_id ? `${l.campaign_id}:${l.source_id}` : null))
    const caseDuplicates = duplicateKeys(data.cases, (c) => `${c.campaign_id}:${c.company_key}`)
    // Assert
    expect(leadDuplicates).toEqual([])
    expect(caseDuplicates).toEqual([])
  })

  it('should keep (client_id, email) unique across suppressions', () => {
    // Arrange
    const data = build()
    // Act
    const duplicates = duplicateKeys(data.suppressions, (s) => `${s.client_id}:${s.email}`)
    // Assert
    expect(duplicates).toEqual([])
    expect(data.suppressions.length).toBeGreaterThan(0)
  })

  it('should create at most one knowledge request per email', () => {
    // Arrange
    const data = build()
    // Act
    const duplicates = duplicateKeys(data.knowledgeRequests, (k) => k.email_id ?? null)
    // Assert
    expect(duplicates).toEqual([])
  })
})

describe('generateSeedData — referential integrity', () => {
  it('should resolve every foreign key to a generated row', () => {
    // Arrange
    const data = build()
    const clientIds = new Set(data.clients.map((c) => c.id))
    const campaignIds = new Set(data.campaigns.map((c) => c.id))
    const caseIds = new Set(data.cases.map((c) => c.id))
    const leadIds = new Set(data.leads.map((l) => l.id))
    const mailboxIds = new Set(data.mailboxes.map((m) => m.id))
    const emailIds = new Set(data.emails.map((e) => e.id))

    // Act
    const broken: string[] = []
    for (const campaign of data.campaigns) if (!clientIds.has(campaign.client_id)) broken.push(`campaign:${campaign.id}`)
    for (const seedCase of data.cases) {
      if (!clientIds.has(seedCase.client_id)) broken.push(`case.client:${seedCase.id}`)
      if (!campaignIds.has(seedCase.campaign_id)) broken.push(`case.campaign:${seedCase.id}`)
    }
    for (const lead of data.leads) {
      if (!caseIds.has(lead.case_id ?? '')) broken.push(`lead.case:${lead.id}`)
      if (!campaignIds.has(lead.campaign_id)) broken.push(`lead.campaign:${lead.id}`)
    }
    for (const email of data.emails) {
      if (!caseIds.has(email.case_id ?? '')) broken.push(`email.case:${email.id}`)
      if (!leadIds.has(email.lead_id ?? '')) broken.push(`email.lead:${email.id}`)
      if (!mailboxIds.has(email.mailbox_id ?? '')) broken.push(`email.mailbox:${email.id}`)
      if (email.in_reply_to_email_id && !emailIds.has(email.in_reply_to_email_id)) broken.push(`email.reply:${email.id}`)
    }
    for (const sequence of data.sequences) {
      if (!caseIds.has(sequence.case_id)) broken.push(`sequence.case:${sequence.id}`)
      if (!leadIds.has(sequence.lead_id)) broken.push(`sequence.lead:${sequence.id}`)
    }
    for (const request of data.knowledgeRequests) {
      if (!caseIds.has(request.case_id)) broken.push(`request.case:${request.id}`)
      if (!emailIds.has(request.email_id ?? '')) broken.push(`request.email:${request.id}`)
    }
    for (const knowledge of data.caseKnowledge) {
      if (!caseIds.has(knowledge.case_id)) broken.push(`knowledge.case:${knowledge.id}`)
    }
    // Assert
    expect(broken).toEqual([])
  })

  it('should set answered_by to the operator id only on answered requests', () => {
    // Arrange
    const data = build()
    // Act
    const answered = data.knowledgeRequests.filter((r) => r.status === 'answered')
    const unanswered = data.knowledgeRequests.filter((r) => r.status !== 'answered')
    // Assert
    expect(answered.every((r) => r.answered_by === OPERATOR_USER_ID && r.human_answer !== null)).toBe(true)
    expect(unanswered.every((r) => r.answered_by === null && r.answered_at === null)).toBe(true)
  })
})

describe('generateSeedData — funnel consistency', () => {
  it('should populate all nine case statuses so every CRM column has cards', () => {
    // Arrange
    const data = build()
    const expected = ['new', 'researching', 'ready', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead']
    // Act
    const present = new Set(data.cases.map((c) => c.status))
    // Assert
    for (const status of expected) expect(present.has(status as never)).toBe(true)
  })

  it('should give every contacted-or-later case at least one first-touch outbound', () => {
    // Arrange
    const data = build()
    const contactable = new Set(['contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead'])
    const caseIdsWithFirstTouch = new Set(
      data.emails.filter((e) => e.direction === 'outbound' && e.sequence_step === 0).map((e) => e.case_id),
    )
    // Act
    const missing = data.cases
      .filter((c) => contactable.has(c.status ?? '') && !caseIdsWithFirstTouch.has(c.id))
      .map((c) => `${c.company_name}:${c.status}`)
    // Assert
    expect(missing).toEqual([])
  })

  it('should never send email for a case that has not been contacted yet', () => {
    // Arrange
    const data = build()
    const preContact = new Set(
      data.cases.filter((c) => c.status === 'new' || c.status === 'researching' || c.status === 'ready').map((c) => c.id),
    )
    // Act
    const leaked = data.emails.filter((e) => preContact.has(e.case_id ?? ''))
    // Assert
    expect(leaked).toEqual([])
  })

  it('should only email leads that are verified and active', () => {
    // Arrange
    const data = build()
    const leadsById = new Map(data.leads.map((l) => [l.id, l]))
    // Act
    const invalid = data.emails
      .filter((e) => e.direction === 'outbound')
      .filter((e) => {
        const lead = leadsById.get(e.lead_id ?? '')
        return !lead || lead.email_status !== 'verified' || lead.status !== 'active'
      })
    // Assert
    expect(invalid).toEqual([])
  })

  it('should pair every inbound reply with a preceding outbound in the same thread', () => {
    // Arrange
    const data = build()
    const inbound = data.emails.filter((e) => e.direction === 'inbound')
    const outboundThreads = new Set(
      data.emails.filter((e) => e.direction === 'outbound' && e.sequence_step === 0).map((e) => e.thread_id),
    )
    // Act
    const orphans = inbound.filter((e) => !outboundThreads.has(e.thread_id))
    // Assert
    expect(inbound.length).toBeGreaterThan(0)
    expect(orphans).toEqual([])
  })

  it('should leave sent_at null for drafts and failed sends only', () => {
    // Arrange
    const data = build()
    // Act
    const wrongNull = data.emails.filter((e) => e.sent_at === null && e.status !== 'draft' && e.status !== 'failed')
    const wrongSet = data.emails.filter((e) => e.sent_at !== null && (e.status === 'draft' || e.status === 'failed'))
    // Assert
    expect(wrongNull).toEqual([])
    expect(wrongSet).toEqual([])
  })

  it('should schedule next_action_at only for active sequences', () => {
    // Arrange
    const data = build()
    // Act
    const active = data.sequences.filter((s) => s.state === 'active')
    const inactive = data.sequences.filter((s) => s.state !== 'active')
    // Assert
    expect(active.length).toBeGreaterThan(0)
    expect(active.every((s) => s.next_action_at !== null)).toBe(true)
    expect(inactive.every((s) => s.next_action_at === null)).toBe(true)
  })
})

describe('generateSeedData — UI coverage', () => {
  it('should leave outbound drafts for the inbox approval queue', () => {
    // Arrange
    const data = build()
    // Act
    const drafts = data.emails.filter((e) => e.status === 'draft' && e.direction === 'outbound')
    // Assert
    expect(drafts.length).toBeGreaterThan(0)
    expect(drafts.every((d) => d.body !== null && d.subject !== null)).toBe(true)
  })

  it('should leave open knowledge requests for the inbox', () => {
    // Arrange
    const data = build()
    // Act
    const open = data.knowledgeRequests.filter((r) => r.status === 'open')
    // Assert
    expect(open.length).toBeGreaterThan(0)
  })

  it('should give every campaign at least one case so the analytics table is never empty', () => {
    // Arrange
    const data = build()
    const casesByCampaign = new Set(data.cases.map((c) => c.campaign_id))
    // Act
    const emptyCampaigns = data.campaigns.filter((c) => !casesByCampaign.has(c.id)).map((c) => c.name)
    // Assert
    expect(emptyCampaigns).toEqual([])
  })

  it('should give every client at least one healthy mailbox to send from', () => {
    // Arrange
    const data = build()
    // Act
    const withoutSender = data.clients.filter(
      (client) => !data.mailboxes.some((m) => m.client_id === client.id && m.health !== 'blocked'),
    )
    // Assert
    expect(withoutSender).toEqual([])
  })

  it('should record agent events across a variety of types', () => {
    // Arrange
    const data = build()
    // Act
    const types = new Set(data.events.map((e) => e.type))
    // Assert
    expect(types.has('lead.found')).toBe(true)
    expect(types.has('pipeline.research.completed')).toBe(true)
    expect(types.has('inbound.received')).toBe(true)
    expect(types.has('mailbox.daily_reset.completed')).toBe(true)
    expect(types.size).toBeGreaterThanOrEqual(10)
  })
})

describe('generateSeedData — time window', () => {
  it('should keep every timestamp inside the history window', () => {
    // Arrange
    const data = build()
    const windowEnd = TODAY.getTime() + MS_PER_DAY
    const windowStart = Date.UTC(TODAY.getUTCFullYear(), TODAY.getUTCMonth(), TODAY.getUTCDate()) - (HISTORY_DAYS - 1) * MS_PER_DAY

    // Act — next_action_at is deliberately excluded: a live sequence schedules
    // its next touch in the future, which may fall outside the window.
    const timestamps: (string | null | undefined)[] = [
      ...data.cases.flatMap((c) => [c.created_at, c.updated_at]),
      ...data.leads.map((l) => l.created_at),
      ...data.emails.flatMap((e) => [e.created_at, e.sent_at]),
      ...data.events.map((e) => e.created_at),
      ...data.suppressions.map((s) => s.created_at),
      ...data.knowledgeRequests.map((k) => k.created_at),
    ]
    const outOfRange = timestamps
      .filter((value): value is string => typeof value === 'string')
      .filter((value) => {
        const time = Date.parse(value)
        return Number.isNaN(time) || time < windowStart || time >= windowEnd
      })
    // Assert
    expect(timestamps.length).toBeGreaterThan(0)
    expect(outOfRange).toEqual([])
  })

  it('should send only on weekdays so the daily trend has a weekly shape', () => {
    // Arrange
    const data = build()
    // Act
    const weekendSends = data.emails
      .filter((e) => e.direction === 'outbound' && e.sent_at)
      .filter((e) => {
        const weekday = new Date(e.sent_at as string).getUTCDay()
        return weekday === 0 || weekday === 6
      })
    // Assert
    expect(weekendSends).toEqual([])
  })

  it('should discover leads before the first email is sent to them', () => {
    // Arrange
    const data = build()
    const leadsById = new Map(data.leads.map((l) => [l.id, l]))
    // Act
    const outOfOrder = data.emails.filter((email) => {
      const lead = leadsById.get(email.lead_id ?? '')
      if (!lead?.created_at || !email.created_at) return false
      return Date.parse(email.created_at) < Date.parse(lead.created_at)
    })
    // Assert
    expect(outOfOrder).toEqual([])
  })
})
