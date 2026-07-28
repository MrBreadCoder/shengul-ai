import { randomUUID } from 'node:crypto'
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

// Base64 payload lines must not exceed 76 columns per RFC 2045.
const BASE64_LINE_LENGTH = 76
const BASE64_LINE_RE = new RegExp(`.{1,${BASE64_LINE_LENGTH}}`, 'g')

function wrapBase64(value: string): string {
  return (value.match(BASE64_LINE_RE) ?? []).join('\r\n')
}

// Dashes stripped from the uuid so the full `Content-Type: multipart/mixed;
// boundary="…"` header fits inside BASE64_LINE_LENGTH — with them it is 80
// columns. Entropy is unchanged; only the hyphens are dropped.
function newBoundary(): string {
  return `b_${randomUUID().replace(/-/g, '')}`
}

// RFC 2822 message, base64url-encoded per Gmail API. Flat text/plain when there
// is nothing to attach; multipart/mixed otherwise.
function encodeMessage(from: string, input: SendEmailInput): string {
  const to = assertNoHeaderInjection(input.to, 'to')
  const subject = assertNoHeaderInjection(input.subject, 'subject')
  const attachments = input.attachments ?? []
  const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${subject}`]
  if (input.inReplyToMessageId) {
    headers.push(`In-Reply-To: ${assertNoHeaderInjection(input.inReplyToMessageId, 'inReplyToMessageId')}`)
  }
  if (input.references) {
    headers.push(`References: ${assertNoHeaderInjection(input.references, 'references')}`)
  }

  if (attachments.length === 0) {
    headers.push('Content-Type: text/plain; charset="UTF-8"')
    const raw = [...headers, '', input.body].join('\r\n')
    return Buffer.from(raw, 'utf-8').toString('base64url')
  }

  const boundary = newBoundary()
  headers.push('MIME-Version: 1.0', `Content-Type: multipart/mixed; boundary="${boundary}"`)

  // base64, not 7bit: replies are model-written and routinely contain em dashes
  // and curly quotes, which are 8-bit octets a 7bit declaration would be lying
  // about. Encoding sidesteps the question entirely.
  const parts: string[] = [
    `--${boundary}`,
    'Content-Type: text/plain; charset="UTF-8"',
    'Content-Transfer-Encoding: base64',
    '',
    wrapBase64(Buffer.from(input.body, 'utf-8').toString('base64')),
  ]
  for (const attachment of attachments) {
    // file_name is sanitized at upload time, but In-Reply-To/References already
    // taught us not to trust anything reaching a header — re-assert here so a
    // row written before the sanitizer existed cannot inject.
    const fileName = assertNoHeaderInjection(attachment.fileName, 'attachmentFileName')
    const mimeType = assertNoHeaderInjection(attachment.mimeType, 'attachmentMimeType')
    parts.push(
      `--${boundary}`,
      `Content-Type: ${mimeType}; name="${fileName}"`,
      'Content-Transfer-Encoding: base64',
      `Content-Disposition: attachment; filename="${fileName}"`,
      '',
      wrapBase64(attachment.content.toString('base64')),
    )
  }
  parts.push(`--${boundary}--`)

  const raw = [...headers, '', ...parts].join('\r\n')
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
