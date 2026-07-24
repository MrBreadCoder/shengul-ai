# SMTP/IMAP Mailbox Provider

**Date:** 2026-07-24
**Status:** Approved design, not yet implemented

## Problem

A mailbox can only be connected through Google or Microsoft OAuth today. Any
client on a custom domain served by Zoho, Fastmail, a cPanel host, a dedicated
cold-outreach SMTP relay, or a self-hosted mail server cannot be onboarded at
all — the settings screen offers exactly two buttons and both end in a consent
screen that server does not have.

This spec adds a third mailbox provider, `smtp`, authenticated with a username
and password instead of an OAuth grant: **SMTP for sending, IMAP for reading
replies.** IMAP is not optional. The reply pipeline
(`ingestInboundForMailbox`), bounce detection, and mailbox health all run off
`MailboxProvider.fetchInbound`, so a send-only mailbox would silently never
detect a reply or a bounce while still counting toward campaign rotation. An
SMTP mailbox must be a first-class peer of a Gmail one, not a degraded variant.

## Decisions

Settled during brainstorming; not open questions.

1. **SMTP + IMAP, never SMTP alone.** Both sets of credentials are required.
2. **Shared username/password, separate host/port.** One credential pair drives
   both protocols, which is how nearly every provider works. Separate
   SMTP-vs-IMAP usernames are not supported; if a real client ever needs it, the
   credential type is a discriminated union and can grow the fields then.
3. **Both protocols are verified before the mailbox row is inserted.** No
   half-connected mailbox reaches the database.
4. **The `mailboxes.oauth` column and the `*MailboxTokens` / `updateMailboxOauth`
   function names stay as they are**, now holding SMTP credentials too. Renaming
   to a credential-generic term would touch ~10 files and both OAuth callbacks
   for a change unrelated to this feature. The name is internal, never
   user-facing. This is deliberate, accepted semantic drift.

## Vendor / library reference (verified 2026-07-24)

New runtime dependencies:

| Package | Role |
|---|---|
| `nodemailer` | SMTP transport, sending, and connection verification |
| `imapflow` | IMAP client (async/await, maintained by the Nodemailer author) |
| `mailparser` | MIME parsing of fetched IMAP message sources |

Details that constrain the implementation:

- `nodemailer.createTransport({ host, port, secure, auth: { user, pass } })`.
  `secure: true` = implicit TLS (465); `secure: false` = STARTTLS upgrade (587).
- `transporter.verify()` authenticates without sending — this is the SMTP
  verification step.
- Nodemailer errors carry `code` (`EAUTH`, `ETIMEDOUT`, `ECONNECTION`,
  `EENVELOPE`, `ESOCKET`) and, for server-reply failures, a numeric SMTP
  `responseCode` (e.g. `535` on failed AUTH). The error mapping keys off both.
- Timeout knobs: `connectionTimeout`, `greetingTimeout`, `socketTimeout`.
- `imapflow`: `await client.connect()` (authenticates — an auth failure throws
  here, which is the IMAP verification step), `await client.getMailboxLock('INBOX')`,
  `client.fetch(range, opts, { uid: true })`, `await client.logout()`.
- **`client.mailbox.uidValidity` is a `BigInt`; `uidNext` is a `Number`.** A
  `BigInt` throws on `JSON.stringify`, so the cursor must store `uidValidity` as
  a decimal **string**. Getting this wrong breaks every poll, not just the edge
  case.

## Credential model

`src/lib/mailbox/provider.ts` — the `MailboxTokens` **type** is replaced by a
`MailboxCredentials` discriminated union. Decision 4 keeps the *column* and
*function* names; a type alias is local to `provider.ts` and five importers, and
leaving it called "Tokens" while it carries a password would be actively
misleading at the call sites that matter most:

```ts
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
```

`MailboxProvider.sendEmail` / `fetchInbound` take and return
`MailboxCredentials`. `ExchangeResult.tokens` narrows to `OAuthCredentials` —
it is only ever produced by an OAuth code exchange. Every existing signature
otherwise stands.

### Interface segregation

`buildAuthUrl` and `exchangeCode` move off `MailboxProvider` into a new
extending interface:

```ts
export interface OAuthMailboxProvider extends MailboxProvider {
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<ExchangeResult>
}
```

`gmailProvider` and `outlookProvider` are typed `OAuthMailboxProvider`;
`smtpProvider` is typed `MailboxProvider`. `getMailboxProvider` returns the base
type — which is all `sender.ts`, `reader.ts`, and the test-email route ever call.
The OAuth connect routes import their provider by name and keep full typing. No
provider gets a stub method that throws "not implemented".

`MailboxProvider.provider` widens to `'gmail' | 'outlook' | 'smtp'`.

### Storage

The column stays `mailboxes.oauth` (jsonb), still AES-256-GCM encrypted through
`encryptMailboxTokens`. `parseMailboxTokens` tries three shapes in order:

1. `kind: 'oauth'` — current OAuth format.
2. `kind: 'smtp'` — new.
3. Legacy no-`kind` OAuth shape — the existing backward-compat path, normalized
   in memory to `{ kind: 'oauth', ... }`.

Gmail/Outlook token refresh returns `kind: 'oauth'`, so every future write is
self-describing and legacy rows keep self-healing as they already do.

Encryption is what makes this design acceptable at all: RLS grants client-role
users SELECT on `mailboxes`, so a plaintext SMTP password would be readable
through PostgREST by anyone in the client's org.

## Database migration

`supabase/migrations/0015_smtp_mailbox_provider.sql`:

```sql
alter type mailbox_provider add value if not exists 'smtp';
```

`ALTER TYPE ... ADD VALUE` is transaction-safe on PG12+ so long as the new value
is not *used* in the same transaction. Nothing else goes in this file — same
constraint and same pattern as migration `0011`.

`src/types/database.ts` regenerates: `mailbox_provider: 'gmail' | 'outlook' | 'smtp'`.

## `smtpProvider`

`src/lib/mailbox/smtp-provider.ts`.

### sendEmail

Builds a transport per call from the stored credentials (no pooling — sends are
jittered and spread across mailboxes, so a persistent pool would idle). Sends
`to` / `subject` / `text: body`, plus `inReplyTo` and `references` when present.

`assertNoHeaderInjection` — extracted from the Gmail/Outlook providers into a
shared module rather than copied a third time — guards `to`, `subject`,
`inReplyToMessageId`, and `references`. `references` and `inReplyToMessageId`
are round-tripped from counterparty-controlled inbound headers, so this is a
real injection surface, not a formality.

**Threading is Message-ID chaining**, because IMAP has no server-side thread id
the way Gmail and Graph do:

- First touch: `providerMessageId` and `threadId` both = the outbound
  `Message-ID` (`info.messageId`).
- Reply: `providerMessageId` = the new `Message-ID`; `threadId` = the incoming
  `input.threadId` unchanged, so it stays stable for the life of the thread.

Credentials are static, so `sendEmail` returns the same credentials object
reference it was given. `sender.ts` already skips persistence when the reference
is unchanged — no special-casing there.

### fetchInbound

Cursor is a JSON string: `{ uidValidity: string, lastUid: number }`.
`uidValidity` is a decimal string because the source value is a `BigInt`.

- **`cursor === null`** — baseline. Connect, open INBOX, return
  `{ messages: [], cursor: { uidValidity: String(mailbox.uidValidity), lastUid: mailbox.uidNext - 1 } }`.
  No backlog ingested, mirroring the Gmail `historyId` and Graph `deltaLink`
  baselines exactly.
- **Stored `uidValidity` !== server's** — the mailbox was recreated and every UID
  is meaningless. Re-baseline and skip the cycle, the same recovery Gmail does on
  a 404 expired `startHistoryId` and Outlook on a 410 expired delta link.
