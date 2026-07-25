import { z } from 'zod'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from './headers'
import {
  requireOAuthCredentials,
  type ExchangeResult, type FetchInboundResult, type InboundMessage, type MailboxCredentials,
  type OAuthCredentials, type OAuthMailboxProvider, type SendEmailInput,
} from './provider'

const REDIRECT_PATH = '/api/mailboxes/google/callback'
const SCOPES = [
  'https://www.googleapis.com/auth/gmail.send',
  'https://www.googleapis.com/auth/gmail.readonly',
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
  const to = assertNoHeaderInjection(input.to, 'to')
  const subject = assertNoHeaderInjection(input.subject, 'subject')
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    'Content-Type: text/plain; charset="UTF-8"',
  ]
  if (input.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${assertNoHeaderInjection(input.inReplyToMessageId, 'inReplyToMessageId')}`)
  }
  if (input.references) {
    headers.push(`References: ${assertNoHeaderInjection(input.references, 'references')}`)
  }
  const raw = [...headers, '', input.body].join('\r\n')
  return Buffer.from(raw, 'utf-8').toString('base64url')
}

async function refreshAccessToken(tokens: OAuthCredentials): Promise<OAuthCredentials> {
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
  return {
    kind: 'oauth',
    accessToken: res.access_token,
    refreshToken: tokens.refreshToken,
    expiresAt: expiresAtFrom(res.expires_in),
  }
}

async function ensureFresh(tokens: OAuthCredentials): Promise<OAuthCredentials> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + 30_000
  return isExpired ? refreshAccessToken(tokens) : tokens
}

const MAX_HISTORY_PAGES = 25 // safety cap on history pagination per poll

const gmailProfileSchema = z.object({ historyId: z.string() })
const gmailHistorySchema = z.object({
  history: z
    .array(z.object({ messagesAdded: z.array(z.object({ message: z.object({ id: z.string() }) })).optional() }))
    .optional(),
  historyId: z.string().optional(),
  nextPageToken: z.string().optional(),
})
const gmailHeaderSchema = z.object({ name: z.string(), value: z.string() })

type GmailPart = { mimeType?: string; body?: { data?: string }; parts?: GmailPart[] }
const gmailPartSchema: z.ZodType<GmailPart> = z.lazy(() =>
  z.object({
    mimeType: z.string().optional(),
    body: z.object({ data: z.string().optional() }).optional(),
    parts: z.array(gmailPartSchema).optional(),
  }),
)
const gmailPayloadSchema = z.object({
  headers: z.array(gmailHeaderSchema).optional(),
  mimeType: z.string().optional(),
  body: z.object({ data: z.string().optional() }).optional(),
  parts: z.array(gmailPartSchema).optional(),
})
const gmailMessageSchema = z.object({
  id: z.string(),
  threadId: z.string(),
  labelIds: z.array(z.string()).optional(),
  internalDate: z.string().optional(),
  payload: gmailPayloadSchema.optional(),
})

function parseFromEmail(value: string): string | null {
  const match = value.match(/<([^>]+)>/)
  const raw = (match ? match[1]! : value).trim().toLowerCase()
  return raw.includes('@') ? raw : null
}

function toHeaderRecord(headers: { name: string; value: string }[]): Record<string, string> {
  const record: Record<string, string> = {}
  for (const header of headers) record[header.name.toLowerCase()] = header.value
  return record
}

function extractPlainText(part: GmailPart): string | null {
  if (part.mimeType === 'text/plain' && part.body?.data) {
    return Buffer.from(part.body.data, 'base64url').toString('utf-8')
  }
  for (const child of part.parts ?? []) {
    const found = extractPlainText(child)
    if (found) return found
  }
  return null
}

async function fetchGmailHistoryId(authHeader: Record<string, string>): Promise<string> {
  const profile = await fetchJson(
    'https://gmail.googleapis.com/gmail/v1/users/me/profile',
    { method: 'GET', headers: authHeader },
    gmailProfileSchema,
  )
  return profile.historyId
}

export const gmailProvider: OAuthMailboxProvider = {
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
      tokens: {
        kind: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
      emailAddress: profile.email,
      displayName: profile.name ?? null,
    }
  },

  async sendEmail(credentials: MailboxCredentials, input: SendEmailInput) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'gmail'))
    const payload: { raw: string; threadId?: string } = { raw: encodeMessage('me', input) }
    if (input.threadId) payload.threadId = input.threadId
    const sendResponse = await fetchJson(
      'https://gmail.googleapis.com/gmail/v1/users/me/messages/send',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      },
      sendResponseSchema,
    )
    return { result: { providerMessageId: sendResponse.id, threadId: sendResponse.threadId }, tokens: fresh }
  },

  async fetchInbound(credentials: MailboxCredentials, cursor: string | null) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'gmail'))
    const auth = { Authorization: `Bearer ${fresh.accessToken}` }

    if (!cursor) {
      const historyId = await fetchGmailHistoryId(auth)
      return { result: { messages: [], cursor: historyId }, tokens: fresh }
    }

    const ids: string[] = []
    let latestHistoryId = cursor
    let pageToken: string | undefined
    let pages = 0
    try {
      do {
        const url = new URL('https://gmail.googleapis.com/gmail/v1/users/me/history')
        url.searchParams.set('startHistoryId', cursor)
        url.searchParams.set('historyTypes', 'messageAdded')
        if (pageToken) url.searchParams.set('pageToken', pageToken)
        const page = await fetchJson(url.toString(), { method: 'GET', headers: auth }, gmailHistorySchema)
        for (const entry of page.history ?? []) {
          for (const added of entry.messagesAdded ?? []) ids.push(added.message.id)
        }
        pageToken = page.nextPageToken
        pages += 1
        // Only trust historyId on the terminal page. If MAX_HISTORY_PAGES cuts
        // the walk off while pageToken is still set, keep the original cursor so
        // the unfetched remainder is retried on the next poll instead of skipped.
        if (!pageToken && page.historyId) latestHistoryId = page.historyId
      } while (pageToken && pages < MAX_HISTORY_PAGES)
    } catch (error) {
      // 404 = startHistoryId expired; re-baseline to the current position and
      // skip this cycle rather than replaying the whole mailbox.
      if (isAppError(error) && (error.context as { status?: number }).status === 404) {
        const historyId = await fetchGmailHistoryId(auth)
        return { result: { messages: [], cursor: historyId }, tokens: fresh }
      }
      throw error
    }

    const messages: InboundMessage[] = []
    for (const id of Array.from(new Set(ids))) {
      const message = await fetchJson(
        `https://gmail.googleapis.com/gmail/v1/users/me/messages/${id}?format=full`,
        { method: 'GET', headers: auth },
        gmailMessageSchema,
      )
      const labels = message.labelIds ?? []
      if (labels.includes('SENT') || labels.includes('DRAFT')) continue
      const headers = message.payload?.headers ?? []
      const fromHeader = headers.find((h) => h.name.toLowerCase() === 'from')?.value ?? ''
      const fromEmail = parseFromEmail(fromHeader)
      if (!fromEmail) continue
      const subject = headers.find((h) => h.name.toLowerCase() === 'subject')?.value ?? null
      const body = (message.payload ? extractPlainText(message.payload) : null) ?? ''
      const receivedAt = message.internalDate
        ? new Date(Number(message.internalDate)).toISOString()
        : new Date().toISOString()
      messages.push({
        providerMessageId: message.id,
        threadId: message.threadId,
        fromEmail,
        subject,
        body,
        receivedAt,
        headers: toHeaderRecord(headers),
      })
    }

    const result: FetchInboundResult = { messages, cursor: latestHistoryId }
    return { result, tokens: fresh }
  },
}
