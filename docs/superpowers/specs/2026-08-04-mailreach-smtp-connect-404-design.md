# Design: Fix Mailreach SMTP connect (wrong API endpoint)

**Status:** Approved for planning. Root cause confirmed via a live probe against
Mailreach's real API plus their published OpenAPI spec — not a guess.

**Reported symptom:** Client connects an SMTP mailbox, checks the "Mailreach warmup"
box in `/settings`, sees `Could not apply that change.` No account ever appears on
Mailreach's dashboard.

**Scope:** SMTP connect only. Two related bugs surfaced during this investigation
(`getAccountStats` reading a field that doesn't exist, and the Gmail/Outlook Mailreach
OAuth path being the wrong shape of feature entirely) are explicitly **out of scope**
for this spec — see "Explicitly out of scope" below.

---

## Root cause

`src/lib/mailreach/client.ts` was written against guessed, never-verified Mailreach
API endpoint paths and response field names. This was a known, explicitly flagged risk
left open since the feature was built — see
`docs/superpowers/specs/2026-07-29-mailreach-warmup-design.md` line 55 and
`docs/superpowers/plans/2026-07-29-mailreach-warmup.md` Task 3 Step 1, both of which
say the field names/paths were "documented conventions" that needed confirming
against a live account and were never confirmed.

Live evidence (2026-08-04, using the real `MAILREACH_API_KEY` already configured in
this project):

```
$ curl -s -i -X POST https://api.mailreach.co/api/v1/connect-account \
    -H "X-Api-Key: Bearer $MAILREACH_API_KEY" -H "Content-Type: application/json" -d '{}'
HTTP/2 404          # this path does not exist on Mailreach's API at all

$ curl -s -i https://api.mailreach.co/api/v1/accounts \
    -H "X-Api-Key: Bearer $MAILREACH_API_KEY"
HTTP/2 200
[]                   # proves the base URL, auth header format, and API key are all valid
```

Live event log for the actual failed production request (diagnostic log added in
commit `6992f54`):

```json
{
  "type": "mailbox.mailreach_connect_failed",
  "payload": { "status": 404, "body": "", "provider": "smtp", "errorCode": "EXTERNAL_ERROR", "errorMessage": "HTTP 404" }
}
```

Mailreach's real OpenAPI spec (`https://docs.mailreach.co/api/openapi.json`,
`servers[0].url = "http://api.mailreach.co/api"`) confirms the actual endpoint:

| Purpose | Code currently calls | Real endpoint |
|---|---|---|
| Connect an SMTP/IMAP account | `POST /connect-account` | `POST /v1/imap_auth` |
| Disconnect an account | `DELETE /accounts/{id}` | ✅ already correct |

---

## The fix

### 1. `src/lib/mailreach/client.ts` — rewrite `connectSmtpAccount`

Real request schema for `POST /v1/imap_auth` (from the OpenAPI spec,
`components.schemas.postV1ImapAuth`):

```
required: email, first_name, last_name, provider ("gmail" | "outlook" | "custom")
optional (used for generic SMTP/IMAP): imap_server, imap_server_port,
  imap_server_username, imap_server_password, smtp_server, smtp_server_port,
  smtp_server_username, smtp_server_password, smtp_server_auth_type (default "plain"),
  smtp_server_starttls
optional: test (boolean) — dry-run credential check, do not set for the real connect flow
```

`provider` for our generic SMTP/IMAP mailboxes (`mailbox.provider === 'smtp'`) is
`"custom"` — per the endpoint's own description ("Use this endpoint to onboard
accounts that are not using OAuth (Gmail / Microsoft)"). This is the only sane
reading of the enum for this case, but has not been live-tested end to end (only the
404-vs-200 routing was probed with an empty body, which never reached
provider-specific validation) — **the implementation must do one real live connect
and confirm `200` with a real account id before calling this done**, per the
Verification section below.

Response on success (`200`): the full `V1_Entities_Account` object. **The id field is
`id` (integer, e.g. `1234`), not `account_id` (string).** `mailboxes.mailreach_account_id`
is `text`, so store `String(res.id)`.

Response on bad credentials: **`500`**, not a 4xx, shape
`V1_Entities_ImapAuthError = { success: false, imap_auth_success, smtp_auth_success, error }`.
`fetchJson` already throws `AppError('EXTERNAL_ERROR', 'HTTP 500', { status: 500, body: <raw text> })`
for any non-2xx — the raw body (containing the useful `error` message) is already
captured in `AppError.context.body` and logged (see `mailbox.mailreach_connect_failed`
event, commit `6992f54`). No special-casing needed to fix the bug.

```ts
// src/lib/mailreach/client.ts

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

const imapAuthResponseSchema = z.object({ id: z.union([z.string(), z.number()]) }).passthrough()

export async function connectSmtpAccount(input: SmtpConnectInput): Promise<{ accountId: string }> {
  const res = await fetchJson(
    `${BASE_URL}/imap_auth`,
    {
      method: 'POST',
      headers: authHeaders(),
      body: JSON.stringify({
        email: input.emailAddress,
        first_name: input.firstName,
        last_name: input.lastName,
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
```

The existing `toMailreachProvider` helper (`'gmail' | 'outlook'` → `'google' | 'outlook'`)
belongs to the unrelated, already-broken, out-of-scope OAuth path — do not touch it and
do not reuse it here; `connectSmtpAccount` always sends the literal `'custom'`.

### 2. Capture `first_name`/`last_name` explicitly (new — not derived/guessed)

Mailreach requires `first_name`/`last_name`, which the app doesn't collect today
(only optional `display_name`). Rather than guess by splitting `display_name`, collect
them explicitly at connect time:

