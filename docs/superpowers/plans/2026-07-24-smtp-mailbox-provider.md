# SMTP/IMAP Mailbox Provider Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator connect a mailbox with an SMTP/IMAP username and password instead of a Google/Microsoft OAuth grant, with full parity — sending, reply ingestion, bounce detection, warmup, and health.

**Architecture:** `MailboxTokens` becomes a `MailboxCredentials` discriminated union (`kind: 'oauth' | 'smtp'`) stored in the same AES-256-GCM-encrypted `mailboxes.oauth` column. OAuth-only methods split off `MailboxProvider` into `OAuthMailboxProvider`, so `smtpProvider` implements the base contract with no stub methods. SMTP failures are mapped onto the existing closed `AppErrorCode` union with an HTTP-ish `context.status`, which makes the existing `withRetry` and `sender.ts` auth-blocking behavior work unchanged.

**Tech Stack:** Next.js App Router (route handlers, `runtime = 'nodejs'`), TypeScript strict, Zod, Supabase, Vitest, `nodemailer`, `imapflow`, `mailparser`.

**Spec:** `docs/superpowers/specs/2026-07-24-smtp-mailbox-design.md`

## Global Constraints

These apply to every task. Sourced from `.claude/QUALITY.md`, `.claude/BEHAVIORS.md`, `.claude/ANTI_LAZY.md`, and the spec.

- Package manager is **pnpm**. Test: `pnpm test`. Typecheck: `pnpm typecheck`. Lint: `pnpm lint`.
- Never use `any`. Use `unknown` and narrow.
- Every function has an **explicit return type**.
- **Named exports** only (default exports only for Next.js pages/layouts).
- Zod validates all external input (route bodies, parsed jsonb).
- Never use bare `Error` — always `AppError(code, message, context)`. `AppErrorCode` is a **closed union**: `VALIDATION_ERROR | NOT_FOUND | UNAUTHORIZED | FORBIDDEN | RATE_LIMITED | EXTERNAL_TIMEOUT | EXTERNAL_ERROR | DB_ERROR | CONFIG_ERROR | INVARIANT_VIOLATION`. Do not add members.
- No `console.log`. No `TODO`/`FIXME` comments. No commented-out code.
- Tests colocated as `feature.test.ts`. Naming: `it('should [behavior] when [condition]')`. Arrange-Act-Assert.
- Mock external libraries at the module boundary. **No real network in unit tests.**
- DB columns are `snake_case`; TypeScript is `camelCase`. Map explicitly.
- Files under `src/` only.
- The password must never appear in a log line, an event payload, or a response body.
- Commit after every task.

---

### Task 1: Credential model — `MailboxCredentials` union and provider interface split

Pure refactor. No new dependencies, no DB changes, no behavior change. Everything must still pass at the end.

**Files:**
- Modify: `src/lib/mailbox/provider.ts`
- Create: `src/lib/mailbox/headers.ts`
- Create: `src/lib/mailbox/headers.test.ts`
- Modify: `src/lib/mailbox/tokens.ts`
- Modify: `src/lib/mailbox/tokens.test.ts`
- Modify: `src/lib/mailbox/gmail-provider.ts`
- Modify: `src/lib/mailbox/gmail-provider.test.ts`
- Modify: `src/lib/mailbox/outlook-provider.ts`
- Modify: `src/lib/mailbox/outlook-provider.test.ts`
- Modify: `src/lib/mailbox/provider.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `OAuthCredentials`, `SmtpCredentials`, `MailboxCredentials`, `MailboxProvider` (base, no OAuth methods), `OAuthMailboxProvider`, `requireOAuthCredentials(credentials, provider): OAuthCredentials`, `requireSmtpCredentials(credentials, provider): SmtpCredentials` — all from `@/lib/mailbox/provider`. `assertNoHeaderInjection(value, field): string` from `@/lib/mailbox/headers`. `encryptMailboxTokens(credentials: MailboxCredentials)` and `parseMailboxTokens(oauth, mailboxId): MailboxCredentials` from `@/lib/mailbox/tokens`.

- [ ] **Step 1: Write the failing test for the shared header guard**

Create `src/lib/mailbox/headers.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from './headers'

describe('assertNoHeaderInjection', () => {
  it('should return the value unchanged when it has no line breaks', () => {
    expect(assertNoHeaderInjection('Hello there', 'subject')).toBe('Hello there')
  })

  it('should throw VALIDATION_ERROR when the value contains a line feed', () => {
    expect(() => assertNoHeaderInjection('a\nBcc: attacker@evil.com', 'subject')).toThrow(AppError)
  })

  it('should throw VALIDATION_ERROR when the value contains a carriage return', () => {
    try {
      assertNoHeaderInjection('a\rBcc: attacker@evil.com', 'to')
      expect.unreachable('expected assertNoHeaderInjection to throw')
    } catch (error) {
      expect(error).toBeInstanceOf(AppError)
      expect((error as AppError).code).toBe('VALIDATION_ERROR')
      expect((error as AppError).context).toMatchObject({ field: 'to' })
    }
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/lib/mailbox/headers.test.ts`
Expected: FAIL — `Failed to resolve import "./headers"`.

- [ ] **Step 3: Create the shared header guard**

Create `src/lib/mailbox/headers.ts` (moved verbatim from the duplicated copies in `gmail-provider.ts` and `outlook-provider.ts`):

```ts
import { AppError } from '@/lib/errors/app-error'

// A CR or LF inside a header value lets an attacker inject extra headers (or
// end the header block early and forge the body) into the raw RFC 2822
// message. None of these fields ever legitimately contain a line break, and
// In-Reply-To / References are round-tripped from inbound headers the
// counterparty controls, so this is a real injection surface.
export function assertNoHeaderInjection(value: string, field: string): string {
  if (/[\r\n]/.test(value)) {
    throw new AppError('VALIDATION_ERROR', 'Email header value contains illegal line break characters', { field })
  }
  return value
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run src/lib/mailbox/headers.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Rewrite `provider.ts` with the credential union and interface split**

Replace the whole of `src/lib/mailbox/provider.ts`:

```ts
import { AppError } from '@/lib/errors/app-error'

export interface OAuthCredentials {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
}

export interface SmtpCredentials {
  kind: 'smtp'
  // The From address. Lives here rather than being read from
  // mailboxes.email_address because sendEmail only ever receives credentials,
  // not the row. User-entered: SMTP/IMAP have no profile endpoint to discover
  // it from, unlike the Gmail/Graph userinfo lookups in exchangeCode.
  emailAddress: string
  username: string
  password: string
  smtpHost: string
  smtpPort: number
  smtpSecure: boolean // true = implicit TLS (465), false = STARTTLS (587)
  imapHost: string
  imapPort: number
  imapSecure: boolean
}

export type MailboxCredentials = OAuthCredentials | SmtpCredentials

export interface SendEmailInput {
  to: string
  subject: string
  body: string
  // Threading (follow-ups only). threadId is the provider conversation id from
  // the first-touch send; inReplyToMessageId/references are RFC 2822 Message-IDs
  // used to build the In-Reply-To / References headers so the reply threads.
  threadId?: string | null
  inReplyToMessageId?: string | null
  references?: string | null
}

export interface SendEmailResult {
  providerMessageId: string
  threadId: string
}

export interface ExchangeResult {
  // Only ever produced by an OAuth code exchange, so this narrows past the union.
  tokens: OAuthCredentials
  emailAddress: string
  displayName: string | null
}

export interface InboundMessage {
  providerMessageId: string   // Gmail message id / Graph message id / RFC Message-ID — inbound dedup key
  threadId: string            // Gmail threadId / Graph conversationId / root Message-ID
  fromEmail: string           // lowercased sender address
  subject: string | null
  body: string                // plain text
  receivedAt: string          // ISO
  // Lowercased header names -> value (last wins). Gmail and SMTP always
  // populate this from the full message; Graph only when it returns
  // internetMessageHeaders, so consumers must treat {} as "unknown", not "absent".
  headers: Record<string, string>
}

export interface FetchInboundResult {
  // Opaque, provider-specific: Gmail historyId, Outlook delta link, SMTP
  // JSON {uidValidity,lastUid}. Persisted per-mailbox and passed back on the
  // next poll. A null cursor means "baseline now, ingest nothing".
  messages: InboundMessage[]
  cursor: string
}

/**
 * What every mailbox implementation must provide. Deliberately excludes the
 * OAuth handshake: an SMTP mailbox authenticates with a stored password and
 * has no consent screen. sender.ts, reader.ts, and the test-email route all
 * consume this base type via the registry.
 */
export interface MailboxProvider {
  readonly provider: 'gmail' | 'outlook' | 'smtp'
  // Returns the send result plus (possibly refreshed) credentials to persist.
  sendEmail(
    credentials: MailboxCredentials,
    input: SendEmailInput,
  ): Promise<{ result: SendEmailResult; tokens: MailboxCredentials }>
  // Returns new inbound messages since `cursor`, plus the next cursor and any
  // refreshed credentials to persist. A null cursor baselines (empty messages).
  fetchInbound(
    credentials: MailboxCredentials,
    cursor: string | null,
  ): Promise<{ result: FetchInboundResult; tokens: MailboxCredentials }>
}

/** A provider whose connection flow is an OAuth redirect + code exchange. */
export interface OAuthMailboxProvider extends MailboxProvider {
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<ExchangeResult>
}

// The registry hands every provider the same union, so each implementation
// narrows at its entry point. A mismatch means a mailbox row's provider column
// disagrees with its stored credential shape — a data/programming error, not a
// user-recoverable one.
export function requireOAuthCredentials(
  credentials: MailboxCredentials,
  provider: string,
): OAuthCredentials {
  if (credentials.kind !== 'oauth') {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox provider received credentials of the wrong kind', {
      provider,
      expected: 'oauth',
      received: credentials.kind,
    })
  }
  return credentials
}

export function requireSmtpCredentials(
  credentials: MailboxCredentials,
  provider: string,
): SmtpCredentials {
  if (credentials.kind !== 'smtp') {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox provider received credentials of the wrong kind', {
      provider,
      expected: 'smtp',
      received: credentials.kind,
    })
  }
  return credentials
}
```

- [ ] **Step 6: Update `provider.test.ts` for the split interface**

Replace the whole of `src/lib/mailbox/provider.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import {
  requireOAuthCredentials,
  requireSmtpCredentials,
  type MailboxProvider,
  type OAuthMailboxProvider,
  type SmtpCredentials,
} from './provider'

const smtpCredentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

// A compile-and-shape guard: a conforming object satisfies the interface.
describe('MailboxProvider contract', () => {
  it('should accept a password-authenticated implementation with no OAuth methods', () => {
    const fake: MailboxProvider = {
      provider: 'smtp',
      sendEmail: async (credentials) => ({
        result: { providerMessageId: 'm', threadId: 't' },
        tokens: credentials,
      }),
      fetchInbound: async (credentials) => ({
        result: { messages: [], cursor: 'c1' },
        tokens: credentials,
      }),
    }
    expect(fake.provider).toBe('smtp')
  })

  it('should accept an OAuth implementation through OAuthMailboxProvider', () => {
    const fake: OAuthMailboxProvider = {
      provider: 'gmail',
      buildAuthUrl: (state) => `https://auth?state=${state}`,
      exchangeCode: async () => ({
        tokens: { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: '2026-01-01T00:00:00Z' },
        emailAddress: 'x@y.com',
        displayName: null,
      }),
      sendEmail: async (credentials) => ({
        result: { providerMessageId: 'm', threadId: 't' },
        tokens: credentials,
      }),
      fetchInbound: async (credentials) => ({
        result: { messages: [], cursor: 'c1' },
        tokens: credentials,
      }),
    }
    expect(fake.buildAuthUrl('s')).toContain('state=s')
  })
})

