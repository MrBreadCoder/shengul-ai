# Design: Person + Company Social Scraping (LinkedIn/X via Apollo + Bright Data)

**Status:** Approved for planning.

## Problem

The email-writing pipeline (`src/lib/pipeline/write.ts`) already ranks dated, specific facts (`news`, `pain_point`) above generic firmographics when building an opener — but nothing in the system today produces genuinely fresh, per-lead facts:

1. **Apollo already sends social/growth data we discard.** `src/lib/apollo/client.ts`'s `organizationSchema` and `enrichedPersonSchema` only capture a narrow field subset. Confirmed live against our own account (2026-08-14, `credits_consumed: 1` — no extra cost): Apollo's real response includes `twitter_url`/`github_url`/`facebook_url` on the person and `linkedin_url`/`twitter_url`/`facebook_url`/`crunchbase_url`/`angellist_url`/headcount-growth/revenue on the organization, all silently dropped by Zod today because these schemas have no `.passthrough()` gap to exploit — they're just too narrow.
2. **Person-level research is disabled, and re-enabling the old path doesn't fix why.** `ENABLE_PERSON_RESEARCH = false` (`src/lib/pipeline/research.ts:48`) was set 2026-08-11 because the open-web search agent (`PERSON_GATHER_SYSTEM` in `src/lib/research/agent.ts`) would run into *other* people at the target company while scraping (the CEO, the Principal) and extract real facts about them tagged generically as `kind: 'person'` — with nothing in `case_knowledge` recording *whose* fact it was. `write.ts:281-288` then hands every case's full knowledge set to every lead's prompt unfiltered, so a wrong-person fact was one dossier generation away from reading as if it were about the actual recipient. This design does not re-enable that path.
3. **No source produces genuinely dated facts.** `case_knowledge` has no `event_date` column — a fact from 14 months ago and one from yesterday are indistinguishable to `write.ts` today.

Live-tested 2026-08-14 against Bright Data's Datasets v3 API (same `BRIGHTDATA_API_KEY` already configured — no new credential): LinkedIn person-post discovery (~49s, real dated posts back to 2022, most recent ~5 months old for the test profile) and X person-post discovery (~30s, clean, most recent post from *the previous day*) both work and both source directly from a URL Apollo already matched to that specific person or company — meaning the fact's provenance *is* the identity proof, structurally avoiding the wrong-person failure mode in (2) rather than patching around it. Facebook was also tested (`gd_lkaxegm826bjpoo9m5`, page-URL based): 18 minutes, 1,508 records for one page, and confirmed via Bright Data's own support assistant to have **no** date-range or result-count bounding parameters at all — structurally unsuited to this use case, not merely slow.

## Scope decisions (from brainstorming)

- **Facebook excluded entirely** — no bounding parameters exist on the dataset (confirmed with Bright Data support), so "last N posts" would require fetching full history every time. Revisit only if Bright Data ships a bounded mode.
- **`ENABLE_PERSON_RESEARCH` stays `false`, untouched.** This is a structurally separate acquisition path, not a fix to the disabled agent.
- **Scrape LinkedIn always (Apollo-verified URL), X only when Apollo provides one** — never search/guess a handle. Preserves "URL from Apollo is the identity proof" for both platforms.
- **Every active lead in a case gets scraped**, not just the primary contact — cost scales with the campaign's existing `contactsPerCompany` setting, which operators already control as a volume knob.
- **Storage: extend `case_knowledge` in place** with `lead_id` (nullable) and `event_date` (nullable), rather than a parallel table — matches the existing `case_id`-required/`lead_id`-optional precedent already used by the `emails` table (`0001_initial_schema.sql:113-114`).
- **Recency: hard-discard posts older than 90 days** at storage time (not deprioritize-and-keep). Never stored past the cutoff.
- **Runs at research time, per case** (`runResearchForCase`), not during discovery/enrichment — avoids spending Bright Data credits on candidates later filtered out by exclude-keywords/AI-relevance/deliverability checks.
- **This round is acquisition + the minimal consumption fix required to make it safe to ship** (the `write.ts` `lead_id` filter). Deeper consumption logic — surfacing growth-metrics as a fact type, recency-weighted ranking in the dossier, richer prompt engineering — is explicitly deferred to a follow-up round.

## 1. Apollo schema widening

