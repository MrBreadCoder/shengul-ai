# Mailreach SMTP Connect 404 Fix — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the Mailreach SMTP mailbox connect flow, which always fails, by pointing
it at Mailreach's real `POST /v1/imap_auth` endpoint instead of a nonexistent one, and
by collecting the `first_name`/`last_name` that endpoint requires through new, explicit
form fields instead of guessing them.

**Architecture:** `src/lib/mailreach/client.ts`'s `connectSmtpAccount` is rewritten
against the real request/response schema. `mailboxes` gains two new nullable columns
(`first_name`, `last_name`) populated at connect time by a new required pair of form
fields on `ConnectSmtpDialog`, threaded through the `/api/mailboxes/smtp/connect`
route and `insertMailbox`, and read back out by `connectSmtpMailbox` in
`src/lib/mailreach/enrollment.ts` (with a legacy-row fallback for mailboxes connected
before this ships).

**Tech Stack:** Next.js route handlers, Supabase (Postgres) via `@supabase/supabase-js`,
Zod validation, Vitest.

## Global Constraints

- DB columns are `snake_case`; TypeScript fields are `camelCase` — map explicitly, never assume they match (spec, `.claude/QUALITY.md`).
- No `any` — use `unknown` and narrow, or a proper type (`.claude/QUALITY.md`).
- All external inputs validated with Zod (`.claude/QUALITY.md`).
- Thrown/returned errors carry `code`, `message`, `context` via `AppError` — never a bare `Error` (`.claude/QUALITY.md`).
- `connectSmtpAccount`'s `provider` field is always the literal `'custom'` for our generic SMTP/IMAP mailboxes (spec, section 1).
- The Mailreach account id comes back as `res.id` (integer) — always store `String(res.id)`, never `res.account_id` (spec, section 1).
- Do not touch `buildOAuthAuthorizeUrl`, `completeOAuthConnect`, `toMailreachProvider`, or the `google`/`outlook` Mailreach callback routes — that path is explicitly out of scope (spec, "Explicitly out of scope").
- Do not touch `getAccountStats` or `runMailreachStatsSync` — explicitly out of scope (spec, "Explicitly out of scope").
- New `mailboxes.first_name`/`last_name` columns are nullable at the DB level; "required" is enforced only at the form/API layer for new connects (spec, section 2).

---

### Task 1: Add `first_name`/`last_name` to the `mailboxes` table

