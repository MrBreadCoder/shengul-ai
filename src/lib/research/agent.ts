import { z } from 'zod'
import type { WebResearch, ResearchLead } from './provider'
import { buildResearchTools } from './tools'
import { generateWithTools, generateJson, type LlmCallContext } from '@/lib/llm/client'

const GATHER_STEPS = 6
// Bumped alongside the 'medium' thinking level below so extra reasoning tokens
// don't starve the actual notes output.
const GATHER_MAX_OUTPUT_TOKENS = 4_000
const EXTRACT_MAX_OUTPUT_TOKENS = 3_600

export type ResearchAgentRole =
  | { kind: 'company'; companyName: string; companyDomain: string | null }
  | { kind: 'person'; lead: ResearchLead; companyName: string; companyDomain: string | null }

const entrySchema = z.object({
  kind: z.enum(['company', 'person', 'news', 'pain_point']),
  content: z.string().min(1),
  sourceUrl: z.string().nullable(),
  citation: z.string().nullable(),
})
const extractionSchema = z.object({ entries: z.array(entrySchema) })

export type AgentDossierEntry = z.infer<typeof entrySchema>

const COMPANY_GATHER_SYSTEM = [
  'You are a B2B sales research analyst gathering facts about a target company.',
  'Use the search tool to find: what the company does, size/industry, recent news',
  'or funding, its LinkedIn/X presence and recent posts, hiring/careers pages',
  '(growth or pain signals), and public reviews or complaints (G2, Glassdoor).',
  'When a snippet looks promising, use the scrape tool to read the full page',
  'instead of trusting a two-line snippet. Keep notes concise and cite the URL',
  'each fact came from. Do not invent facts.',
].join(' ')

const PERSON_GATHER_SYSTEM = [
  'You are a B2B sales research analyst gathering an outreach angle for one person.',
  'Use the search tool to find their role/background and, above all, recent public',
  'activity: LinkedIn posts, X/Twitter, interviews, conference talks, or articles',
  'quoting them. Look for something this specific person said or did recently — a',
  'genuine personalization hook, not generic bio facts. Use the scrape tool to read',
  'a promising page in full. Keep notes concise and cite the URL each fact came',
  'from. Do not invent facts.',
].join(' ')

const EXTRACT_SYSTEM = [
  'You convert research notes into discrete dossier entries.',
  'Use ONLY facts present in the notes. Never invent anything.',
  'For every entry set sourceUrl to the URL the fact came from, or null if the',
  'notes give no single source. Keep each entry to one or two sentences.',
  'Classify each entry by kind: company (company facts), person (facts about the',
  'individual), news (recent events/announcements), pain_point (a problem or',
  'buying signal). Social posts are classified by their substance.',
].join(' ')

function seedQuery(role: ResearchAgentRole): string {
  if (role.kind === 'company') {
    return role.companyDomain
      ? `${role.companyName} ${role.companyDomain} news funding`
      : `${role.companyName} company news funding`
  }
  return `${role.lead.fullName} ${role.companyName} linkedin`
}

function gatherPrompt(role: ResearchAgentRole, valueProp: string | null): string {
  const subject =
    role.kind === 'company'
      ? `Company: ${role.companyName}${role.companyDomain ? ` (${role.companyDomain})` : ''}`
      : `Person: ${role.lead.fullName}${role.lead.title ? `, ${role.lead.title}` : ''} at ${role.companyName}`
  return [
    subject,
    `Our value proposition to them: ${valueProp ?? 'n/a'}`,
    `Start by searching: ${seedQuery(role)}`,
    'Gather the most useful facts, then write your research notes.',
  ].join('\n\n')
}

export async function runResearchAgent(
  context: LlmCallContext,
  deps: { research: WebResearch },
  args: { role: ResearchAgentRole; valueProp: string | null },
): Promise<AgentDossierEntry[]> {
  const { role, valueProp } = args
  const notes = await generateWithTools(context, {
    instructions: role.kind === 'company' ? COMPANY_GATHER_SYSTEM : PERSON_GATHER_SYSTEM,
    prompt: gatherPrompt(role, valueProp),
    tools: buildResearchTools(deps, context),
    maxSteps: GATHER_STEPS,
    maxOutputTokens: GATHER_MAX_OUTPUT_TOKENS,
    // Deciding what to search/scrape next and judging which facts are a genuine
    // personalization hook benefits from deeper reasoning than extraction does.
    thinkingLevel: 'medium',
  })

  const extracted = await generateJson(context, {
    instructions: EXTRACT_SYSTEM,
    prompt: `Research notes:\n${notes}\n\nExtract the dossier entries.`,
    schema: extractionSchema,
    maxOutputTokens: EXTRACT_MAX_OUTPUT_TOKENS,
  })
  return extracted.entries
}
