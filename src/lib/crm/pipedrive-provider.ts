import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'
import type {
  CrmCompanyInput, CrmContactInput, CrmDealInput, CrmDealTarget, CrmExchangeResult,
  CrmPipeline, CrmProvider,
} from './provider'

const OAUTH_BASE = 'https://oauth.pipedrive.com'
const REDIRECT_PATH = '/api/crm/pipedrive/callback'
const SCOPES = 'deals:full contacts:full'
const REFRESH_SKEW_MS = 30_000

/**
 * Pipedrive's API base URL is per-account (`api_domain`), returned only with
 * the token response — every later call needs it. Rather than widen
 * CrmOAuthCredentials (which mailbox tokens share the shape of) we pack it into
 * accessToken after a separator that cannot occur in a bearer token, and split
 * it back out at every use site.
 */
const DOMAIN_SEPARATOR = '|'

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string(),
  expires_in: z.number(),
  api_domain: z.string(),
})

const meSchema = z.object({ data: z.object({ company_name: z.string().optional() }).nullable() })
const pipelinesSchema = z.object({
  data: z.array(z.object({ id: z.number(), name: z.string() })).nullable(),
})
const stagesSchema = z.object({
  data: z.array(z.object({ id: z.number(), name: z.string(), pipeline_id: z.number() })).nullable(),
})
const searchSchema = z.object({
  data: z.object({ items: z.array(z.object({ item: z.object({ id: z.number() }) })) }).nullable(),
})
const createdSchema = z.object({ data: z.object({ id: z.number() }).nullable() })

interface PackedCredentials {
  accessToken: string
  apiDomain: string
}

function unpack(tokens: CrmOAuthCredentials): PackedCredentials {
  const separatorIndex = tokens.accessToken.indexOf(DOMAIN_SEPARATOR)
  if (separatorIndex === -1) {
    throw new AppError('INVARIANT_VIOLATION', 'Pipedrive credentials are missing their api domain', {})
  }
  return {
    accessToken: tokens.accessToken.slice(0, separatorIndex),
    apiDomain: tokens.accessToken.slice(separatorIndex + 1),
  }
}

function pack(accessToken: string, apiDomain: string): string {
  return `${accessToken}${DOMAIN_SEPARATOR}${apiDomain}`
}

