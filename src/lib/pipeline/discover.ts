import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { searchPeople, bulkMatchPeople } from '@/lib/apollo/client'
import { buildPeopleSearchParams } from '@/lib/apollo/build-search-params'
import { mapApolloEmailStatus } from '@/lib/apollo/map-email-status'
import { matchesExcludedKeywords } from '@/lib/apollo/exclude-keywords'
import { isRedactedOrgName, hasTooManyBlankCompanyFields } from '@/lib/apollo/redacted-org'
import type { ApolloIcpFilters, ApolloSearchCandidate } from '@/lib/apollo/types'
import { getKnownSourceIds, insertLeads, getVerifiedLeadCompanies, type LeadInsert, type LeadRow } from '@/lib/db/leads'
import { getSuppressions } from '@/lib/db/suppressions'
import { groupVerifiedLead, computeCompanyKey } from './group-lead'
import { checkCompanyRelevance, type RelevanceVerdict, type CampaignRelevanceContext, type CompanySnapshot } from './ai-relevance'
import { logEvent } from '@/lib/events/log-event'
import { withExternalLogging, type ExternalCallContext } from '@/lib/events/with-external-logging'
import { withRetry } from '@/lib/http/with-retry'
import type { Json } from '@/types/database'
import { verifyEmail } from '@/lib/emailable/client'
import { mapEmailableVerdict, type LeadVerificationVerdict } from '@/lib/emailable/map-verification'
import type { VerificationOutcome } from '@/lib/emailable/types'

const MAX_SEARCH_PAGES = 20
const SEARCH_PER_PAGE = 25
const ENRICH_BATCH_SIZE = 10
const DEFAULT_DAILY_QUOTA = 50

// Emailable allows 25 req/s on /v1/verify. Five in flight keeps us an order of
// magnitude under that with no token bucket, and a 429 would signal a bug
// rather than normal load.
const VERIFY_CONCURRENCY = 5

// Same conservative-default reasoning as VERIFY_CONCURRENCY: not tuned to a
// documented Gemini RPM ceiling, just a sane number of in-flight relevance
// checks per enrich batch.
const AI_RELEVANCE_CONCURRENCY = 5

export interface CampaignForDiscovery {
  id: string
  clientId: string
  /** Campaign display name — part of the context handed to the AI relevance filter (see ai-relevance.ts). */
  name: string
  /** Campaign value proposition — same purpose as `name` above. Nullable: not every campaign has one set. */
  valueProp: string | null
  dailyTarget: number
  /** How many verified contacts to aim for at each company before opening a
   * new one — see the breadth/depth reservation math in
   * runDiscoveryForCampaign below. 1 disables depth targeting entirely
   * (every company stays at exactly 1 verified lead, the old behavior). */
  contactsPerCompany: number
  icp: ApolloIcpFilters
}

export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  /** Picks from the depth phase (a second contact at a company already sitting at 1 verified lead), summed across every round this run. */
  depthCandidates: number
  /** Picks from the breadth phase (a brand-new company), summed across every round this run. */
  breadthCandidates: number
  /** Number of depth+breadth round pairs this run executed before hitting daily_target or a round finding nothing new. */
  rounds: number
  enriched: number
  /** Leads that ended at `status: 'active'` — i.e. cleared for sending. */
  verified: number
  emailableChecked: number
  emailableDeliverable: number
  /** Subset of emailableDeliverable activated via the accept_all/low_deliverability catch-all carve-out, not a clean `deliverable` verdict — see map-verification.ts. */
  emailableAcceptAllActivated: number
  emailableRejected: number
  emailableFailedOpen: number
  /** Apollo-verified leads parked without an Emailable call: suppressed for this client. */
  suppressedSkipped: number
  /** Apollo-verified leads parked without an Emailable call: matched an exclude keyword post-enrich. */
  excludedPostEnrich: number
  /** Apollo-verified leads parked without an Emailable call: Apollo's org name matched its
   * confidential-org redaction template, or 2+ of domain/city/state/country/founded-year came
   * back blank — see src/lib/apollo/redacted-org.ts. Pre-enrich candidates dropped by the same
   * name check (before any credit spend) are silently skipped, like the pre-enrich exclude-keyword
   * filter, and are not counted here — this counter is post-enrich only. */
  redactedOrgSkipped: number
  /** Rows evaluated against the AI relevance filter (cache hits included). */
  aiChecked: number
  /** Rows parked because the AI relevance filter rejected their company. */
  aiRejected: number
  /** Rows that passed through unaffected because the AI relevance check itself failed (timeout/error). */
  aiFailedOpen: number
  inserted: number
}

interface FreshCandidate {
  apolloId: string
  firstName: string
  title: string | null
  organizationName: string | null
  organizationDomain: string | null
  linkedinUrl: string | null
}

