import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { CrmOAuthCredentials } from './tokens'
import type {
  CrmCompanyInput, CrmContactInput, CrmDealInput, CrmDealTarget, CrmExchangeResult,
  CrmPipeline, CrmProvider,
} from './provider'

const API_BASE = 'https://api.hubapi.com'
const APP_BASE = 'https://app.hubspot.com'
const REDIRECT_PATH = '/api/crm/hubspot/callback'

const SCOPES = [
  'oauth',
  'crm.objects.contacts.read',
  'crm.objects.contacts.write',
  'crm.objects.companies.read',
  'crm.objects.companies.write',
  'crm.objects.deals.read',
  'crm.objects.deals.write',
].join(' ')

// HubSpot-defined association type ids. These are platform constants, not
// portal-specific: a portal cannot renumber them.
const ASSOCIATION_DEAL_TO_CONTACT = 3
const ASSOCIATION_DEAL_TO_COMPANY = 341
const ASSOCIATION_NOTE_TO_DEAL = 214

// HubSpot's object type id for deals, used in record deep links.
const DEAL_OBJECT_TYPE_ID = '0-3'

/** Refresh this far before actual expiry so a slow request cannot straddle it. */
const REFRESH_SKEW_MS = 30_000

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
})

const tokenInfoSchema = z.object({
  hub_id: z.number(),
  hub_domain: z.string().optional(),
})

const stageSchema = z.object({
  id: z.string(),
  label: z.string(),
  metadata: z.object({ probability: z.string().optional() }).optional(),
})

const pipelinesSchema = z.object({
  results: z.array(z.object({ id: z.string(), label: z.string(), stages: z.array(stageSchema) })),
})

const searchSchema = z.object({ results: z.array(z.object({ id: z.string() })) })
const objectSchema = z.object({ id: z.string() })
const dealReadSchema = z.object({ properties: z.object({ pipeline: z.string().optional() }) })

