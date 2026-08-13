import { z } from 'zod'
import { fetchJson } from '@/lib/http/fetch-json'

const BASE_URL = 'https://api.mailreach.co/api/v1'

// apiKey is resolved per-client by the caller (see
// src/lib/mailreach/client-api-keys.ts) — this module has no knowledge of
// clients and must never fall back to a default key itself.
function authHeaders(apiKey: string): Record<string, string> {
  return { 'Content-Type': 'application/json', 'X-Api-Key': `Bearer ${apiKey}` }
}

function toMailreachProvider(provider: 'gmail' | 'outlook'): 'google' | 'outlook' {
  return provider === 'gmail' ? 'google' : 'outlook'
}

export interface SmtpConnectInput {
  emailAddress: string
  firstName: string
  lastName: string
  username: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean
  imapHost: string
  imapPort: number
  imapSecure: boolean
}

// id comes back as an integer (e.g. 1234) per the real POST /v1/imap_auth response
// (V1_Entities_Account) — never the `account_id` string the old, wrong endpoint
// implied. Accepting either shape here and normalizing with String() below is
// deliberately permissive in case Mailreach ever changes the wire type.
const imapAuthResponseSchema = z.object({ id: z.union([z.string(), z.number()]) }).passthrough()

export async function connectSmtpAccount(input: SmtpConnectInput, apiKey: string): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/imap_auth`,
    {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({
        email: input.emailAddress,
        first_name: input.firstName,
        last_name: input.lastName,
        // 'custom' per postV1ImapAuth's own description: "Use this endpoint to
        // onboard accounts that are not using OAuth (Gmail / Microsoft)" — our
        // generic SMTP/IMAP mailboxes are exactly that case. Do not reuse
        // toMailreachProvider() below, which maps to the unrelated, out-of-scope
        // OAuth path's 'google'/'outlook' values.
        provider: 'custom',
        imap_server: input.imapHost,
        imap_server_port: input.imapPort,
        imap_server_username: input.username,
        imap_server_password: input.password,
        smtp_server: input.smtpHost,
        smtp_server_port: input.smtpPort,
        smtp_server_username: input.username,
        smtp_server_password: input.password,
        smtp_server_starttls: input.smtpSecure,
      }),
    },
    imapAuthResponseSchema,
  )
  return { accountId: String(res.id) }
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

export async function completeOAuthConnect(
  params: { code: string; provider: 'gmail' | 'outlook' },
  apiKey: string,
): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/connect-account/oauth/callback`,
    {
      method: 'POST',
      headers: authHeaders(apiKey),
      body: JSON.stringify({ code: params.code, provider: toMailreachProvider(params.provider) }),
    },
    oauthCompleteResponseSchema,
  )
  return { accountId: res.account_id }
}

export async function disconnectAccount(accountId: string, apiKey: string): Promise<void> {
  await fetchJson(`${BASE_URL}/accounts/${accountId}`, { method: 'DELETE', headers: authHeaders(apiKey) }, z.unknown())
}

const accountResponseSchema = z.object({ score: z.number().nullable().optional() }).passthrough()

export async function getAccount(accountId: string, apiKey: string): Promise<{ reputationScore: number | null }> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}`,
    { method: 'GET', headers: authHeaders(apiKey) },
    accountResponseSchema,
  )
  return { reputationScore: res.score ?? null }
}

export interface MailreachAccountStats {
  totalMessagesSent: number | null
  totalMessagesReceived: number | null
  totalSpam: number | null
  currentConversationsRunning: number | null
}

const accountStatsResponseSchema = z
  .object({
    total_messages_sent: z.number().int().nonnegative().nullable().optional(),
    total_messages_received: z.number().int().nonnegative().nullable().optional(),
    total_spam: z.number().int().nonnegative().nullable().optional(),
    config_current_conversation_running: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough()

// past_days=180 (the endpoint's max) rather than the 14-day default: the field
// names read like lifetime totals but are actually windowed by past_days. 180
// days safely covers a mailbox's whole history for the "since connecting"
// numbers this feature shows — see docs.mailreach.co/usage/account-stats.
export async function getAccountStats(accountId: string, apiKey: string): Promise<MailreachAccountStats> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}/stats?past_days=180`,
    { method: 'GET', headers: authHeaders(apiKey) },
    accountStatsResponseSchema,
  )
  return {
    totalMessagesSent: res.total_messages_sent ?? null,
    totalMessagesReceived: res.total_messages_received ?? null,
    totalSpam: res.total_spam ?? null,
    currentConversationsRunning: res.config_current_conversation_running ?? null,
  }
}