**Files:**
- Create: `supabase/migrations/0027_mailbox_contact_name.sql`
- Modify: `src/types/database.ts:664-729` (the `mailboxes` table's `Row`/`Insert` types)

**Interfaces:**
- Consumes: nothing (foundation task)
- Produces: `MailboxRow.first_name: string | null`, `MailboxRow.last_name: string | null`, `MailboxInsert.first_name?: string | null`, `MailboxInsert.last_name?: string | null` — every later task in this plan relies on these two field names existing on `MailboxRow`/`MailboxInsert` (from `src/lib/db/mailboxes.ts`, re-exported from `Database['public']['Tables']['mailboxes']`).

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0027_mailbox_contact_name.sql
-- Mailreach's POST /v1/imap_auth requires first_name/last_name, which nothing in
-- the app collected before now (only the optional display_name). Nullable here —
-- existing rows stay null; "required" is enforced at the connect form/route layer
-- for new connects only, not backfilled. See
-- docs/superpowers/specs/2026-08-04-mailreach-smtp-connect-404-design.md section 2.

alter table mailboxes add column first_name text;
alter table mailboxes add column last_name  text;
```

- [ ] **Step 2: Add the columns to the generated types**

In `src/types/database.ts`, in the `mailboxes` table's `Row` type, add the two fields
right after `display_name` (line 670):

```ts
          display_name: string | null
          first_name: string | null
          last_name: string | null
```

In the same table's `Insert` type, add them right after `display_name?` (line 697):

```ts
          display_name?: string | null
          first_name?: string | null
          last_name?: string | null
```

(`Update` is already `Partial<Insert>` — no change needed there.)

- [ ] **Step 3: Verify the types compile**

Run: `pnpm typecheck`
Expected: PASS — no other file references these fields yet, so this can't fail on
anything but a syntax mistake in the edit itself.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0027_mailbox_contact_name.sql src/types/database.ts
git commit -m "feat(mailboxes): add first_name/last_name columns

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVDTDcE8Q5v9nvAKPJMskx"
```

---

### Task 2: Rewrite `connectSmtpAccount` against the real `POST /v1/imap_auth`

**Files:**
- Modify: `src/lib/mailreach/client.ts:11-51`
- Test: `src/lib/mailreach/client.test.ts:1-37`

**Interfaces:**
- Consumes: nothing new (this task is independent of Task 1 — `client.ts` has no
  dependency on `MailboxRow`)
- Produces: `SmtpConnectInput` gains `firstName: string` and `lastName: string`
  (required properties). `connectSmtpAccount(input: SmtpConnectInput): Promise<{ accountId: string }>`
  keeps its existing name and return shape — Task 3's `enrollment.ts` calls it with the
  new required fields.

- [ ] **Step 1: Write the failing tests**

Replace the `connectSmtpAccount` describe block in `src/lib/mailreach/client.test.ts`
(lines 9-37) with:

```ts
const smtpInput = {
  emailAddress: 'sales@acme.com',
  firstName: 'Jordan',
  lastName: 'Lee',
  username: 'sales@acme.com',
  password: 'app-password',
  smtpHost: 'smtp.acme.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.acme.com',
  imapPort: 993,
  imapSecure: true,
}

describe('connectSmtpAccount', () => {
  beforeEach(() => mockFetchJson.mockReset())

  it('should POST to /v1/imap_auth with the real field names and return the account id', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 1234 })
    const result = await connectSmtpAccount(smtpInput)
    expect(result).toEqual({ accountId: '1234' })
    const [url, options] = mockFetchJson.mock.calls[0]!
    expect(url).toBe('https://api.mailreach.co/api/v1/imap_auth')
    expect(options.method).toBe('POST')
    expect(options.headers['X-Api-Key']).toBe('Bearer test-mailreach-key')
    const body = JSON.parse(options.body as string)
    expect(body).toEqual({
      email: 'sales@acme.com',
      first_name: 'Jordan',
      last_name: 'Lee',
      provider: 'custom',
      imap_server: 'imap.acme.com',
      imap_server_port: 993,
      imap_server_username: 'sales@acme.com',
      imap_server_password: 'app-password',
      smtp_server: 'smtp.acme.com',
      smtp_server_port: 587,
      smtp_server_username: 'sales@acme.com',
      smtp_server_password: 'app-password',
      smtp_server_starttls: false,
    })
  })

  it('should coerce a string id in the response to the returned accountId unchanged', async () => {
    mockFetchJson.mockResolvedValueOnce({ id: 'already-a-string' })
    const result = await connectSmtpAccount(smtpInput)
    expect(result).toEqual({ accountId: 'already-a-string' })
  })
})
```

Leave the `buildOAuthAuthorizeUrl`, `completeOAuthConnect`, `disconnectAccount`, and
`getAccountStats` describe blocks in that file exactly as they are — none of them
change in this task.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailreach/client.test.ts`
Expected: FAIL — the old implementation posts to `/connect-account` with the old body
shape and reads `account_id`, so both new assertions fail against it.

- [ ] **Step 3: Rewrite `connectSmtpAccount`**

In `src/lib/mailreach/client.ts`, replace lines 15-51 (the `SmtpConnectInput`
interface, `connectAccountResponseSchema`, and `connectSmtpAccount`) with:

```ts
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
```

Leave `toMailreachProvider`, `buildOAuthAuthorizeUrl`, `completeOAuthConnect`,
`disconnectAccount`, `accountStatsResponseSchema`, and `getAccountStats` in that file
completely untouched — they're outside this fix's scope.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailreach/client.test.ts`
Expected: PASS — all describe blocks in the file, including the three unchanged ones.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailreach/client.ts src/lib/mailreach/client.test.ts
git commit -m "fix(mailreach): connect SMTP mailboxes via the real /v1/imap_auth endpoint

POST /connect-account never existed on Mailreach's API (confirmed 404
against their live API + OpenAPI spec) — every SMTP mailbox connect
attempt was failing silently before this. Switches to POST /v1/imap_auth
with the real field names, provider: 'custom', and the integer id field
(String(res.id), not res.account_id).

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVDTDcE8Q5v9nvAKPJMskx"
```

---

### Task 3: Thread `firstName`/`lastName` through `connectSmtpMailbox`

**Files:**
- Modify: `src/lib/mailreach/enrollment.ts:27-58`
- Test: `src/lib/mailreach/enrollment.test.ts:37-90`

**Interfaces:**
- Consumes: `MailboxRow.first_name`/`last_name` (Task 1); `connectSmtpAccount`'s new
  required `firstName`/`lastName` input fields (Task 2)
- Produces: no change to `connectSmtpMailbox`'s own signature
  (`connectSmtpMailbox(supabase, mailbox: MailboxRow, now: Date): Promise<void>`) —
  Task 4 and 5 don't call it directly, but `bulkReconnectSmtpForClient` (unchanged,
  same file) keeps relying on that exact signature.

- [ ] **Step 1: Write the failing tests**

In `src/lib/mailreach/enrollment.test.ts`, update the `smtpMailbox` fixture (lines
37-60) to include the new columns, defaulting to `null` so existing tests exercise the
legacy-fallback path by default:

```ts
function smtpMailbox(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    client_id: 'c1',
    provider: 'smtp',
    email_address: 'sales@acme.com',
    first_name: null,
    last_name: null,
    mailreach_account_id: null,
    mailreach_status: 'disconnected',
    mailreach_enabled: false,
    mailreach_started_at: null,
    oauth: {
      kind: 'smtp',
      emailAddress: 'sales@acme.com',
      username: 'sales@acme.com',
      password: 'pw',
      smtpHost: 'smtp.acme.com',
      smtpPort: 587,
      smtpSecure: false,
      imapHost: 'imap.acme.com',
      imapPort: 993,
      imapSecure: true,
    },
    ...overrides,
  } as never
}
```

Add two new `it` blocks inside the existing `describe('connectSmtpMailbox', ...)`
(after line 90's closing `})`, still inside the describe):

```ts
  it('should pass the mailbox first_name/last_name straight through when present', async () => {
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_named' })
    await connectSmtpMailbox({} as never, smtpMailbox({ first_name: 'Jordan', last_name: 'Lee' }), now)
    expect(connectSmtpAccount).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'Jordan', lastName: 'Lee' }),
    )
  })

  it('should fall back to the email local part when first_name/last_name are null (legacy row)', async () => {
    connectSmtpAccount.mockResolvedValue({ accountId: 'acc_legacy' })
    await connectSmtpMailbox({} as never, smtpMailbox({ email_address: 'ops@client.com' }), now)
    expect(connectSmtpAccount).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: 'ops', lastName: 'ops' }),
    )
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/mailreach/enrollment.test.ts`
Expected: FAIL — `connectSmtpAccount` isn't currently called with `firstName`/
`lastName` at all, so both new assertions fail. The existing tests in the file still
pass (they don't assert on the full call shape).

- [ ] **Step 3: Implement `legacyNameFallback` and thread it through**

In `src/lib/mailreach/enrollment.ts`, add this helper right after the
`startedAtFor` function (after line 25) and before `connectSmtpMailbox`:

```ts
// Legacy fallback only: mailboxes connected before first_name/last_name existed on
// the connect form have null columns here. Every mailbox created after this ships
// always has real values from the required form fields, so this branch only ever
// fires for pre-existing rows.
function legacyNameFallback(
  mailbox: Pick<MailboxRow, 'first_name' | 'last_name' | 'email_address'>,
): { firstName: string; lastName: string } {
  if (mailbox.first_name && mailbox.last_name) {
    return { firstName: mailbox.first_name, lastName: mailbox.last_name }
  }
  const local = mailbox.email_address.split('@')[0] ?? 'Mailbox'
  return { firstName: mailbox.first_name ?? local, lastName: mailbox.last_name ?? local }
}
```

Then update `connectSmtpMailbox` (lines 27-58) to use it — replace the
`connectSmtpAccount({ ... })` call with:

```ts
  const { firstName, lastName } = legacyNameFallback(mailbox)
  const { accountId } = await connectSmtpAccount({
    emailAddress: credentials.emailAddress,
    firstName,
    lastName,
    username: credentials.username,
    password: credentials.password,
    smtpHost: credentials.smtpHost,
    smtpPort: credentials.smtpPort,
    smtpSecure: credentials.smtpSecure,
    imapHost: credentials.imapHost,
    imapPort: credentials.imapPort,
    imapSecure: credentials.imapSecure,
  })
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailreach/enrollment.test.ts`
Expected: PASS — every describe block in the file, including
`bulkReconnectSmtpForClient`, which exercises `connectSmtpMailbox` indirectly with a
fixture that now has `first_name: null`/`last_name: null` and must still succeed via
the fallback.

- [ ] **Step 5: Commit**

```bash
git add src/lib/mailreach/enrollment.ts src/lib/mailreach/enrollment.test.ts
git commit -m "feat(mailreach): read first_name/last_name off the mailbox row

