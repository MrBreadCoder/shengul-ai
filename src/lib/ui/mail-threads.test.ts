import { describe, it, expect } from 'vitest'
import { buildContactThreads } from './mail-threads'
import type { Database } from '@/types/database'
import type { ComposeContact } from '@/types/mail'

type LeadRow = Database['public']['Tables']['leads']['Row']
type EmailRow = Database['public']['Tables']['emails']['Row']

function makeLead(id: string, fullName: string): LeadRow {
  return {
    id,
    client_id: 'client-1',
    campaign_id: 'campaign-1',
    case_id: 'case-1',
    full_name: fullName,
    title: null,
    company_name: null,
    company_domain: null,
    linkedin_url: null,
    source: null,
    source_id: null,
    raw: {},
    email: `${id}@example.com`,
    email_status: 'verified',
    email_verified_at: null,
    email_verification: null,
    status: 'active',
    stage: null,
    wait_reason: null,
    created_at: '2026-08-01T00:00:00.000Z',
    updated_at: '2026-08-01T00:00:00.000Z',
  }
}

function makeEmail(overrides: {
  id: string
  lead_id: string | null
  direction: EmailRow['direction']
  subject?: string | null
  created_at?: string
}): EmailRow {
  return {
    id: overrides.id,
    client_id: 'client-1',
    case_id: 'case-1',
    lead_id: overrides.lead_id,
    thread_id: null,
    provider_message_id: null,
    direction: overrides.direction,
    subject: overrides.subject ?? null,
    body: null,
    status: 'sent',
    sequence_step: null,
    mailbox_id: null,
    sent_at: null,
    in_reply_to_email_id: null,
    sent_by: null,
    created_at: overrides.created_at ?? '2026-08-01T00:00:00.000Z',
  }
}

function makeContact(id: string, fullName: string): ComposeContact {
  return { id, fullName, email: `${id}@example.com` }
}

describe('buildContactThreads', () => {
  it('should group emails by lead, including a lead with only one direction', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadB = makeLead('lead-b', 'Bob Ross')
    const emails = [
      makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' }),
      makeEmail({ id: 'e2', lead_id: 'lead-b', direction: 'inbound' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace'), makeContact('lead-b', 'Bob Ross')]

    const { threads } = buildContactThreads([leadA, leadB], emails, contacts)

    expect(threads).toHaveLength(2)
    expect(threads[0]).toMatchObject({ leadId: 'lead-a', emails: [emails[0]] })
    expect(threads[1]).toMatchObject({ leadId: 'lead-b', emails: [emails[1]] })
  })

  it('should order threads by leads order, not email recency or count', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadB = makeLead('lead-b', 'Bob Ross')
    const emails = [
      makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound', created_at: '2026-08-01T00:00:00.000Z' }),
      makeEmail({ id: 'e2', lead_id: 'lead-b', direction: 'outbound', created_at: '2026-08-02T00:00:00.000Z' }),
      makeEmail({ id: 'e3', lead_id: 'lead-b', direction: 'inbound', created_at: '2026-08-03T00:00:00.000Z' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace'), makeContact('lead-b', 'Bob Ross')]

    const { threads } = buildContactThreads([leadA, leadB], emails, contacts)

    expect(threads.map((thread) => thread.leadId)).toEqual(['lead-a', 'lead-b'])
  })

  it('should skip a lead with zero emails', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadNoMail = makeLead('lead-c', 'No Mail')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' })]
    const contacts = [makeContact('lead-a', 'Ada Lovelace'), makeContact('lead-c', 'No Mail')]

    const { threads } = buildContactThreads([leadA, leadNoMail], emails, contacts)

    expect(threads.map((thread) => thread.leadId)).toEqual(['lead-a'])
  })

  it('should prefix Re: once for the last outbound subject and not double-prefix', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [
      makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound', subject: 'Hello', created_at: '2026-08-01T00:00:00.000Z' }),
      makeEmail({ id: 'e2', lead_id: 'lead-a', direction: 'inbound', subject: 'Re: Hello', created_at: '2026-08-02T00:00:00.000Z' }),
      makeEmail({ id: 'e3', lead_id: 'lead-a', direction: 'outbound', subject: 'Re: Hello', created_at: '2026-08-03T00:00:00.000Z' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace')]

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads[0]?.defaultSubject).toBe('Re: Hello')
  })

  it('should default to an empty subject when the lead has no outbound email yet', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'inbound', subject: 'Question' })]
    const contacts = [makeContact('lead-a', 'Ada Lovelace')]

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads[0]?.defaultSubject).toBe('')
  })

  it('should set composeContact to null for a lead with emails but no longer eligible to send', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' })]
    // leadA has history but is absent from composeContacts (parked, or lost its address)
    const contacts: ComposeContact[] = []

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads[0]?.composeContact).toBeNull()
  })

  it('should exclude leads that already have a thread from newContactOptions, preserving order', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const leadB = makeLead('lead-b', 'Bob Ross')
    const leadC = makeLead('lead-c', 'Cleo King')
    const emails = [makeEmail({ id: 'e1', lead_id: 'lead-a', direction: 'outbound' })]
    const contacts = [
      makeContact('lead-a', 'Ada Lovelace'),
      makeContact('lead-b', 'Bob Ross'),
      makeContact('lead-c', 'Cleo King'),
    ]

    const { newContactOptions } = buildContactThreads([leadA, leadB, leadC], emails, contacts)

    expect(newContactOptions.map((contact) => contact.id)).toEqual(['lead-b', 'lead-c'])
  })

  it('should skip an email row with a null lead_id instead of throwing', () => {
    const leadA = makeLead('lead-a', 'Ada Lovelace')
    const emails = [
      makeEmail({ id: 'e1', lead_id: null, direction: 'outbound' }),
      makeEmail({ id: 'e2', lead_id: 'lead-a', direction: 'outbound' }),
    ]
    const contacts = [makeContact('lead-a', 'Ada Lovelace')]

    const { threads } = buildContactThreads([leadA], emails, contacts)

    expect(threads).toHaveLength(1)
    expect(threads[0]?.emails).toEqual([emails[1]])
  })
})
