import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { searchPeople, bulkMatchPeople } from '@/lib/apollo/client'
import { buildPeopleSearchParams } from '@/lib/apollo/build-search-params'
import { mapApolloEmailStatus } from '@/lib/apollo/map-email-status'
import { matchesExcludedKeywords } from '@/lib/apollo/exclude-keywords'
import type { ApolloIcpFilters, ApolloSearchCandidate } from '@/lib/apollo/types'
import { getKnownSourceIds, insertLeads, getVerifiedLeadCompanies, type LeadInsert, type LeadRow } from '@/lib/db/leads'
import { getSuppressions } from '@/lib/db/suppressions'
import { groupVerifiedLead, computeCompanyKey } from './group-lead'
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

export interface CampaignForDiscovery {
  id: string
  clientId: string
  dailyTarget: number
  icp: ApolloIcpFilters
}

export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  firstPassCandidates: number
  secondPassCandidates: number
  enriched: number
  /** Leads that ended at `status: 'active'` — i.e. cleared for sending. */
  verified: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  /** Apollo-verified leads parked without an Emailable call: suppressed for this client. */
  suppressedSkipped: number
  /** Apollo-verified leads parked without an Emailable call: matched an exclude keyword post-enrich. */
  excludedPostEnrich: number
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

// Pass 1 (breadth): at most 1 person per brand-new company, regardless of
// how many people from that company appear in the results — a second
// contact is deliberately left to runSecondPass, never picked up here.
// companyPickCounts / domainBackedCompanyKeys are shared, mutated state
// threaded through both passes on purpose: they are how pass 2 learns which
// companies pass 1 (and earlier days) left at exactly 1 verified contact.
async function runFirstPass(
  campaign: CampaignForDiscovery,
  quota: number,
  known: Set<string>,
  companyPickCounts: Map<string, number>,
  domainBackedCompanyKeys: Set<string>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  for (let page = 1; page <= MAX_SEARCH_PAGES && picks.length < quota; page++) {
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE)
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { pass: 1, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) break
    for (const candidate of candidates) {
      if (picks.length >= quota) break
      if (matchesExcludedKeywords(candidate, icp.excludeKeywords)) continue
      if (known.has(candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      const companyKey = computeCompanyKey(candidate.organizationDomain, candidate.organizationName)
      if (companyPickCounts.has(companyKey)) continue
      companyPickCounts.set(companyKey, 1)
      if (candidate.organizationDomain) domainBackedCompanyKeys.add(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
  }
  return { picks, candidatesSeen }
}

// Pass 2 (depth): a company-scoped search (Apollo domain filter) targeting
// exactly the companies that currently sit at 1 verified contact, trying to
// find a second, different person at each. A company that doesn't surface a
// match here simply stays at 1 — case activation already accepts that
// (group-lead.ts), so it is not treated as a failure.
//
// The domain filter narrows every time a target is found (remainingTargets
// shrinks), so `page` is reset to 1 whenever that happens — page N of a
// freshly narrowed filter is not a continuation of page N against the old,
// wider filter, and would silently skip results. `pagesSearched` is the
// real page-budget counter since `page` no longer counts monotonically.
async function runSecondPass(
  campaign: CampaignForDiscovery,
  quota: number,
  known: Set<string>,
  firstPassPicks: FreshCandidate[],
  targetDomains: string[],
  companyPickCounts: Map<string, number>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const remainingTargets = new Set(targetDomains)
  let page = 1
  for (let pagesSearched = 0; pagesSearched < MAX_SEARCH_PAGES && picks.length < quota && remainingTargets.size > 0; pagesSearched++) {
    const targetsBefore = remainingTargets.size
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE, [...remainingTargets])
    const { candidates } = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.search.failed', { pass: 2, page }),
      () => withRetry(() => searchPeople(params)),
    )
    candidatesSeen += candidates.length
    if (candidates.length === 0) break
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
      // Title-only (or title+org) match: person-specific, so only this
      // candidate is skipped — a different employee at the same company may
      // still be a valid second contact.
      if (matchesExcludedKeywords(candidate, icp.excludeKeywords)) continue
      if (known.has(candidate.apolloId)) continue
      if (firstPassPicks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (picks.some((f) => f.apolloId === candidate.apolloId)) continue
      if (!remainingTargets.has(companyKey)) continue
      companyPickCounts.set(companyKey, (companyPickCounts.get(companyKey) ?? 0) + 1)
      remainingTargets.delete(companyKey)
      picks.push(toFreshCandidate(candidate))
    }
    page = remainingTargets.size === targetsBefore ? page + 1 : 1
  }
  return { picks, candidatesSeen }
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
      else if (verdict.leadStatus === 'active') deliverable += 1
      else rejected += 1
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

  return { rows, checked: verifiable.length, deliverable, rejected, failedOpen }
}

interface EnrichResult {
  rows: LeadInsert[]
  /** Rows that ended at `status: 'active'` — i.e. actually cleared to send. */
  verifiedCount: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  suppressedSkipped: number
  excludedPostEnrich: number
}

// Best-effort, same reasoning as the pipeline.discover.group_lead_failed
// logging further down: a logging failure must never turn an
// already-decided filter outcome (the row is parked either way) into a
// failed discovery run.
async function logDiscoveryFilterEvent(
  campaign: CampaignForDiscovery,
  type: 'pipeline.discover.suppressed_skipped' | 'pipeline.discover.excluded_post_enrich',
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

async function enrichCandidates(
  candidates: FreshCandidate[],
  campaign: CampaignForDiscovery,
  supabase: SupabaseClient<Database>,
): Promise<EnrichResult> {
  const { icp } = campaign
  const rows: LeadInsert[] = []
  let verifiedCount = 0
  let emailableChecked = 0
  let emailableDeliverable = 0
  let emailableRejected = 0
  let emailableFailedOpen = 0
  let suppressedSkipped = 0
  let excludedPostEnrich = 0

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
    // post-enrich exclude-keyword check below matched, or the suppression
    // check further down matched. Apollo's raw email_status stays on the row
    // untouched (it may still read 'verified' — that is Apollo's true
    // verdict, not a lie), but `status` is forced to 'parked' so nothing
    // downstream mistakes these for send-eligible. `status`, not
    // `email_status`, is what every caller below and in
    // runDiscoveryForCampaign now checks for exactly this reason.
    const skipVerification = new Set<string>()

    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      const title = person.title ?? source?.title ?? null
      const companyName = person.organizationName ?? source?.organizationName ?? null
      const companyDomain = person.organizationDomain ?? source?.organizationDomain ?? null

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

    // The deliverability guard, not Apollo, has the final say on activation —
    // for every row not already parked above.
    const verified = await verifyBatch(campaign, batchRows, skipVerification)
    emailableChecked += verified.checked
    emailableDeliverable += verified.deliverable
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
    emailableRejected,
    emailableFailedOpen,
    suppressedSkipped,
    excludedPostEnrich,
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

    const priorCompanyCounts = new Map<string, number>()
    const domainBackedCompanyKeys = new Set<string>()
    for (const company of existingCompanies) {
      const key = computeCompanyKey(company.companyDomain, company.companyName)
      priorCompanyCounts.set(key, (priorCompanyCounts.get(key) ?? 0) + 1)
      if (company.companyDomain) domainBackedCompanyKeys.add(key)
    }

    // runFirstPass uses its own copy to dedup within pass 1 (skip a company
    // that already has a pick this run); the prior-verified counts stay
    // untouched below so pass-2 targeting isn't polluted by unverified picks.
    const firstPassQuota = Math.ceil(quota / 2)
    const firstPassPickCounts = new Map(priorCompanyCounts)
    const firstPass = await runFirstPass(campaign, firstPassQuota, known, firstPassPickCounts, domainBackedCompanyKeys)

    // Enrich pass-1 picks before deciding pass-2 targets: only a company
    // whose pass-1 contact actually verified is worth a second-contact search.
    const firstPassEnriched = await enrichCandidates(firstPass.picks, campaign, supabase)

    // Persist pass-1 results now rather than batching with pass 2 at the end:
    // if pass 2 (or its Apollo/Emailable calls) throws after retries are
    // exhausted, these leads are already durable instead of being discarded
    // with the whole run. getKnownSourceIds on the next attempt will see them
    // and skip re-picking, so nothing is duplicated either.
    const firstInserted = await insertLeads(supabase, firstPassEnriched.rows)

    // Key off each pick's own search-time organization fields (matching how
    // runFirstPass computed companyPickCounts), not the enrichment's
    // returned org fields — bulkMatchPeople may resolve a slightly
    // different canonical org name/domain than the original search result.
    const verifiedApolloIds = new Set(
      firstPassEnriched.rows.filter((row) => row.status === 'active').map((row) => row.source_id),
    )
    const verifiedCompanyCounts = new Map(priorCompanyCounts)
    for (const pick of firstPass.picks) {
      if (!verifiedApolloIds.has(pick.apolloId)) continue
      const key = computeCompanyKey(pick.organizationDomain, pick.organizationName)
      verifiedCompanyCounts.set(key, (verifiedCompanyCounts.get(key) ?? 0) + 1)
      if (pick.organizationDomain) domainBackedCompanyKeys.add(key)
    }

    const targetDomains = [...verifiedCompanyCounts.entries()]
      .filter(([key, count]) => count === 1 && domainBackedCompanyKeys.has(key))
      .map(([key]) => key)
    const secondPassQuota = quota - firstPass.picks.length
    const secondPass = targetDomains.length > 0 && secondPassQuota > 0
      ? await runSecondPass(campaign, secondPassQuota, known, firstPass.picks, targetDomains, verifiedCompanyCounts)
      : { picks: [] as FreshCandidate[], candidatesSeen: 0 }

    const secondPassEnriched = await enrichCandidates(secondPass.picks, campaign, supabase)
    const secondInserted = await insertLeads(supabase, secondPassEnriched.rows)

    const fresh = [...firstPass.picks, ...secondPass.picks]
    const candidatesSeen = firstPass.candidatesSeen + secondPass.candidatesSeen
    const enrichedRows = [...firstPassEnriched.rows, ...secondPassEnriched.rows]
    const verifiedCount = firstPassEnriched.verifiedCount + secondPassEnriched.verifiedCount

    const inserted: LeadRow[] = [...firstInserted, ...secondInserted]

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
      newCandidates: fresh.length,
      firstPassCandidates: firstPass.picks.length,
      secondPassCandidates: secondPass.picks.length,
      enriched: enrichedRows.length,
      verified: verifiedCount,
      emailableChecked: firstPassEnriched.emailableChecked + secondPassEnriched.emailableChecked,
      emailableDeliverable: firstPassEnriched.emailableDeliverable + secondPassEnriched.emailableDeliverable,
      emailableRejected: firstPassEnriched.emailableRejected + secondPassEnriched.emailableRejected,
      emailableFailedOpen: firstPassEnriched.emailableFailedOpen + secondPassEnriched.emailableFailedOpen,
      suppressedSkipped: firstPassEnriched.suppressedSkipped + secondPassEnriched.suppressedSkipped,
      excludedPostEnrich: firstPassEnriched.excludedPostEnrich + secondPassEnriched.excludedPostEnrich,
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
