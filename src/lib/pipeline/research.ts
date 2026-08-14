import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { WebResearch, ResearchLead } from '@/lib/research/provider'
import { runResearchAgent, type ResearchAgentRole, type AgentDossierEntry, type SellerContext } from '@/lib/research/agent'
import { insertKnowledge, type KnowledgeInsert } from '@/lib/db/case-knowledge'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { logEventSafe, logWarn } from '@/lib/events/log-event'
import { publishJson } from '@/lib/qstash/client'
import { type LlmCallContext } from '@/lib/llm/client'
import { isAppError } from '@/lib/errors/app-error'
import type { CompanyFirmographics } from '@/lib/apollo/format-company-summary'
import { collectSocialKnowledge, type CompanySocialTarget } from '@/lib/pipeline/social-knowledge'

const ACTOR = 'research_agent'

export interface RunResearchInput {
  clientId: string
  caseId: string
  companyName: string
  companyDomain: string | null
  // Apollo's org match for this case, if discovery captured one — handed to
  // the company research agent as an unverified claim to check, not a fact.
  companyFirmographics: CompanyFirmographics | null
  companySocials: CompanySocialTarget
  leads: ResearchLead[]
  // Who the research is for and what they sell — passed straight through to
  // every agent call so it can judge fact relevance instead of just ranking
  // "newsiest." See SellerContext's own comment for why this regressed
  // dossiers before it existed.
  seller: SellerContext
}

export interface ResearchSummary {
  caseId: string
  knowledgeCount: number
}

// Unifies agent-produced entries (never attributed/dated) with social-scrape
// candidates (always attributed/dated) so toRows can map both through one path.
type KnowledgeCandidate = AgentDossierEntry & { leadId: string | null; eventDate: string | null }

// Person-level research disabled (2026-08-11): for our current ICP (school
// finance/business/procurement admin staff) the agent almost never finds a
// real hook about the *named* lead — no LinkedIn posts, interviews, or talks
// for this audience — and extraction has no way to tell "fact about the
// recipient" from "fact about whoever else I ran into scraping the site"
// (the principal, the CEO), so wrong-person bios were landing in the dossier
// indistinguishable from real personalization hooks. See roadmap 2026-08-11.
// Flip back to true once the person agent/extraction is fixed to tag facts
// with who they're about (or add a role-scoped-inference fallback) — the
// agent implementation itself (agent.ts's PERSON_GATHER_SYSTEM path) is left
// fully intact for that, not removed.
const ENABLE_PERSON_RESEARCH = false

function buildRoles(input: RunResearchInput): ResearchAgentRole[] {
  const company: ResearchAgentRole = {
    kind: 'company',
    companyName: input.companyName,
    companyDomain: input.companyDomain,
    firmographics: input.companyFirmographics,
  }
  if (!ENABLE_PERSON_RESEARCH) return [company]
  const people: ResearchAgentRole[] = input.leads.map((lead) => ({
    kind: 'person', lead, companyName: input.companyName, companyDomain: input.companyDomain,
  }))
  return [company, ...people]
}

function toRows(input: RunResearchInput, entries: KnowledgeCandidate[]): KnowledgeInsert[] {
  return entries.map((entry) => ({
    client_id: input.clientId,
    case_id: input.caseId,
    kind: entry.kind,
    content: entry.content,
    source_url: entry.sourceUrl,
    citation: entry.citation,
    created_by: 'agent',
    lead_id: entry.leadId,
    event_date: entry.eventDate,
  }))
}

async function logAgentFailure(
  input: RunResearchInput,
  role: ResearchAgentRole,
  reason: unknown,
): Promise<void> {
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.research.agent_failed',
    payload: {
      caseId: input.caseId,
      role: role.kind,
      leadName: role.kind === 'person' ? role.lead.fullName : null,
      errorCode: isAppError(reason) ? reason.code : 'EXTERNAL_ERROR',
    },
  })
}

// Runs one research agent per subject (company + each active lead) concurrently.
// A single agent failure is logged and dropped, not fatal: as long as one agent
// succeeds we ship the partial dossier and mark the case ready. If EVERY agent
// fails we leave the case in 'researching' so the stuck-case sweep retries it,
// rather than flipping to 'ready' with an empty (misleading) dossier.
export async function runResearchForCase(
  supabase: SupabaseClient<Database>,
  deps: { research: WebResearch },
  input: RunResearchInput,
): Promise<ResearchSummary> {
  const roles = buildRoles(input)
  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }

  const agentResults = await Promise.allSettled(
    roles.map((role) => runResearchAgent(context, deps, { role, seller: input.seller })),
  )
  const socialCandidates = await collectSocialKnowledge(
    { clientId: input.clientId, caseId: input.caseId },
    input.companySocials,
    input.leads.map((l) => ({ leadId: l.id, linkedinUrl: l.linkedinUrl, twitterUrl: l.twitterUrl })),
  )

  const entries: KnowledgeCandidate[] = socialCandidates.map((c) => ({ ...c }))
  let failed = 0
  for (let i = 0; i < agentResults.length; i += 1) {
    const result = agentResults[i]
    if (result && result.status === 'fulfilled') {
      entries.push(...result.value.map((e) => ({ ...e, leadId: null, eventDate: null })))
    } else if (result) {
      failed += 1
      // roles[i] is guaranteed to exist: agentResults has one entry per role.
      await logAgentFailure(input, roles[i]!, result.reason)
    }
  }

  // failed === roles.length alone would discard real social-only results —
  // the guard's actual intent is "don't mark ready with an empty/misleading
  // dossier," which social-only success doesn't violate.
  const allFailed = failed === roles.length && socialCandidates.length === 0
  if (allFailed) {
    await logEventSafe({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: ACTOR,
      type: 'pipeline.research.completed',
      payload: { caseId: input.caseId, knowledgeCount: 0, agentsFailed: failed },
    })
    return { caseId: input.caseId, knowledgeCount: 0 }
  }

  const inserted = await insertKnowledge(supabase, toRows(input, entries))
  await updateCaseStatus(supabase, input.caseId, 'ready')
  await enqueueCrmSync(input.caseId, 'qualified')

  // Trigger the writer immediately instead of waiting for the next
  // write-fanout tick (up to 5 minutes away) — same reasoning as the
  // research trigger in group-lead.ts. write/route.ts's own
  // `status !== 'ready'` claim-guard makes this safe to race against
  // write-fanout's periodic sweep, which stays in place unchanged as the
  // fallback for a failed publish below.
  try {
    await publishJson('/api/pipeline/write', { caseId: input.caseId })
  } catch (error) {
    await logWarn({
      clientId: input.clientId,
      caseId: input.caseId,
      actor: ACTOR,
      type: 'pipeline.write_trigger_failed',
      source: 'pipeline',
      error,
      payload: { caseId: input.caseId },
    })
  }

  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.research.completed',
    payload: { caseId: input.caseId, knowledgeCount: inserted.length, agentsFailed: failed },
  })
  return { caseId: input.caseId, knowledgeCount: inserted.length }
}