**`supabase/migrations/0027_mailbox_contact_name.sql`** (next sequential number after
`0026_crm_tables_data_api_grants.sql`):

```sql
alter table mailboxes add column first_name text;
alter table mailboxes add column last_name  text;
```

Nullable at the DB level — existing rows stay `null`; "required" is enforced at the
form/API layer for new connects only, not backfilled.

**`src/app/(app)/settings/connect-smtp-dialog.tsx`**: add two required text inputs,
"First name" and "Last name", placed next to the existing optional "Display name"
field. Both included in the `FormValues` state and the POST body.

**`src/app/api/mailboxes/smtp/connect/route.ts`**: `bodySchema` gains
`firstName: z.string().min(1).max(200)` and `lastName: z.string().min(1).max(200)`.
Passed through to `insertMailbox` as `first_name`/`last_name`.

**`src/lib/db/mailboxes.ts`**: `MailboxRow` (and the `insertMailbox` input type) gain
`first_name: string | null` and `last_name: string | null`, mapped from the new
columns exactly like every other `snake_case` DB column → `camelCase`-at-the-boundary
field already on this type.

**`src/lib/mailreach/enrollment.ts`** — `connectSmtpMailbox`: reads
`mailbox.first_name`/`mailbox.last_name` directly. For mailboxes connected **before**
this migration ships (so the columns are `null` on that row), falls back to deriving
from the email's local part — a legacy-row safety net only, not the primary path:

```ts
// Legacy fallback only: mailboxes connected before first_name/last_name existed on
// the form have null columns here. New connects always populate them via the
// required form fields, so this branch is dead for every mailbox created after this
// ships.
function legacyNameFallback(mailbox: Pick<MailboxRow, 'first_name' | 'last_name' | 'email_address'>): { firstName: string; lastName: string } {
  if (mailbox.first_name && mailbox.last_name) {
    return { firstName: mailbox.first_name, lastName: mailbox.last_name }
  }
  const local = mailbox.email_address.split('@')[0] ?? 'Mailbox'
  return { firstName: mailbox.first_name ?? local, lastName: mailbox.last_name ?? local }
}
```

`bulkReconnectSmtpForClient` needs no changes — it already re-calls
`connectSmtpMailbox`, which now carries this fallback for any older row it hits.

### 3. Tests to update

- `src/lib/mailreach/client.test.ts` — `connectSmtpAccount` describe block: mocked
  response `{ account_id: 'acc_123' }` → `{ id: 1234 }`; assert posted URL is
  `.../v1/imap_auth`; assert body has `first_name`, `last_name`, `provider: 'custom'`,
  `imap_server_username`, etc. with the real field names above.
- `src/lib/mailreach/enrollment.test.ts` — `connectSmtpMailbox`: assert
  `first_name`/`last_name` pass straight through when present on the mailbox row, and
  assert the legacy fallback fires when they're `null`.
- `src/app/api/mailboxes/smtp/connect/route.test.ts` — add cases: missing
  `firstName`/`lastName` → `validation_error`; present → passed to `insertMailbox`.
- No changes needed to `api/mailboxes/[id]/mailreach/connect/route.test.ts` — it mocks
  `connectSmtpMailbox` at the `enrollment` module boundary.

### 4. Verification

1. `pnpm typecheck && pnpm lint && pnpm test` all clean.
2. Deploy, then do one real click-through on a real SMTP mailbox (the one already
   used for this investigation: `info@uniformsfashion.com`, mailbox id
   `28879483-ed6b-4f87-9d48-553b909c39a8`, client `uniforms fashion` /
   `d99edf8f-b185-47b2-9615-1f6e43853001`) and confirm:
   - The checkbox turns on and stays on after `router.refresh()`.
   - `mailboxes.mailreach_status` becomes `'connected'` and `mailreach_account_id`
     is set (query via Supabase REST with the service-role key).
   - The account actually appears in the Mailreach dashboard / `GET /v1/accounts`
     now returns a non-empty array.
   - No new `mailbox.mailreach_connect_failed` events after the fix.

---

## Explicitly out of scope

Flagging for separate future tasks, per "one change at a time":

1. **`getAccountStats` reads a field that doesn't exist.** `GET /v1/accounts/{id}/stats`
   has no `reputation_score` field — it returns `total_messages_sent`,
   `total_messages_received`, `total_spam`, `config_current_conversation_running`,
   `consolidated_cutoff`. The reputation-like number (`score`, `score_gmail`,
   `score_outlook`, `score_custom`) lives on `GET /v1/accounts/{id}` instead. Because
   the current Zod schema makes `reputation_score` optional, this never throws — it
   silently always resolves `reputationScore: null`. Blast radius:
   `src/lib/pipeline/mailreach-sync.ts` (`runMailreachStatsSync`) and every mailbox's
   `mailreach_reputation_score` column/UI display are permanently null.
2. **Gmail/Outlook Mailreach connect is the wrong shape of feature, not just broken.**
   `buildOAuthAuthorizeUrl`/`completeOAuthConnect` and the `google`/`outlook` mailreach
   callback routes assume a per-mailbox redirect-then-code-exchange OAuth flow.
   Mailreach's real API has no such endpoint. Gmail/Outlook onboarding instead goes
   through `POST /v1/email_workspaces` (domain-wide delegation for Google Workspace,
   admin consent for Outlook/O365) plus `POST /v1/email_workspaces/{id}/accounts` to
   link individual mailboxes in — a batch, workspace-level mechanism, not a per-mailbox
   one. This needs its own design (a one-time client-admin setup step per domain, a
   shared-credentials-we-own model to keep it self-serve, a new `email_workspaces`-style
   DB table, and changes to the mailbox connect flow to auto-link into an existing
   workspace) — raise it as its own spec, don't patch this in.