- **Otherwise** — fetch `${lastUid + 1}:*` with `{ uid: true }`, capped at
  `MAX_MESSAGES_PER_POLL = 200`. Parse each source with `mailparser`. Skip
  messages flagged `\Deleted` or `\Draft`. Map to `InboundMessage`:
  - `providerMessageId` — the RFC `Message-ID` header, falling back to
    `smtp-uid-${uidValidity}-${uid}` if absent. This is the inbound dedup key, so
    it must be stable across polls; a bare UID is not, since `uidValidity` can
    reset.
  - `threadId` — first token of `References`, else `In-Reply-To`, else the
    message's own `Message-ID`. A new thread roots on itself, matching what
    `sendEmail` writes on first touch.
  - `fromEmail` — lowercased, trimmed, from the parsed `from`.
  - `headers` — every parsed header, lowercased keys, matching the Gmail provider
    (populated, never `{}`), so bounce detection gets its full signal.
  - New `lastUid` is the highest UID **seen in the fetch**, not the highest
    successfully mapped. Advancing only past mapped messages would re-fetch every
    skipped draft or unparseable message on every poll forever, and a trailing
    run of skipped messages would wedge the cursor permanently. On the page cap
    the untouched remainder is above the highest UID seen, so it is picked up
    next poll rather than skipped.

The connection is opened, locked, and released/logged out in a `finally`, so a
parse failure cannot leak a socket into the serverless invocation.

### Verification helpers

`verifySmtpConnection(credentials)` and `verifyImapConnection(credentials)`,
each with a 10s deadline enforced through the libraries' own timeout options and
backstopped by `Promise.race`. Neither sends mail. Both are exported and
unit-testable on their own, and are what the connect route calls.

## Error mapping

`AppErrorCode` is a closed union, so SMTP failures map onto existing codes and
carry detail in `context`:

| Condition | AppError | `context` |
|---|---|---|
| Auth rejected (`EAUTH` / SMTP 535 / IMAP `AUTHENTICATIONFAILED`) | `UNAUTHORIZED` | `{ status: 401, stage }` |
| SMTP **4xx** reply (421/450/451/452 — transient) | `EXTERNAL_ERROR` | `{ status: 503, stage }` |
| SMTP **5xx** reply (permanent) | `EXTERNAL_ERROR` | `{ status: 502, stage }` |
| `ECONNECTION` / `ESOCKET` / DNS / TLS failure | `EXTERNAL_ERROR` | `{ status: 502, stage }` |
| `ETIMEDOUT` or the 10s deadline | `EXTERNAL_TIMEOUT` | `{ stage }` |

`stage` is `'smtp' | 'imap'`. Two existing behaviors fall out of this mapping for
free, which is the whole reason for expressing SMTP failures as HTTP-ish statuses:

- `withRetry` retries only `429`/`5xx`. Transient SMTP 4xx → `503` → retried.
  Permanent SMTP 5xx → `502` → not retried. **SMTP's numbering is inverted
  relative to HTTP**, so this mapping is a deliberate translation, not a
  passthrough — a naive copy would retry exactly the failures that can never
  succeed and give up on the ones that would.
- `sender.ts` blocks a mailbox on `context.status === 401` with
  `HEALTH_REASON.authFailure`. A rotated or revoked SMTP password therefore
  auto-blocks the mailbox exactly like a revoked OAuth grant, with no change to
  `sender.ts`.

## Connect flow

### API — `POST /api/mailboxes/smtp/connect`

`runtime = 'nodejs'` (`net`/`tls` are not edge-compatible). One route, no
connect/callback split, because there is no external redirect.

1. `requireUser()`, then reject non-`operator` with 403 — identical to every
   other mailbox route.
2. Zod-validate the body: `emailAddress` (email), `displayName`
   (nullable string), `username`, `password`, `smtpHost`, `smtpPort`
   (int 1–65535), `smtpSecure`, `imapHost`, `imapPort`, `imapSecure`.
3. `verifySmtpConnection` then `verifyImapConnection`. Either failing returns
   early and inserts nothing.
4. `insertMailbox` with `provider: 'smtp'`, `oauth: encryptMailboxTokens({ kind: 'smtp', ... })`,
   and `warmupInsertFields(client?.warmup_profile ?? 'standard', new Date())` —
   the same warmup treatment a newly connected Gmail mailbox gets.
5. `logEvent('mailbox.connected', { mailboxId, provider: 'smtp', emailAddress })`.
6. Return `{ ok: true, mailboxId }`.

Failure responses are `{ error: 'auth_failed' | 'connection_failed' | 'timeout' | 'validation_error' | 'forbidden', stage? }`.
The underlying library message is logged server-side only — never returned, so
the response cannot leak the mail host's banner or internal error text.

