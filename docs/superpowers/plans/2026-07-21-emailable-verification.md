# Emailable Deliverability Guard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gate lead activation behind a second, independent email verification (Emailable) so that only addresses confirmed `deliverable` are ever emailed — protecting client sender reputation and driving bounces toward zero.

**Architecture:** A new `src/lib/emailable/` module (client + pure decision-table mapper) is called from one seam — `enrichCandidates` in `src/lib/pipeline/discover.ts` — immediately after Apollo enrichment. Emailable acts **only as a narrowing filter**: it can demote a lead Apollo called `verified`, never promote one Apollo did not. Leads that fail the guard are parked, so they are never grouped into a case and never consume Research Agent or Email-Writer LLM cost.

**Tech Stack:** TypeScript (strict), Zod, Vitest, Next.js, Supabase/Postgres, existing `fetchJson` + `AppError` + `withExternalLogging` primitives.

**Spec:** `docs/superpowers/specs/2026-07-21-emailable-verification-design.md`

## Global Constraints

- **Strict send policy.** Only Emailable `state: 'deliverable'` may activate a lead. `risky`, `unknown`, `undeliverable`, and any unrecognized state park it.
- **Blanket fail open.** Any Emailable call failure of any kind — including `402` insufficient credits and `403` invalid key — falls back to Apollo's verdict and activates the lead. This is a deliberate operator decision. Do not add retry, backoff, or circuit-breaking.
- **Emailable is called only** when `mapApolloEmailStatus(person.emailStatus) === 'verified'` **and** the enriched email is a non-empty string. Never call it otherwise — it costs credits and could not promote the lead anyway.
- **Never log the API key or a full email address.** `EMAILABLE_API_KEY` must not reach `AppError.context`, the `events` table, or any log payload. Event payloads carry the company **domain** only.
- **No `any`.** No `!` non-null assertions without a comment proving safety. Explicit return types on every exported function.
- **DB columns are `snake_case`; TypeScript is `camelCase`.** Map explicitly.
- Vendor base URL: `https://api.emailable.com/v1`. Endpoint: `GET /v1/verify`. Vendor-side `timeout=5` (docs allow 2–10). Transport timeout `10_000` ms. Concurrency ceiling `5` (vendor limit is 25 req/s).
- Every task ends green on `pnpm test`, `pnpm typecheck`, and `pnpm lint`.

---

### Task 1: Schema and log-source plumbing

Adds the audit column and the `emailable` log source. `LOG_SOURCE_META` is a `Record<LogSource, StatusMeta>`, so extending the enum without extending the map is a compile error — that is intentional and the task exploits it.

**Files:**
- Create: `supabase/migrations/0011_lead_email_verification.sql`
- Modify: `src/types/database.ts` (leads `Row` + `Insert`, `log_source` enum)
- Modify: `src/types/logs.ts:9-18` (`LOG_SOURCES`)
- Modify: `src/lib/ui/log.ts:12-21` (`LOG_SOURCE_META`) and the `SENTENCE_BUILDERS` map
- Test: `src/lib/ui/log.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `leads.email_verification` column (`jsonb`, nullable); `Database['public']['Enums']['log_source']` now includes `'emailable'`; `LeadInsert` accepts `email_verification?: Json | null`.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/ui/log.test.ts` inside the existing `describe('describeEvent', …)` block:

```ts
  it('should name the vendor and the domain when given a failed email verification', () => {
    const result = describeEvent('emailable.verify.failed', {
      campaignId: 'camp1',
      domain: 'acme.com',
      errorMessage: 'HTTP 402',
    })

    expect(result).toBe('Email verification failed for a lead at acme.com: HTTP 402.')
  })

  it('should warn on a discovery run that activated leads without verification', () => {
    const result = describeEvent('pipeline.discover.completed', {
      campaignId: 'camp1',
      inserted: 14,
      verified: 9,
      emailableFailedOpen: 3,
    })

    expect(result).toBe(
      'Discovery run finished — 14 leads found, 9 with a verified email. 3 activated without verification — the deliverability guard was unavailable.',
    )
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/ui/log.test.ts`
Expected: FAIL — the first test falls through to the unmapped-error branch and returns `'HTTP 402'`; the second returns the sentence without the trailing warning.

- [ ] **Step 3: Create the migration**

Create `supabase/migrations/0011_lead_email_verification.sql`:

```sql
-- Emailable deliverability guard (docs/superpowers/specs/2026-07-21-emailable-verification-design.md).
--
-- Emailable's per-lead verdict, kept out of `raw` — that column is documented in
-- architecture.md §5 as the full raw Apollo person object and must stay that.
--
-- Nullable with no backfill on purpose: an existing row reads NULL, meaning
-- "discovered before the guard existed", which is accurate.
--
-- Under the blanket fail-open policy this column is the only durable record of
-- whether a lead was actually guarded. `verified` no longer means one thing: it
-- is either "Emailable confirmed deliverable" or "Emailable was unreachable and
-- this is Apollo's word alone". The events log cannot answer that — the
-- retention cron added in 0010 purges info rows at 30 days and warn/error at 90.
--
-- No index: nothing queries this on a hot path, it is read per-lead for audit.
alter table leads add column email_verification jsonb;

-- `withExternalLogging('emailable', ...)` writes events.source, which is this
-- enum. ALTER TYPE ... ADD VALUE is permitted inside a transaction on PG12+ so
-- long as the new value is not *used* in the same transaction — nothing here
-- references it, so this is safe under `supabase db push`.
alter type log_source add value if not exists 'emailable';
```

- [ ] **Step 4: Apply the migration to the local database**

Run: `pnpm supabase db reset`
Expected: all migrations `0001`–`0011` apply cleanly, ending with the seed file. If `supabase start` has not been run in this environment, run `pnpm supabase start` first.

- [ ] **Step 5: Update the generated database types**

`src/types/database.ts` is checked in and hand-maintained. Make three edits.

In `leads.Row`, after the `email_verified_at: string | null` line (around line 158):

```ts
          email_verified_at: string | null
          email_verification: Json | null
```

In `leads.Insert`, after the `email_verified_at?: string | null` line (around line 178):

```ts
          email_verified_at?: string | null
          email_verification?: Json | null
```

Replace the `log_source` enum line (line 632):

```ts
      log_source: 'app' | 'pipeline' | 'gemini' | 'apollo' | 'brightdata' | 'mailbox' | 'qstash' | 'db' | 'emailable'
```

`leads.Update` is `Partial<…['Insert']>` and needs no edit.

- [ ] **Step 6: Add the source to the UI enums**

In `src/types/logs.ts`, add `'emailable'` to the end of `LOG_SOURCES`:

```ts
export const LOG_SOURCES: readonly LogSource[] = [
  'app',
  'pipeline',
  'gemini',
  'apollo',
  'brightdata',
  'mailbox',
  'qstash',
  'db',
  'emailable',
] as const
```

