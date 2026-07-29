import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'

const BASE_URL = 'https://api.mailreach.co/api/v1'

function authHeaders(): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Api-Key': `Bearer ${env.MAILREACH_API_KEY}` }
}

function toMailreachProvider(provider: 'gmail' | 'outlook'): 'google' | 'outlook' {
  return provider === 'gmail' ? 'google' : 'outlook'
}

export interface SmtpConnectInput {
  emailAddress: string
  username: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  imapHost: string
  imapPort: number
  imapSecure: boolean
}

const connectAccountResponseSchema = z.object({ account_id: z.string() }).passthrough()

export async function connectSmtpAccount(input: SmtpConnectInput): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/connect-account`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        type: 'smtp',
        email: input.emailAddress,
        smtp_username: input.username,
        smtp_password: input.password,
        smtp_host: input.smtpHost,
        smtp_port: input.smtpPort,
        smtp_secure: input.smtpSecure,
        imap_host: input.imapHost,
        imap_port: input.imapPort,
        imap_secure: input.imapSecure,
      }),
    },
    connectAccountResponseSchema,
  )
  return { accountId: res.account_id }
}

export function buildOAuthAuthorizeUrl(params: { provider: 'gmail' | 'outlook'; redirectUri: string; state: string }): string {
  const usp = new URLSearchParams({
    provider: toMailreachProvider(params.provider),
    redirect_uri: params.redirectUri,
    state: params.state,
  })
  return `${BASE_URL}/connect-account/oauth?${usp.toString()}`
}

const oauthCompleteResponseSchema = z.object({ account_id: z.string() }).passthrough()

export async function completeOAuthConnect(params: { code: string; provider: 'gmail' | 'outlook' }): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/connect-account/oauth/callback`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({ code: params.code, provider: toMailreachProvider(params.provider) }),
    },
    oauthCompleteResponseSchema,
  )
  return { accountId: res.account_id }
}

export async function disconnectAccount(accountId: string): Promise<void> {
  await fetchJson(`${BASE_URL}/accounts/${accountId}`, { method: 'DELETE', headers: authHeaders() }, z.unknown())
}

const accountStatsResponseSchema = z.object({ reputation_score: z.number().nullable().optional() }).passthrough()

export async function getAccountStats(accountId: string): Promise<{ reputationScore: number | null }> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}/stats`,
    { method: 'GET', headers: authHeaders() },
    accountStatsResponseSchema,
  )
  return { reputationScore: res.reputation_score ?? null }
}