connectSmtpMailbox now passes the mailbox's own first_name/last_name to
connectSmtpAccount instead of nothing. Mailboxes connected before this
column existed fall back to deriving a name from the email's local part,
so bulkReconnectSmtpForClient keeps working for pre-existing rows.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVDTDcE8Q5v9nvAKPJMskx"
```

---

### Task 4: Require `firstName`/`lastName` on the connect route

**Files:**
- Modify: `src/app/api/mailboxes/smtp/connect/route.ts:21-32,71-82,149-160`
- Test: `src/app/api/mailboxes/smtp/connect/route.test.ts:33-44,178-198`

**Interfaces:**
- Consumes: `MailboxInsert.first_name`/`last_name` (Task 1)
- Produces: the route's request body now requires `firstName: string` (min length 1)
  and `lastName: string` (min length 1) — Task 5's `ConnectSmtpDialog` must send both.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/mailboxes/smtp/connect/route.test.ts`, add `firstName`/`lastName` to
`validBody` (lines 33-44):

```ts
const validBody = {
  emailAddress: 'ops@client.com',
  displayName: 'Client Ops',
  firstName: 'Jordan',
  lastName: 'Lee',
  username: 'ops@client.com',
  password: 'smtp-password-fixture-qhvnz',
  smtpHost: 'smtp.client.com',
  smtpPort: 587,
  smtpSecure: false,
  imapHost: 'imap.client.com',
  imapPort: 993,
  imapSecure: true,
}
```