In `src/lib/ui/log.ts`, add the entry to `LOG_SOURCE_META`. `--status-hot-handoff` is the one `--status-*` variable no other source uses, so all nine stay visually distinct:

```ts
  db: { label: 'Database', color: 'var(--status-lost)' },
  emailable: { label: 'Emailable', color: 'var(--status-hot-handoff)' },
}
```

- [ ] **Step 7: Add the sentence builders**

In `src/lib/ui/log.ts`, replace the existing `'pipeline.discover.completed'` builder with this one, which appends a warning only when the guard was bypassed (a payload without the field reads `0` via `readNumber`, so every historic event row renders exactly as before):

```ts
  'pipeline.discover.completed': (p) => {
    const base = `Discovery run finished — ${readNumber(p, 'inserted')} leads found, ${readNumber(p, 'verified')} with a verified email.`
    const failedOpen = readNumber(p, 'emailableFailedOpen')
    if (failedOpen === 0) return base
    return `${base} ${failedOpen} activated without verification — the deliverability guard was unavailable.`
  },
```

Add a new builder next to the `apollo.*` ones:

```ts
  'emailable.verify.failed': (p) =>
    `Email verification failed for a lead at ${readString(p, 'domain') ?? 'an unknown domain'}: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
```

- [ ] **Step 8: Run the tests and typecheck**

Run: `pnpm vitest run src/lib/ui/log.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS — including the pre-existing `'should report the lead tally when given a completed discovery run'` test, whose payload has no `emailableFailedOpen` and so still gets the unsuffixed sentence.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/0011_lead_email_verification.sql src/types/database.ts src/types/logs.ts src/lib/ui/log.ts src/lib/ui/log.test.ts
git commit -m "feat(db): add leads.email_verification and the emailable log source"
```

---

### Task 2: Redactable error URL in `fetchJson`

Emailable authenticates by query parameter — unlike Apollo, which uses a header. `fetchJson` copies its `url` argument into `AppError.context` on all three failure paths, and that context reaches the `events` table and the operator-facing Logs tab. Without this change the API key leaks on the first 402.

**Files:**
- Modify: `src/lib/http/fetch-json.ts`
- Test: `src/lib/http/fetch-json.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `fetchJson<T>(url: string, options: RequestInit, schema: ZodType<T>, timeoutMs?: number, logUrl?: string): Promise<T>` — `logUrl` defaults to `url`, so all existing callers are unaffected.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/http/fetch-json.test.ts` inside `describe('fetchJson', …)`:

```ts
  it('should report logUrl instead of url in error context when the status is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 402 })))
    await expect(
      fetchJson('http://x?api_key=secret', { method: 'GET' }, schema, 8000, 'http://x?api_key=REDACTED'),
    ).rejects.toMatchObject({ context: { url: 'http://x?api_key=REDACTED' } })
  })

  it('should report logUrl instead of url in error context when the request aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    await expect(
      fetchJson('http://x?api_key=secret', { method: 'GET' }, schema, 10, 'http://x?api_key=REDACTED'),
    ).rejects.toMatchObject({ context: { url: 'http://x?api_key=REDACTED' } })
  })

  it('should report logUrl instead of url in error context when the body fails validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    ))
    await expect(
      fetchJson('http://x?api_key=secret', { method: 'GET' }, schema, 8000, 'http://x?api_key=REDACTED'),
    ).rejects.toMatchObject({ context: { url: 'http://x?api_key=REDACTED' } })
  })

  it('should fall back to url in error context when logUrl is omitted', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 500 })))
    await expect(
      fetchJson('http://plain', { method: 'GET' }, schema),
    ).rejects.toMatchObject({ context: { url: 'http://plain' } })
  })
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/http/fetch-json.test.ts`
Expected: FAIL on the first three — `context.url` is `'http://x?api_key=secret'`, leaking the key. The fourth passes already; it is a regression guard for the default.

- [ ] **Step 3: Add the parameter**

Rewrite `src/lib/http/fetch-json.ts` as:

```ts
import type { ZodType } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const DEFAULT_TIMEOUT_MS = 8000

/**
 * @param logUrl - URL recorded in `AppError.context` instead of `url`. Callers
 * that authenticate by query parameter pass a redacted copy: error context is
 * written to the `events` table and rendered on the operator-facing Logs tab,
 * so a secret in the real URL would leak there. Defaults to `url`.
 */
export async function fetchJson<T>(
  url: string,
  options: RequestInit,
  schema: ZodType<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  logUrl: string = url,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...options, signal: controller.signal })
  } catch (cause) {
    const isAbort = cause instanceof DOMException && cause.name === 'AbortError'
    throw new AppError(isAbort ? 'EXTERNAL_TIMEOUT' : 'EXTERNAL_ERROR', 'HTTP request failed', {
      url: logUrl, cause: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppError('EXTERNAL_ERROR', `HTTP ${response.status}`, { url: logUrl, status: response.status, body: text.slice(0, 500) })
  }
  const json: unknown = await response.json().catch(() => undefined)
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('EXTERNAL_ERROR', 'Unexpected response shape', { url: logUrl, issues: parsed.error.flatten() })
  }
  return parsed.data
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/http/fetch-json.test.ts && pnpm typecheck`
Expected: PASS, 8 tests.

- [ ] **Step 5: Verify no existing caller regressed**

Run: `pnpm test`
Expected: PASS — `logUrl` defaults to `url`, so Apollo, Brightdata, and mailbox callers are unchanged.

- [ ] **Step 6: Commit**

```bash
git add src/lib/http/fetch-json.ts src/lib/http/fetch-json.test.ts
git commit -m "feat(http): let fetchJson report a redacted URL in error context"
```

---

### Task 3: Emailable client

**Files:**
- Create: `src/lib/emailable/types.ts`
- Create: `src/lib/emailable/client.ts`
- Create: `src/lib/emailable/client.test.ts`
- Modify: `src/lib/env.ts:22` (add key), `src/lib/env.test.ts`, `.env.example`, `vitest.config.ts`

**Interfaces:**
- Consumes: `fetchJson(url, options, schema, timeoutMs, logUrl)` from Task 2.
- Produces:
  - `emailableResultSchema` — Zod schema
  - `type EmailableResult = z.infer<typeof emailableResultSchema>`
  - `verifyEmail(email: string): Promise<EmailableResult>`

> **`vitest.config.ts` is not optional here.** Its `env` block stubs every var so that module-scope `loadEnv(process.env)` in `@/lib/env` never crashes a unit test. Adding `EMAILABLE_API_KEY` to the schema without adding it there breaks the **entire** suite, not just this task.

- [ ] **Step 1: Write the failing env test**

In `src/lib/env.test.ts`, add to the `complete` fixture after the `APOLLO_API_KEY` line:

```ts
  APOLLO_API_KEY: 'apollo-key',
  EMAILABLE_API_KEY: 'emailable-key',
}
```

And add a new test inside `describe('loadEnv', …)`:

```ts
  it('should require EMAILABLE_API_KEY', () => {
    const { EMAILABLE_API_KEY: _omit, ...partial } = complete
    expect(() => loadEnv(partial)).toThrowError(/EMAILABLE_API_KEY/)
    expect(() => loadEnv({ ...complete, EMAILABLE_API_KEY: '' })).toThrowError(/EMAILABLE_API_KEY/)
  })