describe('requireOAuthCredentials', () => {
  it('should return the credentials unchanged when the kind is oauth', () => {
    const oauth = { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: 'z' } as const
    expect(requireOAuthCredentials(oauth, 'gmail')).toBe(oauth)
  })

  it('should throw INVARIANT_VIOLATION when given smtp credentials', () => {
    try {
      requireOAuthCredentials(smtpCredentials, 'gmail')
      expect.unreachable('expected requireOAuthCredentials to throw')
    } catch (error) {
      expect((error as AppError).code).toBe('INVARIANT_VIOLATION')
    }
  })

  it('should not leak the password into the error context', () => {
    try {
      requireOAuthCredentials(smtpCredentials, 'gmail')
      expect.unreachable('expected requireOAuthCredentials to throw')
    } catch (error) {
      expect(JSON.stringify((error as AppError).context)).not.toContain('pw')
    }
  })
})

describe('requireSmtpCredentials', () => {
  it('should return the credentials unchanged when the kind is smtp', () => {
    expect(requireSmtpCredentials(smtpCredentials, 'smtp')).toBe(smtpCredentials)
  })

  it('should throw INVARIANT_VIOLATION when given oauth credentials', () => {
    const oauth = { kind: 'oauth', accessToken: 'a', refreshToken: 'r', expiresAt: 'z' } as const
    expect(() => requireSmtpCredentials(oauth, 'smtp')).toThrow(AppError)
  })
})
```

- [ ] **Step 7: Run it and confirm it fails**

Run: `pnpm vitest run src/lib/mailbox/provider.test.ts`
Expected: PASS (the implementation from Step 5 already satisfies it). If it fails, fix `provider.ts` before continuing.

- [ ] **Step 8: Teach `tokens.ts` the three credential shapes**

Replace the schema block and the two parse functions in `src/lib/mailbox/tokens.ts`. Keep `ALGORITHM`, `IV_BYTES`, `encryptedTokensSchema`, and `encryptionKey()` exactly as they are.

Replace this:

```ts
const tokensSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})
```

with:

```ts
const oauthCredentialsSchema = z.object({
  kind: z.literal('oauth'),
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

const smtpCredentialsSchema = z.object({
  kind: z.literal('smtp'),
  emailAddress: z.string(),
  username: z.string(),
  password: z.string(),
  smtpHost: z.string(),
  smtpPort: z.number(),
  smtpSecure: z.boolean(),
  imapHost: z.string(),
  imapPort: z.number(),
  imapSecure: z.boolean(),
})

const credentialsSchema = z.discriminatedUnion('kind', [oauthCredentialsSchema, smtpCredentialsSchema])

// Tokens persisted before the `kind` discriminator existed. Both plaintext and
// already-encrypted rows can be in this shape, so it is checked on both paths.
const legacyOAuthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

// Accepts current tagged credentials or legacy untagged OAuth tokens,
// normalizing the latter to `kind: 'oauth'`. Returns null when neither matches.
function parseCredentialShape(value: unknown): MailboxCredentials | null {
  const tagged = credentialsSchema.safeParse(value)
  if (tagged.success) return tagged.data

  const legacy = legacyOAuthSchema.safeParse(value)
  if (legacy.success) return { kind: 'oauth', ...legacy.data }

  return null
}
```

Change the import at the top of the file from `import type { MailboxTokens } from './provider'` to:

```ts
import type { MailboxCredentials } from './provider'
```

Change the `encryptMailboxTokens` signature line from `export function encryptMailboxTokens(tokens: MailboxTokens): Record<string, Json> {` to:

```ts
export function encryptMailboxTokens(tokens: MailboxCredentials): Record<string, Json> {
```

Replace the body of `decryptMailboxTokens` so it uses `parseCredentialShape`, and change its return type to `MailboxCredentials`:

```ts
function decryptMailboxTokens(
  encrypted: z.infer<typeof encryptedTokensSchema>,
  mailboxId: string,
): MailboxCredentials {
  try {
    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), Buffer.from(encrypted.iv, 'base64'))
    decipher.setAuthTag(Buffer.from(encrypted.tag, 'base64'))
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(encrypted.data, 'base64')),
      decipher.final(),
    ])
    const parsed = parseCredentialShape(JSON.parse(plaintext.toString('utf-8')))
    if (!parsed) throw new Error('decrypted payload failed schema validation')
    return parsed
  } catch (cause) {
    throw new AppError('INVARIANT_VIOLATION', 'Failed to decrypt mailbox oauth tokens', {
      mailboxId,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

Replace `parseMailboxTokens`:

```ts
// Validates the mailbox oauth jsonb into typed credentials. Throws on malformed
// input — a mailbox with unusable credentials is a programming/config error,
// not an operational one.
//
// Accepts three shapes: encrypted-at-rest (current), plaintext tagged
// credentials, and legacy untagged plaintext OAuth tokens persisted before
// encryption was added. The legacy paths are backward compatibility only —
// every refresh/reconnect re-persists via encryptMailboxTokens, so old rows
// self-heal over time without a manual backfill.
export function parseMailboxTokens(oauth: Json, mailboxId: string): MailboxCredentials {
  const encrypted = encryptedTokensSchema.safeParse(oauth)
  if (encrypted.success) return decryptMailboxTokens(encrypted.data, mailboxId)

  const parsed = parseCredentialShape(oauth)
  if (!parsed) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox oauth tokens malformed', { mailboxId })
  }
  return parsed
}
```

- [ ] **Step 9: Extend `tokens.test.ts` for the SMTP and legacy shapes**

Append to `src/lib/mailbox/tokens.test.ts` (keep every existing test — they now cover the legacy untagged path):

```ts
const smtpCredentials = {
  kind: 'smtp' as const,
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'smtp-password-fixture-qhvnz',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

describe('encryptMailboxTokens with smtp credentials', () => {
  it('should never expose the password in the ciphertext blob', () => {
    const encrypted = encryptMailboxTokens(smtpCredentials)
    expect(JSON.stringify(encrypted)).not.toContain('smtp-password-fixture')
    expect(JSON.stringify(encrypted)).not.toContain('imap.client.com')
  })
})

describe('parseMailboxTokens credential shapes', () => {
  it('should round-trip smtp credentials through encrypt then parse', () => {
    const encrypted = encryptMailboxTokens(smtpCredentials)
    expect(parseMailboxTokens(encrypted, 'm1')).toEqual(smtpCredentials)
  })

  it('should round-trip tagged oauth credentials through encrypt then parse', () => {
    const tagged = { kind: 'oauth' as const, ...tokens }
    const encrypted = encryptMailboxTokens(tagged)
    expect(parseMailboxTokens(encrypted, 'm1')).toEqual(tagged)
  })

  it('should normalize legacy untagged plaintext tokens to kind oauth', () => {
    expect(parseMailboxTokens(tokens, 'm1')).toEqual({ kind: 'oauth', ...tokens })
  })

  it('should normalize legacy untagged encrypted tokens to kind oauth', () => {
    // Encrypt the untagged shape directly to simulate a row written before the
    // discriminator existed — the common case for already-connected mailboxes.
    const encrypted = encryptMailboxTokens(tokens as never)
    expect(parseMailboxTokens(encrypted, 'm1')).toEqual({ kind: 'oauth', ...tokens })
  })

  it('should throw INVARIANT_VIOLATION when smtp credentials are missing a field', () => {
    const { imapHost: _omitted, ...incomplete } = smtpCredentials
    expect(() => parseMailboxTokens(incomplete, 'm1')).toThrow(AppError)
  })
})
```

- [ ] **Step 10: Run the token tests**

Run: `pnpm vitest run src/lib/mailbox/tokens.test.ts`
Expected: PASS, all tests including the five new ones.

- [ ] **Step 11: Narrow credentials in `gmail-provider.ts`**

In `src/lib/mailbox/gmail-provider.ts`:

Replace the type import and add the header helper import:

```ts
import { assertNoHeaderInjection } from './headers'
import {
  requireOAuthCredentials,
  type ExchangeResult, type FetchInboundResult, type InboundMessage, type MailboxCredentials,
  type OAuthCredentials, type OAuthMailboxProvider, type SendEmailInput,
} from './provider'
```

Delete the local `assertNoHeaderInjection` function (now imported from `./headers`).

Change `refreshAccessToken` and `ensureFresh` to `OAuthCredentials`:

```ts
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
```

Change the exported object's type annotation and the two method entry points:

```ts
export const gmailProvider: OAuthMailboxProvider = {
```

In `exchangeCode`, change the returned tokens object to:

```ts
      tokens: {
        kind: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
```

In `sendEmail`, change the first line of the body:

```ts
  async sendEmail(credentials: MailboxCredentials, input: SendEmailInput) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'gmail'))
```

In `fetchInbound`, change the signature and first line:

```ts
  async fetchInbound(credentials: MailboxCredentials, cursor: string | null) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'gmail'))
```

- [ ] **Step 12: Narrow credentials in `outlook-provider.ts`**

Apply the same five changes to `src/lib/mailbox/outlook-provider.ts`:

Imports:

```ts
import { assertNoHeaderInjection } from './headers'
import {
  requireOAuthCredentials,
  type ExchangeResult, type FetchInboundResult, type InboundMessage, type MailboxCredentials,
  type OAuthCredentials, type OAuthMailboxProvider, type SendEmailInput,
} from './provider'
```

Delete the local `assertNoHeaderInjection`.

```ts
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
```

```ts
export const outlookProvider: OAuthMailboxProvider = {
```

In `exchangeCode`:

```ts
      tokens: {
        kind: 'oauth',
        accessToken: token.access_token,
        refreshToken: token.refresh_token,
        expiresAt: expiresAtFrom(token.expires_in),
      },
```

In `sendEmail` and `fetchInbound`:

```ts
  async sendEmail(credentials: MailboxCredentials, input: SendEmailInput) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'outlook'))
```

```ts
  async fetchInbound(credentials: MailboxCredentials, cursor: string | null) {
    const fresh = await ensureFresh(requireOAuthCredentials(credentials, 'outlook'))
```

- [ ] **Step 13: Add `kind: 'oauth'` to every token fixture in the provider tests**

In `src/lib/mailbox/gmail-provider.test.ts` and `src/lib/mailbox/outlook-provider.test.ts`, every literal passed as the first argument to `sendEmail` or `fetchInbound` needs the discriminator. For example:

```ts
const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }
```

becomes:

```ts
const tokens = {
  kind: 'oauth' as const,
  accessToken: 'at',
  refreshToken: 'rt',
  expiresAt: new Date(Date.now() + 60_000).toISOString(),
}
```

Assertions on `result.tokens.accessToken` are unaffected. Assertions comparing a whole tokens object with `toEqual` need `kind: 'oauth'` added to the expected value.

- [ ] **Step 14: Run the full suite and typecheck**

Run: `pnpm typecheck && pnpm test`
Expected: both PASS. `sender.ts`, `reader.ts`, the test-email route, and both OAuth callbacks need no edits — `parseMailboxTokens` now returns the union, which is exactly what `provider.sendEmail`/`fetchInbound` accept, and `encryptMailboxTokens` accepts the union.

If `pnpm typecheck` reports an error in a file not listed in this task, fix it there rather than widening a type with a cast.

- [ ] **Step 15: Commit**

```bash
git add src/lib/mailbox/
git commit -m "refactor: model mailbox credentials as a tagged union

Splits OAuth-only methods off MailboxProvider into OAuthMailboxProvider so a
password-authenticated provider can implement the base contract without stub
methods, and extracts the header-injection guard duplicated across the Gmail
and Outlook providers.

parseMailboxTokens accepts tagged oauth, tagged smtp, and legacy untagged
tokens, so already-connected mailboxes keep working and self-heal on refresh."
```

---

### Task 2: SMTP/IMAP error mapping

**Files:**
- Create: `src/lib/mailbox/smtp-errors.ts`
- Create: `src/lib/mailbox/smtp-errors.test.ts`
- Modify: `package.json` (dependencies)

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors/app-error`.
- Produces: `type MailStage = 'smtp' | 'imap'`, `MAIL_DEADLINE_MS: number`, `toMailAppError(error: unknown, stage: MailStage): AppError`, `withMailDeadline<T>(stage: MailStage, run: () => Promise<T>): Promise<T>` — all from `@/lib/mailbox/smtp-errors`.

- [ ] **Step 1: Install the mail dependencies**

Run:

```bash
pnpm add nodemailer imapflow mailparser
pnpm add -D @types/nodemailer @types/mailparser
```

Expected: `package.json` gains all five entries; `pnpm-lock.yaml` updates. `imapflow` ships its own types, so it needs no `@types` package.

- [ ] **Step 2: Write the failing test**

Create `src/lib/mailbox/smtp-errors.test.ts`:

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'
import { toMailAppError, withMailDeadline, MAIL_DEADLINE_MS } from './smtp-errors'

// Minimal stand-ins for the error objects nodemailer and imapflow throw.
function mailError(fields: Record<string, unknown>): Error {
  return Object.assign(new Error('mail failure'), fields)
}

describe('toMailAppError', () => {
  it('should map a nodemailer EAUTH failure to UNAUTHORIZED with status 401', () => {
    const mapped = toMailAppError(mailError({ code: 'EAUTH', responseCode: 535 }), 'smtp')
    expect(mapped.code).toBe('UNAUTHORIZED')
    expect(mapped.context).toMatchObject({ status: 401, stage: 'smtp' })
  })

  it('should map an imapflow authenticationFailed error to UNAUTHORIZED with status 401', () => {
    const mapped = toMailAppError(mailError({ authenticationFailed: true }), 'imap')
    expect(mapped.code).toBe('UNAUTHORIZED')
    expect(mapped.context).toMatchObject({ status: 401, stage: 'imap' })
  })

  it('should map a transient SMTP 4xx reply to a retryable status 503', () => {
    // SMTP numbering is inverted vs HTTP: 4xx is "try again later".
    const mapped = toMailAppError(mailError({ responseCode: 451 }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 503, responseCode: 451 })
  })

  it('should map a permanent SMTP 5xx reply to a non-retryable status 502', () => {
    const mapped = toMailAppError(mailError({ responseCode: 550 }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 502, responseCode: 550 })
  })

  it('should map a timeout code to EXTERNAL_TIMEOUT', () => {
    const mapped = toMailAppError(mailError({ code: 'ETIMEDOUT' }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_TIMEOUT')
    expect(mapped.context).toMatchObject({ stage: 'smtp' })
  })

  it('should map a connection failure with no SMTP reply code to status 502', () => {
    const mapped = toMailAppError(mailError({ code: 'ECONNECTION' }), 'smtp')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 502 })
  })

  it('should map an unrecognized error to status 502 rather than throwing', () => {
    const mapped = toMailAppError('a bare string', 'imap')
    expect(mapped.code).toBe('EXTERNAL_ERROR')
    expect(mapped.context).toMatchObject({ status: 502, stage: 'imap' })
  })

  it('should pass an AppError through unchanged', () => {
    const original = new AppError('VALIDATION_ERROR', 'bad header', { field: 'to' })
    expect(toMailAppError(original, 'smtp')).toBe(original)
  })
})

describe('withMailDeadline', () => {
  afterEach(() => vi.useRealTimers())

  it('should resolve with the value when the operation finishes in time', async () => {
    await expect(withMailDeadline('smtp', async () => 'done')).resolves.toBe('done')
  })

  it('should reject with EXTERNAL_TIMEOUT when the operation exceeds the deadline', async () => {
    vi.useFakeTimers()
    const pending = withMailDeadline('imap', () => new Promise<string>(() => {}))
    const assertion = expect(pending).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
    await vi.advanceTimersByTimeAsync(MAIL_DEADLINE_MS + 1)
    await assertion
  })

  it('should propagate the original rejection rather than masking it as a timeout', async () => {
    const boom = mailError({ code: 'EAUTH' })
    await expect(withMailDeadline('smtp', () => Promise.reject(boom))).rejects.toBe(boom)
  })
})
```

- [ ] **Step 3: Run it and confirm it fails**

Run: `pnpm vitest run src/lib/mailbox/smtp-errors.test.ts`
Expected: FAIL — `Failed to resolve import "./smtp-errors"`.

- [ ] **Step 4: Implement the mapping**

Create `src/lib/mailbox/smtp-errors.ts`:

```ts
import { AppError } from '@/lib/errors/app-error'

/** Which protocol leg a failure came from. Surfaced to the connect UI. */
export type MailStage = 'smtp' | 'imap'

/** Deadline for any single SMTP or IMAP operation. */
export const MAIL_DEADLINE_MS = 10_000

// The subset of nodemailer's and imapflow's error shapes we branch on.
// Both throw plain Errors decorated with extra fields, so this is read
// defensively rather than validated.
interface MailErrorShape {
  code?: unknown
  responseCode?: unknown
  authenticationFailed?: unknown
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Maps a nodemailer/imapflow failure onto the app's closed AppErrorCode union.
 *
 * `context.status` is deliberately HTTP-shaped so two existing behaviors keep
 * working with no changes at their call sites:
 *   - withRetry retries only 429/5xx, so transient failures land on 503 and
 *     permanent ones on 502.
 *   - sender.ts blocks a mailbox on status 401, so a rotated SMTP password
 *     auto-blocks exactly like a revoked OAuth grant.
 */
export function toMailAppError(error: unknown, stage: MailStage): AppError {
  if (error instanceof AppError) return error

  const raw = (typeof error === 'object' && error !== null ? error : {}) as MailErrorShape
  const code = typeof raw.code === 'string' ? raw.code : undefined
  const responseCode = typeof raw.responseCode === 'number' ? raw.responseCode : undefined
  const cause = messageOf(error)

  // Checked before responseCode: a failed AUTH also carries SMTP reply 535,
  // which would otherwise be mapped as a generic permanent failure and lose
  // the mailbox-blocking signal.
  if (code === 'EAUTH' || code === 'AUTHENTICATIONFAILED' || raw.authenticationFailed === true) {
    return new AppError('UNAUTHORIZED', 'Mailbox credentials were rejected', { status: 401, stage, cause })
  }

  if (code === 'ETIMEDOUT' || code === 'ESOCKETTIMEDOUT') {
    return new AppError('EXTERNAL_TIMEOUT', 'Mail server did not respond in time', { stage, cause })
  }

  if (responseCode !== undefined) {
    // SMTP reply codes are inverted relative to HTTP: 4xx is transient and
    // worth retrying, 5xx is permanent. Translating rather than passing
    // through is the whole point — a naive copy would retry exactly the
    // failures that can never succeed.
    const status = responseCode >= 400 && responseCode < 500 ? 503 : 502
    return new AppError('EXTERNAL_ERROR', 'Mail server rejected the request', {
      status,
      stage,
      responseCode,
      cause,
    })
  }

  return new AppError('EXTERNAL_ERROR', 'Could not reach the mail server', { status: 502, stage, cause })
}

/**
 * Runs a mail operation under a hard deadline. The libraries have their own
 * timeout options, but they do not cover every stage of a connection, and an
 * unbounded wait inside a serverless invocation is worse than a failure.
 */
export async function withMailDeadline<T>(stage: MailStage, run: () => Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      reject(
        new AppError('EXTERNAL_TIMEOUT', 'Mail operation exceeded its deadline', {
          stage,
          timeoutMs: MAIL_DEADLINE_MS,
        }),
      )
    }, MAIL_DEADLINE_MS)
  })

  try {
    return await Promise.race([run(), deadline])
  } finally {
    if (timer) clearTimeout(timer)
  }
}
```

- [ ] **Step 5: Run it and confirm it passes**

Run: `pnpm vitest run src/lib/mailbox/smtp-errors.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 6: Commit**

```bash
git add package.json pnpm-lock.yaml src/lib/mailbox/smtp-errors.ts src/lib/mailbox/smtp-errors.test.ts
git commit -m "feat: map SMTP and IMAP failures onto the AppError union

SMTP reply codes are inverted relative to HTTP, so transient 4xx replies are
translated to a retryable 503 and permanent 5xx to a non-retryable 502. Auth
failures carry status 401 so the existing mailbox-blocking path in sender.ts
treats a rotated password like a revoked OAuth grant."
```

---

### Task 3: Connection factories and credential verification

**Files:**
- Create: `src/lib/mailbox/smtp-connection.ts`
- Create: `src/lib/mailbox/smtp-connection.test.ts`

**Interfaces:**
- Consumes: `SmtpCredentials` from `@/lib/mailbox/provider`; `toMailAppError`, `withMailDeadline`, `MAIL_DEADLINE_MS` from `@/lib/mailbox/smtp-errors`.
- Produces: `createSmtpTransport(credentials: SmtpCredentials): Transporter`, `createImapClient(credentials: SmtpCredentials): ImapFlow`, `verifySmtpConnection(credentials: SmtpCredentials): Promise<void>`, `verifyImapConnection(credentials: SmtpCredentials): Promise<void>` — all from `@/lib/mailbox/smtp-connection`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/smtp-connection.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SmtpCredentials } from './provider'

const verifyMock = vi.hoisted(() => vi.fn())
const closeTransportMock = vi.hoisted(() => vi.fn())
const createTransportMock = vi.hoisted(() =>
  vi.fn(() => ({ verify: verifyMock, close: closeTransportMock })),
)
vi.mock('nodemailer', () => ({ default: { createTransport: createTransportMock } }))

const connectMock = vi.hoisted(() => vi.fn())
const closeImapMock = vi.hoisted(() => vi.fn())
const imapConstructorMock = vi.hoisted(() => vi.fn())
vi.mock('imapflow', () => ({
  ImapFlow: class {
    connect = connectMock
    close = closeImapMock
    constructor(options: unknown) {
      imapConstructorMock(options)
    }
  },
}))

import {
  createImapClient,
  createSmtpTransport,
  verifyImapConnection,
  verifySmtpConnection,
} from './smtp-connection'

const credentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

beforeEach(() => {
  verifyMock.mockReset().mockResolvedValue(true)
  closeTransportMock.mockReset()
  createTransportMock.mockClear()
  connectMock.mockReset().mockResolvedValue(undefined)
  closeImapMock.mockReset()
  imapConstructorMock.mockReset()
})

describe('createSmtpTransport', () => {
  it('should pass host, port, secure, and auth through to nodemailer', () => {
    createSmtpTransport(credentials)
    expect(createTransportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'smtp.client.com',
        port: 587,
        secure: false,
        auth: { user: 'ops@client.com', pass: 'pw' },
      }),
    )
  })

  it('should set every timeout option so a connection cannot hang unbounded', () => {
    createSmtpTransport(credentials)
    const options = createTransportMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.connectionTimeout).toBeGreaterThan(0)
    expect(options.greetingTimeout).toBeGreaterThan(0)
    expect(options.socketTimeout).toBeGreaterThan(0)
  })
})

describe('createImapClient', () => {
  it('should use the imap host and port, not the smtp ones', () => {
    createImapClient(credentials)
    expect(imapConstructorMock).toHaveBeenCalledWith(
      expect.objectContaining({
        host: 'imap.client.com',
        port: 993,
        secure: true,
        auth: { user: 'ops@client.com', pass: 'pw' },
      }),
    )
  })

  it('should disable the library logger so credentials never reach stdout', () => {
    createImapClient(credentials)
    const options = imapConstructorMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(options.logger).toBe(false)
  })
})

describe('verifySmtpConnection', () => {
  it('should resolve when the transport verifies', async () => {
    await expect(verifySmtpConnection(credentials)).resolves.toBeUndefined()
    expect(verifyMock).toHaveBeenCalledTimes(1)
  })

  it('should close the transport even when verification fails', async () => {
    verifyMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'EAUTH' }))
    await expect(verifySmtpConnection(credentials)).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
    expect(closeTransportMock).toHaveBeenCalledTimes(1)
  })

  it('should map an auth rejection to UNAUTHORIZED with the smtp stage', async () => {
    verifyMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'EAUTH' }))
    await expect(verifySmtpConnection(credentials)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      context: expect.objectContaining({ stage: 'smtp' }),
    })
  })

  it('should never send a message', async () => {
    await verifySmtpConnection(credentials)
    const transport = createTransportMock.mock.results[0]?.value as Record<string, unknown>
    expect(transport.sendMail).toBeUndefined()
  })
})

describe('verifyImapConnection', () => {
  it('should resolve and close the client when the connection authenticates', async () => {
    await expect(verifyImapConnection(credentials)).resolves.toBeUndefined()
    expect(connectMock).toHaveBeenCalledTimes(1)
    expect(closeImapMock).toHaveBeenCalledTimes(1)
  })

  it('should map an auth rejection to UNAUTHORIZED with the imap stage', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('nope'), { authenticationFailed: true }))
    await expect(verifyImapConnection(credentials)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      context: expect.objectContaining({ stage: 'imap' }),
    })
  })

  it('should close the client even when the connection fails', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('nope'), { code: 'ECONNECTION' }))
    await expect(verifyImapConnection(credentials)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
    expect(closeImapMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/lib/mailbox/smtp-connection.test.ts`
Expected: FAIL — `Failed to resolve import "./smtp-connection"`.

- [ ] **Step 3: Implement the connection module**

Create `src/lib/mailbox/smtp-connection.ts`:

```ts
import nodemailer, { type Transporter } from 'nodemailer'
import { ImapFlow } from 'imapflow'
import type { SmtpCredentials } from './provider'
import { MAIL_DEADLINE_MS, toMailAppError, withMailDeadline } from './smtp-errors'

/**
 * A single-use transport. Deliberately unpooled: sends are jittered and spread
 * across a client's mailboxes, so a pooled connection would sit idle far
 * longer than a serverless invocation lives.
 */
export function createSmtpTransport(credentials: SmtpCredentials): Transporter {
  return nodemailer.createTransport({
    host: credentials.smtpHost,
    port: credentials.smtpPort,
    // true = implicit TLS (465); false = plaintext connect then STARTTLS (587).
    secure: credentials.smtpSecure,
    auth: { user: credentials.username, pass: credentials.password },
    connectionTimeout: MAIL_DEADLINE_MS,
    greetingTimeout: MAIL_DEADLINE_MS,
    socketTimeout: MAIL_DEADLINE_MS,
  })
}

export function createImapClient(credentials: SmtpCredentials): ImapFlow {
  return new ImapFlow({
    host: credentials.imapHost,
    port: credentials.imapPort,
    secure: credentials.imapSecure,
    auth: { user: credentials.username, pass: credentials.password },
    // ImapFlow logs the full protocol conversation at info level by default,
    // which includes the AUTH exchange. Never enable this.
    logger: false,
    socketTimeout: MAIL_DEADLINE_MS,
  })
}

/** Authenticates against the SMTP server without sending anything. */
export async function verifySmtpConnection(credentials: SmtpCredentials): Promise<void> {
  const transport = createSmtpTransport(credentials)
  try {
    await withMailDeadline('smtp', () => transport.verify())
  } catch (error) {
    throw toMailAppError(error, 'smtp')
  } finally {
    transport.close()
  }
}

/** Authenticates against the IMAP server. connect() performs the login. */
export async function verifyImapConnection(credentials: SmtpCredentials): Promise<void> {
  const client = createImapClient(credentials)
  try {
    await withMailDeadline('imap', () => client.connect())
  } catch (error) {
    throw toMailAppError(error, 'imap')
  } finally {
    // close() rather than logout(): logout() throws when the connection never
    // came up, which would leak the socket for the rest of the invocation.
    client.close()
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run src/lib/mailbox/smtp-connection.test.ts`
Expected: PASS, 11 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/smtp-connection.ts src/lib/mailbox/smtp-connection.test.ts
git commit -m "feat: add SMTP and IMAP connection factories and verification

Both verifiers authenticate without sending mail, run under a hard deadline,
and tear their connection down on every path. The IMAP client disables the
library logger, which would otherwise write the AUTH exchange to stdout."
```

---

### Task 4: SMTP sending

**Files:**
- Create: `src/lib/mailbox/smtp-send.ts`
- Create: `src/lib/mailbox/smtp-send.test.ts`

**Interfaces:**
- Consumes: `SendEmailInput`, `SendEmailResult`, `SmtpCredentials` from `@/lib/mailbox/provider`; `assertNoHeaderInjection` from `@/lib/mailbox/headers`; `createSmtpTransport` from `@/lib/mailbox/smtp-connection`; `toMailAppError`, `withMailDeadline` from `@/lib/mailbox/smtp-errors`.
- Produces: `sendSmtpEmail(credentials: SmtpCredentials, input: SendEmailInput): Promise<SendEmailResult>` from `@/lib/mailbox/smtp-send`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/smtp-send.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SmtpCredentials } from './provider'

const sendMailMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
const createSmtpTransportMock = vi.hoisted(() =>
  vi.fn(() => ({ sendMail: sendMailMock, close: closeMock })),
)
vi.mock('./smtp-connection', () => ({ createSmtpTransport: createSmtpTransportMock }))

import { sendSmtpEmail } from './smtp-send'

const credentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

function sentOptions(): Record<string, unknown> {
  // safe: every test that calls this has asserted or awaited exactly one send
  return sendMailMock.mock.calls[0]?.[0] as Record<string, unknown>
}

beforeEach(() => {
  sendMailMock.mockReset().mockResolvedValue({ messageId: '<generated@client.com>' })
  closeMock.mockReset()
  createSmtpTransportMock.mockClear()
})

describe('sendSmtpEmail', () => {
  it('should send from the credentials email address as plain text', async () => {
    await sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'Body text' })
    expect(sentOptions()).toMatchObject({
      from: 'ops@client.com',
      to: 'lead@target.com',
      subject: 'Hi',
      text: 'Body text',
    })
  })

  it('should return the generated Message-ID as both ids when starting a thread', async () => {
    const result = await sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' })
    expect(result).toEqual({
      providerMessageId: '<generated@client.com>',
      threadId: '<generated@client.com>',
    })
  })

  it('should preserve the incoming threadId when replying so the thread stays stable', async () => {
    const result = await sendSmtpEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Re: Hi',
      body: 'b',
      threadId: '<root@target.com>',
      inReplyToMessageId: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    })
    expect(result.threadId).toBe('<root@target.com>')
    expect(result.providerMessageId).toBe('<generated@client.com>')
  })

  it('should set inReplyTo and references headers when threading', async () => {
    await sendSmtpEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Re: Hi',
      body: 'b',
      inReplyToMessageId: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    })
    expect(sentOptions()).toMatchObject({
      inReplyTo: '<prev@target.com>',
      references: '<root@target.com> <prev@target.com>',
    })
  })

  it('should omit threading headers entirely on a first touch', async () => {
    await sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' })
    expect(sentOptions()).not.toHaveProperty('inReplyTo')
    expect(sentOptions()).not.toHaveProperty('references')
  })

  it.each([
    ['to', { to: 'a@b.com\nBcc: attacker@evil.com', subject: 's', body: 'b' }],
    ['subject', { to: 'a@b.com', subject: 's\r\nBcc: attacker@evil.com', body: 'b' }],
    ['inReplyToMessageId', { to: 'a@b.com', subject: 's', body: 'b', inReplyToMessageId: '<a>\n<b>' }],
    ['references', { to: 'a@b.com', subject: 's', body: 'b', references: '<a>\r<b>' }],
  ])('should reject a line break in %s before opening a connection', async (_field, input) => {
    await expect(sendSmtpEmail(credentials, input)).rejects.toMatchObject({ code: 'VALIDATION_ERROR' })
    expect(createSmtpTransportMock).not.toHaveBeenCalled()
    expect(sendMailMock).not.toHaveBeenCalled()
  })

  it('should map an auth failure to UNAUTHORIZED so the mailbox gets blocked', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('bad login'), { code: 'EAUTH' }))
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toMatchObject({ code: 'UNAUTHORIZED', context: expect.objectContaining({ status: 401 }) })
  })

  it('should map a transient SMTP 4xx reply to a retryable status', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('busy'), { responseCode: 451 }))
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toMatchObject({ context: expect.objectContaining({ status: 503 }) })
  })

  it('should close the transport even when the send fails', async () => {
    sendMailMock.mockRejectedValue(Object.assign(new Error('busy'), { responseCode: 550 }))
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toBeDefined()
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should fail loudly when the server accepts the message without a Message-ID', async () => {
    // Without an id there is nothing stable to thread follow-ups against, so
    // treating this as success would silently break the conversation.
    sendMailMock.mockResolvedValue({ messageId: undefined })
    await expect(
      sendSmtpEmail(credentials, { to: 'lead@target.com', subject: 'Hi', body: 'b' }),
    ).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/lib/mailbox/smtp-send.test.ts`
Expected: FAIL — `Failed to resolve import "./smtp-send"`.

- [ ] **Step 3: Implement sending**

Create `src/lib/mailbox/smtp-send.ts`:

```ts
import { AppError } from '@/lib/errors/app-error'
import { assertNoHeaderInjection } from './headers'
import type { SendEmailInput, SendEmailResult, SmtpCredentials } from './provider'
import { createSmtpTransport } from './smtp-connection'
import { toMailAppError, withMailDeadline } from './smtp-errors'

/**
 * Sends one message over SMTP.
 *
 * Threading is Message-ID chaining, because IMAP has no server-side thread id
 * the way Gmail and Graph do. A first touch roots the thread on its own
 * generated Message-ID; a reply carries the incoming threadId through
 * unchanged so it stays stable for the life of the conversation.
 */
export async function sendSmtpEmail(
  credentials: SmtpCredentials,
  input: SendEmailInput,
): Promise<SendEmailResult> {
  // Validated before a connection is opened: a rejected header is the caller's
  // bug, and there is no reason to touch the network to discover that.
  const to = assertNoHeaderInjection(input.to, 'to')
  const subject = assertNoHeaderInjection(input.subject, 'subject')
  const inReplyTo = input.inReplyToMessageId
    ? assertNoHeaderInjection(input.inReplyToMessageId, 'inReplyToMessageId')
    : undefined
  const references = input.references
    ? assertNoHeaderInjection(input.references, 'references')
    : undefined

  const transport = createSmtpTransport(credentials)
  try {
    const info = await withMailDeadline('smtp', () =>
      transport.sendMail({
        from: credentials.emailAddress,
        to,
        subject,
        text: input.body,
        ...(inReplyTo ? { inReplyTo } : {}),
        ...(references ? { references } : {}),
      }),
    )

    const messageId: unknown = info.messageId
    if (typeof messageId !== 'string' || messageId.length === 0) {
      throw new AppError(
        'EXTERNAL_ERROR',
        'SMTP server accepted the message without returning a Message-ID',
        { status: 502, stage: 'smtp' },
      )
    }

    return { providerMessageId: messageId, threadId: input.threadId ?? messageId }
  } catch (error) {
    throw toMailAppError(error, 'smtp')
  } finally {
    transport.close()
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run src/lib/mailbox/smtp-send.test.ts`
Expected: PASS, 14 tests (the `it.each` block counts as 4).

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/smtp-send.ts src/lib/mailbox/smtp-send.test.ts
git commit -m "feat: send outbound mail over SMTP

Threading is Message-ID chaining since IMAP has no server-side thread id: a
first touch roots on its own generated id, a reply carries the incoming
threadId through unchanged. Header values are validated before a connection is
opened."
```

---

### Task 5: IMAP inbound polling

**Files:**
- Create: `src/lib/mailbox/smtp-inbound.ts`
- Create: `src/lib/mailbox/smtp-inbound.test.ts`

**Interfaces:**
- Consumes: `FetchInboundResult`, `InboundMessage`, `SmtpCredentials` from `@/lib/mailbox/provider`; `createImapClient` from `@/lib/mailbox/smtp-connection`; `toMailAppError` from `@/lib/mailbox/smtp-errors`; `simpleParser` from `mailparser`.
- Produces: `fetchSmtpInbound(credentials: SmtpCredentials, cursor: string | null): Promise<FetchInboundResult>` and `MAX_MESSAGES_PER_POLL: number` from `@/lib/mailbox/smtp-inbound`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/smtp-inbound.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { SmtpCredentials } from './provider'

interface FakeFetched {
  uid: number
  flags: Set<string>
  source: Buffer
}

const connectMock = vi.hoisted(() => vi.fn())
const closeMock = vi.hoisted(() => vi.fn())
const releaseMock = vi.hoisted(() => vi.fn())
const getMailboxLockMock = vi.hoisted(() => vi.fn())
const fetchMock = vi.hoisted(() => vi.fn())
const mailboxState = vi.hoisted(() => ({ value: { uidValidity: 42n, uidNext: 101 } as unknown }))

const createImapClientMock = vi.hoisted(() =>
  vi.fn(() => ({
    connect: connectMock,
    close: closeMock,
    getMailboxLock: getMailboxLockMock,
    fetch: fetchMock,
    get mailbox() {
      return mailboxState.value
    },
  })),
)
vi.mock('./smtp-connection', () => ({ createImapClient: createImapClientMock }))

const simpleParserMock = vi.hoisted(() => vi.fn())
vi.mock('mailparser', () => ({ simpleParser: simpleParserMock }))

import { fetchSmtpInbound, MAX_MESSAGES_PER_POLL } from './smtp-inbound'

const credentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

function fetched(uid: number, flags: string[] = []): FakeFetched {
  return { uid, flags: new Set(flags), source: Buffer.from(`raw-${uid}`) }
}

function feed(messages: FakeFetched[]): void {
  fetchMock.mockImplementation(async function* () {
    for (const message of messages) yield message
  })
}

// A mailparser result with only the fields the mapper reads.
function parsed(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    from: { value: [{ address: 'Lead@Target.com' }] },
    subject: 'Re: your note',
    text: 'reply body',
    date: new Date('2026-07-24T10:00:00.000Z'),
    messageId: '<reply@target.com>',
    inReplyTo: undefined,
    references: undefined,
    headerLines: [
      { key: 'from', line: 'From: Lead@Target.com' },
      { key: 'subject', line: 'Subject: Re: your note' },
    ],
    ...overrides,
  }
}

beforeEach(() => {
  connectMock.mockReset().mockResolvedValue(undefined)
  closeMock.mockReset()
  releaseMock.mockReset()
  getMailboxLockMock.mockReset().mockResolvedValue({ release: releaseMock })
  fetchMock.mockReset()
  createImapClientMock.mockClear()
  simpleParserMock.mockReset().mockResolvedValue(parsed())
  mailboxState.value = { uidValidity: 42n, uidNext: 101 }
  feed([])
})

describe('fetchSmtpInbound baselining', () => {
  it('should ingest nothing and record the current position when the cursor is null', async () => {
    const result = await fetchSmtpInbound(credentials, null)
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor)).toEqual({ uidValidity: '42', lastUid: 100 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should serialize uidValidity as a string because the library returns a BigInt', async () => {
    const result = await fetchSmtpInbound(credentials, null)
    // Regression guard: JSON.stringify throws on a BigInt, which would break
    // every poll rather than only an edge case.
    expect(() => JSON.parse(result.cursor)).not.toThrow()
    expect(typeof JSON.parse(result.cursor).uidValidity).toBe('string')
  })

  it('should re-baseline and ingest nothing when uidValidity no longer matches', async () => {
    const stale = JSON.stringify({ uidValidity: '41', lastUid: 50 })
    const result = await fetchSmtpInbound(credentials, stale)
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor)).toEqual({ uidValidity: '42', lastUid: 100 })
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('should re-baseline when the stored cursor is not valid JSON', async () => {
    const result = await fetchSmtpInbound(credentials, 'not-json')
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor)).toEqual({ uidValidity: '42', lastUid: 100 })
  })
})

describe('fetchSmtpInbound incremental fetch', () => {
  it('should request only UIDs above the stored lastUid', async () => {
    feed([fetched(11)])
    await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(fetchMock).toHaveBeenCalledWith('11:*', expect.anything(), { uid: true })
  })

  it('should map a fetched message into an InboundMessage', async () => {
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toHaveLength(1)
    expect(result.messages[0]).toMatchObject({
      providerMessageId: '<reply@target.com>',
      fromEmail: 'lead@target.com',
      subject: 'Re: your note',
      body: 'reply body',
      receivedAt: '2026-07-24T10:00:00.000Z',
    })
  })

  it('should lowercase header names into the headers record', async () => {
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.headers).toMatchObject({ subject: 'Re: your note' })
  })

  it('should ignore a message at or below lastUid, which IMAP returns for an empty range', async () => {
    // `11:*` returns the newest message even when nothing is new — a standard
    // IMAP quirk that would otherwise re-ingest it on every poll.
    feed([fetched(10)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor).lastUid).toBe(10)
  })

  it('should skip deleted and draft messages', async () => {
    feed([fetched(11, ['\\Deleted']), fetched(12, ['\\Draft'])])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toEqual([])
  })

  it('should advance the cursor past skipped messages so they are not replayed forever', async () => {
    feed([fetched(11, ['\\Draft']), fetched(12, ['\\Deleted'])])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(JSON.parse(result.cursor).lastUid).toBe(12)
  })

  it('should skip a message whose sender cannot be parsed', async () => {
    simpleParserMock.mockResolvedValue(parsed({ from: undefined }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toEqual([])
    expect(JSON.parse(result.cursor).lastUid).toBe(11)
  })

  it('should stop at the per-poll cap and leave the remainder for the next poll', async () => {
    feed(Array.from({ length: MAX_MESSAGES_PER_POLL + 5 }, (_unused, index) => fetched(11 + index)))
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages).toHaveLength(MAX_MESSAGES_PER_POLL)
    expect(JSON.parse(result.cursor).lastUid).toBe(10 + MAX_MESSAGES_PER_POLL)
  })
})

describe('fetchSmtpInbound threading', () => {
  it('should root the thread on the first References entry when present', async () => {
    simpleParserMock.mockResolvedValue(
      parsed({ references: ['<root@target.com>', '<prev@target.com>'], inReplyTo: '<prev@target.com>' }),
    )
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<root@target.com>')
  })

  it('should accept a single-string References value', async () => {
    simpleParserMock.mockResolvedValue(parsed({ references: '<root@target.com>' }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<root@target.com>')
  })

  it('should fall back to In-Reply-To when there are no References', async () => {
    simpleParserMock.mockResolvedValue(parsed({ inReplyTo: '<prev@target.com>' }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<prev@target.com>')
  })

  it('should root a new thread on its own Message-ID', async () => {
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    expect(result.messages[0]?.threadId).toBe('<reply@target.com>')
  })

  it('should synthesize a stable id when the message has no Message-ID', async () => {
    simpleParserMock.mockResolvedValue(parsed({ messageId: undefined }))
    feed([fetched(11)])
    const result = await fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 }))
    // Includes uidValidity because a bare UID is not stable across a reset,
    // and this value is the inbound dedup key.
    expect(result.messages[0]?.providerMessageId).toBe('smtp-uid-42-11')
  })
})

describe('fetchSmtpInbound teardown', () => {
  it('should release the mailbox lock and close the client on success', async () => {
    await fetchSmtpInbound(credentials, null)
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should close the client when parsing throws', async () => {
    simpleParserMock.mockRejectedValue(new Error('malformed MIME'))
    feed([fetched(11)])
    await expect(
      fetchSmtpInbound(credentials, JSON.stringify({ uidValidity: '42', lastUid: 10 })),
    ).rejects.toBeDefined()
    expect(releaseMock).toHaveBeenCalledTimes(1)
    expect(closeMock).toHaveBeenCalledTimes(1)
  })

  it('should map a connection failure through the shared error mapper', async () => {
    connectMock.mockRejectedValue(Object.assign(new Error('nope'), { authenticationFailed: true }))
    await expect(fetchSmtpInbound(credentials, null)).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
      context: expect.objectContaining({ stage: 'imap' }),
    })
    expect(closeMock).toHaveBeenCalledTimes(1)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run src/lib/mailbox/smtp-inbound.test.ts`
Expected: FAIL — `Failed to resolve import "./smtp-inbound"`.

- [ ] **Step 3: Implement inbound polling**

Create `src/lib/mailbox/smtp-inbound.ts`:

```ts
import { simpleParser } from 'mailparser'
import type { ImapFlow } from 'imapflow'
import { AppError } from '@/lib/errors/app-error'
import type { FetchInboundResult, InboundMessage, SmtpCredentials } from './provider'
import { createImapClient } from './smtp-connection'
import { toMailAppError } from './smtp-errors'

/** Safety cap on how many messages one poll will pull down. */
export const MAX_MESSAGES_PER_POLL = 200

interface SmtpCursor {
  // Decimal string, not a number: the library returns a BigInt, which throws
  // on JSON.stringify.
  uidValidity: string
  lastUid: number
}

function parseSmtpCursor(cursor: string | null): SmtpCursor | null {
  if (!cursor) return null
  try {
    const parsed: unknown = JSON.parse(cursor)
    if (typeof parsed !== 'object' || parsed === null) return null
    const { uidValidity, lastUid } = parsed as { uidValidity?: unknown; lastUid?: unknown }
    if (typeof uidValidity !== 'string' || typeof lastUid !== 'number') return null
    return { uidValidity, lastUid }
  } catch {
    return null
  }
}

function serializeCursor(cursor: SmtpCursor): string {
  return JSON.stringify(cursor)
}

function firstReference(references: unknown): string | null {
  if (typeof references === 'string') return references.split(/\s+/)[0] ?? null
  if (Array.isArray(references)) {
    const first: unknown = references[0]
    return typeof first === 'string' ? first : null
  }
  return null
}

async function toInboundMessage(
  source: Buffer,
  uid: number,
  uidValidity: string,
): Promise<InboundMessage | null> {
  const parsed = await simpleParser(source)

  const address = parsed.from?.value[0]?.address
  if (!address) return null

  // The inbound dedup key, so it must be stable across polls. A bare UID is
  // not — uidValidity can reset — hence it is part of the synthetic fallback.
  const messageId = parsed.messageId ?? `smtp-uid-${uidValidity}-${uid}`

  const headers: Record<string, string> = {}
  for (const { key, line } of parsed.headerLines) {
    const separator = line.indexOf(':')
    headers[key.toLowerCase()] = separator === -1 ? '' : line.slice(separator + 1).trim()
  }

  return {
    providerMessageId: messageId,
    // Message-ID chaining, matching what smtp-send writes: the root of the
    // References chain identifies the conversation, and a new thread roots on
    // itself.
    threadId: firstReference(parsed.references) ?? parsed.inReplyTo ?? messageId,
    fromEmail: address.trim().toLowerCase(),
    subject: parsed.subject ?? null,
    body: parsed.text ?? '',
    receivedAt: (parsed.date ?? new Date()).toISOString(),
    headers,
  }
}

async function collectInbound(client: ImapFlow, cursor: string | null): Promise<FetchInboundResult> {
  // client.mailbox is `MailboxObject | false` — false until a mailbox is open.
  const mailbox = client.mailbox
  if (!mailbox) {
    throw new AppError('EXTERNAL_ERROR', 'IMAP server did not report INBOX state', {
      status: 502,
      stage: 'imap',
    })
  }

  const uidValidity = mailbox.uidValidity.toString()
  const previous = parseSmtpCursor(cursor)

  // A null/unreadable cursor baselines. A uidValidity change means the mailbox
  // was recreated and every stored UID is meaningless, so it re-baselines the
  // same way — mirroring Gmail's expired-historyId and Graph's expired-delta
  // recovery.
  if (!previous || previous.uidValidity !== uidValidity) {
    return {
      messages: [],
      cursor: serializeCursor({ uidValidity, lastUid: mailbox.uidNext - 1 }),
    }
  }

  const messages: InboundMessage[] = []
  let highestUid = previous.lastUid
  let examined = 0

  for await (const message of client.fetch(
    `${previous.lastUid + 1}:*`,
    { uid: true, flags: true, source: true },
    { uid: true },
  )) {
    // IMAP returns the newest message for a range that starts past the end, so
    // an empty poll still yields one row. Without this guard it would be
    // re-ingested on every cycle.
    if (message.uid <= previous.lastUid) continue

    if (examined >= MAX_MESSAGES_PER_POLL) break
    examined += 1

    // Advance past every UID examined, mapped or not. Advancing only past
    // mapped messages would replay skipped drafts on every poll, and a
    // trailing run of them would wedge the cursor permanently.
    if (message.uid > highestUid) highestUid = message.uid

    const flags = message.flags ?? new Set<string>()
    if (flags.has('\\Deleted') || flags.has('\\Draft')) continue

    // A server can answer a source fetch with nothing; there is no message to
    // map without it, and the cursor has already moved past this UID.
    if (!message.source) continue

    const mapped = await toInboundMessage(message.source, message.uid, uidValidity)
    if (mapped) messages.push(mapped)
  }

  return { messages, cursor: serializeCursor({ uidValidity, lastUid: highestUid }) }
}

export async function fetchSmtpInbound(
  credentials: SmtpCredentials,
  cursor: string | null,
): Promise<FetchInboundResult> {
  const client = createImapClient(credentials)
  try {
    await client.connect()
    const lock = await client.getMailboxLock('INBOX')
    try {
      return await collectInbound(client, cursor)
    } finally {
      lock.release()
    }
  } catch (error) {
    throw toMailAppError(error, 'imap')
  } finally {
    // close() rather than logout(): logout() throws when the connection never
    // came up, which would leak the socket for the rest of the invocation.
    client.close()
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run src/lib/mailbox/smtp-inbound.test.ts`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailbox/smtp-inbound.ts src/lib/mailbox/smtp-inbound.test.ts
git commit -m "feat: read inbound mail over IMAP

Cursor is {uidValidity, lastUid}, with uidValidity stored as a string because
the library returns a BigInt that JSON.stringify rejects. The cursor advances
past every UID examined rather than only mapped ones, so skipped drafts cannot
wedge it, and a uidValidity change re-baselines the way an expired Gmail
historyId does."
```

---

### Task 6: Wire `smtpProvider` into the registry and the database enum

**Files:**
- Create: `supabase/migrations/0015_smtp_mailbox_provider.sql`
- Create: `src/lib/mailbox/smtp-provider.ts`
- Create: `src/lib/mailbox/smtp-provider.test.ts`
- Modify: `src/types/database.ts:757`
- Modify: `src/lib/mailbox/registry.ts`
- Create: `src/lib/mailbox/registry.test.ts`

**Interfaces:**
- Consumes: `MailboxProvider`, `MailboxCredentials`, `SendEmailInput`, `requireSmtpCredentials` from `@/lib/mailbox/provider`; `sendSmtpEmail` from `@/lib/mailbox/smtp-send`; `fetchSmtpInbound` from `@/lib/mailbox/smtp-inbound`.
- Produces: `smtpProvider: MailboxProvider` from `@/lib/mailbox/smtp-provider`; `getMailboxProvider('smtp')` resolves to it.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0015_smtp_mailbox_provider.sql`:

```sql
-- SMTP/IMAP mailbox provider
-- (docs/superpowers/specs/2026-07-24-smtp-mailbox-design.md).
--
-- Credentials for an 'smtp' mailbox live in the same encrypted `mailboxes.oauth`
-- jsonb as OAuth tokens, tagged with kind: 'smtp'. No column is added: the
-- column name is a historical one that now means "mailbox credentials", and
-- renaming it would touch both OAuth callbacks and the whole db layer for no
-- behavioral gain.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PG12+ so long
-- as the new value is not *used* in the same transaction — nothing here
-- references it, so this is safe under `supabase db push`. This is the only
-- statement in the file for exactly that reason.
alter type mailbox_provider add value if not exists 'smtp';
```

- [ ] **Step 2: Widen the generated enum type**

In `src/types/database.ts`, change line 757 from:

```ts
      mailbox_provider: 'gmail' | 'outlook'
```

to:

```ts
      mailbox_provider: 'gmail' | 'outlook' | 'smtp'
```

- [ ] **Step 3: Write the failing tests**

Create `src/lib/mailbox/smtp-provider.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { MailboxCredentials, SmtpCredentials } from './provider'

const sendSmtpEmailMock = vi.hoisted(() => vi.fn())
vi.mock('./smtp-send', () => ({ sendSmtpEmail: sendSmtpEmailMock }))

const fetchSmtpInboundMock = vi.hoisted(() => vi.fn())
vi.mock('./smtp-inbound', () => ({ fetchSmtpInbound: fetchSmtpInboundMock }))

import { smtpProvider } from './smtp-provider'

const credentials: SmtpCredentials = {
  kind: 'smtp',
  emailAddress: 'ops@client.com',
  username: 'ops@client.com',
  password: 'pw',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

const oauthCredentials: MailboxCredentials = {
  kind: 'oauth',
  accessToken: 'a',
  refreshToken: 'r',
  expiresAt: '2099-01-01T00:00:00.000Z',
}

beforeEach(() => {
  sendSmtpEmailMock.mockReset().mockResolvedValue({ providerMessageId: '<m@x>', threadId: '<m@x>' })
  fetchSmtpInboundMock.mockReset().mockResolvedValue({ messages: [], cursor: 'c1' })
})

describe('smtpProvider', () => {
  it('should identify itself as the smtp provider', () => {
    expect(smtpProvider.provider).toBe('smtp')
  })

  it('should return the same credentials reference from sendEmail so nothing is re-persisted', async () => {
    // sender.ts skips the oauth write when the reference is unchanged; SMTP
    // credentials are static, so it must always be unchanged.
    const { tokens } = await smtpProvider.sendEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Hi',
      body: 'b',
    })
    expect(tokens).toBe(credentials)
  })

  it('should return the same credentials reference from fetchInbound', async () => {
    const { tokens } = await smtpProvider.fetchInbound(credentials, null)
    expect(tokens).toBe(credentials)
  })

  it('should pass the send result straight through', async () => {
    const { result } = await smtpProvider.sendEmail(credentials, {
      to: 'lead@target.com',
      subject: 'Hi',
      body: 'b',
    })
    expect(result).toEqual({ providerMessageId: '<m@x>', threadId: '<m@x>' })
  })

  it('should pass the cursor through to the inbound reader', async () => {
    await smtpProvider.fetchInbound(credentials, 'cursor-1')
    expect(fetchSmtpInboundMock).toHaveBeenCalledWith(credentials, 'cursor-1')
  })

  it('should throw INVARIANT_VIOLATION when handed oauth credentials', async () => {
    await expect(
      smtpProvider.sendEmail(oauthCredentials, { to: 'a@b.com', subject: 's', body: 'b' }),
    ).rejects.toMatchObject({ code: 'INVARIANT_VIOLATION' })
    expect(sendSmtpEmailMock).not.toHaveBeenCalled()
  })
})
```

Create `src/lib/mailbox/registry.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { getMailboxProvider } from './registry'

describe('getMailboxProvider', () => {
  it.each(['gmail', 'outlook', 'smtp'] as const)(
    'should resolve a provider whose name matches when given %s',
    (name) => {
      expect(getMailboxProvider(name).provider).toBe(name)
    },
  )

  it('should throw for an unknown provider rather than returning undefined', () => {
    // Cast is the point of the test: it simulates a DB row whose provider
    // column outran the registry.
    expect(() => getMailboxProvider('carrier-pigeon' as never)).toThrow()
  })
})
```

- [ ] **Step 4: Run them and confirm they fail**

Run: `pnpm vitest run src/lib/mailbox/smtp-provider.test.ts src/lib/mailbox/registry.test.ts`
Expected: FAIL — `Failed to resolve import "./smtp-provider"`.

- [ ] **Step 5: Implement the provider**

Create `src/lib/mailbox/smtp-provider.ts`:

```ts
import {
  requireSmtpCredentials,
  type FetchInboundResult,
  type MailboxCredentials,
  type MailboxProvider,
  type SendEmailInput,
  type SendEmailResult,
} from './provider'
import { fetchSmtpInbound } from './smtp-inbound'
import { sendSmtpEmail } from './smtp-send'

/**
 * A password-authenticated mailbox: SMTP out, IMAP in. Implements the base
 * MailboxProvider contract only — there is no consent screen to redirect to,
 * so it is not an OAuthMailboxProvider.
 */
export const smtpProvider: MailboxProvider = {
  provider: 'smtp',

  async sendEmail(
    credentials: MailboxCredentials,
    input: SendEmailInput,
  ): Promise<{ result: SendEmailResult; tokens: MailboxCredentials }> {
    const smtp = requireSmtpCredentials(credentials, 'smtp')
    const result = await sendSmtpEmail(smtp, input)
    // Static credentials, so the same reference goes back out. That is exactly
    // what tells sender.ts and reader.ts there is nothing to re-persist.
    return { result, tokens: credentials }
  },

  async fetchInbound(
    credentials: MailboxCredentials,
    cursor: string | null,
  ): Promise<{ result: FetchInboundResult; tokens: MailboxCredentials }> {
    const smtp = requireSmtpCredentials(credentials, 'smtp')
    const result = await fetchSmtpInbound(smtp, cursor)
    return { result, tokens: credentials }
  },
}
```

- [ ] **Step 6: Register the provider**

Replace `src/lib/mailbox/registry.ts`:

```ts
import type { Database } from '@/types/database'
import type { MailboxProvider } from './provider'
import { gmailProvider } from './gmail-provider'
import { outlookProvider } from './outlook-provider'
import { smtpProvider } from './smtp-provider'

type ProviderName = Database['public']['Enums']['mailbox_provider']

export function getMailboxProvider(provider: ProviderName): MailboxProvider {
  switch (provider) {
    case 'gmail':
      return gmailProvider
    case 'outlook':
      return outlookProvider
    case 'smtp':
      return smtpProvider
    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown mailbox provider: ${String(exhaustive)}`)
    }
  }
}
```

- [ ] **Step 7: Run the tests and the full suite**

Run: `pnpm vitest run src/lib/mailbox/smtp-provider.test.ts src/lib/mailbox/registry.test.ts`
Expected: PASS, 10 tests.

Run: `pnpm typecheck && pnpm test`
Expected: both PASS.

- [ ] **Step 8: Apply the migration**

Run: `pnpm supabase db push`
Expected: `0015_smtp_mailbox_provider.sql` applies cleanly.

If the local Supabase stack is not running, start it with `pnpm supabase start` first. If `db push` is not the project's normal workflow, apply the migration however migrations `0001`–`0014` were applied and note the deviation.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0015_smtp_mailbox_provider.sql src/types/database.ts src/lib/mailbox/
git commit -m "feat: register the smtp mailbox provider

Adds 'smtp' to the mailbox_provider enum and assembles the send and inbound
modules into a MailboxProvider. Returning the same credentials reference is
what tells sender.ts and reader.ts that static credentials need no re-persist."
```

