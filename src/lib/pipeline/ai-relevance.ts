import { z } from 'zod'
import { generateJson, type LlmCallContext } from '@/lib/llm/client'
import type { CompanyFirmographics } from '@/lib/apollo/format-company-summary'

// A lighter/cheaper model than the pipeline's shared default
// (gemini-3-flash-preview, see src/lib/llm/client.ts) — this check can run
// once per distinct new company on every active campaign's every discovery
// run, and a single yes/no classification doesn't need the default model's
// full capability.
const AI_RELEVANCE_MODEL_ID = 'gemini-3.1-flash-lite'

// The schema is tiny (a bool + a short reason), so a small ceiling keeps
// latency down without risking truncation.
const MAX_OUTPUT_TOKENS = 200
const REASON_MAX_LENGTH = 300

export interface RelevanceVerdict {
  pass: boolean
  reason: string
}

export interface CompanySnapshot extends CompanyFirmographics {
  companyName: string | null
  companyDomain: string | null
}

// Narrow view of a campaign this module needs — deliberately not
// CampaignForDiscovery (defined in ./discover) to avoid a circular import
// between the two pipeline modules.
export interface CampaignRelevanceContext {
  name: string
  valueProp: string | null
  keywords: string[]
  excludeKeywords: string[]
}

const relevanceVerdictSchema = z.object({
  pass: z.boolean(),
  reason: z.string().min(1).max(REASON_MAX_LENGTH),
})

const INSTRUCTIONS = [
  'You are a lead-qualification judge for a B2B outreach campaign.',
  "Given the campaign's target description and one company's firmographics,",
  'decide whether this company is a genuine, relevant prospect for the',
  'campaign — not a wrong-industry, wrong-business-type, or clearly-unrelated',
  'match. Reject only when the mismatch is clear from the given data. When',
  'the data is ambiguous or incomplete, pass.',
].join(' ')

function formatField(label: string, value: string | number | null): string | null {
  if (value === null) return null
  return `${label}: ${value}`
}

function buildPrompt(campaign: CampaignRelevanceContext, company: CompanySnapshot): string {
  const campaignLines = [
    `Campaign name: ${campaign.name}`,
    formatField('Value proposition', campaign.valueProp),
    campaign.keywords.length > 0 ? `Target keywords: ${campaign.keywords.join(', ')}` : null,
    campaign.excludeKeywords.length > 0 ? `Excluded keywords: ${campaign.excludeKeywords.join(', ')}` : null,
  ].filter((line): line is string => line !== null)

  const companyLines = [
    `Company name: ${company.companyName ?? 'Unknown'}`,
    formatField('Domain', company.companyDomain),
    formatField('Industry', company.industry),
    formatField('Employee count', company.employeeCount),
    formatField('Founded year', company.foundedYear),
    formatField('Description', company.description),
    formatField('City', company.city),
    formatField('State', company.state),
    formatField('Country', company.country),
  ].filter((line): line is string => line !== null)

  return [
    'Campaign:',
    ...campaignLines,
    '',
    'Company:',
    ...companyLines,
    '',
    'Is this company a relevant prospect for this campaign?',
  ].join('\n')
}

/**
 * Judges whether one company is a relevant prospect for a campaign, given the
 * campaign's own targeting fields and the company's Apollo firmographics.
 * Company-level only — deliberately does not take a lead's title, so the
 * caller can cache one verdict per company and reuse it for every contact
 * discovered there in the same run (see src/lib/pipeline/discover.ts).
 */
export async function checkCompanyRelevance(
  context: LlmCallContext,
  campaign: CampaignRelevanceContext,
  company: CompanySnapshot,
): Promise<RelevanceVerdict> {
  return generateJson(context, {
    instructions: INSTRUCTIONS,
    prompt: buildPrompt(campaign, company),
    schema: relevanceVerdictSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    modelId: AI_RELEVANCE_MODEL_ID,
  })
}
