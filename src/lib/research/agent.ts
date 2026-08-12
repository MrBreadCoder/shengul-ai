import { z } from 'zod'
import type { WebResearch, ResearchLead } from './provider'
import { buildResearchTools } from './tools'
import { generateWithTools, generateJson, type LlmCallContext } from '@/lib/llm/client'
import type { CompanyFirmographics } from '@/lib/apollo/format-company-summary'

// `stopWhen: isStepCount(GATHER_STEPS)` in runResearchAgent cuts the loop the
// instant this many steps complete, whether the last one was a tool call or
// a text response — a live test (2026-08-10 roadmap entry) found real
// research silently discarded when all steps went to search/scrape and none
// were left for the model to write its notes. Raised from 6 to 10 for
// headroom; see llm/client.ts's TOOL_LOOP_TIMEOUT_MS comment, which reasons
// about GATHER_STEPS's worst case and needs to stay in sync with this value.
const GATHER_STEPS = 10
// Bumped alongside the 'medium' thinking level below so extra reasoning tokens
// don't starve the actual notes output.
const GATHER_MAX_OUTPUT_TOKENS = 4_000
const EXTRACT_MAX_OUTPUT_TOKENS = 3_600
// Extraction is a constrained, schema-validated task (turn already-gathered
// notes into structured entries) — no open-ended reasoning or tool use, so it
// doesn't need the module default's full capability. Same pattern as
// ai-relevance.ts's AI_RELEVANCE_MODEL_ID. Runs on every agent call (company
// + each person), so this is a fixed cost cut across the whole pipeline —
// a live test (2026-08-10 roadmap entry) found prompt tokens, not output,
// dominate spend, and this doesn't touch the gather step where the real
// reasoning happens.
const EXTRACT_MODEL_ID = 'gemini-3.1-flash-lite'

export type ResearchAgentRole =
  | {
      kind: 'company'
      companyName: string
      companyDomain: string | null
      // Apollo's own org match — trusted background context for the agent
      // to build on. null when discovery never captured firmographics for
      // this lead.
      firmographics: CompanyFirmographics | null
    }
  | { kind: 'person'; lead: ResearchLead; companyName: string; companyDomain: string | null }

// Who the agent is researching *for* — the client running the campaign, not
// the subject being researched (that's ResearchAgentRole). Named `seller*`
// rather than `client*`/`company*` so it can never be confused with the
// research subject's own `companyName` field above. Without this the agent
// has no way to judge whether a fact it finds (a tuition discount, a
// personnel departure, a conference talk) has any bearing on what's being
// sold — it just ranks "newsiest" over "sells-relevant", which is how
// dossiers ended up citing facts with zero connection to the client's
// product as if they were personalization hooks (see .claude/roadmap.md
// 2026-08-12). All three fields are optional because a client can be
// missing `company_info` or a campaign's `value_prop` can theoretically be
// empty — the agent still researches, just with less to filter against.
export interface SellerContext {
  name: string | null
  companyInfo: string | null
  valueProp: string | null
}

const entrySchema = z.object({
  kind: z.enum(['company', 'person', 'news', 'pain_point']),
  content: z.string().min(1),
  sourceUrl: z.string().nullable(),
  citation: z.string().nullable(),
})
const extractionSchema = z.object({ entries: z.array(entrySchema) })

export type AgentDossierEntry = z.infer<typeof entrySchema>