`src/lib/apollo/client.ts` — widen `organizationSchema` and `enrichedPersonSchema`. Growth-metric values confirmed live as fractional rates (`0.0` = 0%, not a percentage-as-integer):

```ts
const organizationSchema = z.object({
  name: z.string().nullable().optional(),
  primary_domain: z.string().nullable().optional(),
  website_url: z.string().nullable().optional(),
  industry: z.string().nullable().optional(),
  estimated_num_employees: z.number().nullable().optional(),
  founded_year: z.number().nullable().optional(),
  short_description: z.string().nullable().optional(),
  city: z.string().nullable().optional(),
  state: z.string().nullable().optional(),
  country: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  facebook_url: z.string().nullable().optional(),
  crunchbase_url: z.string().nullable().optional(),
  angellist_url: z.string().nullable().optional(),
  organization_revenue: z.number().nullable().optional(),
  organization_headcount_six_month_growth: z.number().nullable().optional(),
  organization_headcount_twelve_month_growth: z.number().nullable().optional(),
  organization_headcount_twenty_four_month_growth: z.number().nullable().optional(),
}).nullable().optional()
```

```ts
const searchPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  last_name_obfuscated: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  organization: organizationSchema,
}).passthrough()
```

```ts
const enrichedPersonSchema = z.object({
  id: z.string(),
  first_name: z.string().nullable().optional(),
  last_name: z.string().nullable().optional(),
  title: z.string().nullable().optional(),
  linkedin_url: z.string().nullable().optional(),
  twitter_url: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
  email_status: z.string().nullable().optional(),
  contact_emails: z.array(z.object({
    email: z.string().nullable().optional(),
    email_status: z.string().nullable().optional(),
  })).optional(),
  organization: organizationSchema,
}).passthrough()
```

`github_url`/`facebook_url` on the person are deliberately **not** added — nothing in this design consumes them (no GitHub/Facebook person-scraping exists), and QUALITY.md's "no over-abstraction" argues against capturing fields with no reader. `twitter_url` is added because it's consumed in §4 below.

`bulkMatchPeople`'s mapping gains one line: `twitterUrl: p.twitter_url ?? null,` alongside the existing `linkedinUrl: p.linkedin_url ?? null,`. `searchPeople`'s mapping gains the same for `ApolloSearchCandidate`.

`src/lib/apollo/types.ts`:

```ts
export interface ApolloSearchCandidate {
  apolloId: string
  firstName: string
  lastNamePreview: string | null
  title: string | null
  organizationName: string | null
  organizationDomain: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
}

export interface ApolloEnrichedPerson {
  apolloId: string
  firstName: string | null
  lastName: string | null
  title: string | null
  email: string | null
  emailStatus: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
  organizationName: string | null
  organizationDomain: string | null
  organizationIndustry: string | null
  organizationEmployeeCount: number | null
  organizationFoundedYear: number | null
  organizationDescription: string | null
  organizationCity: string | null
  organizationState: string | null
  organizationCountry: string | null
  organizationLinkedinUrl: string | null
  organizationTwitterUrl: string | null
  organizationRevenue: number | null
  organizationHeadcountGrowth6Month: number | null
  organizationHeadcountGrowth12Month: number | null
  organizationHeadcountGrowth24Month: number | null
}
```

(`crunchbase_url`/`angellist_url`/`facebook_url` on the org: captured by the widened Zod schema so they survive into `leads.raw` via `.passthrough()`-adjacent full-object spread in `discover.ts:656`, but intentionally **not** promoted to named `ApolloEnrichedPerson` fields — nothing reads them yet either. `organizationLinkedinUrl`/`organizationTwitterUrl`/`organizationRevenue`/growth fields *are* promoted because §4 and a future consumption round need them by name, not just present-in-raw-JSON.)

`bulkMatchPeople`'s per-person mapping gains:

```ts
organizationLinkedinUrl: p.organization?.linkedin_url ?? null,
organizationTwitterUrl: p.organization?.twitter_url ?? null,
organizationRevenue: p.organization?.organization_revenue ?? null,
organizationHeadcountGrowth6Month: p.organization?.organization_headcount_six_month_growth ?? null,
organizationHeadcountGrowth12Month: p.organization?.organization_headcount_twelve_month_growth ?? null,
organizationHeadcountGrowth24Month: p.organization?.organization_headcount_twenty_four_month_growth ?? null,
```