Add a new `it` block next to the existing "should return 400 when a required field is
missing" test (after line 97):

```ts
  it('should return 400 when firstName is missing', async () => {
    const { firstName: _omitted, ...incomplete } = validBody
    const res = await POST(req(incomplete))
    expect(res.status).toBe(400)
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })

  it('should return 400 when lastName is empty', async () => {
    const res = await POST(req({ ...validBody, lastName: '' }))
    expect(res.status).toBe(400)
    expect(insertMailboxMock).not.toHaveBeenCalled()
  })
```

Update the existing "should insert an smtp mailbox..." assertion (lines 178-198) to
also check the new fields are passed through:

```ts
    expect(row).toMatchObject({
      client_id: 'client-1',
      provider: 'smtp',
      email_address: 'ops@client.com',
      display_name: 'Client Ops',
      first_name: 'Jordan',
      last_name: 'Lee',
      warmup_profile: 'standard',
      warmup_target_cap: 20,
    })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/app/api/mailboxes/smtp/connect/route.test.ts`
Expected: FAIL — the two new "missing field" tests fail because the current schema
has no `firstName`/`lastName` at all (they're silently ignored, not rejected), and the
updated `toMatchObject` assertion fails because `insertMailbox` isn't called with
those keys.

- [ ] **Step 3: Update the route**

In `src/app/api/mailboxes/smtp/connect/route.ts`, add to `bodySchema` (after line 23's
`displayName` line):

```ts
  displayName: z.string().min(1).max(200).nullable().optional(),
  firstName: z.string().min(1).max(200),
  lastName: z.string().min(1).max(200),
```

Add the two fields to the `insertMailbox` call (after `display_name` on line 153):

```ts
      display_name: parsed.data.displayName ?? null,
      first_name: parsed.data.firstName,
      last_name: parsed.data.lastName,
```

`SmtpCredentials`/`credentials` don't change — `firstName`/`lastName` aren't part of
the encrypted OAuth-token payload, they're a plain column on the row, so they're
threaded from `parsed.data` straight to `insertMailbox`, not through `credentials`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/app/api/mailboxes/smtp/connect/route.test.ts`
Expected: PASS — every test in the file.

- [ ] **Step 5: Commit**

```bash
git add src/app/api/mailboxes/smtp/connect/route.ts src/app/api/mailboxes/smtp/connect/route.test.ts
git commit -m "feat(mailboxes): require firstName/lastName on the SMTP connect route

Threads the two new required body fields straight to insertMailbox's
first_name/last_name columns, so Mailreach's imap_auth endpoint (which
requires both) has real values instead of a guess.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVDTDcE8Q5v9nvAKPJMskx"
```

---

### Task 5: Add the First name / Last name fields to the connect dialog

**Files:**
- Modify: `src/app/(app)/settings/connect-smtp-dialog.tsx:23-49,98-109,177-189`

**Interfaces:**
- Consumes: the route's now-required `firstName`/`lastName` body fields (Task 4)
- Produces: nothing consumed by a later task — this is the last task with a coded
  deliverable in this plan.

This is a client component with no existing test file (`connect-smtp-dialog.tsx` has
no colocated `.test.tsx` today — React components in this codebase are tested at
critical paths only per `.claude/QUALITY.md`, and this dialog isn't currently one of
them), so this task is implement-and-manually-verify rather than red/green.

- [ ] **Step 1: Add the fields to `FormValues` and `INITIAL_VALUES`**

In `src/app/(app)/settings/connect-smtp-dialog.tsx`, update the `FormValues`
interface (lines 23-34) to add the two fields after `displayName`:

```ts
interface FormValues {
  emailAddress: string
  displayName: string
  firstName: string
  lastName: string
  username: string
  password: string
  smtpHost: string
  smtpPort: string
  smtpSecure: string
  imapHost: string
  imapPort: string
  imapSecure: string
}
```

Update `INITIAL_VALUES` (lines 38-49) to match:

```ts
const INITIAL_VALUES: FormValues = {
  emailAddress: '',
  displayName: '',
  firstName: '',
  lastName: '',
  username: '',
  password: '',
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: 'false',
  imapHost: '',
  imapPort: '993',
  imapSecure: 'true',
}
```

- [ ] **Step 2: Send the fields in the POST body**

In the `onSubmit` handler's `fetch` call (lines 98-109), add the two fields to the
JSON body, right after `displayName`:

```ts
          displayName: values.displayName.trim() === '' ? null : values.displayName.trim(),
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
```

- [ ] **Step 3: Add the form inputs**

In the JSX, right after the existing "Display name (optional)" field block (lines
177-189), add a two-column grid for the two new required inputs, matching the
existing `username`/`password` grid's pattern (lines 191-219):

```tsx
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-first-name" className="text-xs">
                First name
              </Label>
              <Input
                id="smtp-first-name"
                type="text"
                required
                autoComplete="off"
                value={values.firstName}
                onChange={(event) => setField('firstName', event.target.value)}
                placeholder="Jordan"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-last-name" className="text-xs">
                Last name
              </Label>
              <Input
                id="smtp-last-name"
                type="text"
                required
                autoComplete="off"
                value={values.lastName}
                onChange={(event) => setField('lastName', event.target.value)}
                placeholder="Lee"
              />
            </div>
          </div>