const COMPANY_GATHER_SYSTEM = `You are a B2B sales research analyst building an accurate, source-grounded profile of one target company.

## Tools and limits
You have exactly two tools: search (returns web snippets) and scrape (returns the full text of one URL). That is all you have — no image or vision capability, no ZoomInfo/LinkedIn API, no proprietary database. If a fact, method, or observation did not come from a search result or a page you scraped this session, you do not have it — never write as though you "reviewed," "observed," or "saw" something (a photo, a video, a dashboard) that only search and scrape could not have produced.

## Research approach
Start with a short, broad query — company name and domain — read what comes back, then progressively narrow: ownership/funding, recent news, leadership, hiring activity, and public sentiment (reviews, complaints, local press). When a snippet looks promising, scrape the page instead of trusting a two-line summary. Favor primary sources — the company's own site, press releases, local news, regulatory or public filings — over SEO content farms and data-broker profile pages (RocketReach, ZoomInfo teasers, and similar), which frequently carry stale, rounded, or unsourced numbers; if you do use one, flag the number as unverified rather than stating it as fact.

## If you're given Apollo's own match for this company
This is Apollo's confirmed org match — trusted background, not something you need to spend a search step re-verifying. Use it directly to focus your research (industry and size tell you what angle to look for; location narrows which "Acme Hospital" you're reading about when a search turns up more than one). If something you find along the way plainly contradicts it, mention that in your notes, but don't go looking for problems with it.

## Grounding discipline
Before writing a fact down, trace it to the specific search result or scraped page that stated it. If you cannot point to that source, leave the fact out — do not guess, round, extrapolate, or fill a gap with something plausible. A shorter, fully-sourced set of notes beats a longer one with invented details.

## Who you're researching for
You'll be told, below, who you're researching this company on behalf of and what that seller sells. Use it to judge relevance: a fact only belongs in your notes as a personalization hook if it plausibly bears on whether this target company would want that seller's offering — an operational change, expansion, or event that touches the actual thing being sold. A fact can be true, recent, and "newsworthy" and still be irrelevant to this outreach (an unrelated tuition discount, an executive's award, a conference appearance with no bearing on the product) — note those only as plain background, never as your headline finding, and don't let them crowd out a smaller but genuinely relevant fact.

## When to stop
Stop once you have enough for a genuinely useful, differentiated profile — not everything you could theoretically find. Keep notes concise, and record the exact URL each fact came from next to the fact.`

const PERSON_GATHER_SYSTEM = `You are a B2B sales research analyst building a genuine outreach angle for one person.

## Tools and limits
You have exactly two tools: search (returns web snippets) and scrape (returns the full text of one URL). That is all you have — no image or vision capability, no ZoomInfo/LinkedIn API, no proprietary database. If a fact, method, or observation did not come from a search result or a page you scraped this session, you do not have it — never write as though you "reviewed," "observed," or "saw" something (a photo, a video, a post's image) that only search and scrape could not have produced.

## Research approach
Start with a short, broad query — the person's name and company — then narrow toward their own public activity: LinkedIn posts, X/Twitter, interviews, conference talks, or articles that quote them directly. The goal is something this specific person said or did recently — a genuine personalization hook — not a generic bio fact restated from a directory listing. Scrape a promising page instead of trusting a snippet.

## If you're given a known LinkedIn profile URL for this person
This is Apollo's own match for this person — scrape it first as your starting point and treat it as their page. Only fall back to a broader search if it plainly turns out to be someone else entirely.

## Grounding discipline
Before writing a fact down, trace it to the specific search result or scraped page that stated it. If you cannot point to that source, leave the fact out. Treat numeric or biographical claims from data-broker profile pages (RocketReach, ZoomInfo, and similar) as unverified unless a primary source corroborates them — carry that uncertainty into the note rather than presenting the claim as confirmed.

## Who you're researching for
You'll be told, below, who you're researching this person on behalf of and what that seller sells. Use it to judge relevance: the goal is a fact about this person's own activity that plausibly connects to whether their organization would want the seller's offering — not just any public detail about them. A genuinely personal fact with no bearing on that (an unrelated hobby, an award for something unconnected to the seller's product) is weaker than it looks; prefer a smaller but relevant fact over a bigger but unrelated one.

## When to stop
Stop once you have one or two genuinely sourced personalization hooks — not every fact you can find about this person. Keep notes concise, and record the exact URL each fact came from next to the fact.`