interface SearchPassResult {
  picks: FreshCandidate[]
  candidatesSeen: number
}

function toFreshCandidate(candidate: ApolloSearchCandidate): FreshCandidate {
  return {
    apolloId: candidate.apolloId,
    firstName: candidate.firstName,
    title: candidate.title,
    organizationName: candidate.organizationName,
    organizationDomain: candidate.organizationDomain,
    linkedinUrl: candidate.linkedinUrl,
  }
}

// Every vendor call in this file is attributed to the campaign's client, so an
// Apollo or Emailable outage (or quota exhaustion) shows up on that client's
// Logs tab instead of only in a 500 the operator never sees.
function vendorContext(
  campaign: CampaignForDiscovery,
  failureType: string,
  payload: Record<string, Json>,
): ExternalCallContext {
  return {
    clientId: campaign.clientId,
    actor: 'system',
    failureType,
    payload: { campaignId: campaign.id, ...payload },
  }
}

// Apollo's q_keywords param is a single free-text field, not an OR-list —
// confirmed live 2026-08-06: two keywords joined into one q_keywords string
// returned total_entries: 0, and a longer join returned HTTP 422 "Value too
// long". buildPeopleSearchParams still joins icp.keywords.join(' ') for a
// single call, so an ICP with more than one keyword must never be handed to
// it directly; each pass instead searches one keyword at a time via this
// list of per-call ICPs. `null` in the return array means "no keyword
// filter" (icp.keywords was empty) — buildPeopleSearchParams already omits
// q_keywords in that case.
function searchTargets(icp: ApolloIcpFilters): (string | null)[] {
  return icp.keywords.length > 0 ? icp.keywords : [null]
}

function icpForTarget(icp: ApolloIcpFilters, target: string | null): ApolloIcpFilters {
  return target === null ? icp : { ...icp, keywords: [target] }
}