No changes needed to `src/lib/env.ts` or credit spend anywhere in this section — confirmed live, `credits_consumed: 1` for a call returning every one of these fields.

## 2. DB migration — attribution + recency on `case_knowledge`

New `supabase/migrations/0044_case_knowledge_attribution.sql`:

```sql
-- Fixes the root cause behind the 2026-08-11 person-research attribution bug
-- (.claude/roadmap.md same date): case_knowledge had no way to record *whose*
-- a person-kind fact was, so write.ts handed every case's full knowledge set
-- to every lead's prompt unfiltered. lead_id is null for company-level facts,
-- set for person-level facts. event_date supports a hard recency cutoff for
-- dated facts (e.g. scraped social posts) — null for evergreen firmographics.
-- See docs/superpowers/specs/2026-08-14-social-scraping-design.md.
alter table case_knowledge add column lead_id    uuid references leads(id) on delete set null;
alter table case_knowledge add column event_date timestamptz;

create index case_knowledge_lead_id_idx on case_knowledge(lead_id) where lead_id is not null;
```

No RLS changes — `case_knowledge`'s existing policies (`0002_rls_policies.sql:36-41`) key entirely off `client_id`, unaffected by additive nullable columns.

`src/types/database.ts` (hand-authored) — `case_knowledge`'s `Row`/`Insert`/`Update` gain:

```ts
lead_id: string | null
event_date: string | null
```

