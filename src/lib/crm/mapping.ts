import type { Database } from '@/types/database'
import type { CrmCompanyInput, CrmContactInput } from './provider'

type LeadEmailStatus = Database['public']['Enums']['lead_email_status']
type LeadStatus = Database['public']['Enums']['lead_status']

/** The lead fields the CRM mapping reads. Narrower than LeadRow on purpose. */
export interface SyncableLead {
  email: string | null
  full_name: string
  title: string | null
  linkedin_url: string | null
  company_name: string | null
  email_status: LeadEmailStatus
  status: LeadStatus
}

/** The case fields the company mapping reads. */
export interface MappableCase {
  company_name: string
  company_domain: string | null
}

export interface SplitName {
  firstName: string | null
  lastName: string | null
}

/**
 * First token is the given name, everything after it is the family name. Naive
 * on purpose: the alternative is guessing at particles and multi-part surnames,
 * and a wrong guess is worse in a client's CRM than an unsplit surname.
 */
export function splitFullName(fullName: string): SplitName {
  const parts = fullName.trim().split(/\s+/).filter((part) => part.length > 0)
  if (parts.length === 0) return { firstName: null, lastName: null }
  // length check above guarantees index 0 exists
  const [firstName, ...rest] = parts as [string, ...string[]]
  return { firstName, lastName: rest.length > 0 ? rest.join(' ') : null }
}

export function toCompanyInput(kase: MappableCase): CrmCompanyInput {
  return { name: kase.company_name, domain: kase.company_domain }
}

/**
 * Callers must have filtered with isSyncableLead first, which is what proves
 * `email` is non-null here.
 */
export function toContactInput(lead: SyncableLead): CrmContactInput {
  const { firstName, lastName } = splitFullName(lead.full_name)
  return {
    email: lead.email ?? '',
    firstName,
    lastName,
    title: lead.title,
    linkedinUrl: lead.linkedin_url,
    companyName: lead.company_name,
  }
}

export function toDealTitle(companyName: string, campaignName: string | null): string {
  return campaignName ? `${companyName} — ${campaignName}` : companyName
}

export interface CreationNoteInput {
  summary: string | null
  caseUrl: string
  companyDomain: string | null
  leads: readonly SyncableLead[]
}

/**
 * The note carries every field the providers cannot store natively. Pipedrive
 * has no standard field for job title, LinkedIn URL, or organization domain,
 * and its custom fields must be created by the account owner first — we do not
 * mutate a client's CRM schema, so those values live here instead.
 */
export function toCreationNote({ summary, caseUrl, companyDomain, leads }: CreationNoteInput): string {
  const lines: string[] = ['Sourced and qualified by the outreach agent.']
  if (summary) lines.push('', `Summary: ${summary}`)
  if (companyDomain) lines.push('', `Domain: ${companyDomain}`)
  if (leads.length > 0) {
    lines.push('', 'Contacts:')
    for (const lead of leads) {
      const detail = [lead.title, lead.linkedin_url].filter((part) => part !== null)
      const suffix = detail.length > 0 ? ` — ${detail.join(' — ')}` : ''
      lines.push(`- ${lead.full_name} <${lead.email ?? 'no email'}>${suffix}`)
    }
  }
  lines.push('', `Full case: ${caseUrl}`)
  return lines.join('\n')
}

/**
 * Only active, email-verified leads reach a client's CRM. An unverified or
 * parked lead is not something their sales team should be calling.
 */
export function isSyncableLead(lead: SyncableLead): boolean {
  return lead.status === 'active' && lead.email_status === 'verified' && lead.email !== null
}