// Breadth (new companies): at most 1 person per brand-new company,
// regardless of how many people from that company appear in the results —
// a second contact is deliberately left to runDepthSearch, never picked up
// here. companyPickCounts / domainBackedCompanyKeys are caller-owned,
// mutated state: they are how the caller learns which companies this call
// (and earlier rounds/days) left at exactly 1 pick.
//
// Iterates (keyword, page) pairs rather than just pages — see
// searchTargets — cycling to the next keyword once the current one's page
// comes back empty. `call` is the real page-budget counter (MAX_SEARCH_PAGES
// total Apollo calls for this phase); `page` only counts pages within the
// current keyword.
async function runBreadthSearch(
  campaign: CampaignForDiscovery,
  round: number,
  quota: number,
  known: Set<string>,
  companyPickCounts: Map<string, number>,
  domainBackedCompanyKeys: Set<string>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const targets = searchTargets(icp)
  let targetIndex = 0
  let page = 1
  for (let call = 0; call < MAX_SEARCH_PAGES && picks.length < quota && targetIndex < targets.length; call++) {
    const params = buildPeopleSearchParams(icpForTarget(icp, targets[targetIndex]!), page, SEARCH_PER_PAGE)
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { phase: 'breadth', round, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) {
      targetIndex += 1
      page = 1
      continue
    }
    for (const candidate of candidates) {
      if (picks.length >= quota) break
      if (matchesExcludedKeywords(candidate, icp.excludeKeywords)) continue
      // Zero-cost rejection: organizationName is the only company signal a
      // pre-enrich search candidate carries, and Apollo's own search call is
      // free — this drops confidential-org placeholders before Apollo's
      // enrich call (bulk_match) and before any credit, Apollo or Emailable,
      // is ever spent. See src/lib/apollo/redacted-org.ts.
      if (isRedactedOrgName(candidate.organizationName)) continue
      if (known.has(candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      const companyKey = computeCompanyKey(candidate.organizationDomain, candidate.organizationName)
      if (companyPickCounts.has(companyKey)) continue
      companyPickCounts.set(companyKey, 1)
      if (candidate.organizationDomain) domainBackedCompanyKeys.add(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
    page += 1
  }
  return { picks, candidatesSeen }
}

interface DepthSearchResult extends SearchPassResult {
  /** Domains searched this call that came back with zero further Apollo
   * results — not "found nothing yet" but "nothing left to find" for this
   * run. The caller drops these from every later round's depth targets
   * instead of re-querying a domain that already came back empty. A domain
   * dropped only because the page budget ran out (not because Apollo ran
   * dry) is NOT included here — a later round may still find something for
   * it with fresh budget. */
  exhaustedDomains: Set<string>
}

// Depth (Nth contact): a company-scoped search (Apollo domain filter)
// targeting companies that currently sit below campaign.contactsPerCompany
// verified contacts, trying to find one more, different person at each. A
// company that doesn't surface a match here simply stays below target —
// case activation already accepts that (group-lead.ts), so it is not
// treated as a failure.
//
// Deliberately omits icp.keywords / q_keywords: the domain restriction
// already pins the exact company, so an additional free-text company-level
// keyword match is redundant and produces false negatives whenever that
// company's Apollo org profile doesn't literally contain the keyword text
// (confirmed live 2026-08-06 — see
// docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md).
// person_titles / employee range / contact_email_status still apply, so a
// second contact still has to be a legitimate ICP-matching persona.
//
// The domain filter narrows every time a target is found (remainingTargets
// shrinks), so `page` is reset to 1 whenever that happens — page N of a
// freshly narrowed filter is not a continuation of page N against the old,
// wider filter, and would silently skip results. `call` is the real
// page-budget counter since `page` no longer counts monotonically.
async function runDepthSearch(
  campaign: CampaignForDiscovery,
  round: number,
  quota: number,
  known: Set<string>,
  targetDomains: string[],
): Promise<DepthSearchResult> {
  const { icp } = campaign
  const searchIcp: ApolloIcpFilters = { ...icp, keywords: [] }
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const remainingTargets = new Set(targetDomains)
  let page = 1
  let ranOutOfResults = false
  for (let call = 0; call < MAX_SEARCH_PAGES && picks.length < quota && remainingTargets.size > 0; call++) {
    const targetsBefore = remainingTargets.size
    const params = buildPeopleSearchParams(searchIcp, page, SEARCH_PER_PAGE, [...remainingTargets])
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { phase: 'depth', round, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) {
      ranOutOfResults = true
      break
    }
    for (const candidate of candidates) {
      if (picks.length >= quota) break
      const companyKey = computeCompanyKey(candidate.organizationDomain, candidate.organizationName)
      // Organization-name-only check: this is a company-level attribute, so
      // if it alone disqualifies the candidate, no other employee at the
      // same domain will ever pass either — drop the target now instead of
      // re-querying this company on every remaining page.
      if (matchesExcludedKeywords({ title: null, organizationName: candidate.organizationName }, icp.excludeKeywords)) {
        remainingTargets.delete(companyKey)
        continue
      }
      // Same zero-cost, company-level reasoning as runBreadthSearch above —
      // a redacted placeholder name disqualifies the whole company, not just
      // this one candidate, so it comes off the target list entirely.
      if (isRedactedOrgName(candidate.organizationName)) {
        remainingTargets.delete(companyKey)
        continue
      }
      // Title-only (or title+org) match: person-specific, so only this
      // candidate is skipped — a different employee at the same company may
      // still be a valid second contact.
      if (matchesExcludedKeywords(candidate, icp.excludeKeywords)) continue
      if (known.has(candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (!remainingTargets.has(companyKey)) continue
      remainingTargets.delete(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
    page = remainingTargets.size === targetsBefore ? page + 1 : 1
  }
  const exhaustedDomains = ranOutOfResults ? new Set(remainingTargets) : new Set<string>()
  return { picks, candidatesSeen, exhaustedDomains }
}

interface VerifiableRow {
  index: number
  row: LeadInsert
  email: string
}

interface VerifyBatchResult {
  rows: LeadInsert[]
  checked: number
  deliverable: number
  acceptAllActivated: number
  rejected: number
  failedOpen: number
}

// Never rejects: a missing verdict is a value the decision table understands,
// not an exception. Wrapping here is what lets a whole slice run under
// Promise.all without one bad address discarding its neighbours' results.
async function verifyRow(
  campaign: CampaignForDiscovery,
  { row, email }: VerifiableRow,
): Promise<VerificationOutcome> {
  try {
    // Only the company domain goes into the failure payload — events are
    // rendered on the operator-facing Logs tab, and the address itself is
    // already on the lead row behind the same RLS.
    const result = await withExternalLogging(
      'emailable',
      vendorContext(campaign, 'emailable.verify.failed', { domain: row.company_domain ?? null }),
      () => verifyEmail(email),
    )
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs the deliverability guard over one enrichment batch and returns the rows
 * with their final status applied.
 *
 * Emailable is called only for rows Apollo already marked `verified`, that
 * carry a real address, and that are not in `skipVerification` (already
 * parked upstream as suppressed or post-enrich excluded — see
 * enrichCandidates). Untouched rows keep the verdict Apollo (or the upstream
 * filter) gave them.
 */
async function verifyBatch(
  campaign: CampaignForDiscovery,
  batchRows: LeadInsert[],
  skipVerification: Set<string>,
): Promise<VerifyBatchResult> {
  const verifiable: VerifiableRow[] = []
  batchRows.forEach((row, index) => {
    if (row.email_status !== 'verified') return
    if (row.source_id && skipVerification.has(row.source_id)) return
    const { email } = row
    if (typeof email !== 'string' || email.length === 0) return
    verifiable.push({ index, row, email })
  })

  const verdicts = new Map<number, LeadVerificationVerdict>()
  let deliverable = 0
  let acceptAllActivated = 0
  let rejected = 0
  let failedOpen = 0

  // One timestamp for the whole batch, so a row's email_verified_at always
  // matches the checkedAt inside its own email_verification record.
  const checkedAt = new Date().toISOString()

  for (let i = 0; i < verifiable.length; i += VERIFY_CONCURRENCY) {
    const slice = verifiable.slice(i, i + VERIFY_CONCURRENCY)
    const outcomes = await Promise.all(slice.map((target) => verifyRow(campaign, target)))
    slice.forEach((target, offset) => {
      // Promise.all preserves input order, so outcomes[offset] belongs to slice[offset].
      const outcome = outcomes[offset]!
      const verdict = mapEmailableVerdict(outcome, checkedAt)
      verdicts.set(target.index, verdict)
      if (!outcome.ok) failedOpen += 1
      else if (verdict.leadStatus === 'active') {
        deliverable += 1
        // The carve-out is the only way a `risky` emailStatus ends up active.
        if (verdict.emailStatus === 'risky') acceptAllActivated += 1
      } else rejected += 1
    })
  }

  const rows = batchRows.map((row, index) => {
    const verdict = verdicts.get(index)
    if (!verdict) return row
    return {
      ...row,
      email_status: verdict.emailStatus,
      status: verdict.leadStatus,
      email_verified_at: verdict.leadStatus === 'active' ? checkedAt : null,
      email_verification: verdict.verification,
    }
  })

  return { rows, checked: verifiable.length, deliverable, acceptAllActivated, rejected, failedOpen }
}

interface EnrichResult {
  rows: LeadInsert[]
  /** Rows that ended at `status: 'active'` — i.e. actually cleared to send. */
  verifiedCount: number
  emailableChecked: number
  emailableDeliverable: number
  emailableAcceptAllActivated: number
  emailableRejected: number
  emailableFailedOpen: number
  suppressedSkipped: number
  excludedPostEnrich: number
  redactedOrgSkipped: number
  aiChecked: number
  aiRejected: number
  aiFailedOpen: number
}

// Mirrors verifyBatch's own inline eligibility check (email_status ===
// 'verified', not already parked upstream, has a real email) — kept as a
// standalone helper rather than refactored into verifyBatch itself, so this
// change doesn't touch that function's already-tested internals. A row that
// could never reach `active` regardless of company relevance isn't worth an
// AI call either.
function isVerifiableRow(row: LeadInsert, skipVerification: Set<string>): boolean {
  if (row.email_status !== 'verified') return false
  if (row.source_id && skipVerification.has(row.source_id)) return false
  return typeof row.email === 'string' && row.email.length > 0
}

// Best-effort, same reasoning as the pipeline.discover.group_lead_failed
// logging further down: a logging failure must never turn an
// already-decided filter outcome (the row is parked either way) into a
// failed discovery run.
async function logDiscoveryFilterEvent(
  campaign: CampaignForDiscovery,
  type:
    | 'pipeline.discover.suppressed_skipped'
    | 'pipeline.discover.excluded_post_enrich'
    | 'pipeline.discover.redacted_org_skipped',
  leadSourceId: string,
  companyKey: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type,
      source: 'pipeline',
      payload: { campaignId: campaign.id, leadSourceId, companyKey },
    })
  } catch {
    // Audit logging is best-effort.
  }
}

// Separate from logDiscoveryFilterEvent above because this payload carries
// the model's own reason string, not just the (leadSourceId, companyKey)
// pair the other two filter events share.
async function logAiRejectedEvent(
  campaign: CampaignForDiscovery,
  leadSourceId: string,
  companyKey: string,
  reason: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type: 'pipeline.discover.ai_rejected',
      source: 'pipeline',
      payload: { campaignId: campaign.id, leadSourceId, companyKey, reason },
    })
  } catch {
    // Audit logging is best-effort.
  }
}

// Company-level, not lead-level (no leadSourceId) — the AI check itself is
// evaluated per company_key, so a failure is a company-level event even
// though it fail-opens every eligible row at that company.
async function logAiCheckFailedEvent(
  campaign: CampaignForDiscovery,
  companyKey: string,
  error: string,
): Promise<void> {
  try {
    await logEvent({
      clientId: campaign.clientId,
      actor: 'system',
      type: 'pipeline.discover.ai_check_failed',
      source: 'pipeline',
      payload: { campaignId: campaign.id, companyKey, error },
    })
  } catch {
    // Audit logging is best-effort.
  }
}

async function enrichCandidates(
  candidates: FreshCandidate[],
  campaign: CampaignForDiscovery,
  supabase: SupabaseClient<Database>,
  aiVerdictCache: Map<string, RelevanceVerdict>,
): Promise<EnrichResult> {
  const { icp } = campaign
  const rows: LeadInsert[] = []
  let verifiedCount = 0
  let emailableChecked = 0
  let emailableDeliverable = 0
  let emailableAcceptAllActivated = 0
  let emailableRejected = 0
  let emailableFailedOpen = 0
  let suppressedSkipped = 0
  let excludedPostEnrich = 0
  let redactedOrgSkipped = 0
  let aiChecked = 0
  let aiRejected = 0
  let aiFailedOpen = 0

  const relevanceCampaign: CampaignRelevanceContext = {
    name: campaign.name,
    valueProp: campaign.valueProp,
    keywords: icp.keywords,
    excludeKeywords: icp.excludeKeywords,
  }

  for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + ENRICH_BATCH_SIZE)
    const enrichedPeople = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.enrich.failed', { batchSize: batch.length }),
      () =>
        withRetry(() =>
          bulkMatchPeople(
            batch.map((c) => ({
              id: c.apolloId,
              organizationName: c.organizationName ?? undefined,
              domain: c.organizationDomain ?? undefined,
              linkedinUrl: c.linkedinUrl ?? undefined,
            })),
          ),
        ),
    )

    const batchRows: LeadInsert[] = []
    // Apollo person ids parked without ever reaching Emailable — either the
    // post-enrich exclude-keyword check below matched, the suppression check
    // further down matched, or the AI relevance check rejected the company.
    // Apollo's raw email_status stays on the row untouched (it may still
    // read 'verified' — that is Apollo's true verdict, not a lie), but
    // `status` is forced to 'parked' so nothing downstream mistakes these
    // for send-eligible. `status`, not `email_status`, is what every caller
    // below and in runDiscoveryForCampaign now checks for exactly this
    // reason.
    const skipVerification = new Set<string>()
    // Built alongside batchRows below, keyed the same way skipVerification's
    // callers key everything else (computeCompanyKey(domain, name)) — lets
    // the AI relevance stage further down look up a row's firmographics
    // without re-parsing anything back out of `raw`.
    const companySnapshotByKey = new Map<string, CompanySnapshot>()

    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      const title = person.title ?? source?.title ?? null
      const companyName = person.organizationName ?? source?.organizationName ?? null
      const companyDomain = person.organizationDomain ?? source?.organizationDomain ?? null

      companySnapshotByKey.set(computeCompanyKey(companyDomain, companyName), {
        companyName,
        companyDomain,
        industry: person.organizationIndustry,
        employeeCount: person.organizationEmployeeCount,
        foundedYear: person.organizationFoundedYear,
        description: person.organizationDescription,
        city: person.organizationCity,
        state: person.organizationState,
        country: person.organizationCountry,
      })

      // Post-enrich exclude check: catches companies the pre-enrich pass-1/
      // pass-2 title+org-name check couldn't see, because industry and
      // description only exist after this enrich call.
      if (
        matchesExcludedKeywords(
          {
            title,
            organizationName: companyName,
            organizationIndustry: person.organizationIndustry,
            organizationDescription: person.organizationDescription,
          },
          icp.excludeKeywords,
        )
      ) {
        skipVerification.add(person.apolloId)
        excludedPostEnrich += 1
        await logDiscoveryFilterEvent(
          campaign,
          'pipeline.discover.excluded_post_enrich',
          person.apolloId,
          computeCompanyKey(companyDomain, companyName),
        )
      }

      // Post-enrich privacy-redaction backstop: re-checks the org name (in
      // case enrich resolved a different name than the search candidate
      // carried) and, now that firmographics exist, checks for the
      // data-sparsity fingerprint the same redaction leaves even under a
      // name that doesn't match the template. Scoped to rows the check above
      // hasn't already parked, so a row matching both filters is counted and
      // logged once — see src/lib/apollo/redacted-org.ts.
      if (
        !skipVerification.has(person.apolloId) &&
        (isRedactedOrgName(companyName) ||
          hasTooManyBlankCompanyFields({
            companyDomain,
            city: person.organizationCity,
            state: person.organizationState,
            country: person.organizationCountry,
            foundedYear: person.organizationFoundedYear,
          }))
      ) {
        skipVerification.add(person.apolloId)
        redactedOrgSkipped += 1
        await logDiscoveryFilterEvent(
          campaign,
          'pipeline.discover.redacted_org_skipped',
          person.apolloId,
          computeCompanyKey(companyDomain, companyName),
        )
      }

      batchRows.push({
        client_id: campaign.clientId,
        campaign_id: campaign.id,
        source_id: person.apolloId,
        full_name: fullName,
        title,
        company_name: companyName,
        company_domain: companyDomain,
        linkedin_url: person.linkedinUrl ?? source?.linkedinUrl ?? null,
        source: 'apollo',
        raw: { ...person },
        email: person.email,
        email_status: emailStatus,
        email_verified_at: null,
        status: 'parked',
        email_verification: null,
      })
    }

    // Suppression check: one bulk lookup per batch, client-scoped, for every
    // row not already parked above — a contact who already bounced or
    // unsubscribed for this client must never reach Emailable spend or case
    // grouping, no matter which campaign rediscovers them.
    const emailsToCheck = batchRows
      .filter((row) => row.source_id != null && !skipVerification.has(row.source_id))
      .map((row) => row.email)
      .filter((email): email is string => typeof email === 'string' && email.length > 0)
    if (emailsToCheck.length > 0) {
      const suppressed = await getSuppressions(supabase, campaign.clientId, emailsToCheck)
      for (const row of batchRows) {
        if (row.source_id && row.email && suppressed.has(row.email.trim().toLowerCase())) {
          skipVerification.add(row.source_id)
          suppressedSkipped += 1
          await logDiscoveryFilterEvent(
            campaign,
            'pipeline.discover.suppressed_skipped',
            row.source_id,
            computeCompanyKey(row.company_domain ?? null, row.company_name ?? null),
          )
        }
      }
    }

    // AI relevance check: company-level, cached per company_key across the
    // whole discovery run (aiVerdictCache is created once in
    // runDiscoveryForCampaign and shared between the pass-1 and pass-2 calls
    // to this function), so a second contact discovered at an
    // already-judged company costs no extra Gemini call. Runs before
    // Emailable — same reasoning as the suppression/exclude-keyword checks
    // above: a check that's cheap relative to Emailable gates the more
    // expensive vendor call — and only ever considers rows still eligible
    // for Emailable, since a row that could never reach `active` anyway
    // isn't worth an AI call either.
    const aiEligibleRows = batchRows.filter((row) => isVerifiableRow(row, skipVerification))
    const uncachedKeys = new Set<string>()
    for (const row of aiEligibleRows) {
      const key = computeCompanyKey(row.company_domain ?? null, row.company_name ?? null)
      if (!aiVerdictCache.has(key)) uncachedKeys.add(key)
    }
    const keysToResolve = [...uncachedKeys]
    for (let k = 0; k < keysToResolve.length; k += AI_RELEVANCE_CONCURRENCY) {
      const slice = keysToResolve.slice(k, k + AI_RELEVANCE_CONCURRENCY)
      const resolved = await Promise.all(
        slice.map(async (key) => {
          // Safe: every key in uncachedKeys was derived from a row in
          // aiEligibleRows (a filter of batchRows), and the loop above that
          // builds batchRows sets this same key in companySnapshotByKey for
          // every row, unconditionally, before this point.
          const snapshot = companySnapshotByKey.get(key)!
          try {
            const verdict = await checkCompanyRelevance(
              { clientId: campaign.clientId, actor: 'system' },
              relevanceCampaign,
              snapshot,
            )
            return { key, verdict, failed: false as const, error: null as string | null }
          } catch (error) {
            return {
              key,
              verdict: { pass: true, reason: 'ai_check_failed' } as RelevanceVerdict,
              failed: true as const,
              error: error instanceof Error ? error.message : String(error),
            }
          }
        }),
      )
      for (const { key, verdict, failed, error } of resolved) {
        aiVerdictCache.set(key, verdict)
        if (failed) {
          aiFailedOpen += 1
          await logAiCheckFailedEvent(campaign, key, error ?? 'unknown error')
        }
      }
    }
    for (const row of aiEligibleRows) {
      const key = computeCompanyKey(row.company_domain ?? null, row.company_name ?? null)
      const verdict = aiVerdictCache.get(key)
      if (!verdict) continue
      aiChecked += 1
      if (verdict.pass) continue
      if (row.source_id) skipVerification.add(row.source_id)
      aiRejected += 1
      await logAiRejectedEvent(campaign, row.source_id ?? 'unknown', key, verdict.reason)
    }

    // The deliverability guard, not Apollo, has the final say on activation —
    // for every row not already parked above.
    const verified = await verifyBatch(campaign, batchRows, skipVerification)
    emailableChecked += verified.checked
    emailableDeliverable += verified.deliverable
    emailableAcceptAllActivated += verified.acceptAllActivated
    emailableRejected += verified.rejected
    emailableFailedOpen += verified.failedOpen
    for (const row of verified.rows) {
      if (row.status === 'active') verifiedCount += 1
      rows.push(row)
    }
  }

  return {
    rows,
    verifiedCount,
    emailableChecked,
    emailableDeliverable,
    emailableAcceptAllActivated,
    emailableRejected,
    emailableFailedOpen,
    suppressedSkipped,
    excludedPostEnrich,
    redactedOrgSkipped,
    aiChecked,
    aiRejected,
    aiFailedOpen,
  }
}

