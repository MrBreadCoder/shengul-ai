import type { Database } from '@/types/database'
import type { ComposeContact } from '@/types/mail'

type LeadRow = Database['public']['Tables']['leads']['Row']
type EmailRow = Database['public']['Tables']['emails']['Row']

export interface ContactThread {
  leadId: string
  fullName: string
  emails: EmailRow[]
  composeContact: ComposeContact | null
  defaultSubject: string
}

export interface MailThreads {
  threads: ContactThread[]
  newContactOptions: ComposeContact[]
}

// Splits a case's flat email list into one thread per contacted lead (leads
// order, so tab order and the default tab match the Contacts section), plus
// the leads that are eligible to email but have no thread yet.
export function buildContactThreads(
  leads: readonly LeadRow[],
  emails: readonly EmailRow[],
  composeContacts: readonly ComposeContact[],
): MailThreads {
  const emailsByLeadId = new Map<string, EmailRow[]>()
  for (const email of emails) {
    // Every real write path sets lead_id (see the pipeline callers of
    // claimOutboundEmail / insertInboundEmail / insertManualEmail); the
    // column is nullable only because the DB doesn't enforce it.
    if (!email.lead_id) continue
    const existing = emailsByLeadId.get(email.lead_id)
    if (existing) {
      existing.push(email)
    } else {
      emailsByLeadId.set(email.lead_id, [email])
    }
  }

  const composeContactByLeadId = new Map(composeContacts.map((contact) => [contact.id, contact]))

  const threads: ContactThread[] = []
  for (const lead of leads) {
    const leadEmails = emailsByLeadId.get(lead.id)
    if (!leadEmails || leadEmails.length === 0) continue
    threads.push({
      leadId: lead.id,
      fullName: lead.full_name,
      emails: leadEmails,
      composeContact: composeContactByLeadId.get(lead.id) ?? null,
      defaultSubject: replySubject(leadEmails),
    })
  }

  const threadLeadIds = new Set(threads.map((thread) => thread.leadId))
  const newContactOptions = composeContacts.filter((contact) => !threadLeadIds.has(contact.id))

  return { threads, newContactOptions }
}

// "Re: <last outbound subject>" for one lead's own emails, or '' if this lead
// has no outbound email yet. Scoped per lead so one contact's subject line
// can no longer leak into another contact's reply box, which the case-wide
// version this replaces did.
function replySubject(leadEmails: readonly EmailRow[]): string {
  const lastOutbound = [...leadEmails].reverse().find((email) => email.direction === 'outbound')
  if (!lastOutbound || !lastOutbound.subject) return ''
  return lastOutbound.subject.startsWith('Re: ') ? lastOutbound.subject : `Re: ${lastOutbound.subject}`
}
