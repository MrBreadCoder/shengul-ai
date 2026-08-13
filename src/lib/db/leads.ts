import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type LeadRow = Database['public']['Tables']['leads']['Row']
export type LeadInsert = Database['public']['Tables']['leads']['Insert']

export async function getKnownSourceIds(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<Set<string>> {
  const { data, error } = await supabase
    .from('leads')
    .select('source_id')
    .eq('client_id', clientId)
    .not('source_id', 'is', null)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load known lead source ids', { clientId, cause: error.message })
  }
  return new Set((data ?? []).map((r) => r.source_id).filter((v): v is string => v !== null))
}

export interface LeadCompanyRef {
  companyDomain: string | null
  companyName: string | null
}

// Used by discovery (src/lib/pipeline/discover.ts) to see which companies
// already have a verified, ACTIVE lead for a campaign — across all days,
// not just today's run — so the depth phase knows which companies to go
// back to for a second contact. Filters on `status`, not `email_status`:
// a row Apollo marked `verified` but that was later parked (suppressed,
// post-enrich excluded, or AI-rejected) must not count as "this company
// has a verified lead" — it was never grouped into a case.
export async function getVerifiedLeadCompanies(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<LeadCompanyRef[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('company_domain, company_name')
    .eq('campaign_id', campaignId)
    .eq('status', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load verified lead companies', { campaignId, cause: error.message })
  }
  return (data ?? []).map((r) => ({ companyDomain: r.company_domain, companyName: r.company_name }))
}

// Upsert with ignoreDuplicates so a QStash retry of /api/pipeline/discover is
// idempotent: rows already present for (campaign_id, source_id) are silently
// skipped and never appear in the returned array (Postgres INSERT ... ON
// CONFLICT DO NOTHING RETURNING * semantics).
export async function insertLeads(
  supabase: SupabaseClient<Database>,
  rows: LeadInsert[],
): Promise<LeadRow[]> {
  if (rows.length === 0) return []
  const { data, error } = await supabase
    .from('leads')
    .upsert(rows, { onConflict: 'campaign_id,source_id', ignoreDuplicates: true })
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert leads', { count: rows.length, cause: error.message })
  }
  return data ?? []
}

export async function updateLeadCase(
  supabase: SupabaseClient<Database>,
  leadId: string,
  caseId: string,
): Promise<void> {
  const { error } = await supabase
    .from('leads')
    .update({ case_id: caseId, status: 'active' })
    .eq('id', leadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to attach lead to case', { leadId, caseId, cause: error.message })
  }
}

export async function getLeadById(
  supabase: SupabaseClient<Database>,
  leadId: string,
): Promise<LeadRow | null> {
  const { data, error } = await supabase.from('leads').select('*').eq('id', leadId).maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load lead', { leadId, cause: error.message })
  }
  return data
}

// The lead an inbound reply belongs to. Sender-address matching is provider-
// agnostic (Outlook synthesizes outbound thread ids, so thread matching is
// unreliable there), so this is scoped to case-attached leads for this client
// at that address AND requires actual outbound-contact evidence — a sent
// email to that lead through the mailbox that received the reply. A case_id
// alone doesn't prove we ever emailed them (e.g. human_approve mode with a
// draft still pending). If more than one case-attached lead has that
// evidence, the match is ambiguous and we fail closed (null) rather than
// guess by picking the newest — misattributing a reply to the wrong case is
// worse than dropping it.
export async function findContactedLeadByEmail(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
  mailboxId: string,
): Promise<LeadRow | null> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('client_id', clientId)
    .eq('email', email)
    .not('case_id', 'is', null)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to find contacted lead by email', { clientId, cause: error.message })
  }
  const candidates = data ?? []
  if (candidates.length === 0) return null

  const { data: sent, error: sentError } = await supabase
    .from('emails')
    .select('lead_id')
    .in('lead_id', candidates.map((c) => c.id))
    .eq('direction', 'outbound')
    .eq('status', 'sent')
    .eq('mailbox_id', mailboxId)
  if (sentError) {
    throw new AppError('DB_ERROR', 'Failed to verify outbound contact for lead match', { clientId, cause: sentError.message })
  }
  const contactedIds = new Set((sent ?? []).map((e) => e.lead_id))
  const contacted = candidates.filter((c) => contactedIds.has(c.id))
  return contacted.length === 1 ? contacted[0]! : null
}