function redirectUri(): string {
  return new URL(REDIRECT_PATH, env.APP_URL).toString()
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

function authHeaders(accessToken: string): Record<string, string> {
  return { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' }
}

async function refreshAccessToken(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const refreshed = await fetchJson(
    `${API_BASE}/oauth/v1/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: env.HUBSPOT_OAUTH_CLIENT_ID,
        client_secret: env.HUBSPOT_OAUTH_CLIENT_SECRET,
        refresh_token: tokens.refreshToken,
      }),
    },
    tokenResponseSchema,
  )
  return {
    kind: 'oauth',
    accessToken: refreshed.access_token,
    // HubSpot returns a rotated refresh token on some plans and omits it on
    // others; keeping the old one when absent is what the docs prescribe.
    refreshToken: refreshed.refresh_token ?? tokens.refreshToken,
    expiresAt: expiresAtFrom(refreshed.expires_in),
  }
}

async function ensureFresh(tokens: CrmOAuthCredentials): Promise<CrmOAuthCredentials> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + REFRESH_SKEW_MS
  return isExpired ? refreshAccessToken(tokens) : tokens
}

function closedOutcomeFor(probability: string | undefined): 'won' | 'lost' | null {
  if (probability === '1.0') return 'won'
  if (probability === '0.0') return 'lost'
  return null
}

async function fetchPipelines(accessToken: string): Promise<CrmPipeline[]> {
  const response = await fetchJson(
    `${API_BASE}/crm/v3/pipelines/deals`,
    { method: 'GET', headers: authHeaders(accessToken) },
    pipelinesSchema,
  )
  return response.results.map((pipeline) => ({
    id: pipeline.id,
    label: pipeline.label,
    stages: pipeline.stages.map((stage) => ({
      id: stage.id,
      label: stage.label,
      closedOutcome: closedOutcomeFor(stage.metadata?.probability),
    })),
  }))
}

/** Search by an exact property match, returning the first id or null. */
async function findObjectId(
  accessToken: string,
  objectType: 'contacts' | 'companies',
  propertyName: string,
  value: string,
): Promise<string | null> {
  const found = await fetchJson(
    `${API_BASE}/crm/v3/objects/${objectType}/search`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        filterGroups: [{ filters: [{ propertyName, operator: 'EQ', value }] }],
        limit: 1,
      }),
    },
    searchSchema,
  )
  return found.results[0]?.id ?? null
}

async function createOrPatch(
  accessToken: string,
  objectType: 'contacts' | 'companies',
  existingId: string | null,
  properties: Record<string, string>,
): Promise<string> {
  const url = existingId
    ? `${API_BASE}/crm/v3/objects/${objectType}/${existingId}`
    : `${API_BASE}/crm/v3/objects/${objectType}`
  const saved = await fetchJson(
    url,
    {
      method: existingId ? 'PATCH' : 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({ properties }),
    },
    objectSchema,
  )
  return saved.id
}

/** Drops null/empty values — HubSpot rejects a property set to `null`. */
function definedProperties(entries: Record<string, string | null>): Record<string, string> {
  const properties: Record<string, string> = {}
  for (const [key, value] of Object.entries(entries)) {
    if (value !== null && value !== '') properties[key] = value
  }
  return properties
}

async function postNote(accessToken: string, dealId: string, note: string): Promise<void> {
  await fetchJson(
    `${API_BASE}/crm/v3/objects/notes`,
    {
      method: 'POST',
      headers: authHeaders(accessToken),
      body: JSON.stringify({
        properties: { hs_note_body: note, hs_timestamp: new Date().toISOString() },
        associations: [
          {
            to: { id: dealId },
            types: [
              { associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_NOTE_TO_DEAL },
            ],
          },
        ],
      }),
    },
    objectSchema,
  )
}

export const hubspotProvider: CrmProvider = {
  provider: 'hubspot',

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.HUBSPOT_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      state,
    })
    return `${APP_BASE}/oauth/authorize?${params.toString()}`
  },

  async exchangeCode(code: string): Promise<CrmExchangeResult> {
    const token = await fetchJson(
      `${API_BASE}/oauth/v1/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          grant_type: 'authorization_code',
          client_id: env.HUBSPOT_OAUTH_CLIENT_ID,
          client_secret: env.HUBSPOT_OAUTH_CLIENT_SECRET,
          redirect_uri: redirectUri(),
          code,
        }),
      },
      tokenResponseSchema,
    )
    if (!token.refresh_token) {
      throw new AppError('EXTERNAL_ERROR', 'HubSpot did not return a refresh token', {})
    }
    const info = await fetchJson(
      `${API_BASE}/oauth/v1/access-tokens/${token.access_token}`,
      { method: 'GET' },
      tokenInfoSchema,
      // Redacted: the real URL embeds the access token, and AppError context is
      // written to the events table and rendered on the operator Logs tab.
      8000,
      `${API_BASE}/oauth/v1/access-tokens/[redacted]`,
    )
    return {
      tokens: {
        kind: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
      accountLabel: info.hub_domain ?? null,
      accountRef: String(info.hub_id),
    }
  },

  async listPipelines(credentials: CrmOAuthCredentials) {
    const fresh = await ensureFresh(credentials)
    return { pipelines: await fetchPipelines(fresh.accessToken), tokens: fresh }
  },

  async upsertCompany(credentials: CrmOAuthCredentials, input: CrmCompanyInput) {
    const fresh = await ensureFresh(credentials)
    // Domain is the only reliable company identity in HubSpot. Without one we
    // create rather than risk merging two unrelated same-named companies.
    const existingId = input.domain
      ? await findObjectId(fresh.accessToken, 'companies', 'domain', input.domain)
      : null
    const externalId = await createOrPatch(
      fresh.accessToken,
      'companies',
      existingId,
      definedProperties({ name: input.name, domain: input.domain }),
    )
    return { externalId, tokens: fresh }
  },

  async upsertContact(credentials: CrmOAuthCredentials, input: CrmContactInput) {
    const fresh = await ensureFresh(credentials)
    const existingId = await findObjectId(fresh.accessToken, 'contacts', 'email', input.email)
    const externalId = await createOrPatch(
      fresh.accessToken,
      'contacts',
      existingId,
      definedProperties({
        email: input.email,
        firstname: input.firstName,
        lastname: input.lastName,
        jobtitle: input.title,
        linkedin_bio: input.linkedinUrl,
        company: input.companyName,
      }),
    )
    return { externalId, tokens: fresh }
  },

  async createDeal(credentials: CrmOAuthCredentials, input: CrmDealInput) {
    const fresh = await ensureFresh(credentials)
    const associations = [
      ...(input.companyExternalId
        ? [{
            to: { id: input.companyExternalId },
            types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_DEAL_TO_COMPANY }],
          }]
        : []),
      ...input.contactExternalIds.map((contactId) => ({
        to: { id: contactId },
        types: [{ associationCategory: 'HUBSPOT_DEFINED', associationTypeId: ASSOCIATION_DEAL_TO_CONTACT }],
      })),
    ]
    const deal = await fetchJson(
      `${API_BASE}/crm/v3/objects/deals`,
      {
        method: 'POST',
        headers: authHeaders(fresh.accessToken),
        body: JSON.stringify({
          properties: { dealname: input.title, pipeline: input.pipelineId, dealstage: input.stageId },
          associations,
        }),
      },
      objectSchema,
    )
    // Empty rather than a broken link when the portal id is unknown; the UI
    // renders the indicator without an anchor in that case.
    const url = input.accountRef
      ? `${APP_BASE}/contacts/${input.accountRef}/record/${DEAL_OBJECT_TYPE_ID}/${deal.id}`
      : ''
    return { externalId: deal.id, url, tokens: fresh }
  },

  async moveDeal(credentials: CrmOAuthCredentials, dealId: string, target: CrmDealTarget) {
    const fresh = await ensureFresh(credentials)
    let stageId: string | null = null

    if (target.kind === 'stage') {
      stageId = target.stageId
    } else {
      // Read the deal's own pipeline rather than trusting the stored stage ids:
      // a client can move a deal to another pipeline in HubSpot after we
      // created it, which would make our stored closed-stage id invalid.
      const deal = await fetchJson(
        `${API_BASE}/crm/v3/objects/deals/${dealId}?properties=pipeline`,
        { method: 'GET', headers: authHeaders(fresh.accessToken) },
        dealReadSchema,
      )
      const pipelines = await fetchPipelines(fresh.accessToken)
      const pipeline = pipelines.find((candidate) => candidate.id === deal.properties.pipeline)
      stageId = pipeline?.stages.find((stage) => stage.closedOutcome === target.outcome)?.id ?? null
    }

    if (stageId === null) {
      // Losing a stage move is not worth failing a sync over — record the
      // outcome as a note so the information still reaches the client.
      await postNote(fresh.accessToken, dealId, `Case marked ${target.kind === 'closed' ? target.outcome : 'updated'}`)
      return { tokens: fresh }
    }

    await fetchJson(
      `${API_BASE}/crm/v3/objects/deals/${dealId}`,
      {
        method: 'PATCH',
        headers: authHeaders(fresh.accessToken),
        body: JSON.stringify({ properties: { dealstage: stageId } }),
      },
      objectSchema,
    )
    return { tokens: fresh }
  },

  async addDealNote(credentials: CrmOAuthCredentials, dealId: string, note: string) {
    const fresh = await ensureFresh(credentials)
    await postNote(fresh.accessToken, dealId, note)
    return { tokens: fresh }
  },
}
