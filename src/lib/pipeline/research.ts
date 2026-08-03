import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { WebResearch, ResearchLead } from '@/lib/research/provider'
import { runResearchAgent, type ResearchAgentRole, type AgentDossierEntry } from '@/lib/research/agent'
import { insertKnowledge, type KnowledgeInsert } from '@/lib/db/case-knowledge'
import { updateCaseStatus } from '@/lib/db/cases'
import { enqueueCrmSync } from '@/lib/crm/sync'
import { logEventSafe } from '@/lib/events/log-event'
import { type LlmCallContext } from '@/lib/llm/client'
import { isAppError } from '@/lib/errors/app-error'

const ACTOR = 'research_agent'

export interface RunResearchInput {
  clientId: string
  caseId: string
  companyName: string
  companyDomain: string | null
  valueProp: string | null
  leads: ResearchLead[]
}

export interface ResearchSummary {
  caseId: string
  knowledgeCount: number
}

function buildRoles(input: RunResearchInput): ResearchAgentRole[] {
  const company: ResearchAgentRole = {
    kind: 'company', companyName: input.companyName, companyDomain: input.companyDomain,
  }
  const people: ResearchAgentRole[] = input.leads.map((lead) => ({
    kind: 'person', lead, companyName: input.companyName, companyDomain: input.companyDomain,
  }))
  return [company, ...people]
}

function toRows(input: RunResearchInput, entries: AgentDossierEntry[]): KnowledgeInsert[] {
  return entries.map((entry) => ({
    client_id: input.clientId,
    case_id: input.caseId,
    kind: entry.kind,
    content: entry.content,
    source_url: entry.sourceUrl,
    citation: entry.citation,
    created_by: 'agent',
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

  const results = await Promise.allSettled(
    roles.map((role) => runResearchAgent(context, deps, { role, valueProp: input.valueProp })),
  )

  const entries: AgentDossierEntry[] = []
  let failed = 0
  for (let i = 0; i < results.length; i += 1) {
    const result = results[i]
    if (result && result.status === 'fulfilled') {
      entries.push(...result.value)
    } else if (result) {
      failed += 1
      // roles[i] is guaranteed to exist: results has one entry per role.
      await logAgentFailure(input, roles[i]!, result.reason)
    }
  }

  const allFailed = failed === roles.length
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
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId,
    actor: ACTOR,
    type: 'pipeline.research.completed',
    payload: { caseId: input.caseId, knowledgeCount: inserted.length, agentsFailed: failed },
  })
  return { caseId: input.caseId, knowledgeCount: inserted.length }
}