const EXTRACT_SYSTEM = `You convert research notes into discrete dossier entries. Use ONLY facts explicitly present in the notes — never add, round, infer, or "fill in" anything the notes do not state.

For every entry:
- sourceUrl must be the exact URL the fact came from. Use null only when the notes genuinely give no URL for that fact — never invent a citation label ("visual observation," "industry knowledge," a database name) to stand in for a missing URL.
- citation must name the actual source (the publication, page title, or similar) as it appears in the notes — never a description of a research method the agent could not have performed. The agent that wrote these notes had only web search and page scrape; nothing else exists to cite.
- If the notes flag a claim as uncertain, approximate, or sourced from an unverified data-broker page, keep that uncertainty visible in the entry's content — do not smooth it into a confirmed-sounding fact.
- Keep each entry to one or two sentences.

Classify each entry by kind: company (company facts), person (facts about the individual), news (recent events/announcements), pain_point (a problem or buying signal actually stated or directly evidenced in the notes — never inferred or invented to fit a sales narrative). Social posts are classified by their substance.

If the notes contain nothing usable, return an empty entries array — do not manufacture an entry to avoid returning one.`

// One line summarizing Apollo's org match, or null if discovery never
// captured firmographics for this lead — the prompt simply omits the section.
function formatFirmographicsLine(f: CompanyFirmographics): string | null {
  const parts: string[] = []
  if (f.industry) parts.push(`industry: ${f.industry}`)
  if (f.employeeCount !== null) parts.push(`~${f.employeeCount} employees`)
  if (f.foundedYear !== null) parts.push(`founded ${f.foundedYear}`)
  const location = [f.city, f.state, f.country].filter((part): part is string => !!part).join(', ')
  if (location) parts.push(`location: ${location}`)
  if (f.description) parts.push(`description: ${f.description}`)
  return parts.length > 0 ? parts.join('; ') : null
}

// Shared by both gather prompts — same section, same wording, so relevance
// judgment doesn't drift between the company and person research paths.
// Omits itself entirely when the seller has told us nothing at all (every
// field null), rather than emitting an empty "You are researching on
// behalf of:" line.
function sellerContextLine(seller: SellerContext): string | null {
  if (!seller.name && !seller.companyInfo && !seller.valueProp) return null
  const parts = [`You are researching this subject on behalf of ${seller.name ?? 'our client'}.`]
  if (seller.valueProp) parts.push(`What they sell: ${seller.valueProp}.`)
  if (seller.companyInfo) parts.push(`About them: ${seller.companyInfo}`)
  return parts.join(' ')
}

function companyGatherPrompt(role: Extract<ResearchAgentRole, { kind: 'company' }>, seller: SellerContext): string {
  const subject = `Company: ${role.companyName}${role.companyDomain ? ` (${role.companyDomain})` : ''}`
  const firmographicsLine = role.firmographics ? formatFirmographicsLine(role.firmographics) : null
  const applyContext = firmographicsLine
    ? `Apollo's own match for this company (background context — use it to focus your research): ${firmographicsLine}.`
    : null
  const instruction = 'Research this subject using the search and scrape tools, then write your research notes.'
  return [subject, sellerContextLine(seller), applyContext, instruction]
    .filter((line): line is string => line !== null)
    .join('\n\n')
}

function personGatherPrompt(role: Extract<ResearchAgentRole, { kind: 'person' }>, seller: SellerContext): string {
  const subject = `Person: ${role.lead.fullName}${role.lead.title ? `, ${role.lead.title}` : ''} at ${role.companyName}`
  const knownProfile = role.lead.linkedinUrl
    ? `Known LinkedIn profile from Apollo: ${role.lead.linkedinUrl} — start here.`
    : null
  const instruction = 'Research this subject using the search and scrape tools, then write your research notes.'
  return [subject, sellerContextLine(seller), knownProfile, instruction]
    .filter((line): line is string => line !== null)
    .join('\n\n')
}

function gatherPrompt(role: ResearchAgentRole, seller: SellerContext): string {
  return role.kind === 'company' ? companyGatherPrompt(role, seller) : personGatherPrompt(role, seller)
}

export async function runResearchAgent(
  context: LlmCallContext,
  deps: { research: WebResearch },
  args: { role: ResearchAgentRole; seller: SellerContext },
): Promise<AgentDossierEntry[]> {
  const { role, seller } = args
  const notes = await generateWithTools(context, {
    instructions: role.kind === 'company' ? COMPANY_GATHER_SYSTEM : PERSON_GATHER_SYSTEM,
    prompt: gatherPrompt(role, seller),
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
    modelId: EXTRACT_MODEL_ID,
  })
  return extracted.entries
}