```

- [ ] **Step 2: Run it to verify it fails**

Run: `pnpm vitest run src/lib/env.test.ts`
Expected: FAIL — `loadEnv` accepts the object without the key, so neither `toThrowError` fires.

- [ ] **Step 3: Add the env var everywhere it is declared**

In `src/lib/env.ts`, add to `envSchema` after `APOLLO_API_KEY`:

```ts
  APOLLO_API_KEY: nonEmpty,
  EMAILABLE_API_KEY: nonEmpty,
})
```

In `vitest.config.ts`, add to the `env` block after `APOLLO_API_KEY`:

```ts
      APOLLO_API_KEY: 'test-apollo-api-key',
      EMAILABLE_API_KEY: 'test-emailable-api-key',
    },
```

In `.env.example`, append under the pipeline providers block:

```
APOLLO_API_KEY=
# Emailable — second-opinion deliverability check layered on Apollo's own
# email_status. Only `deliverable` activates a lead. See architecture.md §6.
EMAILABLE_API_KEY=
```

- [ ] **Step 4: Run the env test to verify it passes**

Run: `pnpm vitest run src/lib/env.test.ts && pnpm test`
Expected: PASS — the whole suite, proving the `vitest.config.ts` stub landed.

- [ ] **Step 4b: Confirm the dev and build allowlist entries still work**

`.claude/settings.local.json` allowlists two long `pnpm dev` / `pnpm build` commands that inline every env var. Both already carry `EMAILABLE_API_KEY=fake` from before the key was dropped in P1, so no edit should be needed.

Run: `grep -c "EMAILABLE_API_KEY=fake" .claude/settings.local.json`
Expected: `2`. If it prints `0` or `1`, add `EMAILABLE_API_KEY=fake` to whichever of the two commands is missing it — otherwise `pnpm build` will fail on the new required env var and the allowlisted command will no longer match.

- [ ] **Step 5: Write the failing client tests**

Create `src/lib/emailable/client.test.ts`. This test stubs `fetch` rather than `fetchJson`, so vendor status codes and schema handling are exercised through the real `fetchJson` — mocking `fetchJson` would make those assertions vacuous.

```ts
import { describe, it, expect, vi, afterEach } from 'vitest'

vi.mock('@/lib/env', () => ({ env: { EMAILABLE_API_KEY: 'super-secret-key' } }))

import { verifyEmail } from './client'

const deliverable = {
  accept_all: false,
  did_you_mean: null,
  disposable: false,
  domain: 'acme.com',
  duration: 0.493,
  email: 'jo@acme.com',
  free: false,
  mailbox_full: false,
  mx_record: 'aspmx.l.google.com',
  no_reply: false,
  reason: 'accepted_email',
  role: false,
  score: 100,
  smtp_provider: 'google',
  state: 'deliverable',
  tag: null,
  user: 'jo',
}

function stubFetch(body: string, status: number): ReturnType<typeof vi.fn> {
  const spy = vi.fn().mockResolvedValue(new Response(body, { status }))
  vi.stubGlobal('fetch', spy)
  return spy
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
})

describe('verifyEmail', () => {
  it('should call the v1/verify endpoint with the email, api key and a 5 second vendor timeout', async () => {
    const spy = stubFetch(JSON.stringify(deliverable), 200)

    await verifyEmail('jo@acme.com')

    const url = new URL(String(spy.mock.calls[0]?.[0]))
    expect(url.origin + url.pathname).toBe('https://api.emailable.com/v1/verify')
    expect(url.searchParams.get('email')).toBe('jo@acme.com')
    expect(url.searchParams.get('api_key')).toBe('super-secret-key')
    expect(url.searchParams.get('timeout')).toBe('5')
  })

  it('should return the parsed result when the vendor responds with a deliverable state', async () => {
    stubFetch(JSON.stringify(deliverable), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result.state).toBe('deliverable')
    expect(result.score).toBe(100)
  })

  it('should preserve undocumented vendor fields so the audit record stays complete', async () => {
    stubFetch(JSON.stringify({ ...deliverable, brand_new_field: 'keep me' }), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result).toMatchObject({ brand_new_field: 'keep me' })
  })

  it('should still parse a response carrying only the fields we depend on', async () => {
    stubFetch(JSON.stringify({ state: 'risky', email: 'jo@acme.com' }), 200)

    const result = await verifyEmail('jo@acme.com')

    expect(result.state).toBe('risky')
  })

  it.each([249, 400, 401, 402, 403, 404, 429, 500, 503])(
    'should throw EXTERNAL_ERROR when the vendor responds %i',
    async (status) => {
      stubFetch(JSON.stringify({ message: 'nope' }), status)

      await expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({
        code: 'EXTERNAL_ERROR',
        context: { status },
      })
    },
  )

  it('should throw EXTERNAL_ERROR when the response has no state field', async () => {
    stubFetch(JSON.stringify({ email: 'jo@acme.com' }), 200)

    await expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_TIMEOUT when the request aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))

    await expect(verifyEmail('jo@acme.com')).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })

  it('should never expose the api key in thrown error context', async () => {
    stubFetch(JSON.stringify({ message: 'insufficient credits' }), 402)

    const error = await verifyEmail('jo@acme.com').catch((e: unknown) => e)

    const serialized = JSON.stringify((error as { context: Record<string, unknown> }).context)
    expect(serialized).not.toContain('super-secret-key')
    expect(serialized).toContain('REDACTED')
  })
})
```

- [ ] **Step 6: Run them to verify they fail**

Run: `pnpm vitest run src/lib/emailable/client.test.ts`
Expected: FAIL — `Failed to resolve import "./client"`.

- [ ] **Step 7: Write `types.ts`**

Create `src/lib/emailable/types.ts`:

```ts
import { z } from 'zod'

// Emailable's documented /v1/verify response. Only `state` and `email` are
// required: `state` is the sole field the send policy branches on, and every
// other field exists purely for the audit record on leads.email_verification.
//
// Everything else is optional on purpose. A schema failure here would be
// indistinguishable from a vendor outage and would fall into the fail-open
// branch, activating a lead we had a real verdict for. Being permissive about
// fields we do not read is strictly safer than being strict about them.
//
// `state` is typed as a plain string rather than an enum for the same reason:
// an unrecognized state is mapped to a parked lead by map-verification.ts,
// which is a better outcome than a parse error that fails open.
export const emailableResultSchema = z.object({
  state: z.string(),
  email: z.string(),
  reason: z.string().optional(),
  score: z.number().optional(),
  domain: z.string().optional(),
  user: z.string().optional(),
  accept_all: z.boolean().nullable().optional(),
  did_you_mean: z.string().nullable().optional(),
  disposable: z.boolean().optional(),
  free: z.boolean().optional(),
  role: z.boolean().optional(),
  no_reply: z.boolean().optional(),
  mailbox_full: z.boolean().optional(),
  mx_record: z.string().nullable().optional(),
  smtp_provider: z.string().nullable().optional(),
  tag: z.string().nullable().optional(),
  duration: z.number().optional(),
}).passthrough()

