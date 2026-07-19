import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { ExchangeResult, MailboxProvider, MailboxTokens, SendEmailInput } from './provider'

const REDIRECT_PATH = '/api/mailboxes/google/callback'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/userinfo.email',
  'https://www.googleapis.com/auth/userinfo.profile',
].join(' ')

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().optional(),
  expires_in: z.number(),
})
const profileSchema = z.object({ email: z.string().email(), name: z.string().optional() })
const sendResponseSchema = z.object({ id: z.string(), threadId: z.string() })

function redirectUri(): string {
  return new URL(REDIRECT_PATH, env.APP_URL).toString()
}

function expiresAtFrom(expiresIn: number): string {
  return new Date(Date.now() + expiresIn * 1000).toISOString()
}

// RFC 2822 message, base64url-encoded per Gmail API.
function encodeMessage(from: string, input: SendEmailInput): string {
  const raw = [
    `From: ${from}`,
    `To: ${input.to}`,
    `Subject: ${input.subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
    '',
    input.body,
  ].join('\r\n')
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

async function refreshAccessToken(tokens: MailboxTokens): Promise<MailboxTokens> {
  const res = await fetchJson(
    'https://oauth2.googleapis.com/token',
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_OAUTH_CLIENT_ID,
        client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
        grant_type: 'refresh_token',
        refresh_token: tokens.refreshToken,
      }),
    },
    tokenResponseSchema,
  )
  return { accessToken: res.access_token, refreshToken: tokens.refreshToken, expiresAt: expiresAtFrom(res.expires_in) }
}

async function ensureFresh(tokens: MailboxTokens): Promise<MailboxTokens> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + 30_000
  return isExpired ? refreshAccessToken(tokens) : tokens
}

export const gmailProvider: MailboxProvider = {
  provider: 'gmail',

  buildAuthUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: env.GOOGLE_OAUTH_CLIENT_ID,
      redirect_uri: redirectUri(),
      response_type: 'code',
      scope: SCOPES,
      access_type: 'offline',
      prompt: 'consent',
      state,
    })
    return `https://accounts.google.com/o/oauth2/v2/auth?${params.toString()}`
  },

  async exchangeCode(code: string): Promise<ExchangeResult> {
    const token = await fetchJson(
      'https://oauth2.googleapis.com/token',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({
          client_id: env.GOOGLE_OAUTH_CLIENT_ID,
          client_secret: env.GOOGLE_OAUTH_CLIENT_SECRET,
          grant_type: 'authorization_code',
          code,
          redirect_uri: redirectUri(),
        }),
      },
      tokenResponseSchema,
    )
    if (!token.refresh_token) {
      throw new AppError('EXTERNAL_ERROR', 'Google did not return a refresh token', {})
    }
    const profile = await fetchJson(
      'https://www.googleapis.com/oauth2/v2/userinfo',
      { method: 'GET', headers: { Authorization: `Bearer ${token.access_token}` } },
      profileSchema,
    )
    return {
      tokens: { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: expiresAtFrom(token.expires_in) },
      emailAddress: profile.email,
      displayName: profile.name ?? null,
    }
  },

  async sendEmail(tokens: MailboxTokens, input: SendEmailInput) {
    const fresh = await ensureFresh(tokens)
    const sendResponse = await fetchJson(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ raw: encodeMessage('me', input) }),
      },
      sendResponseSchema,
    )
    return { result: { providerMessageId: sendResponse.id, threadId: sendResponse.threadId }, tokens: fresh }
  },
}
