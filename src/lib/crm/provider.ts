import type { Database } from '@/types/database'
import type { CrmOAuthCredentials } from './tokens'

/** Derived from the DB enum so the schema and the code cannot drift apart. */
export type CrmProviderName = Database['public']['Enums']['crm_provider']

export interface CrmPipelineStage {
  id: string
  label: string
  /** Providers that model closure as a stage flag it here; null when unknown. */
  closedOutcome: 'won' | 'lost' | null
}

export interface CrmPipeline {
  id: string
  label: string
  stages: CrmPipelineStage[]
}

export interface CrmContactInput {
  email: string
  firstName: string | null
  lastName: string | null
  title: string | null
  linkedinUrl: string | null
  companyName: string | null
}

export interface CrmCompanyInput {
  name: string
  domain: string | null
}

export interface CrmDealInput {
  title: string
  pipelineId: string
  stageId: string
  companyExternalId: string | null
  contactExternalIds: readonly string[]
  /** crm_connections.account_ref — HubSpot hub id / Pipedrive api_domain. */
  accountRef: string | null
}

/**
 * Where a Deal should end up. A discriminated union rather than a boolean: the
 * two providers model closure differently (HubSpot moves to a closed stage,
 * Pipedrive sets a separate status field) and callers must not have to know.
 */
export type CrmDealTarget =
  | { kind: 'stage'; stageId: string }
  | { kind: 'closed'; outcome: 'won' | 'lost' }

export interface CrmExchangeResult {
  tokens: CrmOAuthCredentials
  /** Human-readable account name for Settings. Null when the provider has none. */
  accountLabel: string | null
  /** Stored as crm_connections.account_ref; feeds CrmDealInput.accountRef. */
  accountRef: string | null
}

/**
 * Every method returns possibly-refreshed credentials alongside its result,
 * the same contract as MailboxProvider.sendEmail. The caller persists them
 * when accessToken changed, so a refresh is never silently dropped.
 */
export interface CrmProvider {
  readonly provider: CrmProviderName

  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<CrmExchangeResult>

  listPipelines(
    credentials: CrmOAuthCredentials,
  ): Promise<{ pipelines: CrmPipeline[]; tokens: CrmOAuthCredentials }>

  upsertCompany(
    credentials: CrmOAuthCredentials,
    input: CrmCompanyInput,
  ): Promise<{ externalId: string; tokens: CrmOAuthCredentials }>

  upsertContact(
    credentials: CrmOAuthCredentials,
    input: CrmContactInput,
  ): Promise<{ externalId: string; tokens: CrmOAuthCredentials }>

  createDeal(
    credentials: CrmOAuthCredentials,
    input: CrmDealInput,
  ): Promise<{ externalId: string; url: string; tokens: CrmOAuthCredentials }>

  moveDeal(
    credentials: CrmOAuthCredentials,
    dealId: string,
    target: CrmDealTarget,
  ): Promise<{ tokens: CrmOAuthCredentials }>

  addDealNote(
    credentials: CrmOAuthCredentials,
    dealId: string,
    note: string,
  ): Promise<{ tokens: CrmOAuthCredentials }>
}