function redirectUri(): string {
  return new URL(REDIRECT_PATH, env.APP_URL).toString()
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

function basicAuthHeader(): string {
  const raw = `${env.PIPEDRIVE_OAUTH_CLIENT_ID}:${env.PIPEDRIVE_OAUTH_CLIENT_SECRET}`
  return `Basic ${Buffer.from(raw, 'utf-8').toString('base64')}`
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

async function refreshAccessToken(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const { apiDomain } = unpack(tokens)
  const refreshed = await fetchJson(
    `${OAUTH_BASE}/oauth/token`,
    {
      method: 'POST',
      headers: {
        Authorization: basicAuthHeader(),
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: tokens.refreshToken }),
    },
    tokenResponseSchema,
  )
  return {
    kind: 'oauth',
    // The refresh response repeats api_domain; prefer it over the stored one so
    // an account migrated to a new domain keeps working.
    accessToken: pack(refreshed.access_token, refreshed.api_domain || apiDomain),
    refreshToken: refreshed.refresh_token,
    expiresAt: expiresAtFrom(refreshed.expires_in),
  }
}

async function ensureFresh(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + REFRESH_SKEW_MS
  return isExpired ? refreshAccessToken(tokens) : tokens
}

/** Pipedrive ids are numeric; our interface carries strings. One place to convert. */
function toNumericId(id: string, field: string): number {
  const parsed = Number(id)
  if (!Number.isInteger(parsed)) {
    throw new AppError('INVARIANT_VIOLATION', 'Pipedrive id is not numeric', { field, id })
  }
  return parsed
}

async function searchFirstId(
  packed: PackedCredentials,
  resource: 'persons' | 'organizations',
  term: string,
  fields: string,
): Promise<string | null> {
  const params = new URLSearchParams({ term, fields, exact_match: 'true', limit: '1' })
  const found = await fetchJson(
    `${packed.apiDomain}/api/v1/${resource}/search?${params.toString()}`,
    { method: 'GET', headers: authHeaders(packed.accessToken) },
    searchSchema,
  )
  const first = found.data?.items[0]
  return first ? String(first.item.id) : null
}

async function createResource(
  packed: PackedCredentials,
  resource: 'persons' | 'organizations' | 'deals' | 'notes',
  body: Record<string, unknown>,
): Promise<string> {
  const created = await fetchJson(
    `${packed.apiDomain}/api/v1/${resource}`,
    { method: 'POST', headers: authHeaders(packed.accessToken), body: JSON.stringify(body) },
    createdSchema,
  )
  if (!created.data) {
    throw new AppError('EXTERNAL_ERROR', 'Pipedrive create returned no record', { resource })
  }
  return String(created.data.id)
}

export const pipedriveProvider: CrmProvider = {
  provider: 'pipedrive',

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.PIPEDRIVE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      state,
    })
    return `${OAUTH_BASE}/oauth/authorize?${params.toString()}`
  },

  async exchangeCode(code: string): Promise<CrmExchangeResult> {
    const token = await fetchJson(
      `${OAUTH_BASE}/oauth/token`,
      {
        method: 'POST',
        headers: {
          Authorization: basicAuthHeader(),
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }),
      },
      tokenResponseSchema,
    )
    const me = await fetchJson(
      `${token.api_domain}/api/v1/users/me`,
      { method: 'GET', headers: authHeaders(token.access_token) },
      meSchema,
    )
    return {
      tokens: {
        kind: 'oauth',
        accessToken: pack(token.access_token, token.api_domain),
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
      accountLabel: me.data?.company_name ?? null,
      accountRef: token.api_domain,
    }
  },

  async listPipelines(credentials: CrmOAuthCredentials) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const pipelinesResponse = await fetchJson(
      `${packed.apiDomain}/api/v1/pipelines`,
      { method: 'GET', headers: authHeaders(packed.accessToken) },
      pipelinesSchema,
    )
    const stagesResponse = await fetchJson(
      `${packed.apiDomain}/api/v1/stages`,
      { method: 'GET', headers: authHeaders(packed.accessToken) },
      stagesSchema,
    )
    const stages = stagesResponse.data ?? []
    // Pipedrive models closure as a deal status field, not a stage, so no stage
    // ever carries a closed outcome here. moveDeal handles closure instead.
    const pipelines: CrmPipeline[] = (pipelinesResponse.data ?? []).map((pipeline) => ({
      id: String(pipeline.id),
      label: pipeline.name,
      stages: stages
        .filter((stage) => stage.pipeline_id === pipeline.id)
        .map((stage) => ({ id: String(stage.id), label: stage.name, closedOutcome: null })),
    }))
    return { pipelines, tokens: fresh }
  },

  async upsertCompany(credentials: CrmOAuthCredentials, input: CrmCompanyInput) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const existingId = await searchFirstId(packed, 'organizations', input.name, 'name')
    if (existingId) return { externalId: existingId, tokens: fresh }
    const externalId = await createResource(packed, 'organizations', { name: input.name })
    return { externalId, tokens: fresh }
  },

  async upsertContact(credentials: CrmOAuthCredentials, input: CrmContactInput) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const existingId = await searchFirstId(packed, 'persons', input.email, 'email')
    if (existingId) return { externalId: existingId, tokens: fresh }
    const name = [input.firstName, input.lastName].filter((part) => part !== null).join(' ') || input.email
    const externalId = await createResource(packed, 'persons', {
      name,
      email: [{ value: input.email, primary: true }],
    })
    return { externalId, tokens: fresh }
  },

  async createDeal(credentials: CrmOAuthCredentials, input: CrmDealInput) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const body: Record<string, unknown> = {
      title: input.title,
      pipeline_id: toNumericId(input.pipelineId, 'pipelineId'),
      stage_id: toNumericId(input.stageId, 'stageId'),
    }
    if (input.companyExternalId) body.org_id = toNumericId(input.companyExternalId, 'companyExternalId')
    // A Pipedrive deal links to exactly one person. The rest of the case's
    // contacts are already Persons on the organization and appear there.
    const primaryContactId = input.contactExternalIds[0]
    if (primaryContactId) body.person_id = toNumericId(primaryContactId, 'contactExternalIds[0]')

    const externalId = await createResource(packed, 'deals', body)
    const url = input.accountRef ? `${input.accountRef}/deal/${externalId}` : ''
    return { externalId, url, tokens: fresh }
  },

  async moveDeal(credentials: CrmOAuthCredentials, dealId: string, target: CrmDealTarget) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    const body =
      target.kind === 'stage'
        ? { stage_id: toNumericId(target.stageId, 'stageId') }
        : { status: target.outcome }
    await fetchJson(
      `${packed.apiDomain}/api/v1/deals/${toNumericId(dealId, 'dealId')}`,
      { method: 'PUT', headers: authHeaders(packed.accessToken), body: JSON.stringify(body) },
      createdSchema,
    )
    return { tokens: fresh }
  },

  async addDealNote(credentials: CrmOAuthCredentials, dealId: string, note: string) {
    const fresh = await ensureFresh(credentials)
    const packed = unpack(fresh)
    await createResource(packed, 'notes', { content: note, deal_id: toNumericId(dealId, 'dealId') })
    return { tokens: fresh }
  },
}