export type EmailableResult = z.infer<typeof emailableResultSchema>

/**
 * One lead's verification attempt. `ok: false` means we got no verdict at all
 * (network, timeout, 4xx, 5xx) — distinct from a verdict we understood and
 * rejected. Only this case triggers the fail-open branch.
 */
export type VerificationOutcome =
  | { ok: true; result: EmailableResult }
  | { ok: false; error: string }
```

- [ ] **Step 8: Write `client.ts`**

Create `src/lib/emailable/client.ts`:

```ts
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { emailableResultSchema, type EmailableResult } from './types'

const BASE_URL = 'https://api.emailable.com/v1'

// Vendor-side ceiling for the SMTP probe; their docs allow 2-10s and default to 5.
const VERIFY_TIMEOUT_SECONDS = 5

// Sits above VERIFY_TIMEOUT_SECONDS so their own deadline always wins the race —
// aborting first would turn a real verdict into a fail-open activation.
const TRANSPORT_TIMEOUT_MS = 10_000

const REDACTED_KEY = 'REDACTED'

function buildVerifyUrl(email: string, apiKey: string): string {
  const params = new URLSearchParams({
    email,
    api_key: apiKey,
    timeout: String(VERIFY_TIMEOUT_SECONDS),
  })
  return `${BASE_URL}/verify?${params.toString()}`
}

/**
 * Verifies one address against Emailable. Throws `AppError` on any failure —
 * the caller decides what a missing verdict means, this module does not.
 *
 * The key travels in the query string because that is the only auth mechanism
 * the documented endpoint accepts, so a redacted copy of the URL is handed to
 * fetchJson for error context: that context reaches the events table.
 */
export async function verifyEmail(email: string): Promise<EmailableResult> {
  return fetchJson(
    buildVerifyUrl(email, env.EMAILABLE_API_KEY),
    { method: 'GET', headers: { Accept: 'application/json' } },
    emailableResultSchema,
    TRANSPORT_TIMEOUT_MS,
    buildVerifyUrl(email, REDACTED_KEY),
  )
}
```

- [ ] **Step 9: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/emailable/client.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS, 17 tests (the `it.each` block counts as 9).

- [ ] **Step 10: Commit**

```bash
git add src/lib/emailable/types.ts src/lib/emailable/client.ts src/lib/emailable/client.test.ts src/lib/env.ts src/lib/env.test.ts .env.example vitest.config.ts
git commit -m "feat(emailable): add /v1/verify client with redacted error context"
```

---

### Task 4: Verdict decision table

The entire send policy, as one pure function. No I/O, total over its input, 100% covered.

**Files:**
- Create: `src/lib/emailable/map-verification.ts`
- Create: `src/lib/emailable/map-verification.test.ts`

**Interfaces:**
- Consumes: `EmailableResult`, `VerificationOutcome` from Task 3.
- Produces:
  - `interface LeadVerificationVerdict { emailStatus: LeadEmailStatus; leadStatus: LeadStatus; verification: Json }`
  - `mapEmailableVerdict(outcome: VerificationOutcome, checkedAt: string): LeadVerificationVerdict`

The table it implements (input is always an Apollo-`verified` lead with a non-empty email — the caller guarantees this):

| Emailable outcome | `emailStatus` | `leadStatus` |
|---|---|---|
| `deliverable` | `verified` | `active` |
| `undeliverable` | `invalid` | `parked` |
| `risky` | `risky` | `parked` |
| `unknown` | `unverified` | `parked` |
| unrecognized state | `unverified` | `parked` |
| call failed | `verified` | `active` |

- [ ] **Step 1: Write the failing tests**

Create `src/lib/emailable/map-verification.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { mapEmailableVerdict } from './map-verification'
import type { EmailableResult } from './types'

const CHECKED_AT = '2026-07-21T10:00:00.000Z'

function result(state: string, reason: string): EmailableResult {
  return { state, reason, email: 'jo@acme.com', score: 100 }
}

function ok(state: string, reason: string) {
  return mapEmailableVerdict({ ok: true, result: result(state, reason) }, CHECKED_AT)
}

