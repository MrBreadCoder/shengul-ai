import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError, isAppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from './headers'
import {
  requireOAuthCredentials,
  type ExchangeResult, type FetchInboundResult, type InboundMessage, type MailboxCredentials,
  type OAuthCredentials, type OAuthMailboxProvider, type SendEmailInput,
} from './provider'

const REDIRECT_PATH = '/api/mailboxes/outlook/callback'
const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const SCOPES = [
  'https://graph.microsoft.com/Mail.Send',
  'https://graph.microsoft.com/Mail.Read',
  'https://graph.microsoft.com/User.Read',
  'offline_access',
].join(' ')

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

async function refreshAccessToken(tokens: OAuthCredentials): Promise<OAuthCredentials> {
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
    kind: 'oauth',
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? tokens.refreshToken,
    expiresAt: expiresAtFrom(res.expires_in),
  }
}

async function ensureFresh(tokens: OAuthCredentials): Promise<OAuthCredentials> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + 30_000
  return isExpired ? refreshAccessToken(tokens) : tokens
}

const MAX_DELTA_PAGES = 25
const INBOX_DELTA_URL =
  'https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta' +
  '?$select=id,conversationId,subject,from,receivedDateTime,body,isDraft,internetMessageHeaders'

const graphMessageSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  subject: z.string().nullable().optional(),
  from: z
    .object({ emailAddress: z.object({ address: z.string().optional() }).optional() })
    .nullable()
    .optional(),
  receivedDateTime: z.string().optional(),
  body: z.object({ content: z.string().optional() }).nullable().optional(),
  isDraft: z.boolean().optional(),
  internetMessageHeaders: z
    .array(z.object({ name: z.string(), value: z.string() }))
    .nullable()
    .optional(),
})
const graphDeltaSchema = z.object({
  value: z.array(graphMessageSchema),
  '@odata.nextLink': z.string().optional(),
  '@odata.deltaLink': z.string().optional(),
})

// Walks the delta feed from `cursor` (or a fresh baseline when null, mirroring
// Gmail's cursor===null path) and returns the mapped messages plus the next
// cursor to resume from. Extracted so fetchInbound can re-run it against a
// fresh baseline after a 410 without duplicating the pagination logic.
async function walkDelta(
  headers: Record<string, string>,
  cursor: string | null,
): Promise<FetchInboundResult> {
  const messages: InboundMessage[] = []
  let nextUrl: string | undefined = cursor ?? INBOX_DELTA_URL
  let deltaLink: string | undefined
  let pages = 0

  while (nextUrl && pages < MAX_DELTA_PAGES) {
    const page: z.infer<typeof graphDeltaSchema> = await fetchJson(
      nextUrl,
      { method: 'GET', headers },
      graphDeltaSchema,
    )
    // On a fresh baseline (cursor === null) we only want the delta link, not
    // the backlog — so skip mapping until we already had a cursor.
    if (cursor) {
      for (const raw of page.value) {
        const mapped = toInboundMessage(raw)
        if (mapped) messages.push(mapped)
      }
    }
    deltaLink = page['@odata.deltaLink']
    nextUrl = page['@odata.nextLink']
    pages += 1
  }

  // Graph always terminates a delta walk with a deltaLink; fall back to the
  // previous cursor (or the base URL) if a page cap cut us off mid-walk.
  const nextCursor = deltaLink ?? cursor ?? INBOX_DELTA_URL
  return { messages, cursor: nextCursor }
}

function toInboundMessage(m: z.infer<typeof graphMessageSchema>): InboundMessage | null {
  if (m.isDraft) return null
  const address = m.from?.emailAddress?.address
  if (!address) return null
  return {
    providerMessageId: m.id,
    threadId: m.conversationId ?? m.id,
    fromEmail: address.trim().toLowerCase(),
    subject: m.subject ?? null,
    body: m.body?.content ?? '',
    receivedAt: m.receivedDateTime ?? new Date().toISOString(),
    // Graph omits internetMessageHeaders on some delta pages; {} then means
    // "unknown", and bounce detection falls back to sender + subject + body.
    headers: Object.fromEntries(
      (m.internetMessageHeaders ?? []).map((h) => [h.name.toLowerCase(), h.value]),
    ),
  }
}

export const outlookProvider: OAuthMailboxProvider = {
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
      tokens: {
        kind: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
      emailAddress,
      displayName: profile.displayName ?? null,
    }
  },

  async sendEmail(credentials: MailboxCredentials, input: SendEmailInput) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'outlook'))
    // Graph threads a message when it carries In-Reply-To / References headers
    // that point at the original conversation's Message-IDs. threadId isn't
    // used directly by Graph sendMail, so we thread purely via these headers.
    const internetMessageHeaders: { name: string; value: string }[] = []
    if (input.inReplyToMessageId) {
      internetMessageHeaders.push({
        name: 'In-Reply-To',
        value: assertNoHeaderInjection(input.inReplyToMessageId, 'inReplyToMessageId'),
      })
    }
    if (input.references) {
      internetMessageHeaders.push({ name: 'References', value: assertNoHeaderInjection(input.references, 'references') })
    }
    // Under the 3MB per-email ceiling Graph accepts inline fileAttachments on
    // the sendMail call itself. Anything larger would need a draft plus
    // createUploadSession, which is deliberately out of scope.
    const attachments = (input.attachments ?? []).map((attachment) => ({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: assertNoHeaderInjection(attachment.fileName, 'attachmentFileName'),
      contentType: assertNoHeaderInjection(attachment.mimeType, 'attachmentMimeType'),
      contentBytes: attachment.content.toString('base64'),
    }))
    await fetchJson(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: assertNoHeaderInjection(input.subject, 'subject'),
            body: { contentType: 'Text', content: input.body },
            toRecipients: [{ emailAddress: { address: assertNoHeaderInjection(input.to, 'to') } }],
            ...(internetMessageHeaders.length > 0 ? { internetMessageHeaders } : {}),
            ...(attachments.length > 0 ? { attachments } : {}),
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

  async fetchInbound(credentials: MailboxCredentials, cursor: string | null) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'outlook'))
    const headers = {
      Authorization: `Bearer ${fresh.accessToken}`,
      Prefer: 'outlook.body-content-type="text"',
    }

    try {
      const result = await walkDelta(headers, cursor)
      return { result, tokens: fresh }
    } catch (error) {
      // 410 Gone = the delta link expired (Graph's resyncRequired signal).
      // Re-baseline to a fresh delta link and skip this cycle rather than
      // failing every poll forever — mirrors Gmail's 404/startHistoryId-expired
      // handling above.
      if (isAppError(error) && (error.context as { status?: number }).status === 410) {
        const result = await walkDelta(headers, null)
        return { result, tokens: fresh }
      }
      throw error
    }
  },
}
