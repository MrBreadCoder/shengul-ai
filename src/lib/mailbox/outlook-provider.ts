import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { ExchangeResult, MailboxProvider, MailboxTokens, SendEmailInput } from './provider'

const REDIRECT_PATH = '/api/mailboxes/outlook/callback'
const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const SCOPES = ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read', 'offline_access'].join(' ')

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
})
const profileSchema = z.object({
  mail: z.string().nullable().optional(),
  userPrincipalName: z.string().optional(),
  displayName: z.string().nullable().optional(),
})
const sendResponseSchema = z.unknown() // Graph sendMail returns 202 with no JSON body

function redirectUri(): string {
  return new URL(REDIRECT_PATH, env.APP_URL).toString()
}
function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

async function refreshAccessToken(tokens: MailboxTokens): Promise<MailboxTokens> {
  const res = await fetchJson(
    `${AUTH_BASE}/token`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.MICROSOFT_OAUTH_CLIENT_ID,
        client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
        scope: SCOPES,
      }),
    },
    tokenResponseSchema,
  )
  return {
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? tokens.refreshToken,
    expiresAt: expiresAtFrom(res.expires_in),
  }
}

async function ensureFresh(tokens: MailboxTokens): Promise<MailboxTokens> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + 30_000
  return isExpired ? refreshAccessToken(tokens) : tokens
}

export const outlookProvider: MailboxProvider = {
  provider: 'outlook',

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.MICROSOFT_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      response_mode: 'query',
      scope: SCOPES,
      state,
    })
    return `${AUTH_BASE}/authorize?${params.toString()}`
  },

  async exchangeCode(code: string): Promise<ExchangeResult> {
    const token = await fetchJson(
      `${AUTH_BASE}/token`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.MICROSOFT_OAUTH_CLIENT_ID,
          client_secret: env.MICROSOFT_OAUTH_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
          scope: SCOPES,
        }),
      },
      tokenResponseSchema,
    )
    if (!token.refresh_token) {
      throw new AppError('EXTERNAL_ERROR', 'Microsoft did not return a refresh token', {})
    }
    const profile = await fetchJson(
      'https://graph.microsoft.com/v1.0/me',
      { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` } },
      profileSchema,
    )
    const emailAddress = profile.mail ?? profile.userPrincipalName
    if (!emailAddress) {
      throw new AppError('EXTERNAL_ERROR', 'Microsoft profile has no email address', {})
    }
    return {
      tokens: { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: expiresAtFrom(token.expires_in) },
      emailAddress,
      displayName: profile.displayName ?? null,
    }
  },

  async sendEmail(tokens: MailboxTokens, input: SendEmailInput) {
    const fresh = await ensureFresh(tokens)
    await fetchJson(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: input.subject,
            body: { contentType: 'Text', content: input.body },
            toRecipients: [{ emailAddress: { address: input.to } }],
          },
          saveToSentItems: true,
        }),
      },
      sendResponseSchema,
    )
    // Graph sendMail does not return message/thread ids; synthesize stable placeholders.
    const id = randomUUID()
    return { result: { providerMessageId: `outlook-${id}`, threadId: `outlook-${id}` }, tokens: fresh }
  },
}