```

- [ ] **Step 4: Verify types and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS — both clean.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/connect-smtp-dialog.tsx"
git commit -m "feat(settings): collect first/last name on the SMTP connect form

Required by Mailreach's imap_auth endpoint (see fix in the mailreach
client/enrollment layer). Placed next to the existing optional display
name field.

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01SVDTDcE8Q5v9nvAKPJMskx"
```

---

### Task 6: Full verification and live confirmation

**Files:** none (verification only)

**Interfaces:**
- Consumes: everything from Tasks 1-5
- Produces: nothing — terminal task

- [ ] **Step 1: Run the full suite**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS, zero failures, zero type errors, zero lint errors.

- [ ] **Step 2: Deploy**

Ship the branch per this project's normal deploy path.

- [ ] **Step 3: One real click-through on a live SMTP mailbox**

Using the mailbox already identified during the original investigation
(`info@uniformsfashion.com`, mailbox id `28879483-ed6b-4f87-9d48-553b909c39a8`, client
`uniforms fashion` / `d99edf8f-b185-47b2-9615-1f6e43853001`), or any other real SMTP
mailbox: open `/settings`, check the "Mailreach warmup" box for that mailbox, and
confirm all of the following:

- The checkbox turns on and stays on after `router.refresh()`.
- `mailboxes.mailreach_status` becomes `'connected'` and `mailreach_account_id` is set
  (query via Supabase REST with the service-role key, e.g.
  `curl -s "$SUPABASE_URL/rest/v1/mailboxes?id=eq.<mailbox-id>&select=mailreach_status,mailreach_account_id" -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY"`).
- The account appears in Mailreach's own dashboard, or
  `curl -s -H "X-Api-Key: Bearer $MAILREACH_API_KEY" "https://api.mailreach.co/api/v1/accounts"`
  now returns a non-empty array containing that email address.
- No new `mailbox.mailreach_connect_failed` event was logged for that mailbox after
  the fix (query the `events` table / whatever the operator log UI is for this
  project, filtered to that `mailboxId` and a timestamp after deploy).

If any of these fail, do not consider this fix complete — go back to
`docs/superpowers/specs/2026-08-04-mailreach-smtp-connect-404-design.md` section 1's
open question about the `provider` enum value and re-verify against the actual `422`/
`500` response body Mailreach returns, since that's the one part of this fix that
couldn't be confirmed without a live account.

- [ ] **Step 4: Update the roadmap**

Per `CLAUDE.md`, update `.claude/roadmap.md` to reflect this fix as shipped.