describe('mapEmailableVerdict', () => {
  it('should activate the lead when the state is deliverable', () => {
    const verdict = ok('deliverable', 'accepted_email')

    expect(verdict.emailStatus).toBe('verified')
    expect(verdict.leadStatus).toBe('active')
  })

  it.each(['invalid_email', 'invalid_domain', 'rejected_email', 'invalid_smtp'])(
    'should park the lead as invalid when undeliverable for reason %s',
    (reason) => {
      const verdict = ok('undeliverable', reason)

      expect(verdict.emailStatus).toBe('invalid')
      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it.each(['low_quality', 'low_deliverability'])(
    'should park the lead as risky when risky for reason %s',
    (reason) => {
      const verdict = ok('risky', reason)

      expect(verdict.emailStatus).toBe('risky')
      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it.each(['no_connect', 'timeout', 'unavailable_smtp', 'unexpected_error'])(
    'should park the lead as unverified when unknown for reason %s',
    (reason) => {
      const verdict = ok('unknown', reason)

      expect(verdict.emailStatus).toBe('unverified')
      expect(verdict.leadStatus).toBe('parked')
    },
  )

  it('should park the lead when the vendor returns a state we do not recognise', () => {
    const verdict = ok('brand_new_state', 'whatever')

    expect(verdict.emailStatus).toBe('unverified')
    expect(verdict.leadStatus).toBe('parked')
  })

  it('should park the lead on the batch-only duplicate state, which /v1/verify should never return', () => {
    const verdict = ok('duplicate', 'whatever')

    expect(verdict.leadStatus).toBe('parked')
  })

  it('should be case and whitespace insensitive about the state', () => {
    expect(ok(' Deliverable ', 'accepted_email').leadStatus).toBe('active')
    expect(ok('UNDELIVERABLE', 'rejected_email').emailStatus).toBe('invalid')
  })

  it('should record the full vendor response for audit when a verdict was returned', () => {
    const verdict = ok('risky', 'low_quality')

    expect(verdict.verification).toMatchObject({
      provider: 'emailable',
      outcome: 'checked',
      checkedAt: CHECKED_AT,
      state: 'risky',
      reason: 'low_quality',
      score: 100,
    })
  })

  it('should preserve undocumented vendor fields in the audit record', () => {
    const verdict = mapEmailableVerdict(
      { ok: true, result: { ...result('deliverable', 'accepted_email'), brand_new_field: 'keep me' } },
      CHECKED_AT,
    )

    expect(verdict.verification).toMatchObject({ brand_new_field: 'keep me' })
  })

  it('should fail open and activate the lead on Apollo\'s word when the call failed', () => {
    const verdict = mapEmailableVerdict({ ok: false, error: 'HTTP 402' }, CHECKED_AT)

    expect(verdict.emailStatus).toBe('verified')
    expect(verdict.leadStatus).toBe('active')
  })

  it('should record the failure so a fail-open lead is distinguishable from a verified one', () => {
    const verdict = mapEmailableVerdict({ ok: false, error: 'HTTP 402' }, CHECKED_AT)

    expect(verdict.verification).toEqual({
      provider: 'emailable',
      outcome: 'failed',
      error: 'HTTP 402',
      checkedAt: CHECKED_AT,
    })
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/emailable/map-verification.test.ts`
Expected: FAIL — `Failed to resolve import "./map-verification"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/emailable/map-verification.ts`:

```ts
import type { Database, Json } from '@/types/database'
import type { VerificationOutcome } from './types'

type LeadEmailStatus = Database['public']['Enums']['lead_email_status']
type LeadStatus = Database['public']['Enums']['lead_status']

export interface LeadVerificationVerdict {
  emailStatus: LeadEmailStatus
  leadStatus: LeadStatus
  /** Written verbatim to leads.email_verification. */
  verification: Json
}

// Emailable's documented /v1/verify states. `duplicate` is deliberately absent:
// it only occurs in uploaded batch lists, so on this endpoint it falls through
// to the unrecognized-state branch and parks, which is the correct outcome.
const STATE_MAP: Record<string, LeadEmailStatus> = {
  deliverable: 'verified',
  undeliverable: 'invalid',
  risky: 'risky',
  unknown: 'unverified',
}

// The parsed response came off the wire as JSON, so it is JSON-serialisable by
// construction — this round-trip only re-expresses that fact in a type the
// jsonb column accepts, without an `as` cast that could hide a real mismatch.
function toJson(value: unknown): Json {
  return JSON.parse(JSON.stringify(value)) as Json
}

/**
 * The whole send policy. Input is always a lead Apollo already marked
 * `verified` with a non-empty email — the caller guarantees that, because
 * Emailable is never called for any other lead.
 *
 * Emailable only ever narrows: it can demote a lead Apollo verified, never
 * promote one Apollo did not. Only `deliverable` activates.
 *
 * A state we do not recognise parks the lead. That is deliberate and is NOT
 * the same as the fail-open branch below: an unrecognised state is a definite
 * answer we cannot interpret, so the safe reading is "not proven deliverable".
 * Fail-open applies only to the absence of an answer.
 */
export function mapEmailableVerdict(
  outcome: VerificationOutcome,
  checkedAt: string,
): LeadVerificationVerdict {
  // Blanket fail open, by explicit operator decision: any failure — including a
  // persistent 402 (out of credits) or 403 (bad key) — falls back to Apollo's
  // verdict rather than stalling discovery. `verification` is the only durable
  // record that this lead was never actually guarded.
  if (!outcome.ok) {
    return {
      emailStatus: 'verified',
      leadStatus: 'active',
      verification: { provider: 'emailable', outcome: 'failed', error: outcome.error, checkedAt },
    }
  }

  const state = outcome.result.state.toLowerCase().trim()
  const emailStatus = STATE_MAP[state] ?? 'unverified'
  return {
    emailStatus,
    leadStatus: emailStatus === 'verified' ? 'active' : 'parked',
    verification: toJson({
      provider: 'emailable',
      outcome: 'checked',
      checkedAt,
      ...outcome.result,
    }),
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/emailable/map-verification.test.ts && pnpm typecheck && pnpm lint`
Expected: PASS, 21 tests (the three `it.each` blocks contribute 10).

- [ ] **Step 5: Commit**

```bash
git add src/lib/emailable/map-verification.ts src/lib/emailable/map-verification.test.ts
git commit -m "feat(emailable): add the strict deliverability decision table"
```

---

### Task 5: Wire the guard into discovery

**Files:**
- Modify: `src/lib/pipeline/discover.ts`
- Test: `src/lib/pipeline/discover.test.ts`

**Interfaces:**
- Consumes: `verifyEmail` (Task 3), `mapEmailableVerdict` + `LeadVerificationVerdict` (Task 4), `VerificationOutcome` (Task 3), `leads.email_verification` (Task 1).
- Produces: `DiscoverySummary` gains `emailableChecked`, `emailableDeliverable`, `emailableRejected`, `emailableFailedOpen`; its existing `verified` field is redefined as the count of rows that ended at `email_status: 'verified'`.

> **Two existing things must not break.** The pre-existing tests in `discover.test.ts` all assume an Apollo-`verified` lead becomes `active` and gets grouped — a `mockVerifyEmail` default of `deliverable` in `beforeEach` keeps them green. And `apolloContext` is renamed to `vendorContext` because Emailable now uses the same helper; that rename touches its six existing call sites in this file and nothing outside it.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pipeline/discover.test.ts`, add the mock alongside the existing hoisted mocks (after `mockBulkMatchPeople`):

```ts
const mockVerifyEmail = vi.hoisted(() => vi.fn())
```

Add the module mock next to the others:

```ts
vi.mock('@/lib/emailable/client', () => ({ verifyEmail: mockVerifyEmail }))
```

Add this helper next to the existing `enriched` helper:

```ts
function verification(state: string) {
  return { state, reason: 'x', email: 'jo@acme.com', score: state === 'deliverable' ? 100 : 10 }
}
```

In `beforeEach`, add the reset and the default. The default is what keeps every pre-existing test in this file green:

```ts
    mockVerifyEmail.mockReset()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))
```

Then append this new `describe` block at the end of the file:

```ts
describe('runDiscoveryForCampaign — Emailable deliverability guard', () => {
  beforeEach(() => {
    mockSearchPeople.mockReset()
    mockBulkMatchPeople.mockReset()
    mockGetKnownSourceIds.mockReset()
    mockInsertLeads.mockReset()
    mockGetVerifiedLeadCompanies.mockReset()
    mockGroupVerifiedLead.mockReset()
    mockLogEvent.mockReset()
    mockLogError.mockReset()
    mockVerifyEmail.mockReset()
    mockGetKnownSourceIds.mockResolvedValue(new Set())
    mockGetVerifiedLeadCompanies.mockResolvedValue([])
    mockGroupVerifiedLead.mockResolvedValue('case1')
    mockInsertLeads.mockImplementation(async (_supabase: unknown, rows: { source_id: string | null | undefined }[]) =>
      insertedRows(rows),
    )
  })

  // One brand-new company on pass 1, nothing on pass 2 — the smallest run that
  // still exercises both passes.
  function singleCandidateRun(apolloEmailStatus = 'verified') {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, apolloEmailStatus)),
    )
  }

  function insertedRow(): Record<string, unknown> {
    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    // insertLeads is called exactly once per run, with every enriched row.
    return rows[0]!
  }

  it('should activate the lead when Emailable says deliverable', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verification('deliverable'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'verified', status: 'active' })
    expect(insertedRow().email_verified_at).toEqual(expect.any(String))
    expect(insertedRow().email_verification).toMatchObject({ provider: 'emailable', outcome: 'checked', state: 'deliverable' })
    expect(summary.emailableChecked).toBe(1)
    expect(summary.emailableDeliverable).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.emailableFailedOpen).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should park the lead as invalid and never group it when Emailable says undeliverable', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verification('undeliverable'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'invalid', status: 'parked', email_verified_at: null })
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    expect(summary.emailableRejected).toBe(1)
    expect(summary.verified).toBe(0)
  })

  it.each([
    ['risky', 'risky'],
    ['unknown', 'unverified'],
  ])('should park the lead when Emailable says %s', async (state, expectedStatus) => {
    singleCandidateRun()
    mockVerifyEmail.mockResolvedValue(verification(state))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: expectedStatus, status: 'parked' })
    expect(mockGroupVerifiedLead).not.toHaveBeenCalled()
    expect(summary.emailableRejected).toBe(1)
  })

  it('should fail open and activate the lead when the Emailable call throws', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(insertedRow()).toMatchObject({ email_status: 'verified', status: 'active' })
    expect(insertedRow().email_verification).toMatchObject({ outcome: 'failed', error: 'HTTP 402' })
    expect(summary.emailableFailedOpen).toBe(1)
    expect(summary.emailableRejected).toBe(0)
    expect(summary.verified).toBe(1)
  })

  it('should log a client-attributed error event when the Emailable call throws', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockLogError).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'client1',
      type: 'emailable.verify.failed',
      source: 'emailable',
    }))
  })

  it('should never send a full email address to the logs, only the company domain', async () => {
    singleCandidateRun()
    mockVerifyEmail.mockRejectedValue(new Error('HTTP 402'))

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    const logged = JSON.stringify(mockLogError.mock.calls[0]?.[0])
    expect(logged).toContain('acme.com')
    expect(logged).not.toContain('p1@acme.com')
  })

  it('should not call Emailable for a lead Apollo did not mark verified', async () => {
    singleCandidateRun('unverified')

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(insertedRow()).toMatchObject({ email_status: 'unverified', status: 'parked', email_verification: null })
    expect(summary.emailableChecked).toBe(0)
  })

  it('should not call Emailable when Apollo returned a verified status but no email address', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 1, candidates: [candidate('p1', 'acme.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => ({ ...enriched(d.id, 'verified'), email: null })),
    )

    await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 2, icp })

    expect(mockVerifyEmail).not.toHaveBeenCalled()
    expect(insertedRow()).toMatchObject({ status: 'parked' })
  })

  it('should give every lead its own verdict when one verification in a batch fails', async () => {
    mockSearchPeople
      .mockResolvedValueOnce({ totalEntries: 2, candidates: [candidate('p1', 'p1.com'), candidate('p2', 'p2.com')] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
      .mockResolvedValueOnce({ totalEntries: 0, candidates: [] })
    mockBulkMatchPeople.mockImplementation(async (details: { id: string }[]) =>
      details.map((d) => enriched(d.id, 'verified')),
    )
    mockVerifyEmail
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce(verification('undeliverable'))

    const summary = await runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp })

    const rows = mockInsertLeads.mock.calls[0]?.[1] as Record<string, unknown>[]
    expect(rows[0]).toMatchObject({ status: 'active' })
    expect(rows[1]).toMatchObject({ status: 'parked', email_status: 'invalid' })
    expect(summary.emailableFailedOpen).toBe(1)
    expect(summary.emailableRejected).toBe(1)
    expect(summary.emailableChecked).toBe(2)
  })
})
```

- [ ] **Step 2: Run them to verify they fail**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — `Failed to resolve import "@/lib/emailable/client"` is not the error (that module exists from Task 3); instead the new assertions fail because `discover.ts` never calls `verifyEmail`, so `summary.emailableChecked` is `undefined` and every lead stays on Apollo's verdict.

- [ ] **Step 3: Add the imports and constants**

In `src/lib/pipeline/discover.ts`, add to the imports:

```ts
import { verifyEmail } from '@/lib/emailable/client'
import { mapEmailableVerdict, type LeadVerificationVerdict } from '@/lib/emailable/map-verification'
import type { VerificationOutcome } from '@/lib/emailable/types'
```

Add next to the other module constants:

```ts
// Emailable allows 25 req/s on /v1/verify. Five in flight keeps us an order of
// magnitude under that with no token bucket, and a 429 would signal a bug
// rather than normal load.
const VERIFY_CONCURRENCY = 5
```

- [ ] **Step 4: Rename `apolloContext` to `vendorContext`**

Emailable now uses the same helper, so the Apollo-specific name is wrong. Rename the function and update its comment; the body is unchanged:

```ts
// Every vendor call in this file is attributed to the campaign's client, so an
// Apollo or Emailable outage (or quota exhaustion) shows up on that client's
// Logs tab instead of only in a 500 the operator never sees.
function vendorContext(
  campaign: CampaignForDiscovery,
  failureType: string,
  payload: Record<string, Json>,
): ExternalCallContext {
  return {
    clientId: campaign.clientId,
    actor: 'system',
    failureType,
    payload: { campaignId: campaign.id, ...payload },
  }
}
```

Then update all six existing call sites in this file from `apolloContext(` to `vendorContext(` — they are in `runFirstPass`, `runSecondPass`, and `enrichCandidates`.

Run: `grep -n "apolloContext" src/lib/pipeline/discover.ts`
Expected: no output.

- [ ] **Step 5: Add the verification helpers**

Add these above `enrichCandidates` in `src/lib/pipeline/discover.ts`:

```ts
interface VerifiableRow {
  index: number
  row: LeadInsert
  email: string
}

interface VerifyBatchResult {
  rows: LeadInsert[]
  checked: number
  deliverable: number
  rejected: number
  failedOpen: number
}

// Never rejects: a missing verdict is a value the decision table understands,
// not an exception. Wrapping here is what lets a whole slice run under
// Promise.all without one bad address discarding its neighbours' results.
async function verifyRow(
  campaign: CampaignForDiscovery,
  { row, email }: VerifiableRow,
): Promise<VerificationOutcome> {
  try {
    // Only the company domain goes into the failure payload — events are
    // rendered on the operator-facing Logs tab, and the address itself is
    // already on the lead row behind the same RLS.
    const result = await withExternalLogging(
      'emailable',
      vendorContext(campaign, 'emailable.verify.failed', { domain: row.company_domain ?? null }),
      () => verifyEmail(email),
    )
    return { ok: true, result }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  }
}

/**
 * Runs the deliverability guard over one enrichment batch and returns the rows
 * with their final status applied.
 *
 * Emailable is called only for rows Apollo already marked `verified` that carry
 * a real address: it can never promote anything else, so verifying them would
 * only spend credits. Untouched rows keep the verdict Apollo gave them.
 */
async function verifyBatch(
  campaign: CampaignForDiscovery,
  batchRows: LeadInsert[],
): Promise<VerifyBatchResult> {
  const verifiable: VerifiableRow[] = []
  batchRows.forEach((row, index) => {
    if (row.email_status !== 'verified') return
    const { email } = row
    if (typeof email !== 'string' || email.length === 0) return
    verifiable.push({ index, row, email })
  })

  const verdicts = new Map<number, LeadVerificationVerdict>()
  let deliverable = 0
  let rejected = 0
  let failedOpen = 0

  // One timestamp for the whole batch, so a row's email_verified_at always
  // matches the checkedAt inside its own email_verification record.
  const checkedAt = new Date().toISOString()

  for (let i = 0; i < verifiable.length; i += VERIFY_CONCURRENCY) {
    const slice = verifiable.slice(i, i + VERIFY_CONCURRENCY)
    const outcomes = await Promise.all(slice.map((target) => verifyRow(campaign, target)))
    slice.forEach((target, offset) => {
      // Promise.all preserves input order, so outcomes[offset] belongs to slice[offset].
      const outcome = outcomes[offset]!
      const verdict = mapEmailableVerdict(outcome, checkedAt)
      verdicts.set(target.index, verdict)
      if (!outcome.ok) failedOpen += 1
      else if (verdict.leadStatus === 'active') deliverable += 1
      else rejected += 1
    })
  }

  const rows = batchRows.map((row, index) => {
    const verdict = verdicts.get(index)
    if (!verdict) return row
    return {
      ...row,
      email_status: verdict.emailStatus,
      status: verdict.leadStatus,
      email_verified_at: verdict.leadStatus === 'active' ? checkedAt : null,
      email_verification: verdict.verification,
    }
  })

  return { rows, checked: verifiable.length, deliverable, rejected, failedOpen }
}
```

- [ ] **Step 6: Rewrite `enrichCandidates`**

Replace the `EnrichResult` interface and the whole `enrichCandidates` function with:

```ts
interface EnrichResult {
  rows: LeadInsert[]
  /** Rows that ended at `email_status: 'verified'` — i.e. actually activated. */
  verifiedCount: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
}

async function enrichCandidates(
  candidates: FreshCandidate[],
  campaign: CampaignForDiscovery,
): Promise<EnrichResult> {
  const rows: LeadInsert[] = []
  let verifiedCount = 0
  let emailableChecked = 0
  let emailableDeliverable = 0
  let emailableRejected = 0
  let emailableFailedOpen = 0

  for (let i = 0; i < candidates.length; i += ENRICH_BATCH_SIZE) {
    const batch = candidates.slice(i, i + ENRICH_BATCH_SIZE)
    const enrichedPeople = await withExternalLogging(
      'apollo',
      vendorContext(campaign, 'apollo.enrich.failed', { batchSize: batch.length }),
      () =>
        bulkMatchPeople(
          batch.map((c) => ({
            id: c.apolloId,
            organizationName: c.organizationName ?? undefined,
            domain: c.organizationDomain ?? undefined,
            linkedinUrl: c.linkedinUrl ?? undefined,
          })),
        ),
    )

    const batchRows: LeadInsert[] = []
    for (const person of enrichedPeople) {
      const emailStatus = mapApolloEmailStatus(person.emailStatus)
      const source = batch.find((b) => b.apolloId === person.apolloId)
      const fullName = [person.firstName, person.lastName].filter(Boolean).join(' ') || source?.firstName || 'Unknown'
      batchRows.push({
        client_id: campaign.clientId,
        campaign_id: campaign.id,
        source_id: person.apolloId,
        full_name: fullName,
        title: person.title ?? source?.title ?? null,
        company_name: person.organizationName ?? source?.organizationName ?? null,
        company_domain: person.organizationDomain ?? source?.organizationDomain ?? null,
        linkedin_url: person.linkedinUrl ?? source?.linkedinUrl ?? null,
        source: 'apollo',
        raw: { ...person },
        email: person.email,
        email_status: emailStatus,
        email_verified_at: null,
        status: 'parked',
        email_verification: null,
      })
    }

    // The deliverability guard, not Apollo, has the final say on activation.
    const verified = await verifyBatch(campaign, batchRows)
    emailableChecked += verified.checked
    emailableDeliverable += verified.deliverable
    emailableRejected += verified.rejected
    emailableFailedOpen += verified.failedOpen
    for (const row of verified.rows) {
      if (row.email_status === 'verified') verifiedCount += 1
      rows.push(row)
    }
  }

  return { rows, verifiedCount, emailableChecked, emailableDeliverable, emailableRejected, emailableFailedOpen }
}
```

Note the two behavioural changes inside the row builder: `email_verified_at` and `status` are no longer derived from Apollo's verdict — every row starts parked with no timestamp, and `verifyBatch` promotes the ones that earn it. That is what makes it impossible for an unguarded lead to reach `active` through this path.

- [ ] **Step 7: Extend `DiscoverySummary` and thread the counters**

In the `DiscoverySummary` interface, add after `verified`:

```ts
export interface DiscoverySummary {
  campaignId: string
  candidatesSeen: number
  newCandidates: number
  firstPassCandidates: number
  secondPassCandidates: number
  enriched: number
  /** Leads that ended at `email_status: 'verified'` — i.e. cleared for sending. */
  verified: number
  emailableChecked: number
  emailableDeliverable: number
  emailableRejected: number
  emailableFailedOpen: number
  inserted: number
}
```

In `runDiscoveryForCampaign`, replace the `summary` object literal with:

```ts
    const summary: DiscoverySummary = {
      campaignId: campaign.id,
      candidatesSeen,
      newCandidates: fresh.length,
      firstPassCandidates: firstPass.picks.length,
      secondPassCandidates: secondPass.picks.length,
      enriched: enrichedRows.length,
      verified: verifiedCount,
      emailableChecked: firstPassEnriched.emailableChecked + secondPassEnriched.emailableChecked,
      emailableDeliverable: firstPassEnriched.emailableDeliverable + secondPassEnriched.emailableDeliverable,
      emailableRejected: firstPassEnriched.emailableRejected + secondPassEnriched.emailableRejected,
      emailableFailedOpen: firstPassEnriched.emailableFailedOpen + secondPassEnriched.emailableFailedOpen,
      inserted: inserted.length,
    }
```

The existing `secondPassEnriched` early-exit path already returns a full `EnrichResult` because `enrichCandidates` is always called — no change needed there. Leave the `verifiedApolloIds` / `verifiedCompanyCounts` block untouched: it filters `firstPassEnriched.rows` on `email_status === 'verified'`, which now means "cleared by the guard", so pass 2 correctly targets only companies whose first contact is actually sendable.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — both the new `describe` block and every pre-existing test in the file.

- [ ] **Step 9: Run the whole suite and the type checks**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS across the board.

- [ ] **Step 10: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts
git commit -m "feat(pipeline): gate lead activation behind the Emailable guard"
```

---

### Task 6: Documentation

`architecture.md` currently asserts in four places that Emailable was removed from the design. Leaving those in place would make the document actively wrong about how leads get activated.

**Files:**
- Modify: `.claude/architecture.md` (§2, §3, §4, §5, §12, §13)
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: the shipped behaviour from Tasks 1–5.
- Produces: nothing code-facing.

- [ ] **Step 1: Update §2 Design Principles**

In the **No guessing** bullet, replace the sentence about Apollo being the sole activator so it reads:

> **No guessing.** Email addresses come from Apollo's database, and an address only activates a lead if Apollo reports it `verified` **and** Emailable independently confirms it `deliverable` — never a pattern guess. Emailable only ever narrows: it can demote a lead Apollo verified, never promote one Apollo did not. Facts the AI cannot establish are escalated to a human, never invented.

- [ ] **Step 2: Update the §3 diagram**

Replace the discover branch annotation:

```
                     /api/pipeline/discover ─▶ Apollo People-Search + Enrich
                                    │            (finds ICP-matching people, reveals + verifies
                                    │             email in the same call — no LLM)
                                    ▼
                     Emailable /v1/verify (deliverability guard, no LLM)
                                    │            (only state=deliverable activates; risky,
                                    │             unknown, undeliverable are parked)
                                    ▼
                     Grouping (system: company-key → Case; 1+ verified person = a case)
```

- [ ] **Step 3: Update §4 Component Inventory**

Add a row after the Apollo row and renumber the rows below it:

| # | Component | Type | Responsibility |
|---|-----------|------|----------------|
| 2 | Emailable Deliverability Guard | System (code, no LLM) | Second-opinion verification of every Apollo-`verified` address; only `deliverable` activates a lead |

Then replace the "Changed from v1" note beneath the table with:

> **Changed from v1:** the old "Lead-Gen Agent" (Brightdata + Gemini) is replaced by the Apollo People-Search + Enrich system. Emailable, dropped in v2, returned in v3 (2026-07-21) in a narrower role: it is no longer an email *acquisition* system, only a deliverability guard layered on top of Apollo's `verified` status. Brightdata + Gemini remain in the stack for the P2 **Research Agent only** (§6 Stage 3).

- [ ] **Step 4: Update §5 data model**

In the `leads` block, add the column beneath `email_verified_at`:

```
email · email_status(unverified|verified|invalid|risky|not_found)
email_verified_at · email_verification(jsonb)   -- Emailable verdict, or the
                                                -- recorded failure when the guard
                                                -- was unavailable (fail-open)
status(new|parked|active) · created_at
```

- [ ] **Step 5: Update §12 and §13**

In §12, replace the trailing sentence of the Apollo dependency risk — the one offering "(a) a secondary verifier (e.g. Emailable)… neither is built for P1 by design" — with:

> Option (a), a secondary verifier layered on top of Apollo's `verified` status, **shipped on 2026-07-21** as the Emailable deliverability guard (`src/lib/emailable/`). It was adopted for bounce protection rather than for yield: it narrows the activated set and never widens it, so if verified-yield is ever the problem, option (b) — a dedicated `EmailFinder` provider — remains the answer.

Add a new §12 risk entry:

> - **Fail-open verification gap.** Any Emailable failure — including a persistent `402` (out of credits) or `403` (rotated key) — activates the lead on Apollo's word alone, by explicit operator decision on 2026-07-21. Discovery never stalls, but bounce protection is off for the duration. The only signals are `emailable.verify.failed` error events and the `emailableFailedOpen` counter on `pipeline.discover.completed`; `leads.email_verification` is the durable per-lead record, since events are purged at 30/90 days. Revisit with real bounce data.

In §13, remove the "A secondary/dual email verifier (e.g. Emailable) alongside Apollo" out-of-scope bullet and replace it with what genuinely remains out of scope:

> - **Re-verification of stale or fail-open leads.** The guard runs once, at discovery. There is no staleness re-check before follow-up sends and no automatic re-verification of leads activated while Emailable was unavailable.
> - **Score thresholds and shape-based blocking** (`role`, `disposable`, `no_reply`, `mailbox_full`). These fields are stored on `leads.email_verification` but the policy branches on `state` alone.

- [ ] **Step 6: Update the roadmap**

In `.claude/roadmap.md`, two existing lines need no edit and must be left alone: line 20's secrets bullet already lists Emailable, and line 34's `- [x] Env: drop EMAILABLE_API_KEY, add APOLLO_API_KEY` is accurate P1 history — rewriting completed history would make the roadmap lie about what happened when.

Only line 157's backlog bullet changes:

> - ~~Dedicated `EmailFinder` provider, or a secondary verifier (e.g. Emailable) layered on top of Apollo, if verified-address yield or accuracy is low.~~ The Emailable half **shipped 2026-07-21** as a deliverability guard — see the entry below. A dedicated `EmailFinder` provider remains backlog.

Add a new completed section following the file's existing format:

```markdown
### Emailable deliverability guard — shipped 2026-07-21

Second-opinion verification layered on Apollo's `email_status`. Only Emailable
`state: 'deliverable'` activates a lead; `risky`, `unknown`, `undeliverable`
and any unrecognized state are parked. Runs at discovery, so a rejected lead
never consumes Research Agent or Email-Writer cost. Blanket fail-open on any
Emailable failure, by explicit operator decision — see `architecture.md §12`.

Spec: `docs/superpowers/specs/2026-07-21-emailable-verification-design.md`
Plan: `docs/superpowers/plans/2026-07-21-emailable-verification.md`

- [x] `0011_lead_email_verification.sql` — `leads.email_verification` + `emailable` log source.
- [x] `fetchJson` accepts a redacted `logUrl` so the query-string API key never reaches the events table.
- [x] `src/lib/emailable/` — client, Zod response schema, and the pure decision table.
- [x] `enrichCandidates` gates activation; `DiscoverySummary` reports `emailableChecked` / `Deliverable` / `Rejected` / `FailedOpen`.
- [ ] Review `emailableRejected` after the first week of live runs and decide whether the strict policy needs loosening for accept-all domains.
```

- [ ] **Step 7: Verify nothing still claims Emailable was removed**

Run: `grep -n "no LLM, no Emailable\|Emailable has been removed\|neither is built for P1" .claude/architecture.md`
Expected: no output.

- [ ] **Step 8: Commit**

```bash
git add .claude/architecture.md .claude/roadmap.md
git commit -m "docs: record the Emailable deliverability guard in architecture and roadmap"
```

---

## Verification

After Task 6, confirm the whole feature from a clean state:

- [ ] `pnpm supabase db reset` — migrations `0001`–`0011` apply cleanly
- [ ] `pnpm test` — full unit suite green
- [ ] `pnpm typecheck` — no errors
- [ ] `pnpm lint` — no errors
- [ ] `grep -rn "apolloContext" src/` — no output (rename complete)
- [ ] `grep -rn "EMAILABLE_API_KEY" src/lib/emailable/` — appears only in `client.ts`, never in a log or error payload