(`Insert` keeps both optional/nullable, matching every other nullable column's existing convention in this file.)

## 3. Bright Data social-scrape client (new module)

New `src/lib/research/social-scrape.ts` — thin, deterministic client for Bright Data's Datasets v3 API. Deliberately separate from `src/lib/research/brightdata.ts` (Web Unlocker/SERP, zone-scoped) — this API is dataset-scoped and reuses the same `BRIGHTDATA_API_KEY` as a bearer token with no zone at all, confirmed live 2026-08-14.

```ts
import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'

const DATASETS_BASE_URL = 'https://api.brightdata.com/datasets/v3'

// dataset_ids confirmed live against our own account 2026-08-14 — see
// docs/superpowers/specs/2026-08-14-social-scraping-design.md.
const LINKEDIN_POSTS_DATASET_ID = 'gd_lyy3tktm25m4avu764'
const X_POSTS_DATASET_ID = 'gd_lwxkxvnf1cynvib9co'

function authHeaders(): Record<string, string> {
  return { Authorization: `Bearer ${env.BRIGHTDATA_API_KEY}`, 'Content-Type': 'application/json' }
}

// Live testing 2026-08-14: LinkedIn ~49s, X ~30s for a single-profile
// discovery job. 180s leaves real headroom while still failing loudly
// instead of tying up a research task indefinitely — see QUALITY.md
// "timeout every external call."
const POLL_TIMEOUT_MS = 180_000
const POLL_INTERVAL_MS = 5_000

const triggerResponseSchema = z.object({ snapshot_id: z.string() })

const progressResponseSchema = z.object({
  status: z.enum(['starting', 'running', 'ready', 'failed']),
  snapshot_id: z.string(),
})

export interface ScrapedPost {
  url: string
  text: string | null
  datePosted: string | null
}

// LinkedIn's text field is post_text; X's is description — accept either
// rather than guess, same pattern as apollo/client.ts's bulkMatchResponseSchema
// comment on matches-vs-people.
const postRecordSchema = z.object({
  url: z.string(),
  post_text: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  date_posted: z.string().nullable().optional(),
  error: z.string().optional(),
}).passthrough()

const snapshotResponseSchema = z.array(postRecordSchema)

async function triggerDiscovery(
  datasetId: string,
  discoverParams: Record<string, string>,
  profileUrl: string,
  extraInput: Record<string, unknown>,
): Promise<string> {
  const query = new URLSearchParams({ dataset_id: datasetId, ...discoverParams }).toString()
  const res = await fetchJson(
    `${DATASETS_BASE_URL}/trigger?${query}`,
    { method: 'POST', headers: authHeaders(), body: JSON.stringify({ input: [{ url: profileUrl, ...extraInput }] }) },
    triggerResponseSchema,
  )
  return res.snapshot_id
}

async function pollUntilReady(snapshotId: string): Promise<void> {
  const deadline = Date.now() + POLL_TIMEOUT_MS
  while (Date.now() < deadline) {
    const res = await fetchJson(
      `${DATASETS_BASE_URL}/progress/${snapshotId}`,
      { method: 'GET', headers: authHeaders() },
      progressResponseSchema,
    )
    if (res.status === 'ready') return
    if (res.status === 'failed') {
      throw new AppError('EXTERNAL_ERROR', 'Bright Data social scrape job failed', { snapshotId })
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
  }
  throw new AppError('EXTERNAL_TIMEOUT', 'Bright Data social scrape job did not finish in time', {
    snapshotId, timeoutMs: POLL_TIMEOUT_MS,
  })
}

async function downloadSnapshot(snapshotId: string): Promise<ScrapedPost[]> {
  const records = await fetchJson(
    `${DATASETS_BASE_URL}/snapshot/${snapshotId}?format=json`,
    { method: 'GET', headers: authHeaders() },
    snapshotResponseSchema,
  )
  // Bright Data reports per-record failures (e.g. a "Signup blocking page"
  // wall on one post) inline inside an otherwise-successful batch rather than
  // failing the whole job — confirmed live 2026-08-14. Drop only those rows.
  return records
    .filter((r) => !r.error)
    .map((r) => ({ url: r.url, text: r.post_text ?? r.description ?? null, datePosted: r.date_posted ?? null }))
}

async function discoverPosts(
  datasetId: string,
  discoverParams: Record<string, string>,
  profileUrl: string,
  extraInput: Record<string, unknown> = {},
): Promise<ScrapedPost[]> {
  const snapshotId = await triggerDiscovery(datasetId, discoverParams, profileUrl, extraInput)
  await pollUntilReady(snapshotId)
  return downloadSnapshot(snapshotId)
}

/**
 * Posts authored by a specific person, via their Apollo-verified LinkedIn
 * URL. `only_authored_posts: true` is load-bearing — live testing 2026-08-14
 * found the default (false) surfaces other accounts' posts (reposts/related
 * content) mixed in with the target's own, which is exactly the cross-author
 * contamination this whole design exists to avoid.
 */
export async function discoverLinkedInPersonPosts(linkedinUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(
    LINKEDIN_POSTS_DATASET_ID,
    { type: 'discover_new', discover_by: 'profile_url' },
    linkedinUrl,
    { only_authored_posts: true },
  )
}

/**
 * Posts from a company's LinkedIn page.
 * NOTE: Bright Data's own docs assistant gave param names for this mode
 * (`discover_by=discover_new`+`discover_by_type=company_url`) inconsistent
 * with the profile_url pair confirmed live below — confirm against the live
 * Bright Data dashboard request-builder during implementation before
 * trusting this in production; unlike discoverLinkedInPersonPosts, this
 * specific call was not independently live-tested.
 */
export async function discoverLinkedInCompanyPosts(companyUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(LINKEDIN_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'company_url' }, companyUrl)
}

/** Posts authored by a person's X/Twitter account, when Apollo has one on file. */
export async function discoverXPersonPosts(xUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(X_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'profile_url' }, xUrl)
}

/** Posts from a company's X/Twitter account — same discovery mode as a person's, X has no separate company dataset. */
export async function discoverXCompanyPosts(xUrl: string): Promise<ScrapedPost[]> {
  return discoverPosts(X_POSTS_DATASET_ID, { type: 'discover_new', discover_by: 'profile_url' }, xUrl)
}
```

## 4. Social-knowledge orchestration (new module)

New `src/lib/pipeline/social-knowledge.ts` — applies the 90-day cutoff and maps `ScrapedPost` to a `case_knowledge`-shaped candidate. No LLM involved anywhere in this module: mapping is fully deterministic, which is what makes attribution safe by construction rather than by convention.

```ts
import { discoverLinkedInPersonPosts, discoverLinkedInCompanyPosts, discoverXPersonPosts, discoverXCompanyPosts, type ScrapedPost } from '@/lib/research/social-scrape'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

// Posts older than this are dropped entirely, not deprioritized — an opener
// referencing a "recent" post that's actually 4 months old reads worse than
// no personalization at all. See docs/superpowers/specs/2026-08-14-social-scraping-design.md.
const MAX_POST_AGE_DAYS = 90
const MAX_CONTENT_CHARS = 600

export interface SocialKnowledgeCandidate {
  kind: 'news'
  content: string
  sourceUrl: string
  citation: string
  leadId: string | null
  eventDate: string
}

export interface PersonSocialTarget {
  leadId: string
  linkedinUrl: string | null
  twitterUrl: string | null
}

export interface CompanySocialTarget {
  linkedinUrl: string | null
  twitterUrl: string | null
}

function withinCutoff(datePosted: string, now: Date): boolean {
  const posted = new Date(datePosted)
  if (Number.isNaN(posted.getTime())) return false
  const ageDays = (now.getTime() - posted.getTime()) / (1000 * 60 * 60 * 24)
  // ageDays >= 0 rejects a future-dated post outright (clock skew or bad
  // upstream data) rather than silently treating it as maximally "fresh."
  return ageDays >= 0 && ageDays <= MAX_POST_AGE_DAYS
}

function toCandidates(posts: ScrapedPost[], leadId: string | null, platform: 'LinkedIn' | 'X', now: Date): SocialKnowledgeCandidate[] {
  const candidates: SocialKnowledgeCandidate[] = []
  for (const post of posts) {
    if (!post.text || !post.datePosted) continue
    if (!withinCutoff(post.datePosted, now)) continue
    candidates.push({
      kind: 'news',
      content: post.text.slice(0, MAX_CONTENT_CHARS),
      sourceUrl: post.url,
      citation: `${platform} post, ${post.datePosted.slice(0, 10)}`,
      leadId,
      eventDate: post.datePosted,
    })
  }
  return candidates
}

// One failed source (a LinkedIn timeout, an X job that errors) never fails
// the case — matches runResearchForCase's existing "one agent failure is
// logged and dropped, not fatal" stance (research.ts:95-99).
async function safeDiscover(
  fn: () => Promise<ScrapedPost[]>,
  context: { clientId: string; caseId: string; source: string },
): Promise<ScrapedPost[]> {
  try {
    return await fn()
  } catch (error) {
    await logEventSafe({
      clientId: context.clientId,
      caseId: context.caseId,
      actor: 'social_scrape',
      type: 'pipeline.research.social_scrape_failed',
      payload: { source: context.source, errorCode: isAppError(error) ? error.code : 'EXTERNAL_ERROR' },
    })
    return []
  }
}

export async function collectSocialKnowledge(
  context: { clientId: string; caseId: string },
  company: CompanySocialTarget,
  people: PersonSocialTarget[],
  now: Date = new Date(),
): Promise<SocialKnowledgeCandidate[]> {
  const tasks: Promise<SocialKnowledgeCandidate[]>[] = []

  if (company.linkedinUrl) {
    const url = company.linkedinUrl
    tasks.push(
      safeDiscover(() => discoverLinkedInCompanyPosts(url), { ...context, source: 'linkedin_company' })
        .then((posts) => toCandidates(posts, null, 'LinkedIn', now)),
    )
  }
  if (company.twitterUrl) {
    const url = company.twitterUrl
    tasks.push(
      safeDiscover(() => discoverXCompanyPosts(url), { ...context, source: 'x_company' })
        .then((posts) => toCandidates(posts, null, 'X', now)),
    )
  }
  for (const person of people) {
    if (person.linkedinUrl) {
      const url = person.linkedinUrl
      tasks.push(
        safeDiscover(() => discoverLinkedInPersonPosts(url), { ...context, source: 'linkedin_person' })
          .then((posts) => toCandidates(posts, person.leadId, 'LinkedIn', now)),
      )
    }
    if (person.twitterUrl) {
      const url = person.twitterUrl
      tasks.push(
        safeDiscover(() => discoverXPersonPosts(url), { ...context, source: 'x_person' })
          .then((posts) => toCandidates(posts, person.leadId, 'X', now)),
      )
    }
  }

  const results = await Promise.all(tasks)
  return results.flat()
}
```

`Promise.all` (not `allSettled`) is correct here — every element already resolves via `safeDiscover`'s own try/catch, so nothing in this array can reject.

## 5. Wiring into `research.ts`

`RunResearchInput` gains company social targets; `leads` is widened (§6) to carry `id`/`twitterUrl`:

```ts
export interface RunResearchInput {
  clientId: string
  caseId: string
  companyName: string
  companyDomain: string | null
  companyFirmographics: CompanyFirmographics | null
  companySocials: CompanySocialTarget
  leads: ResearchLead[]
  seller: SellerContext
}
```

Internal candidate type unifies agent-produced entries (never attributed/dated) with social candidates (always attributed/dated):

```ts
type KnowledgeCandidate = AgentDossierEntry & { leadId: string | null; eventDate: string | null }
```

`runResearchForCase` runs social scraping alongside the existing agent roles in the same `Promise.allSettled`, so a slow/failed social source has exactly the same "doesn't block the rest" behavior the agent roles already have:

```ts
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
    await logAgentFailure(input, roles[i]!, result.reason)
  }
}
```

(`collectSocialKnowledge` never rejects — §4 — so it sits outside the `allSettled`/failure-counting machinery; `input.leads.map(...)` needs no filter/type-guard here because `ResearchLead.id` is required per §6, not optional.)

**Correctness fix caught in spec self-review:** the original code's early-return guard was `const allFailed = failed === roles.length`, which — unchanged — would discard any social candidates found on a run where every *agent* role happened to fail, even though `entries` (built above) already contains real, insertable social data. The guard's actual intent (per its own comment, research.ts:95-99) is "don't mark ready with an empty/misleading dossier," which social-only success doesn't violate. Fixed condition:

```ts
const allFailed = failed === roles.length && socialCandidates.length === 0
```

This preserves today's exact behavior for the pure-agent case (social finds nothing → same as before) while correctly shipping a partial dossier when agents fail but social scraping succeeds. Every other line of the `allFailed` branch and the success path below it is unchanged.

`toRows` gains the two new columns:

```ts
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
```

## 6. `provider.ts` — `ResearchLead` widened

```ts
export interface ResearchLead {
  id: string
  fullName: string
  title: string | null
  linkedinUrl: string | null
  twitterUrl: string | null
}
```

Additive and backward-compatible with the still-disabled `PERSON_GATHER_SYSTEM` role type in `agent.ts:39`, which only reads `fullName`/`title`/`linkedinUrl` today.

## 7. `route.ts` — pass the new fields through

`src/app/api/pipeline/research/route.ts` already has the full `LeadRow[]` (with `.id` and `.raw`) before narrowing to `ResearchLead[]`, and already derives `companyFirmographics` from `leads[0].raw` the same way this needs to derive company socials — same pattern, new field:

```ts
const companyFirmographics = leads[0] ? parseCompanyFirmographicsFromRaw(leads[0].raw) : null
const companySocials = leads[0] ? parseCompanySocialsFromRaw(leads[0].raw) : { linkedinUrl: null, twitterUrl: null }
```

```ts
leads: leads.map((l) => {
  const socials = parsePersonSocialsFromRaw(l.raw)
  return { id: l.id, fullName: l.full_name, title: l.title, linkedinUrl: l.linkedin_url, twitterUrl: socials.twitterUrl }
}),
companySocials,
```

Two new small raw-parsers in `src/lib/apollo/format-company-summary.ts`, following `parseCompanyFirmographicsFromRaw`'s exact existing pattern (safe-parse, `null` on any shape mismatch, never throws):

```ts
const rawCompanySocialsSchema = z.object({
  organizationLinkedinUrl: z.string().nullable().optional(),
  organizationTwitterUrl: z.string().nullable().optional(),
}).passthrough()

export function parseCompanySocialsFromRaw(raw: Json): { linkedinUrl: string | null; twitterUrl: string | null } {
  const parsed = rawCompanySocialsSchema.safeParse(raw)
  if (!parsed.success) return { linkedinUrl: null, twitterUrl: null }
  return { linkedinUrl: parsed.data.organizationLinkedinUrl ?? null, twitterUrl: parsed.data.organizationTwitterUrl ?? null }
}

const rawPersonSocialsSchema = z.object({
  twitterUrl: z.string().nullable().optional(),
}).passthrough()

export function parsePersonSocialsFromRaw(raw: Json): { twitterUrl: string | null } {
  const parsed = rawPersonSocialsSchema.safeParse(raw)
  if (!parsed.success) return { twitterUrl: null }
  return { twitterUrl: parsed.data.twitterUrl ?? null }
}
```

## 8. `write.ts` — the safety fix

This is the change that makes storing `lead_id`-tagged rows safe to ship. `runWriteForCase` (`write.ts:277-289`) currently fetches `knowledge` once and hands the identical array to every lead in the case:

```ts
export async function runWriteForCase(/* ... */) {
  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)
  // ...
  for (const lead of leads) {
    const leadKnowledge = knowledge.filter((k) => k.lead_id === null || k.lead_id === lead.id)
    const outcome = await processLead(supabase, input, lead, leadKnowledge, client)
    // ...
  }
}
```

One line added at the top of the loop. Company-level facts (`lead_id: null`) reach every lead, exactly as today; person-level facts now reach only the lead they're actually about. This is the entire fix for the 2026-08-11 bug — everything else in this design is what makes there be person-level facts worth filtering in the first place.

## 9. Explicitly out of scope

- **Facebook** — no bounded discovery mode exists (§ Problem). Revisit if Bright Data adds one.
- **Re-enabling `ENABLE_PERSON_RESEARCH`** — stays `false`. `PERSON_GATHER_SYSTEM` is untouched, per the original brainstorming scope decision.
- **Consuming `organizationRevenue`/headcount-growth/`crunchbase_url`/`angellist_url`** in the write prompt — captured this round (§1), read by nothing until a follow-up round decides how to surface them (a new fact type? a `DOSSIER_KIND_PRIORITY` entry? a plain sentence like `formatCompanySummary`?).
- **Recency-weighted ranking inside the dossier** (e.g. a 3-day-old post outranking a 60-day-old one) — this round only does a hard 90-day cutoff; anything more nuanced than binary in/out is prompt-engineering work for the follow-up round.
- **GitHub/Facebook person URLs** — captured nowhere; no consumer exists for them.
- **Periodic re-scraping of a case already researched once** — this runs exactly once, at research time, same lifecycle as the existing research agents.
- **A `num_of_posts`/count limit on LinkedIn or X** — neither dataset documents one (confirmed with Bright Data support); the 90-day date filter is the only bound, applied client-side post-fetch, not requested from the API.

## 10. Testing

- **`src/lib/apollo/client.test.ts`**: `bulkMatchPeople`/`searchPeople` map `twitter_url`, org `linkedin_url`/`twitter_url`/revenue/growth fields when present; all `null`/absent → mapped fields `null` (not throw); existing tests for already-mapped fields unchanged.
- **`src/lib/apollo/format-company-summary.test.ts`**: new `describe('parseCompanySocialsFromRaw')` / `describe('parsePersonSocialsFromRaw')` — valid shape → mapped; malformed/missing → all-null result, never throws; existing `parseCompanyFirmographicsFromRaw` tests unchanged.
- **`src/lib/research/social-scrape.test.ts`** (new): each `discover*Posts` function — trigger → progress(`running` then `ready`) → snapshot happy path returns mapped `ScrapedPost[]`; `progress` returns `failed` → throws `AppError('EXTERNAL_ERROR')`; `progress` never reaches `ready` within timeout → throws `AppError('EXTERNAL_TIMEOUT')`; a snapshot record with `error` set is dropped, not mapped; `post_text` vs `description` field-name fallback both map correctly.
- **`src/lib/pipeline/social-knowledge.test.ts`** (new): `collectSocialKnowledge` — no social targets at all → `[]`, zero calls made; company-only targets → `leadId: null` on results; person targets → correct `leadId` per person; a post older than 90 days → dropped; a post with no `text` or no `datePosted` → dropped; one source throwing → that source's contribution is `[]` and `logEventSafe` is called, other sources' results still present (mirrors `runResearchForCase`'s existing "one failure doesn't kill the rest" test pattern).
- **`src/lib/pipeline/research.test.ts`**: `toRows` includes `lead_id`/`event_date`; social candidates and agent-produced entries both land correctly in `entries` with the right `leadId`/`eventDate` (`null`/`null` for agent-sourced); `collectSocialKnowledge` failing/returning empty doesn't affect the existing `allFailed`/case-status logic, which stays keyed on agent roles only.
- **`src/lib/pipeline/write.test.ts`**: two leads in one case, one `lead_id`-tagged knowledge row per lead plus one `lead_id: null` company row → each lead's prompt includes the company row and only its own person row, never the other lead's (this is the regression test for the original 2026-08-11 bug).
- **`src/app/api/pipeline/research/route.test.ts`**: `leads.map(...)` produces `id`/`twitterUrl` correctly from a `LeadRow`+`raw` fixture; `companySocials` derived from `leads[0].raw` same as existing `companyFirmographics` derivation.
- Migration `0044`: `pnpm supabase db reset` (or equivalent local check) confirms `lead_id`/`event_date` add cleanly and the partial index builds.
- `pnpm typecheck && pnpm lint && pnpm test` all clean before calling this done.