### UI

`ConnectSmtpDialog` (client component, `src/app/(app)/settings/`), rendered as a
third card in the existing grid in `connect-buttons.tsx` — a server component
composing a client child, so no directive change there. The grid goes to
`sm:grid-cols-3`.

The dialog uses the existing `Dialog` / `Input` / `Label` / `Select` primitives:
email address, display name (optional), username, password (`type="password"`),
SMTP host, SMTP port (default `587`), SMTP security (`STARTTLS` / `SSL-TLS`),
IMAP host, IMAP port (default `993`), IMAP security (default `SSL/TLS`).

State is a discriminated union — `idle | submitting | error | success` — with
submission wrapped in `useTransition`, mirroring `MailboxRow`'s `sendTest`. On
success the dialog closes and `router.refresh()` re-renders the connected list.
The error state renders a message keyed off the response `error` code and
`stage`, so "IMAP password rejected" is distinguishable from "SMTP host
unreachable" without exposing server internals.

`mailbox-row.tsx` gains `smtp: EnvelopeSimple` in its `PROVIDER_ICON` map and
widens its `provider` prop. `registry.ts` gains the `'smtp'` case; its
`assertNever` default stays and is what forces this to be a compile error if a
future provider is added without handling.

## Security

- The password exists only inside the AES-256-GCM-encrypted `oauth` jsonb. Never
  a column, never an event payload, never a log line, never a response body.
- `listMailboxesForViewer` already selects an explicit column list that excludes
  `oauth`; no change needed, but the SMTP row is covered by it.
- `logEvent('mailbox.connected')` carries `provider`, `emailAddress`, and host —
  no credentials.
- Operator-only connect route.
- Header-injection guard on every user- and counterparty-controlled header value.
- No SSRF gate on the host fields: the route is operator-only, and an operator
  can already point the app at arbitrary infrastructure. Noted as accepted, not
  overlooked.

## Testing

Colocated `*.test.ts`, Vitest, `nodemailer` / `imapflow` / `mailparser` mocked at
the module boundary. No real network in unit tests.

**`smtp-provider.test.ts`**
- Send success returns `Message-ID` as both `providerMessageId` and `threadId`.
- Reply send sets `inReplyTo` / `references` and preserves the incoming `threadId`.
- Header injection (CR/LF) rejected on each of `to`, `subject`,
  `inReplyToMessageId`, `references`.
- Each error-mapping row above, asserting both the `AppError` code and
  `context.status`, including that transient SMTP 4xx maps to a retryable status
  and permanent 5xx does not.
- `fetchInbound` null cursor baselines with no messages and a `uidValidity`
  serialized as a string (regression guard for the `BigInt` `JSON.stringify` throw).
- Incremental UID fetch from `lastUid + 1`.
- `uidValidity` mismatch re-baselines and ingests nothing.
- Page cap leaves the remainder for the next poll.
- `\Deleted` and `\Draft` messages skipped — **and the cursor still advances past
  them**, so a poll that maps nothing does not replay the same UIDs forever.
- `threadId` derived from `References`, from `In-Reply-To`, and the self-rooted
  fallback.
- `providerMessageId` falls back to the synthetic id when `Message-ID` is absent.
- Connection released even when parsing throws.

**`tokens.test.ts`** — extend for the three parse shapes (new oauth, new smtp,
legacy no-`kind`), round-tripping encrypt→decrypt for the SMTP shape and
asserting the legacy shape normalizes to `kind: 'oauth'`.

**`registry.test.ts`** — `'smtp'` resolves to `smtpProvider`; exhaustiveness holds.

**Connect route test** — non-operator 403; invalid body 400; SMTP verify failure
inserts nothing; IMAP verify failure inserts nothing; success inserts with
warmup fields and logs `mailbox.connected`; no response body on any path
contains the password or the raw library error.

## Out of scope

- Editing an existing mailbox's SMTP credentials (delete and reconnect).
- OAuth-authenticated SMTP/IMAP (XOAUTH2).
- Separate SMTP-vs-IMAP usernames.
- Folders other than `INBOX`.
- IMAP IDLE / push. Polling reuses the existing QStash cron fanout unchanged.
