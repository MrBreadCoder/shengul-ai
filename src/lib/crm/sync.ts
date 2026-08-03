import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { publishJson } from '@/lib/qstash/client'
import { logEventSafe, logError } from '@/lib/events/log-event'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCaseById } from '@/lib/db/cases'
import { listActiveLeadsForCase } from '@/lib/db/leads'
import { getCampaignForCase } from '@/lib/db/campaigns'
import {
  getCrmConnectionForClient, markCrmConnectionError, updateCrmConnectionTokens,
  type CrmConnectionRow,
} from '@/lib/db/crm-connections'
import {
  claimCrmSync, ensureCaseCrmLink, markCrmSyncResult, updateCaseCrmLinkIds,
} from '@/lib/db/case-crm-links'
import { getCrmProvider } from './registry'
import { encryptCrmTokens, parseCrmTokens, type CrmOAuthCredentials } from './tokens'
import { isSyncableLead, toCompanyInput, toContactInput, toCreationNote, toDealTitle } from './mapping'
import type { CrmDealTarget } from './provider'

export const CRM_SYNC_PATH = '/api/crm/sync'

export type CrmSyncReason =
  | 'qualified'
  | 'contacted'
  | 'in_conversation'
  | 'hot_handoff'
  | 'won'
  | 'lost'
  | 'dead'

export type CrmSyncOutcome =
  | { kind: 'synced' }
  | { kind: 'skipped'; reason: string }
  | { kind: 'busy' }
  | { kind: 'permanent_failure'; message: string }

export interface RunCrmSyncInput {
  caseId: string
  reason: CrmSyncReason
  now: Date
}

function assertNever(value: never): never {
  throw new AppError('INVARIANT_VIOLATION', 'Unhandled CRM sync reason', { value: String(value) })
}

/** What gets written on the Deal for each reason, beyond creation. */
function noteForReason(reason: CrmSyncReason): string {
  switch (reason) {
    case 'qualified':      return 'Qualified by the outreach agent.'
    case 'contacted':      return 'First outreach sent.'
    case 'in_conversation':return 'Prospect replied — conversation in progress.'
    case 'hot_handoff':    return 'Hot handoff — ready for your team to take over.'
    case 'won':            return 'Marked won.'
    case 'lost':           return 'Marked lost.'
    case 'dead':           return 'No reply after the full follow-up sequence.'
    default:               return assertNever(reason)
  }
}

/**
 * Stage moves only for outcomes we can identify unambiguously. We know the
 * client's initial, won, and lost stages because they told us or the provider
 * flagged them; we do not know what their intermediate stages mean, and
 * guessing would corrupt their forecast.
 */
function dealTargetForReason(reason: CrmSyncReason): CrmDealTarget | null {
  switch (reason) {
    case 'qualified':
    case 'contacted':
    case 'in_conversation':
    case 'hot_handoff':
      return null
    case 'won':
      return { kind: 'closed', outcome: 'won' }
    case 'lost':
    case 'dead':
      return { kind: 'closed', outcome: 'lost' }
    default:
      return assertNever(reason)
  }
}

type FailureClass = 'auth' | 'retryable' | 'permanent'

function classifyFailure(error: unknown): FailureClass {
  if (!isAppError(error)) return 'permanent'
  if (error.code === 'EXTERNAL_TIMEOUT') return 'retryable'
  if (error.code !== 'EXTERNAL_ERROR') return 'permanent'

  const status = error.context.status
  if (typeof status !== 'number') return 'permanent'
  if (status === 401 || status === 403) return 'auth'
  if (status === 429 || status >= 500) return 'retryable'
  return 'permanent'
}

/**
 * Fire-and-forget entry point for the pipeline. Never throws: a CRM sync must
 * not be able to fail a case status transition that already succeeded.
 * Short-circuits before publishing for clients with no usable connection, so
 * the common case costs one indexed read.
 */
export async function enqueueCrmSync(caseId: string, reason: CrmSyncReason): Promise<void> {
  try {
    const supabase = createAdminClient()
    const kase = await getCaseById(supabase, caseId)
    if (!kase) return
    const connection = await getCrmConnectionForClient(supabase, kase.client_id)
    if (!connection || !connection.pipeline_id || connection.status !== 'connected') return
    await publishJson(CRM_SYNC_PATH, { caseId, reason })
  } catch (error) {
    await logError({
      clientId: null,
      caseId,
      actor: 'system:crm',
      type: 'crm.enqueue_failed',
      source: 'crm',
      error,
      payload: { reason },
    })
  }
}

/** Guards the pipeline-selection columns so the sync body can treat them as set. */
interface ReadyConnection extends CrmConnectionRow {
  pipeline_id: string
  initial_stage_id: string
}

function isReady(connection: CrmConnectionRow): connection is ReadyConnection {
  return connection.pipeline_id !== null && connection.initial_stage_id !== null
}