---

### Task 7: Connect API route

**Files:**
- Create: `src/app/api/mailboxes/smtp/connect/route.ts`
- Create: `src/app/api/mailboxes/smtp/connect/route.test.ts`

**Interfaces:**
- Consumes: `verifySmtpConnection`, `verifyImapConnection` from `@/lib/mailbox/smtp-connection`; `encryptMailboxTokens` from `@/lib/mailbox/tokens`; `insertMailbox` from `@/lib/db/mailboxes`; `getOrCreateOperatorClient`, `getClientById` from `@/lib/db/clients`; `warmupInsertFields` from `@/lib/mailbox/warmup`; `logEvent` from `@/lib/events/log-event`.
- Produces: `POST` handler at `/api/mailboxes/smtp/connect`. Success `200 { ok: true, mailboxId: string }`. Failure `{ error: 'forbidden' | 'validation_error' | 'auth_failed' | 'connection_failed' | 'timeout', stage?: 'smtp' | 'imap' }`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/mailboxes/smtp/connect/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { AppError } from '@/lib/errors/app-error'

const requireUserMock = vi.fn()
const verifySmtpConnectionMock = vi.fn()
const verifyImapConnectionMock = vi.fn()
const insertMailboxMock = vi.fn()
const getOrCreateOperatorClientMock = vi.fn()
const getClientByIdMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/mailbox/smtp-connection', () => ({
  verifySmtpConnection: (...a: unknown[]) => verifySmtpConnectionMock(...a),
  verifyImapConnection: (...a: unknown[]) => verifyImapConnectionMock(...a),
}))
vi.mock('@/lib/db/mailboxes', () => ({ insertMailbox: (...a: unknown[]) => insertMailboxMock(...a) }))
vi.mock('@/lib/db/clients', () => ({
  getOrCreateOperatorClient: (...a: unknown[]) => getOrCreateOperatorClientMock(...a),
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

const validBody = {
  emailAddress: 'ops@client.com',
  displayName: 'Client Ops',
  username: 'ops@client.com',
  password: 'smtp-password-fixture-qhvnz',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}

function req(body: unknown): Request {
  return new Request('http://x/api/mailboxes/smtp/connect', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  verifySmtpConnectionMock.mockReset().mockResolvedValue(undefined)
  verifyImapConnectionMock.mockReset().mockResolvedValue(undefined)
  insertMailboxMock.mockReset().mockResolvedValue({ id: 'mb1' })
  getOrCreateOperatorClientMock.mockReset().mockResolvedValue('client-1')
  getClientByIdMock.mockReset().mockResolvedValue({ id: 'client-1', warmup_profile: 'standard' })
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/mailboxes/smtp/connect', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(verifySmtpConnectionMock).not.toHaveBeenCalled()
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should return 400 when the body is not valid JSON', async () => {
    const res = await POST(req('{not json'))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'validation_error' })
  })

  it('should return 400 when a required field is missing', async () => {
    const { imapHost: _omitted, ...incomplete } = validBody
    const res = await POST(req(incomplete))
    expect(res.status).toBe(400)
    expect(verifySmtpConnectionMock).not.toHaveBeenCalled()
  })

  it('should return 400 when the port is out of range', async () => {
    const res = await POST(req({ ...validBody, smtpPort: 70000 }))
    expect(res.status).toBe(400)
  })

  it('should insert nothing when SMTP verification fails', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('UNAUTHORIZED', 'rejected', { status: 401, stage: 'smtp' }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(400)
    await expect(res.json()).resolves.toMatchObject({ error: 'auth_failed', stage: 'smtp' })
    expect(verifyImapConnectionMock).not.toHaveBeenCalled()
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should insert nothing when IMAP verification fails', async () => {
    verifyImapConnectionMock.mockRejectedValue(
      new AppError('UNAUTHORIZED', 'rejected', { status: 401, stage: 'imap' }),
    )
    const res = await POST(req(validBody))
    await expect(res.json()).resolves.toMatchObject({ error: 'auth_failed', stage: 'imap' })
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should report a timeout distinctly from an auth failure', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('EXTERNAL_TIMEOUT', 'too slow', { stage: 'smtp' }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(504)
    await expect(res.json()).resolves.toMatchObject({ error: 'timeout' })
  })

  it('should report an unreachable host as a connection failure', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'no route', { status: 502, stage: 'smtp' }),
    )
    const res = await POST(req(validBody))
    expect(res.status).toBe(502)
    await expect(res.json()).resolves.toMatchObject({ error: 'connection_failed' })
  })

  it('should never return the password or the underlying error message', async () => {
    verifySmtpConnectionMock.mockRejectedValue(
      new AppError('EXTERNAL_ERROR', 'mail.client.com said 550 blocked by policy', {
        status: 502,
        stage: 'smtp',
        cause: 'mail.client.com said 550 blocked by policy',
      }),
    )
    const res = await POST(req(validBody))
    const text = await res.text()
    expect(text).not.toContain('smtp-password-fixture')
    expect(text).not.toContain('blocked by policy')
  })

  it('should insert an smtp mailbox with encrypted credentials and warmup fields on success', async () => {
    const res = await POST(req(validBody))
    expect(res.status).toBe(200)
    await expect(res.json()).resolves.toEqual({ ok: true, mailboxId: 'mb1' })

    const row = insertMailboxMock.mock.calls[0]?.[1] as Record<string, unknown>
    expect(row).toMatchObject({
      client_id: 'client-1',
      provider: 'smtp',
      email_address: 'ops@client.com',
      display_name: 'Client Ops',
      warmup_profile: 'standard',
    })
    expect(row.warmup_started_at).toEqual(expect.any(String))
    expect(JSON.stringify(row.oauth)).not.toContain('smtp-password-fixture')
  })

  it('should log mailbox.connected without the password', async () => {
    await POST(req(validBody))
    const event = logEventMock.mock.calls[0]?.[0] as Record<string, unknown>
    expect(event).toMatchObject({ type: 'mailbox.connected', actor: 'human:op1', clientId: 'client-1' })
    expect(JSON.stringify(event)).not.toContain('smtp-password-fixture')
  })

  it('should return 500 when the insert fails', async () => {
    insertMailboxMock.mockRejectedValue(new AppError('DB_ERROR', 'insert failed', {}))
    const res = await POST(req(validBody))
    expect(res.status).toBe(500)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

Run: `pnpm vitest run "src/app/api/mailboxes/smtp/connect/route.test.ts"`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Implement the route**

Create `src/app/api/mailboxes/smtp/connect/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertMailbox } from '@/lib/db/mailboxes'
import { getClientById, getOrCreateOperatorClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { encryptMailboxTokens } from '@/lib/mailbox/tokens'
import { warmupInsertFields } from '@/lib/mailbox/warmup'
import { verifyImapConnection, verifySmtpConnection } from '@/lib/mailbox/smtp-connection'
import type { SmtpCredentials } from '@/lib/mailbox/provider'

// net/tls are not available on the edge runtime.
export const runtime = 'nodejs'

const portSchema = z.number().int().min(1).max(65535)
// 253 is the maximum length of a fully qualified domain name.
const hostSchema = z.string().min(1).max(253)

const bodySchema = z.object({
  emailAddress: z.string().email(),
  displayName: z.string().min(1).max(200).nullable().optional(),
  username: z.string().min(1),
  password: z.string().min(1),
  smtpHost: hostSchema,
  smtpPort: portSchema,
  smtpSecure: z.boolean(),
  imapHost: hostSchema,
  imapPort: portSchema,
  imapSecure: z.boolean(),
})

// Verification failures become a stable, machine-readable code the dialog
// branches on. The underlying library message stays server-side: it can carry
// the mail host's banner and internal policy text.
function verificationFailure(error: unknown): NextResponse {
  if (!isAppError(error)) {
    return NextResponse.json({ error: 'connection_failed' }, { status: 502 })
  }
  const stage = typeof error.context.stage === 'string' ? error.context.stage : undefined
  if (error.code === 'UNAUTHORIZED') {
    return NextResponse.json({ error: 'auth_failed', stage }, { status: 400 })
  }
  if (error.code === 'EXTERNAL_TIMEOUT') {
    return NextResponse.json({ error: 'timeout', stage }, { status: 504 })
  }
  return NextResponse.json({ error: 'connection_failed', stage }, { status: 502 })
}

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  let json: unknown
  try {
    json = await request.json()
  } catch {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 })
  }

  const parsed = bodySchema.safeParse(json)
  if (!parsed.success) {
    return NextResponse.json({ error: 'validation_error' }, { status: 400 })
  }

  const credentials: SmtpCredentials = {
    kind: 'smtp',
    emailAddress: parsed.data.emailAddress,
    username: parsed.data.username,
    password: parsed.data.password,
    smtpHost: parsed.data.smtpHost,
    smtpPort: parsed.data.smtpPort,
    smtpSecure: parsed.data.smtpSecure,
    imapHost: parsed.data.imapHost,
    imapPort: parsed.data.imapPort,
    imapSecure: parsed.data.imapSecure,
  }

  // Both legs must authenticate before anything is written: a mailbox whose
  // IMAP credentials are wrong would send fine and silently never detect a
  // reply or a bounce.
  try {
    await verifySmtpConnection(credentials)
    await verifyImapConnection(credentials)
  } catch (error) {
    return verificationFailure(error)
  }

  try {
    const admin = createAdminClient()
    const clientId = await getOrCreateOperatorClient(admin)
    // A newly connected mailbox starts at the client's configured ramp, the
    // same as an OAuth one.
    const client = await getClientById(admin, clientId)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'smtp',
      email_address: credentials.emailAddress,
      display_name: parsed.data.displayName ?? null,
      oauth: encryptMailboxTokens(credentials),
      ...warmupInsertFields(client?.warmup_profile ?? 'standard', new Date()),
    })
    await logEvent({
      clientId,
      actor: `human:${appUser.id}`,
      type: 'mailbox.connected',
      // Host but never credentials — this payload is readable in the event log.
      payload: {
        mailboxId: mailbox.id,
        provider: 'smtp',
        emailAddress: credentials.emailAddress,
        smtpHost: credentials.smtpHost,
        imapHost: credentials.imapHost,
      },
    })
    return NextResponse.json({ ok: true, mailboxId: mailbox.id })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run it and confirm it passes**

Run: `pnpm vitest run "src/app/api/mailboxes/smtp/connect/route.test.ts"`
Expected: PASS, 12 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/mailboxes/smtp/connect"
git commit -m "feat: add the SMTP mailbox connect endpoint

Operator-only. Both the SMTP and IMAP legs must authenticate before the
mailbox row is written, so a half-working mailbox never reaches the database.
Failures return a stable code the dialog branches on; the library's message
stays server-side because it can carry the mail host's banner."
```

---

### Task 8: Settings UI

**Files:**
- Create: `src/app/(app)/settings/connect-smtp-dialog.tsx`
- Modify: `src/app/(app)/settings/connect-buttons.tsx`
- Modify: `src/app/(app)/settings/mailbox-row.tsx`

**Interfaces:**
- Consumes: `POST /api/mailboxes/smtp/connect` from Task 7.
- Produces: `ConnectSmtpDialog` (named export, client component).

- [ ] **Step 1: Create the connect dialog**

Create `src/app/(app)/settings/connect-smtp-dialog.tsx`. It follows `invite-user-dialog.tsx` for structure and `mailbox-controls.tsx` for the native `<select>` (the settings screen does not use the shadcn `Select`):

```tsx
'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { EnvelopeSimple, Plus } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

type ConnectState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }

interface FormValues {
  emailAddress: string
  displayName: string
  username: string
  password: string
  smtpHost: string
  smtpPort: string
  smtpSecure: string
  imapHost: string
  imapPort: string
  imapSecure: string
}

// Ports and TLS modes almost every provider uses. 587 is STARTTLS, 993 is
// implicit TLS — a user who knows neither term gets a working default.
const INITIAL_VALUES: FormValues = {
  emailAddress: '',
  displayName: '',
  username: '',
  password: '',
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: 'false',
  imapHost: '',
  imapPort: '993',
  imapSecure: 'true',
}

const STAGE_LABEL: Record<string, string> = { smtp: 'sending (SMTP)', imap: 'reading (IMAP)' }

function errorMessage(code: unknown, stage: unknown): string {
  const leg = typeof stage === 'string' && stage in STAGE_LABEL ? ` on the ${STAGE_LABEL[stage]} server` : ''
  if (code === 'auth_failed') {
    return `The username or password was rejected${leg}. App passwords are often required instead of your account password.`
  }
  if (code === 'timeout') {
    return `The server did not respond in time${leg}. Check the host and port.`
  }
  if (code === 'connection_failed') {
    return `Could not reach the server${leg}. Check the host, port, and TLS mode.`
  }
  if (code === 'validation_error') {
    return 'Some fields are missing or invalid. Check the email address and port numbers.'
  }
  return 'Could not connect the mailbox. Check the details and try again.'
}

export function ConnectSmtpDialog(): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES)
  const [state, setState] = useState<ConnectState>({ status: 'idle' })
  const isBusy = state.status === 'submitting' || isPending

  function setField(field: keyof FormValues, value: string): void {
    setValues((current) => ({ ...current, [field]: value }))
  }

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setValues(INITIAL_VALUES)
      setState({ status: 'idle' })
    }
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (isBusy) return
    setState({ status: 'submitting' })
    try {
      const response = await fetch('/api/mailboxes/smtp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress: values.emailAddress,
          displayName: values.displayName.trim() === '' ? null : values.displayName.trim(),
          username: values.username,
          password: values.password,
          smtpHost: values.smtpHost,
          smtpPort: Number(values.smtpPort),
          smtpSecure: values.smtpSecure === 'true',
          imapHost: values.imapHost,
          imapPort: Number(values.imapPort),
          imapSecure: values.imapSecure === 'true',
        }),
      })
      const json: unknown = await response.json().catch(() => ({}))
      if (!response.ok) {
        const body = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
        setState({ status: 'error', message: errorMessage(body.error, body.stage) })
        return
      }
      onOpenChange(false)
      startTransition(() => router.refresh())
    } catch {
      setState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="border-hairline bg-surface hover:border-hairline-strong group flex items-center gap-3 rounded-lg border p-4 text-left transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.99]"
        >
          <span className="bg-accent text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
            <EnvelopeSimple size={18} weight="light" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Connect SMTP</span>
            <span className="text-faint block text-[11px]">Any provider, with a username and password</span>
          </span>
          <Plus
            size={15}
            weight="light"
            className="text-faint group-hover:text-foreground shrink-0 transition-colors duration-200"
          />
        </button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>Connect a mailbox over SMTP</DialogTitle>
        </DialogHeader>

        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <p className="text-muted-foreground text-xs">
            Sending uses SMTP and reading replies uses IMAP. Both are checked before the mailbox is saved.
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="smtp-email" className="text-xs">
              Email address
            </Label>
            <Input
              id="smtp-email"
              type="email"
              required
              autoComplete="off"
              value={values.emailAddress}
              onChange={(event) => setField('emailAddress', event.target.value)}
              placeholder="ops@yourdomain.com"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="smtp-display-name" className="text-xs">
              Display name (optional)
            </Label>
            <Input
              id="smtp-display-name"
              type="text"
              autoComplete="off"
              value={values.displayName}
              onChange={(event) => setField('displayName', event.target.value)}
              placeholder="Client Ops"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-username" className="text-xs">
                Username
              </Label>
              <Input
                id="smtp-username"
                type="text"
                required
                autoComplete="off"
                value={values.username}
                onChange={(event) => setField('username', event.target.value)}
                placeholder="ops@yourdomain.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-password" className="text-xs">
                Password
              </Label>
              <Input
                id="smtp-password"
                type="password"
                required
                autoComplete="new-password"
                value={values.password}
                onChange={(event) => setField('password', event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="smtp-host" className="text-xs">
                SMTP host
              </Label>
              <Input
                id="smtp-host"
                type="text"
                required
                value={values.smtpHost}
                onChange={(event) => setField('smtpHost', event.target.value)}
                placeholder="smtp.yourdomain.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-port" className="text-xs">
                SMTP port
              </Label>
              <Input
                id="smtp-port"
                type="number"
                required
                min={1}
                max={65535}
                value={values.smtpPort}
                onChange={(event) => setField('smtpPort', event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="smtp-secure" className="text-xs">
              SMTP security
            </Label>
            <select
              id="smtp-secure"
              value={values.smtpSecure}
              onChange={(event) => setField('smtpSecure', event.target.value)}
              className="border-hairline bg-surface rounded-md border px-2 py-2 text-[13px]"
            >
              <option value="false">STARTTLS (usually port 587)</option>
              <option value="true">SSL/TLS (usually port 465)</option>
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="imap-host" className="text-xs">
                IMAP host
              </Label>
              <Input
                id="imap-host"
                type="text"
                required
                value={values.imapHost}
                onChange={(event) => setField('imapHost', event.target.value)}
                placeholder="imap.yourdomain.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="imap-port" className="text-xs">
                IMAP port
              </Label>
              <Input
                id="imap-port"
                type="number"
                required
                min={1}
                max={65535}
                value={values.imapPort}
                onChange={(event) => setField('imapPort', event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="imap-secure" className="text-xs">
              IMAP security
            </Label>
            <select
              id="imap-secure"
              value={values.imapSecure}
              onChange={(event) => setField('imapSecure', event.target.value)}
              className="border-hairline bg-surface rounded-md border px-2 py-2 text-[13px]"
            >
              <option value="true">SSL/TLS (usually port 993)</option>
              <option value="false">STARTTLS (usually port 143)</option>
            </select>
          </div>

          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" size="sm" disabled={isBusy}>
              <EnvelopeSimple size={13} weight="light" />
              {isBusy ? 'Checking connection…' : 'Connect mailbox'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Add the dialog to the connect grid**

Replace `src/app/(app)/settings/connect-buttons.tsx`:

```tsx
import { GoogleLogo, MicrosoftOutlookLogo, Plus } from '@phosphor-icons/react/dist/ssr'
import { ConnectSmtpDialog } from './connect-smtp-dialog'

const OAUTH_PROVIDERS = [
  { href: '/api/mailboxes/google/connect', label: 'Gmail', icon: GoogleLogo },
  { href: '/api/mailboxes/outlook/connect', label: 'Outlook', icon: MicrosoftOutlookLogo },
] as const

export function ConnectButtons(): React.ReactElement {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      {OAUTH_PROVIDERS.map(({ href, label, icon: Icon }) => (
        // A full page navigation into the OAuth consent screen, so this is an
        // anchor rather than a button with a click handler.
        <a
          key={href}
          href={href}
          className="border-hairline bg-surface hover:border-hairline-strong group flex items-center gap-3 rounded-lg border p-4 transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.99]"
        >
          <span className="bg-accent text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
            <Icon size={18} weight="light" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">Connect {label}</span>
            <span className="text-faint block text-[11px]">Sends and reads on your behalf</span>
          </span>
          <Plus
            size={15}
            weight="light"
            className="text-faint group-hover:text-foreground shrink-0 transition-colors duration-200"
          />
        </a>
      ))}
      {/* SMTP has no consent screen, so it collects credentials in a dialog
          instead of navigating away. */}
      <ConnectSmtpDialog />
    </div>
  )
}
```

- [ ] **Step 3: Render the SMTP icon in the connected list**

In `src/app/(app)/settings/mailbox-row.tsx`, change the icon import:

```tsx
import { EnvelopeSimple, GoogleLogo, MicrosoftOutlookLogo, PaperPlaneTilt } from '@phosphor-icons/react'
```

change the `provider` prop type:

```tsx
  provider: 'gmail' | 'outlook' | 'smtp'
```

and change the icon map:

```tsx
const PROVIDER_ICON = {
  gmail: GoogleLogo,
  outlook: MicrosoftOutlookLogo,
  smtp: EnvelopeSimple,
} as const
```

`page.tsx` needs no change — it passes `mailbox.provider` straight through, and the DB enum widened in Task 6.

- [ ] **Step 4: Verify the whole build**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all three PASS.

- [ ] **Step 5: Verify the flow in the running app**

Run: `pnpm dev`

Then, signed in as an operator, open `/settings` and confirm:
1. Three connect cards render — Gmail, Outlook, and Connect SMTP.
2. Clicking **Connect SMTP** opens the dialog with `587` and `993` pre-filled.
3. Submitting a deliberately wrong password shows the credentials-rejected message and no new mailbox appears.
4. Submitting a wrong host shows the could-not-reach message.
5. Submitting real credentials closes the dialog and the mailbox appears in **Connected mailboxes** with an envelope icon and `0/…  today`.
6. **Send test** on that row delivers a message to the address.

If step 5 or 6 fails, debug before committing — this is the only end-to-end check in the plan.

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/settings"
git commit -m "feat: connect an SMTP mailbox from settings

SMTP has no consent screen, so it collects credentials in a dialog rather than
navigating away. Errors distinguish the SMTP leg from the IMAP leg and suggest
an app password on a rejected login, which is the usual cause."
```

---

## Verification Checklist

Run after every task is complete:

- [ ] `pnpm typecheck` passes
- [ ] `pnpm lint` passes
- [ ] `pnpm test` passes
- [ ] `git grep -n "MailboxTokens" src/` returns nothing (fully replaced by `MailboxCredentials`)
- [ ] `git grep -rn "console.log" src/lib/mailbox src/app/api/mailboxes` returns nothing
- [ ] An existing Gmail or Outlook mailbox still sends a test email (legacy untagged credentials path)
- [ ] A connected SMTP mailbox ingests a reply through `/api/inbound/poll`
