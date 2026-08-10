import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database, Json } from '@/types/database'
import { normalizeCompanyName } from './company-key'
import { findOrCreateCase } from '@/lib/db/cases'
import { updateLeadCase } from '@/lib/db/leads'
import { insertCompanyKnowledgeIfMissing } from '@/lib/db/case-knowledge'
import { formatCompanySummary, parseCompanyFirmographicsFromRaw } from '@/lib/apollo/format-company-summary'
import { logEvent, logWarn } from '@/lib/events/log-event'

export function computeCompanyKey(domain: string | null, companyName: string | null): string {
  if (domain) return domain.toLowerCase().trim()
  return normalizeCompanyName(companyName ?? '')
}

export interface LeadToGroup {
  id: string
  clientId: string
  campaignId: string
  companyName: string | null
  companyDomain: string | null
  raw: Json
}

// Stage 2 (.claude/architecture.md §6): a verified lead activates a case for its
// company. Unverified/not-found leads are inserted (Task 11) but stay
// unattached (case_id null) until a verified person for the same company
// arrives — this function is only ever called for verified leads.
export async function groupVerifiedLead(
  supabase: SupabaseClient<Database>,
  lead: LeadToGroup,
): Promise<string> {
  const companyName = lead.companyName?.trim() || lead.companyDomain || 'Unknown company'
  const companyKey = computeCompanyKey(lead.companyDomain, lead.companyName)

  const kase = await findOrCreateCase(supabase, {
    clientId: lead.clientId,
    campaignId: lead.campaignId,
    companyName,
    companyDomain: lead.companyDomain,
    companyKey,
  })
  await updateLeadCase(supabase, lead.id, kase.id)

  const firmographics = parseCompanyFirmographicsFromRaw(lead.raw)
  const summary = firmographics ? formatCompanySummary(companyName, firmographics) : null
  if (summary) {
    try {
      await insertCompanyKnowledgeIfMissing(supabase, {
        clientId: lead.clientId,
        caseId: kase.id,
        content: summary,
        sourceUrl: lead.companyDomain ? `https://${lead.companyDomain}` : null,
      })
    } catch (error) {
      // Isolated on purpose: a company-knowledge write failure must never
      // turn an already-successful case grouping into a failed pipeline run.
      await logWarn({
        clientId: lead.clientId,
        caseId: kase.id,
        actor: 'system',
        type: 'pipeline.company_knowledge_failed',
        source: 'pipeline',
        error,
        payload: { leadId: lead.id },
      })
    }
  }

  try {
    await logEvent({
      clientId: lead.clientId,
      caseId: kase.id,
      actor: 'system',
      type: 'pipeline.lead_grouped',
      payload: { leadId: lead.id, caseId: kase.id, companyKey },
    })
  } catch {
    // Audit logging is best-effort — it must not turn an already-completed
    // grouping (case created, lead attached) into a rejected operation.
  }
  return kase.id
}