export async function runCrmSync(
  supabase: SupabaseClient<Database>,
  { caseId, reason, now }: RunCrmSyncInput,
): Promise<CrmSyncOutcome> {
  const kase = await getCaseById(supabase, caseId)
  if (!kase) return { kind: 'skipped', reason: 'case_not_found' }

  const connection = await getCrmConnectionForClient(supabase, kase.client_id)
  if (!connection) return { kind: 'skipped', reason: 'no_connection' }
  if (connection.status !== 'connected') return { kind: 'skipped', reason: 'connection_errored' }
  if (!isReady(connection)) return { kind: 'skipped', reason: 'setup_incomplete' }

  const link = await ensureCaseCrmLink(supabase, {
    clientId: kase.client_id,
    caseId,
    crmConnectionId: connection.id,
  })

  // Single-flight: a loser must not proceed, or two concurrent transitions on
  // one case would create two Deals.
  const claimed = await claimCrmSync(supabase, caseId, now)
  if (!claimed) return { kind: 'busy' }

  const provider = getCrmProvider(connection.provider)
  const connectionId = connection.id
  let credentials: CrmOAuthCredentials = parseCrmTokens(connection.oauth, connectionId)

  /**
   * Runs one provider call and persists rotated credentials immediately.
   * Immediately, not at the end: Pipedrive rotates the refresh token on every
   * refresh, so crashing before the write would leave the stored token dead.
   */
  async function call<T>(
    invoke: (creds: CrmOAuthCredentials) => Promise<T & { tokens: CrmOAuthCredentials }>,
  ): Promise<T> {
    const result = await invoke(credentials)
    if (result.tokens.accessToken !== credentials.accessToken) {
      credentials = result.tokens
      await updateCrmConnectionTokens(supabase, connectionId, encryptCrmTokens(result.tokens))
    }
    return result
  }

  try {
    let companyId = link.external_company_id
    let contactIds = link.external_contact_ids
    let dealId = link.external_deal_id

    // Create-or-update runs on ANY reason, which is what lets a client who
    // connects mid-campaign pick up existing cases at their next transition.
    if (dealId === null) {
      const leads = (await listActiveLeadsForCase(supabase, caseId)).filter(isSyncableLead)

      if (companyId === null) {
        const company = await call((creds) => provider.upsertCompany(creds, toCompanyInput(kase)))
        companyId = company.externalId
        await updateCaseCrmLinkIds(supabase, caseId, { externalCompanyId: companyId })
      }

      if (contactIds.length === 0 && leads.length > 0) {
        const created: string[] = []
        for (const lead of leads) {
          const contact = await call((creds) => provider.upsertContact(creds, toContactInput(lead)))
          created.push(contact.externalId)
        }
        contactIds = created
        await updateCaseCrmLinkIds(supabase, caseId, { externalContactIds: contactIds })
      }

      const campaign = await getCampaignForCase(supabase, caseId)
      const deal = await call((creds) =>
        provider.createDeal(creds, {
          title: toDealTitle(kase.company_name, campaign?.name ?? null),
          pipelineId: connection.pipeline_id,
          stageId: connection.initial_stage_id,
          companyExternalId: companyId,
          contactExternalIds: contactIds,
          accountRef: connection.account_ref,
        }),
      )
      dealId = deal.externalId
      await updateCaseCrmLinkIds(supabase, caseId, {
        externalDealId: deal.externalId,
        externalDealUrl: deal.url,
      })

      const createdDealId = deal.externalId
      await call((creds) =>
        provider.addDealNote(
          creds,
          createdDealId,
          toCreationNote({
            summary: kase.summary,
            caseUrl: new URL(`/cases/${caseId}`, env.APP_URL).toString(),
            companyDomain: kase.company_domain,
            leads,
          }),
        ),
      )
    }

    const target = dealTargetForReason(reason)
    // `dealId` is non-null here: either it was already linked, or the create
    // branch above assigned it. The narrowing is re-stated for the compiler.
    const activeDealId = dealId
    if (activeDealId !== null) {
      if (target !== null) {
        await call((creds) => provider.moveDeal(creds, activeDealId, target))
      }
      if (reason !== 'qualified') {
        await call((creds) => provider.addDealNote(creds, activeDealId, noteForReason(reason)))
      }
    }

    await markCrmSyncResult(supabase, caseId, { status: 'ok' })
    await logEventSafe({
      clientId: kase.client_id,
      caseId,
      actor: 'system:crm',
      type: 'crm.synced',
      source: 'crm',
      payload: { provider: connection.provider, reason, dealId: activeDealId },
    })
    return { kind: 'synced' }
  } catch (error) {
    const failure = classifyFailure(error)
    const message = error instanceof Error ? error.message : String(error)

    // Always release the claim, whatever the outcome — a held claim would block
    // the retry we are about to ask QStash for.
    await markCrmSyncResult(supabase, caseId, { status: 'error', message })

    if (failure === 'auth') {
      await markCrmConnectionError(supabase, connection.id, 'token_revoked')
    }
    await logError({
      clientId: kase.client_id,
      caseId,
      actor: 'system:crm',
      type: 'crm.sync_failed',
      source: 'crm',
      error,
      payload: { reason, failure },
    })

    // Retryable failures propagate so the route returns 500 and QStash retries.
    // Auth and validation failures are terminal — retrying cannot help.
    if (failure === 'retryable') throw error
    return { kind: 'permanent_failure', message }
  }
}