// Send-eligible, case-attached leads for a case — the people we are allowed
// to email. Filters on `status` alone, not `email_status`: `status = 'active'`
// is the single send-eligibility signal set by the discovery/verification
// pipeline (see getVerifiedLeadCompanies and listOtherActiveLeadsForCollisionNotice
// above, which already rely on this). Emailable's accept-all catch-all
// carve-out (src/lib/emailable/map-verification.ts) activates a lead while
// deliberately leaving email_status at 'risky' for audit/tracking — an
// additional `email_status = 'verified'` filter here would silently strand
// every carve-out-activated lead, never emailing it despite `status: 'active'`.
export async function listActiveLeadsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<LeadRow[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('case_id', caseId)
    .eq('status', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list active leads for case', { caseId, cause: error.message })
  }
  return data ?? []
}

// Takes a lead out of every send path without deleting it: parked leads are
// excluded by listActiveLeadsForCase. Used by the hard-bounce handler and the
// per-lead stop control.
export async function parkLead(supabase: SupabaseClient<Database>, leadId: string): Promise<void> {
  const { error } = await supabase.from('leads').update({ status: 'parked' }).eq('id', leadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to park lead', { leadId, cause: error.message })
  }
}

// Blast-radius count for the campaign delete confirmation dialog — a head
// count avoids fetching every lead row just to show a number.
export async function countLeadsForCampaign(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count leads for campaign', { campaignId, cause: error.message })
  }
  return count ?? 0
}

// Every lead attached to a case regardless of status, for the case detail view.
// Distinct from listActiveLeadsForCase, which is the send-eligible subset.
export async function listLeadsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<LeadRow[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list leads for case', { caseId, cause: error.message })
  }
  return data ?? []
}

// Fan-out target list for the meeting collision notice: every other contact
// at this case's company who is still on a fully untouched sequence. A lead
// whose own sequence is already paused/stopped has replied on their own
// thread and is deliberately excluded — only silent contacts get the notice.
export async function listOtherActiveLeadsForCollisionNotice(
  supabase: SupabaseClient<Database>,
  caseId: string,
  excludeLeadId: string,
): Promise<LeadRow[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('*')
    .eq('case_id', caseId)
    .eq('status', 'active')
    .neq('id', excludeLeadId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list other active leads for collision notice', {
      caseId, excludeLeadId, cause: error.message,
    })
  }
  const candidates = data ?? []
  if (candidates.length === 0) return []

  const { data: activeSequences, error: seqError } = await supabase
    .from('sequences')
    .select('lead_id')
    .in('lead_id', candidates.map((c) => c.id))
    .eq('state', 'active')
  if (seqError) {
    throw new AppError('DB_ERROR', 'Failed to check sequence state for collision notice candidates', {
      caseId, cause: seqError.message,
    })
  }
  const untouchedIds = new Set((activeSequences ?? []).map((s) => s.lead_id))
  return candidates.filter((c) => untouchedIds.has(c.id))
}

export interface RecentLeadForClient {
  id: string
  fullName: string
  title: string | null
  companyName: string | null
  companyDomain: string | null
  status: Database['public']['Enums']['lead_status']
  emailStatus: Database['public']['Enums']['lead_email_status']
  caseId: string | null
  createdAt: string
}

// RLS-scoped: pass a session-bound server client so a client role only sees
// its own leads. Used by /home's "Latest leads found" widget — newest first,
// capped by the caller. Filters on `status`, not `email_status` — same
// reasoning as getVerifiedLeadCompanies above: a row Apollo marked
// 'verified' but that we later parked (AI-rejected, suppressed, excluded,
// or redacted-org) must never be shown to the client as a found lead, even
// though its email_status pill would still read "Verified".
export async function listRecentLeadsForClient(
  supabase: SupabaseClient<Database>,
  { limit }: { limit: number },
): Promise<RecentLeadForClient[]> {
  const { data, error } = await supabase
    .from('leads')
    .select('id, full_name, title, company_name, company_domain, status, email_status, case_id, created_at')
    .eq('status', 'active')
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list recent leads for client', { limit, cause: error.message })
  }
  return (data ?? []).map((row) => ({
    id: row.id,
    fullName: row.full_name,
    title: row.title,
    companyName: row.company_name,
    companyDomain: row.company_domain,
    status: row.status,
    emailStatus: row.email_status,
    caseId: row.case_id,
    createdAt: row.created_at,
  }))
}