export async function runDiscoveryForCampaign(
  supabase: SupabaseClient<Database>,
  campaign: CampaignForDiscovery,
): Promise<DiscoverySummary> {
  try {
    const quota = campaign.dailyTarget > 0 ? campaign.dailyTarget : DEFAULT_DAILY_QUOTA
    const known = await getKnownSourceIds(supabase, campaign.clientId)
    const existingCompanies = await getVerifiedLeadCompanies(supabase, campaign.id)
    // Shared across every phase of every round so a company judged once by
    // the AI relevance filter is never re-judged for a second contact
    // discovered at the same company later in this run.
    const aiVerdictCache = new Map<string, RelevanceVerdict>()

    // Persist and mutate across every round of this run — see
    // docs/superpowers/specs/2026-08-07-discovery-retry-loop-design.md
    // ("Architecture"). verifiedCompanyCounts is only ever updated from a
    // phase's REAL post-verification outcome (never an optimistic guess made
    // at pick time), so every round's depth-targeting decision stays
    // accurate even across many rounds.
    const verifiedCompanyCounts = new Map<string, number>()
    const domainBackedCompanyKeys = new Set<string>()
    for (const company of existingCompanies) {
      const key = computeCompanyKey(company.companyDomain, company.companyName)
      verifiedCompanyCounts.set(key, (verifiedCompanyCounts.get(key) ?? 0) + 1)
      if (company.companyDomain) domainBackedCompanyKeys.add(key)
    }
    // A domain that came back with zero further Apollo results in an
    // earlier round of THIS run — never retried, since Apollo's answer for
    // an unchanged, unnarrowed domain-restricted query will not change
    // within the same run.
    const exhaustedDomains = new Set<string>()

    const inserted: LeadRow[] = []
    let candidatesSeen = 0
    let depthCandidates = 0
    let breadthCandidates = 0
    let enrichedCount = 0
    let verifiedSoFar = 0
    let emailableChecked = 0
    let emailableDeliverable = 0
    let emailableAcceptAllActivated = 0
    let emailableRejected = 0
    let emailableFailedOpen = 0
    let suppressedSkipped = 0
    let excludedPostEnrich = 0
    let redactedOrgSkipped = 0
    let aiChecked = 0
    let aiRejected = 0
    let aiFailedOpen = 0
    let rounds = 0

    // Folds one phase's enrichCandidates() output into the run's running
    // totals, persists its rows (durable immediately — a later phase or
    // round throwing must never discard already-durable work), and updates
    // verifiedCompanyCounts/domainBackedCompanyKeys from the real
    // post-verification outcome.
    const applyEnrichResult = async (picks: FreshCandidate[], result: EnrichResult): Promise<void> => {
      enrichedCount += result.rows.length
      emailableChecked += result.emailableChecked
      emailableDeliverable += result.emailableDeliverable
      emailableAcceptAllActivated += result.emailableAcceptAllActivated
      emailableRejected += result.emailableRejected
      emailableFailedOpen += result.emailableFailedOpen
      suppressedSkipped += result.suppressedSkipped
      excludedPostEnrich += result.excludedPostEnrich
      redactedOrgSkipped += result.redactedOrgSkipped
      aiChecked += result.aiChecked
      aiRejected += result.aiRejected
      aiFailedOpen += result.aiFailedOpen
      verifiedSoFar += result.verifiedCount

      const insertedRows = await insertLeads(supabase, result.rows)
      inserted.push(...insertedRows)

      const verifiedApolloIds = new Set(
        result.rows.filter((row) => row.status === 'active').map((row) => row.source_id),
      )
      for (const pick of picks) {
        if (!verifiedApolloIds.has(pick.apolloId)) continue
        const key = computeCompanyKey(pick.organizationDomain, pick.organizationName)
        verifiedCompanyCounts.set(key, (verifiedCompanyCounts.get(key) ?? 0) + 1)
        if (pick.organizationDomain) domainBackedCompanyKeys.add(key)
      }
    }

    while (verifiedSoFar < quota) {
      rounds += 1
      let roundPicks = 0

      const targetDomains = [...verifiedCompanyCounts.entries()]
        .filter(
          ([key, count]) =>
            count < campaign.contactsPerCompany && domainBackedCompanyKeys.has(key) && !exhaustedDomains.has(key),
        )
        .map(([key]) => key)

      if (targetDomains.length > 0) {
        const depthQuota = quota - verifiedSoFar
        const depth = await runDepthSearch(campaign, rounds, depthQuota, known, targetDomains)
        candidatesSeen += depth.candidatesSeen
        depthCandidates += depth.picks.length
        roundPicks += depth.picks.length
        for (const domain of depth.exhaustedDomains) exhaustedDomains.add(domain)
        for (const pick of depth.picks) known.add(pick.apolloId)
        const depthEnriched = await enrichCandidates(depth.picks, campaign, supabase, aiVerdictCache)
        await applyEnrichResult(depth.picks, depthEnriched)
      }

      const breadthQuota = quota - verifiedSoFar
      if (breadthQuota > 0) {
        // Reserve room for depth instead of handing breadth the entire
        // remaining quota: breadth picks at most 1 person per brand-new
        // company, so passing it the full shortfall would open that many
        // distinct companies at once and starve depth of anything to do in
        // a later round — the root cause of the "N companies x 1 lead
        // instead of N/contactsPerCompany companies x contactsPerCompany"
        // bug. Opening at most ceil(shortfall / contactsPerCompany) new
        // companies this round leaves the rest of each one's quota for
        // depth to fill against the same, now-existing company in the next
        // round (see the targetDomains filter above).
        const newCompanyQuota = Math.ceil(breadthQuota / campaign.contactsPerCompany)
        // Throwaway snapshot: runBreadthSearch mutates it optimistically
        // (immediate +1 on pick, before verification is known) purely to
        // avoid picking two people from the same brand-new company within
        // this one call — never merged back into verifiedCompanyCounts,
        // which is only ever updated from a real outcome above.
        const breadthPickCounts = new Map(verifiedCompanyCounts)
        const breadth = await runBreadthSearch(
          campaign,
          rounds,
          newCompanyQuota,
          known,
          breadthPickCounts,
          domainBackedCompanyKeys,
        )
        candidatesSeen += breadth.candidatesSeen
        breadthCandidates += breadth.picks.length
        roundPicks += breadth.picks.length
        for (const pick of breadth.picks) known.add(pick.apolloId)
        const breadthEnriched = await enrichCandidates(breadth.picks, campaign, supabase, aiVerdictCache)
        await applyEnrichResult(breadth.picks, breadthEnriched)
      }

      if (roundPicks === 0) break
    }

    for (const lead of inserted) {
      if (lead.status !== 'active') continue
      try {
        await groupVerifiedLead(supabase, {
          id: lead.id,
          clientId: lead.client_id,
          campaignId: lead.campaign_id,
          companyName: lead.company_name,
          companyDomain: lead.company_domain,
          raw: lead.raw,
        })
      } catch (error) {
        // Isolate one lead's grouping failure so the rest of the batch (already
        // inserted) still gets grouped instead of the whole run failing.
        try {
          await logEvent({
            clientId: campaign.clientId,
            actor: 'system',
            type: 'pipeline.discover.group_lead_failed',
            severity: 'error',
            source: 'pipeline',
            payload: {
              campaignId: campaign.id,
              leadId: lead.id,
              error: error instanceof Error ? error.message : String(error),
            },
          })
        } catch {
          // Audit logging is best-effort.
        }
      }
    }

    const summary: DiscoverySummary = {
      campaignId: campaign.id,
      candidatesSeen,
      newCandidates: depthCandidates + breadthCandidates,
      depthCandidates,
      breadthCandidates,
      rounds,
      enriched: enrichedCount,
      verified: verifiedSoFar,
      emailableChecked,
      emailableDeliverable,
      emailableAcceptAllActivated,
      emailableRejected,
      emailableFailedOpen,
      suppressedSkipped,
      excludedPostEnrich,
      redactedOrgSkipped,
      aiChecked,
      aiRejected,
      aiFailedOpen,
      inserted: inserted.length,
    }

    try {
      await logEvent({
        clientId: campaign.clientId,
        actor: 'system',
        type: 'pipeline.discover.completed',
        source: 'pipeline',
        payload: { ...summary },
      })
    } catch {
      // Audit logging is best-effort — it must not turn a completed discovery
      // run into a rejected operation.
    }

    return summary
  } catch (error) {
    try {
      await logEvent({
        clientId: campaign.clientId,
        actor: 'system',
        type: 'pipeline.discover.failed',
        severity: 'error',
        source: 'pipeline',
        payload: {
          campaignId: campaign.id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
    } catch {
      // Audit logging is best-effort — it must not mask the original
      // discovery failure being rethrown below.
    }
    throw error
  }
}
