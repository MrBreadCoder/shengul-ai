# Client-Scoped Logging Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every error and every notable pipeline event is attributed to a client and readable on that client's page, so an operator can tell at a glance whether a client's agent is healthy or broken.

**Architecture:** The `events` table already carries `client_id`, `case_id`, `actor`, `type` and `payload`, and ~35 call sites already write to it via `logEvent`/`logEventSafe`. This plan adds two dimensions — `severity` (`info` | `warn` | `error`) and `source` (which subsystem/vendor emitted it) — plus a `logError`/`logWarn` helper and a `withExternalLogging` wrapper that attributes vendor failures (Gemini, Apollo, BrightData, mailbox) to a client before rethrowing. Reads land on a new "Logs" tab on `/clients/[id]` and a 24h error dot on `/clients`. A nightly QStash cron purges old rows.

**Tech Stack:** Next.js 16 (App Router, Server Components), TypeScript strict, Supabase (Postgres + RLS + `supabase-js`), Zod, Vitest, QStash, Tailwind v4, Phosphor icons.

## Global Constraints

- All source lives under `src/`. Files are `kebab-case.ts` / `kebab-case.tsx`.
- DB columns are `snake_case`; TypeScript is `camelCase`. Map explicitly.
- No `any`. No `console.log`. No `TODO`/`FIXME`. No commented-out code. Named exports only (default export only for Next.js pages/layouts).
- Every function has an explicit return type.
- All Supabase access lives in `src/lib/db/` — never inline a query in a component, action, or route.
- All DB errors are mapped to `AppError('DB_ERROR', ...)` at the DB layer.
- Tests are colocated as `<name>.test.ts`, use Arrange-Act-Assert, and are named `it('should [behavior] when [condition]')`.
- Run `pnpm test` (Vitest), `pnpm typecheck` (tsc --noEmit) and `pnpm lint` (eslint) before every commit.
- `src/types/database.ts` is hand-maintained in this repo — every migration must be mirrored into it in the same task.
- Audit/log writes are **best-effort**: a logging failure must never turn a succeeded operation into a failure, and must never mask an error being rethrown.
- Never log secrets, OAuth tokens, API keys, or raw email bodies.
- Update `.claude/roadmap.md` when the plan completes (Task 10).

---

### Task 1: Migration — severity + source columns, backfill, indexes, error-count RPC

**Files:**
- Create: `supabase/migrations/0010_event_logging.sql`
- Create: `src/types/logs.ts`
- Modify: `src/types/database.ts` (events `Row`/`Insert` at lines 486-504, `Functions` block at line 524, `Enums` block at line 617)

**Interfaces:**
- Consumes: nothing (first task).
- Produces:
  - SQL enums `log_severity` (`'info' | 'warn' | 'error'`) and `log_source` (`'app' | 'pipeline' | 'gemini' | 'apollo' | 'brightdata' | 'mailbox' | 'qstash' | 'db'`).
  - `events.severity` and `events.source` columns, both `not null` with defaults `'info'` / `'app'`.
  - SQL function `public.events_error_counts(p_since timestamptz) returns table (client_id uuid, error_count bigint, warn_count bigint)`.
  - TypeScript: `LogSeverity`, `LogSource`, `LOG_SEVERITIES`, `LOG_SOURCES`, `LogSeverityFilter`, `SEVERITIES_FOR_FILTER`, `ClientErrorCount` — all from `@/types/logs`.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0010_event_logging.sql`:

```sql
-- Client-scoped logging.
--
-- `events` already carries client_id / case_id / actor / type / payload and is
-- written by ~35 call sites. This adds the two dimensions an operator needs to
-- answer "is this client's agent healthy?" without reading every payload:
--   severity - info | warn | error
--   source   - which subsystem or vendor emitted the row
--
-- Both columns are NOT NULL WITH DEFAULT, so every existing insert keeps
-- working unchanged while the call sites are migrated task by task.

create type log_severity as enum ('info', 'warn', 'error');

create type log_source as enum (
  'app',        -- operator/user actions in the web app
  'pipeline',   -- our own orchestration steps
  'gemini',     -- Google Gemini via the AI SDK
  'apollo',     -- Apollo.io lead search + enrichment
  'brightdata', -- BrightData SERP + Web Unlocker
  'mailbox',    -- Gmail / Outlook send + read
  'qstash',     -- Upstash QStash scheduling and delivery
  'db'          -- Supabase / Postgres
);

alter table events
  add column severity log_severity not null default 'info',
  add column source   log_source   not null default 'app';

-- Backfill historic rows so the Logs tab has real content the moment it ships.
-- Ordered narrowest-last: the source rules do not overlap, but the severity
-- rule runs first so a failed row keeps its correct source below.
update events set severity = 'error'
 where type like '%.failed' or type like '%_failed' or type like '%.agent_failed';

update events set source = 'gemini'     where type like 'llm.%';
update events set source = 'apollo'     where type like 'apollo.%';
update events set source = 'brightdata' where type like 'brightdata.%';
update events set source = 'mailbox'    where type like 'mailbox.%';
update events set source = 'pipeline'
 where type like 'pipeline.%' or type like 'reply.%' or type like 'inbound.%' or type like 'cron.%';

-- Hot paths. The Logs tab filters by (client, severity) newest-first; the
-- clients list groups by client over a 24h window; the retention purge scans
-- by (severity, age) across every client.
create index idx_events_client_severity_created on events (client_id, severity, created_at desc);
create index idx_events_client_created          on events (client_id, created_at desc);
create index idx_events_severity_created        on events (severity, created_at);

-- One grouped query for the clients-list health dots. Without it the list would
-- issue one count per client (N+1) on a page that renders every client at once.
--
-- SECURITY INVOKER (the default): a client-role caller is already restricted to
-- its own client_id by the events RLS policy from 0002_rls_policies.sql, exactly
-- as in 0008_analytics.sql. Every reference to the events table is qualified
-- with the `e` alias so it can never collide with an OUT column name.
create function public.events_error_counts(p_since timestamptz)
returns table (
  client_id   uuid,
  error_count bigint,
  warn_count  bigint
)
language sql
stable
as $$
  select e.client_id,
         count(*) filter (where e.severity = 'error') as error_count,
         count(*) filter (where e.severity = 'warn')  as warn_count
    from public.events e
   where e.client_id is not null
     and e.created_at >= p_since
     and e.severity in ('error', 'warn')
   group by e.client_id;
$$;

grant execute on function public.events_error_counts(timestamptz) to authenticated;
```

- [ ] **Step 2: Apply the migration locally and verify it succeeds**

Run: `supabase migration up --local`
Expected: output ends with `Applying migration 0010_event_logging.sql...` and no error.

If you do not have a local Supabase running, start it first with `supabase start`. Against a hosted project use `supabase db push` instead.

Verify the columns and function exist:

Run: `supabase db diff --local --schema public`
Expected: empty output (no drift between migrations and the local database).

- [ ] **Step 3: Create the shared log types**

Create `src/types/logs.ts`:

```ts
import type { Database } from './database'

export type LogSeverity = Database['public']['Enums']['log_severity']
export type LogSource = Database['public']['Enums']['log_source']

/** Display order, most severe last — used to render filter chips. */
export const LOG_SEVERITIES: readonly LogSeverity[] = ['info', 'warn', 'error'] as const

export const LOG_SOURCES: readonly LogSource[] = [
  'app',
  'pipeline',
  'gemini',
  'apollo',
  'brightdata',
  'mailbox',
  'qstash',
  'db',
] as const

/**
 * What the Logs tab shows. `problems` is the default view: an operator opening
 * a client wants to know what is broken, not to scroll past every LLM call.
 */
export type LogSeverityFilter = 'problems' | 'errors' | 'all'

export const LOG_SEVERITY_FILTERS: readonly LogSeverityFilter[] = ['problems', 'errors', 'all'] as const

export const SEVERITIES_FOR_FILTER: Record<LogSeverityFilter, LogSeverity[]> = {
  problems: ['warn', 'error'],
  errors: ['error'],
  all: ['info', 'warn', 'error'],
}

/** One row of `events_error_counts`, mapped to camelCase. */
export interface ClientErrorCount {
  clientId: string
  errorCount: number
  warnCount: number
}
```

- [ ] **Step 4: Mirror the migration into the generated database types**

In `src/types/database.ts`, replace the `events` `Row` and `Insert` blocks (lines 486-504) with:

```ts
        Row: {
          id: string
          client_id: string | null
          case_id: string | null
          actor: string
          type: string
          severity: Database['public']['Enums']['log_severity']
          source: Database['public']['Enums']['log_source']
          payload: Json
          created_at: string
        }
        Insert: {
          id?: string
          client_id?: string | null
          case_id?: string | null
          actor: string
          type: string
          severity?: Database['public']['Enums']['log_severity']
          source?: Database['public']['Enums']['log_source']
          payload?: Json
          created_at?: string
        }
```

In the same file, add to the `Functions` block (after the `is_operator` entry at line 525):

```ts
      events_error_counts: {
        Args: { p_since: string }
        Returns: {
          client_id: string
          error_count: number
          warn_count: number
        }[]
      }
```

And add to the `Enums` block (after `user_role` at line 618):

```ts
      log_severity: 'info' | 'warn' | 'error'
      log_source: 'app' | 'pipeline' | 'gemini' | 'apollo' | 'brightdata' | 'mailbox' | 'qstash' | 'db'
```

- [ ] **Step 5: Verify types compile and nothing regressed**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck prints nothing and exits 0; Vitest reports all existing tests passing.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0010_event_logging.sql src/types/logs.ts src/types/database.ts
git commit -m "feat(logging): add event severity and source columns with error-count RPC"
```

---

### Task 2: Error description + severity-aware log helpers

**Files:**
- Create: `src/lib/events/error-context.ts`
- Create: `src/lib/events/error-context.test.ts`
- Modify: `src/lib/events/log-event.ts`
- Modify: `src/lib/events/log-event.test.ts`

**Interfaces:**
- Consumes: `LogSeverity`, `LogSource` from `@/types/logs` (Task 1); `AppError`, `isAppError` from `@/lib/errors/app-error`; `truncate` from `@/lib/format`.
- Produces:
  - `describeError(error: unknown): { code: string; message: string }`
  - `LogEventInput` gains optional `severity?: LogSeverity` and `source?: LogSource`.
  - `logError(input: LogFailureInput): Promise<void>` and `logWarn(input: LogFailureInput): Promise<void>`, where
    `LogFailureInput = { clientId: string | null; caseId?: string | null; actor: string; type: string; source: LogSource; error: unknown; payload?: Record<string, Json> }`.
    Both are best-effort (never throw) and stamp `errorCode` + `errorMessage` into the payload.

- [ ] **Step 1: Write the failing test for `describeError`**

Create `src/lib/events/error-context.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeError } from './error-context'
import { AppError } from '@/lib/errors/app-error'

describe('describeError', () => {
  it('should use the AppError code and message when given an AppError', () => {
    const error = new AppError('RATE_LIMITED', 'Apollo rejected the request', { url: 'x' })

    const result = describeError(error)

    expect(result).toEqual({ code: 'RATE_LIMITED', message: 'Apollo rejected the request' })
  })

  it('should fall back to UNEXPECTED_ERROR when given a plain Error', () => {
    const result = describeError(new Error('socket hang up'))

    expect(result).toEqual({ code: 'UNEXPECTED_ERROR', message: 'socket hang up' })
  })

  it('should stringify the value when given a non-Error throw', () => {
    const result = describeError('boom')

    expect(result).toEqual({ code: 'UNEXPECTED_ERROR', message: 'boom' })
  })

  it('should truncate a message longer than the cap so one log row cannot bloat the table', () => {
    const result = describeError(new Error('x'.repeat(500)))

    expect(result.message).toHaveLength(300)
    expect(result.message.endsWith('…')).toBe(true)
  })

  it('should describe null without throwing', () => {
    const result = describeError(null)

    expect(result).toEqual({ code: 'UNEXPECTED_ERROR', message: 'null' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/events/error-context.test.ts`
Expected: FAIL — `Failed to resolve import "./error-context"`.

- [ ] **Step 3: Implement `describeError`**

Create `src/lib/events/error-context.ts`:

```ts
import { isAppError } from '@/lib/errors/app-error'
import { truncate } from '@/lib/format'

// One log row must never carry a multi-kilobyte provider stack trace; the
// operator needs the first line, and the full error still reaches the caller.
const MAX_MESSAGE_CHARS = 300

/** Code used when the thrown value is not one of our own typed errors. */
const UNEXPECTED_CODE = 'UNEXPECTED_ERROR'

export interface ErrorDescription {
  code: string
  message: string
}

/**
 * Normalises anything a `catch` block can receive into the two fields every
 * error log carries. Total and pure by design: it runs inside catch blocks
 * whose job is to report a failure, so it must never create a second one.
 */
export function describeError(error: unknown): ErrorDescription {
  if (isAppError(error)) {
    return { code: error.code, message: truncate(error.message, MAX_MESSAGE_CHARS) }
  }
  if (error instanceof Error) {
    return { code: UNEXPECTED_CODE, message: truncate(error.message, MAX_MESSAGE_CHARS) }
  }
  return { code: UNEXPECTED_CODE, message: truncate(String(error), MAX_MESSAGE_CHARS) }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/events/error-context.test.ts`
Expected: PASS — 5 tests.

- [ ] **Step 5: Write the failing tests for the new log helpers**

Replace the whole contents of `src/lib/events/log-event.test.ts` with:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: insertMock }) }),
}))

import { logEvent, logEventSafe, logError, logWarn } from './log-event'
import { AppError } from '@/lib/errors/app-error'

describe('logEvent', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert an event row with info/app defaults when severity and source are omitted', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logEvent({ clientId: 'c1', actor: 'system', type: 'mailbox.connected' })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: null,
      actor: 'system',
      type: 'mailbox.connected',
      severity: 'info',
      source: 'app',
      payload: {},
    })
  })

  it('should pass caseId, severity, source and payload through when provided', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logEvent({
      clientId: 'c1',
      caseId: 'case9',
      actor: 'agent:lead-gen',
      type: 'lead.found',
      severity: 'warn',
      source: 'apollo',
      payload: { n: 3 },
    })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: 'case9',
      actor: 'agent:lead-gen',
      type: 'lead.found',
      severity: 'warn',
      source: 'apollo',
      payload: { n: 3 },
    })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'nope' } })

    await expect(
      logEvent({ clientId: 'c1', actor: 'system', type: 'x' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('logEventSafe', () => {
  beforeEach(() => insertMock.mockReset())

  it('should resolve without throwing when the insert fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'nope' } })

    await expect(logEventSafe({ clientId: 'c1', actor: 'system', type: 'x' })).resolves.toBeUndefined()
  })
})

describe('logError', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert an error row carrying the error code and message in the payload', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logError({
      clientId: 'c1',
      caseId: 'case9',
      actor: 'system',
      type: 'apollo.search.failed',
      source: 'apollo',
      error: new AppError('EXTERNAL_TIMEOUT', 'HTTP request failed', { url: 'x' }),
      payload: { campaignId: 'camp1' },
    })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: 'case9',
      actor: 'system',
      type: 'apollo.search.failed',
      severity: 'error',
      source: 'apollo',
      payload: {
        campaignId: 'camp1',
        errorCode: 'EXTERNAL_TIMEOUT',
        errorMessage: 'HTTP request failed',
      },
    })
  })

  it('should not throw when the audit insert itself fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'audit table gone' } })

    await expect(
      logError({
        clientId: 'c1',
        actor: 'system',
        type: 'apollo.search.failed',
        source: 'apollo',
        error: new Error('boom'),
      }),
    ).resolves.toBeUndefined()
  })
})

describe('logWarn', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert a warn row rather than an error row', async () => {
    insertMock.mockResolvedValue({ error: null })

    await logWarn({
      clientId: 'c1',
      actor: 'system',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      error: new AppError('RATE_LIMITED', 'No healthy mailbox available', {}),
    })

    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1',
      case_id: null,
      actor: 'system',
      type: 'mailbox.none_healthy',
      severity: 'warn',
      source: 'mailbox',
      payload: { errorCode: 'RATE_LIMITED', errorMessage: 'No healthy mailbox available' },
    })
  })
})
```

- [ ] **Step 6: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/events/log-event.test.ts`
Expected: FAIL — `"logError" is not exported by "src/lib/events/log-event.ts"`.

- [ ] **Step 7: Implement the log helpers**

Replace the whole contents of `src/lib/events/log-event.ts` with:

```ts
import { createAdminClient } from '@/lib/supabase/admin'
import { insertEvent } from '@/lib/db/events'
import { describeError } from './error-context'
import type { Json } from '@/types/database'
import type { LogSeverity, LogSource } from '@/types/logs'

export interface LogEventInput {
  clientId: string | null
  caseId?: string | null
  actor: string
  type: string
  /** Defaults to 'info' — the vast majority of rows are milestones, not problems. */
  severity?: LogSeverity
  /** Defaults to 'app' — an operator/user action rather than a vendor call. */
  source?: LogSource
  payload?: Record<string, Json>
}

// The single audit entry point. Uses the service-role client so audit writes
// are never blocked by RLS. Call after the core action succeeds.
export async function logEvent(input: LogEventInput): Promise<void> {
  const supabase = createAdminClient()
  await insertEvent(supabase, {
    client_id: input.clientId,
    case_id: input.caseId ?? null,
    actor: input.actor,
    type: input.type,
    severity: input.severity ?? 'info',
    source: input.source ?? 'app',
    payload: input.payload ?? {},
  })
}

// Best-effort variant: swallows failures so an audit-log error never fails an
// action that already succeeded (which, on a QStash retry, would needlessly
// re-run it). Use for logging that follows a completed send/DB mutation.
export async function logEventSafe(input: LogEventInput): Promise<void> {
  try {
    await logEvent(input)
  } catch {
    // Audit logging is best-effort; the core action already succeeded.
  }
}

export interface LogFailureInput {
  clientId: string | null
  caseId?: string | null
  actor: string
  type: string
  source: LogSource
  /** Whatever the catch block received. Never assumed to be an Error. */
  error: unknown
  /** Extra structured context merged into the payload. Never secrets. */
  payload?: Record<string, Json>
}

async function logFailure(input: LogFailureInput, severity: 'warn' | 'error'): Promise<void> {
  const { code, message } = describeError(input.error)
  // Always the *safe* variant: every caller is inside a catch block that is
  // about to rethrow, so a logging failure must not replace the real error.
  await logEventSafe({
    clientId: input.clientId,
    caseId: input.caseId ?? null,
    actor: input.actor,
    type: input.type,
    severity,
    source: input.source,
    payload: { ...(input.payload ?? {}), errorCode: code, errorMessage: message },
  })
}

/** Records a failure against a client. Best-effort — never throws. */
export async function logError(input: LogFailureInput): Promise<void> {
  await logFailure(input, 'error')
}

/**
 * Records a degraded-but-handled condition against a client (a send skipped
 * because no mailbox was healthy, a partial agent failure). Best-effort.
 */
export async function logWarn(input: LogFailureInput): Promise<void> {
  await logFailure(input, 'warn')
}
```

- [ ] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/events/log-event.test.ts src/lib/events/error-context.test.ts`
Expected: PASS — 11 tests across 2 files.

- [ ] **Step 9: Verify the whole suite and types still pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all three exit 0.

- [ ] **Step 10: Commit**

```bash
git add src/lib/events/error-context.ts src/lib/events/error-context.test.ts src/lib/events/log-event.ts src/lib/events/log-event.test.ts
git commit -m "feat(logging): add describeError and severity-aware logError/logWarn helpers"
```

---

### Task 3: `withExternalLogging` wrapper for vendor calls

**Files:**
- Create: `src/lib/events/with-external-logging.ts`
- Create: `src/lib/events/with-external-logging.test.ts`

**Interfaces:**
- Consumes: `logError` from `./log-event` (Task 2); `LogSource` from `@/types/logs`; `Json` from `@/types/database`.
- Produces:
  - `ExternalCallContext = { clientId: string | null; caseId?: string | null; actor: string; failureType: string; payload?: Record<string, Json> }`
  - `withExternalLogging<T>(source: LogSource, context: ExternalCallContext, work: () => Promise<T>): Promise<T>` — returns `work()`'s value on success, logs an error row and **rethrows the original error unchanged** on failure.

- [ ] **Step 1: Write the failing test**

Create `src/lib/events/with-external-logging.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const logErrorMock = vi.fn()
vi.mock('./log-event', () => ({ logError: logErrorMock }))

import { withExternalLogging } from './with-external-logging'
import { AppError } from '@/lib/errors/app-error'

const context = {
  clientId: 'c1',
  caseId: 'case9',
  actor: 'system',
  failureType: 'apollo.search.failed',
  payload: { campaignId: 'camp1' },
}

describe('withExternalLogging', () => {
  beforeEach(() => logErrorMock.mockReset().mockResolvedValue(undefined))

  it('should return the work result and log nothing when the call succeeds', async () => {
    const result = await withExternalLogging('apollo', context, async () => ({ people: 3 }))

    expect(result).toEqual({ people: 3 })
    expect(logErrorMock).not.toHaveBeenCalled()
  })

  it('should log an error attributed to the client when the call fails', async () => {
    const failure = new AppError('EXTERNAL_TIMEOUT', 'HTTP request failed', {})

    await expect(
      withExternalLogging('apollo', context, () => Promise.reject(failure)),
    ).rejects.toBe(failure)

    expect(logErrorMock).toHaveBeenCalledWith({
      clientId: 'c1',
      caseId: 'case9',
      actor: 'system',
      type: 'apollo.search.failed',
      source: 'apollo',
      error: failure,
      payload: { campaignId: 'camp1' },
    })
  })

  it('should rethrow the original error unchanged so callers still branch on its code', async () => {
    const failure = new AppError('RATE_LIMITED', 'slow down', {})

    const caught = await withExternalLogging('apollo', context, () => Promise.reject(failure)).catch(
      (error: unknown) => error,
    )

    expect(caught).toBe(failure)
  })

  it('should default caseId to null when the context omits it', async () => {
    await expect(
      withExternalLogging(
        'gemini',
        { clientId: 'c1', actor: 'system', failureType: 'llm.failed' },
        () => Promise.reject(new Error('boom')),
      ),
    ).rejects.toBeInstanceOf(Error)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({ caseId: null, payload: undefined })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/events/with-external-logging.test.ts`
Expected: FAIL — `Failed to resolve import "./with-external-logging"`.

- [ ] **Step 3: Implement the wrapper**

Create `src/lib/events/with-external-logging.ts`:

```ts
import { logError } from './log-event'
import type { Json } from '@/types/database'
import type { LogSource } from '@/types/logs'

export interface ExternalCallContext {
  clientId: string | null
  caseId?: string | null
  actor: string
  /** Dotted event type recorded on failure, e.g. `apollo.search.failed`. */
  failureType: string
  /** Extra structured fields merged into the failure payload. Never secrets. */
  payload?: Record<string, Json>
}

/**
 * Runs one external-vendor call, attributing any failure to a client before
 * rethrowing it untouched. This adds only the audit row that makes a vendor
 * outage visible on the client's Logs tab — error handling, retries and
 * status-code branching all stay with the caller.
 */
export async function withExternalLogging<T>(
  source: LogSource,
  context: ExternalCallContext,
  work: () => Promise<T>,
): Promise<T> {
  try {
    return await work()
  } catch (error) {
    // logError is best-effort and never throws, so the rethrow below is always
    // reached with the original error.
    await logError({
      clientId: context.clientId,
      caseId: context.caseId ?? null,
      actor: context.actor,
      type: context.failureType,
      source,
      error,
      payload: context.payload,
    })
    throw error
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/events/with-external-logging.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/events/with-external-logging.ts src/lib/events/with-external-logging.test.ts
git commit -m "feat(logging): add withExternalLogging wrapper for vendor calls"
```

---

### Task 4: DB reads — client log feed, error counts, retention purge

**Files:**
- Modify: `src/lib/db/events.ts`
- Create: `src/lib/db/events.test.ts`

**Interfaces:**
- Consumes: `LogSeverity`, `LogSource`, `ClientErrorCount` from `@/types/logs` (Task 1); `AppError`.
- Produces:
  - `listEventsForClient(supabase, input: ListEventsForClientInput): Promise<EventRow[]>` where
    `ListEventsForClientInput = { clientId: string; severities: LogSeverity[]; source: LogSource | null; limit: number; before: string | null }`
  - `countRecentErrorsByClient(supabase, since: string): Promise<Map<string, ClientErrorCount>>`
  - `deleteExpiredEvents(supabase, now: Date, retention: EventRetention): Promise<PurgeSummary>` where
    `EventRetention = { infoDays: number; problemDays: number }` and `PurgeSummary = { infoDeleted: number; problemDeleted: number }`

- [ ] **Step 1: Write the failing tests**

Create `src/lib/db/events.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  insertEvent,
  listEventsForCase,
  listEventsForClient,
  countRecentErrorsByClient,
  deleteExpiredEvents,
} from './events'
import { AppError } from '@/lib/errors/app-error'

/**
 * PostgREST builders are chainable and thenable. This stub records every call
 * so a test can assert the query shape, and resolves to `result` when awaited.
 */
function queryStub(result: { data: unknown; error: unknown }) {
  const calls: Record<string, unknown[]> = {}
  const builder: Record<string, unknown> = {}
  for (const method of ['select', 'insert', 'delete', 'eq', 'in', 'lt', 'order', 'limit']) {
    builder[method] = (...args: unknown[]) => {
      calls[method] = args
      return builder
    }
  }
  builder.then = (resolve: (value: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return { supabase: { from: () => builder } as never, calls }
}

describe('insertEvent', () => {
  it('should resolve when the insert succeeds', async () => {
    const supabase = { from: () => ({ insert: () => Promise.resolve({ error: null }) }) } as never

    await expect(
      insertEvent(supabase, { actor: 'system', type: 'x', severity: 'info', source: 'app' }),
    ).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as never

    await expect(
      insertEvent(supabase, { actor: 'system', type: 'x' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('listEventsForCase', () => {
  it('should return the rows for the case', async () => {
    const rows = [{ id: 'e1' }]
    const { supabase } = queryStub({ data: rows, error: null })

    const result = await listEventsForCase(supabase, 'case1', 50)

    expect(result).toEqual(rows)
  })
})

describe('listEventsForClient', () => {
  it('should filter by client and the requested severities, newest first', async () => {
    const rows = [{ id: 'e1' }]
    const { supabase, calls } = queryStub({ data: rows, error: null })

    const result = await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['warn', 'error'],
      source: null,
      limit: 50,
      before: null,
    })

    expect(result).toEqual(rows)
    expect(calls.eq).toEqual(['client_id', 'c1'])
    expect(calls.in).toEqual(['severity', ['warn', 'error']])
    expect(calls.order).toEqual(['created_at', { ascending: false }])
    expect(calls.limit).toEqual([50])
    expect(calls.lt).toBeUndefined()
  })

  it('should add a created_at cursor when `before` is given', async () => {
    const { supabase, calls } = queryStub({ data: [], error: null })

    await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['error'],
      source: null,
      limit: 50,
      before: '2026-07-20T10:00:00.000Z',
    })

    expect(calls.lt).toEqual(['created_at', '2026-07-20T10:00:00.000Z'])
  })

  it('should filter by source when one is given', async () => {
    const { supabase, calls } = queryStub({ data: [], error: null })

    await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['error'],
      source: 'apollo',
      limit: 50,
      before: null,
    })

    expect(calls.eq).toEqual(['source', 'apollo'])
  })

  it('should return an empty array when PostgREST returns no data', async () => {
    const { supabase } = queryStub({ data: null, error: null })

    const result = await listEventsForClient(supabase, {
      clientId: 'c1',
      severities: ['error'],
      source: null,
      limit: 50,
      before: null,
    })

    expect(result).toEqual([])
  })

  it('should throw DB_ERROR when the query fails', async () => {
    const { supabase } = queryStub({ data: null, error: { message: 'boom' } })

    await expect(
      listEventsForClient(supabase, {
        clientId: 'c1',
        severities: ['error'],
        source: null,
        limit: 50,
        before: null,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('countRecentErrorsByClient', () => {
  it('should map rpc rows into a camelCase map keyed by client id', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({
        data: [{ client_id: 'c1', error_count: 3, warn_count: 1 }],
        error: null,
      }),
    } as never

    const result = await countRecentErrorsByClient(supabase, '2026-07-20T00:00:00.000Z')

    expect(result.get('c1')).toEqual({ clientId: 'c1', errorCount: 3, warnCount: 1 })
  })

  it('should return an empty map when there are no rows', async () => {
    const supabase = { rpc: vi.fn().mockResolvedValue({ data: null, error: null }) } as never

    const result = await countRecentErrorsByClient(supabase, '2026-07-20T00:00:00.000Z')

    expect(result.size).toBe(0)
  })

  it('should throw DB_ERROR when the rpc fails', async () => {
    const supabase = {
      rpc: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }),
    } as never

    await expect(
      countRecentErrorsByClient(supabase, '2026-07-20T00:00:00.000Z'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteExpiredEvents', () => {
  it('should purge info rows and problem rows against their own cutoffs', async () => {
    const deleteCalls: { severity: unknown; cutoff: unknown }[] = []
    const supabase = {
      from: () => ({
        delete: () => {
          const captured: { severity: unknown; cutoff: unknown } = { severity: null, cutoff: null }
          const builder: Record<string, unknown> = {}
          builder.eq = (_column: string, value: unknown) => {
            captured.severity = value
            return builder
          }
          builder.in = (_column: string, value: unknown) => {
            captured.severity = value
            return builder
          }
          builder.lt = (_column: string, value: unknown) => {
            captured.cutoff = value
            deleteCalls.push(captured)
            return builder
          }
          builder.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: 2, error: null }).then(resolve)
          return builder
        },
      }),
    } as never

    const result = await deleteExpiredEvents(supabase, new Date('2026-07-21T00:00:00.000Z'), {
      infoDays: 30,
      problemDays: 90,
    })

    expect(result).toEqual({ infoDeleted: 2, problemDeleted: 2 })
    expect(deleteCalls[0]).toEqual({ severity: 'info', cutoff: '2026-06-21T00:00:00.000Z' })
    expect(deleteCalls[1]).toEqual({ severity: ['warn', 'error'], cutoff: '2026-04-22T00:00:00.000Z' })
  })

  it('should throw DB_ERROR when a purge query fails', async () => {
    const supabase = {
      from: () => ({
        delete: () => {
          const builder: Record<string, unknown> = {}
          builder.eq = () => builder
          builder.in = () => builder
          builder.lt = () => builder
          builder.then = (resolve: (v: unknown) => unknown) =>
            Promise.resolve({ count: null, error: { message: 'boom' } }).then(resolve)
          return builder
        },
      }),
    } as never

    await expect(
      deleteExpiredEvents(supabase, new Date('2026-07-21T00:00:00.000Z'), {
        infoDays: 30,
        problemDays: 90,
      }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/events.test.ts`
Expected: FAIL — `"listEventsForClient" is not exported by "src/lib/db/events.ts"`.

- [ ] **Step 3: Implement the read and purge queries**

Replace the whole contents of `src/lib/db/events.ts` with:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { ClientErrorCount, LogSeverity, LogSource } from '@/types/logs'
import { AppError } from '@/lib/errors/app-error'

export type EventInsert = Database['public']['Tables']['events']['Insert']
export type EventRow = Database['public']['Tables']['events']['Row']

const DAY_MS = 24 * 60 * 60 * 1000

export async function insertEvent(
  supabase: SupabaseClient<Database>,
  row: EventInsert,
): Promise<void> {
  const { error } = await supabase.from('events').insert(row)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert event', { type: row.type, cause: error.message })
  }
}

// Agent audit trail for one case, newest first. Bounded because a long-running
// case can accumulate hundreds of pipeline events.
export async function listEventsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
  limit: number,
): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list events for case', { caseId, cause: error.message })
  }
  return data ?? []
}

export interface ListEventsForClientInput {
  clientId: string
  /** Severities to include. Never empty — an empty list would return nothing. */
  severities: LogSeverity[]
  source: LogSource | null
  limit: number
  /** Keyset cursor: return only rows strictly older than this ISO timestamp. */
  before: string | null
}

/**
 * One page of a client's log feed, newest first. Paginated by `created_at`
 * cursor rather than offset: the pipeline inserts at the head of this list
 * continuously, and offset paging would silently skip or repeat rows.
 */
export async function listEventsForClient(
  supabase: SupabaseClient<Database>,
  { clientId, severities, source, limit, before }: ListEventsForClientInput,
): Promise<EventRow[]> {
  let query = supabase
    .from('events')
    .select('*')
    .eq('client_id', clientId)
    .in('severity', severities)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (source) query = query.eq('source', source)
  if (before) query = query.lt('created_at', before)

  const { data, error } = await query
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list events for client', { clientId, cause: error.message })
  }
  return data ?? []
}

/**
 * Warn/error tallies per client since `since`, as one grouped query. The
 * clients list renders every client at once, so a per-client count would be an
 * N+1 on that page.
 */
export async function countRecentErrorsByClient(
  supabase: SupabaseClient<Database>,
  since: string,
): Promise<Map<string, ClientErrorCount>> {
  const { data, error } = await supabase.rpc('events_error_counts', { p_since: since })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count client errors', { since, cause: error.message })
  }
  const counts = new Map<string, ClientErrorCount>()
  for (const row of data ?? []) {
    counts.set(row.client_id, {
      clientId: row.client_id,
      errorCount: row.error_count,
      warnCount: row.warn_count,
    })
  }
  return counts
}

export interface EventRetention {
  /** Days to keep `info` rows — high volume, low long-term value. */
  infoDays: number
  /** Days to keep `warn` and `error` rows — the ones worth investigating later. */
  problemDays: number
}

export interface PurgeSummary {
  infoDeleted: number
  problemDeleted: number
}

function cutoffFor(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

/**
 * Deletes log rows past their retention window. `now` is an explicit parameter
 * so the caller stays testable and the two cutoffs are computed from a single
 * instant rather than drifting between the two statements.
 */
export async function deleteExpiredEvents(
  supabase: SupabaseClient<Database>,
  now: Date,
  retention: EventRetention,
): Promise<PurgeSummary> {
  const { count: infoDeleted, error: infoError } = await supabase
    .from('events')
    .delete({ count: 'exact' })
    .eq('severity', 'info')
    .lt('created_at', cutoffFor(now, retention.infoDays))
  if (infoError) {
    throw new AppError('DB_ERROR', 'Failed to purge info events', { cause: infoError.message })
  }

  const { count: problemDeleted, error: problemError } = await supabase
    .from('events')
    .delete({ count: 'exact' })
    .in('severity', ['warn', 'error'])
    .lt('created_at', cutoffFor(now, retention.problemDays))
  if (problemError) {
    throw new AppError('DB_ERROR', 'Failed to purge warn/error events', { cause: problemError.message })
  }

  return { infoDeleted: infoDeleted ?? 0, problemDeleted: problemDeleted ?? 0 }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/events.test.ts`
Expected: PASS — 12 tests.

- [ ] **Step 5: Verify the whole suite and types still pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/events.ts src/lib/db/events.test.ts
git commit -m "feat(logging): add client log feed, error-count and retention queries"
```

---

### Task 5: Attribute Gemini failures to the client

**Files:**
- Modify: `src/lib/llm/client.ts`
- Modify: `src/lib/llm/client.test.ts`

**Interfaces:**
- Consumes: `logError` from `@/lib/events/log-event` (Task 2); the existing `LlmCallContext = { clientId: string; caseId?: string | null; actor: string }`.
- Produces: `llm.completed` rows now carry `source: 'gemini'`; new `llm.failed` rows with `severity: 'error'`, `source: 'gemini'`, and payload `{ model, operation, durationMs, errorCode, errorMessage }`. No exported signatures change.

- [ ] **Step 1: Extend the log-event mock, then write the failing test**

`src/lib/llm/client.test.ts` currently mocks `@/lib/events/log-event` with only `logEvent` (line 16-17). After this task `client.ts` imports `logEventSafe` and `logError` instead, so the mock must export them or every test in the file throws "logEventSafe is not a function".

Replace lines 16-17 of `src/lib/llm/client.test.ts`:

```ts
const logEventMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))
```

with:

```ts
const logEventMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
  logEventSafe: (...a: unknown[]) => logEventMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
}))
```

Existing assertions like `expect(logEventMock).toHaveBeenCalledTimes(1)` keep passing: `logUsage` now calls `logEventSafe`, which routes to the same spy.

Add `logErrorMock.mockReset()` to the `beforeEach` block (line 23-27), so it reads:

```ts
beforeEach(() => {
  generateObjectMock.mockReset()
  generateTextMock.mockReset()
  logEventMock.mockReset()
  logErrorMock.mockReset()
})
```

Then append this block to the end of the file (`ctx` is already declared at line 21 as `{ clientId: 'client1', caseId: 'case1', actor: 'research_agent' }`):

```ts
describe('gemini failure logging', () => {
  it('should log an llm.failed event attributed to the client when generateText throws', async () => {
    generateTextMock.mockRejectedValue(new Error('503 Service Unavailable'))

    await expect(
      generateText(ctx, { system: 's', prompt: 'p', maxOutputTokens: 100 }),
    ).rejects.toBeInstanceOf(AppError)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      caseId: 'case1',
      actor: 'research_agent',
      type: 'llm.failed',
      source: 'gemini',
      payload: { model: 'gemini-3-flash-preview', operation: 'generateText' },
    })
  })

  it('should log an llm.failed event when the tool loop throws', async () => {
    generateTextMock.mockRejectedValue(new Error('tool exploded'))

    await expect(
      generateWithTools(ctx, {
        system: 's',
        prompt: 'p',
        tools: {},
        maxSteps: 2,
        maxOutputTokens: 100,
      }),
    ).rejects.toBeInstanceOf(AppError)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'llm.failed',
      source: 'gemini',
      payload: { operation: 'generateWithTools' },
    })
  })

  it('should tag successful usage logs with the gemini source', async () => {
    generateTextMock.mockResolvedValue({ text: 'ok', usage: { inputTokens: 10, outputTokens: 5 } })

    await generateText(ctx, { system: 's', prompt: 'p', maxOutputTokens: 100 })

    expect(logEventMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'llm.completed',
      severity: 'info',
      source: 'gemini',
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/llm/client.test.ts`
Expected: FAIL — no `llm.failed` call is found (`failureCall` is `undefined`), and `usageCall` does not match `{ source: 'gemini' }`.

- [ ] **Step 3: Add the failure logger and tag usage logs**

In `src/lib/llm/client.ts`, change the import line

```ts
import { logEvent } from '@/lib/events/log-event'
```

to

```ts
import { logEventSafe, logError } from '@/lib/events/log-event'
```

Replace the `logUsage` function with:

```ts
async function logUsage(
  context: LlmCallContext,
  usage: unknown,
  durationMs: number,
): Promise<void> {
  const { promptTokens, completionTokens } = readUsage(usage)
  // Safe variant on purpose: the generation already succeeded and its result is
  // about to be returned, so an audit-write failure must not reject the call
  // (and, on a QStash retry, pay for the same generation twice).
  await logEventSafe({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.completed',
    severity: 'info',
    source: 'gemini',
    payload: { model: MODEL_ID, promptTokens, completionTokens, durationMs },
  })
}

/**
 * Attributes a Gemini failure to the client whose pipeline run triggered it, so
 * an operator sees "this client's AI is erroring" on the client's Logs tab.
 * Best-effort by construction (`logError` never throws) — the AppError raised
 * by the caller immediately below is what callers actually see.
 */
async function logLlmFailure(
  context: LlmCallContext,
  operation: string,
  cause: unknown,
  durationMs: number,
): Promise<void> {
  await logError({
    clientId: context.clientId,
    caseId: context.caseId ?? null,
    actor: context.actor,
    type: 'llm.failed',
    source: 'gemini',
    error: cause,
    payload: { model: MODEL_ID, operation, durationMs },
  })
}
```

Then update all three catch blocks. In `generateJson`:

```ts
  } catch (cause) {
    await logLlmFailure(context, 'generateObject', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateObject failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
```

In `generateText`:

```ts
  } catch (cause) {
    await logLlmFailure(context, 'generateText', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM generateText failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
```

In `generateWithTools`:

```ts
  } catch (cause) {
    await logLlmFailure(context, 'generateWithTools', cause, Date.now() - startedAt)
    if (cause instanceof AppError) throw cause
    throw new AppError('EXTERNAL_ERROR', 'LLM tool loop failed', {
      actor: context.actor,
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/llm/client.test.ts`
Expected: PASS — all existing tests plus the 2 new ones.

- [ ] **Step 5: Verify the whole suite and types still pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all three exit 0.

- [ ] **Step 6: Commit**

```bash
git add src/lib/llm/client.ts src/lib/llm/client.test.ts
git commit -m "feat(logging): attribute Gemini failures and token usage to the client"
```

---

### Task 6: Attribute Apollo, BrightData and mailbox failures to the client

**Files:**
- Modify: `src/lib/pipeline/discover.ts` (Apollo — `runFirstPass`, `runSecondPass`, `enrichCandidates`)
- Modify: `src/lib/pipeline/discover.test.ts`
- Modify: `src/lib/research/tools.ts` (BrightData)
- Modify: `src/lib/research/tools.test.ts`
- Modify: `src/lib/research/agent.ts:87` (pass the context through)
- Modify: `src/lib/mailbox/sender.ts`
- Modify: `src/lib/mailbox/sender.test.ts`

**Interfaces:**
- Consumes: `withExternalLogging`, `ExternalCallContext` from `@/lib/events/with-external-logging` (Task 3); `logWarn`, `logError` from `@/lib/events/log-event` (Task 2).
- Produces:
  - `runFirstPass(campaign: CampaignForDiscovery, quota, known, companyPickCounts, domainBackedCompanyKeys)` — first parameter changes from `icp: ApolloIcpFilters` to the full `campaign`.
  - `runSecondPass(campaign: CampaignForDiscovery, quota, known, firstPassPicks, targetDomains, companyPickCounts)` — same first-parameter change.
  - `buildResearchTools(deps: { research: WebResearch }, context: ResearchToolContext): ToolSet` — gains a second parameter; `ResearchToolContext = { clientId: string; caseId?: string | null; actor: string }` (structurally satisfied by `LlmCallContext`).
  - New event types: `apollo.search.failed`, `apollo.enrich.failed`, `brightdata.search.failed`, `brightdata.scrape.failed`, `mailbox.send.failed`, `mailbox.none_healthy`.

- [ ] **Step 1: Extend the discover mock, then write the failing test for Apollo attribution**

`src/lib/pipeline/discover.test.ts` mocks `@/lib/events/log-event` with only `logEvent` (line 21). `withExternalLogging` imports `logError` from that same module, so the mock must export it too — otherwise the wrapper calls `undefined` and every discovery test fails.

Replace line 21 of `src/lib/pipeline/discover.test.ts`:

```ts
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent }))
```

with:

```ts
vi.mock('@/lib/events/log-event', () => ({ logEvent: mockLogEvent, logError: mockLogError }))
```

and add the hoisted spy next to the others (after line 12):

```ts
const mockLogError = vi.hoisted(() => vi.fn())
```

Add `mockLogError.mockReset()` to the `beforeEach` inside `describe('runDiscoveryForCampaign', ...)`, alongside `mockLogEvent.mockReset()`.

Then append this block to the end of the file (`icp` is already declared at line 26 and `runDiscoveryForCampaign` takes the supabase client as `{} as never`):

```ts
describe('apollo failure attribution', () => {
  it('should log an apollo.search.failed event against the client when the search throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockSearchPeople.mockRejectedValue(new AppError('EXTERNAL_TIMEOUT', 'HTTP request failed', {}))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp }),
    ).rejects.toBeInstanceOf(AppError)

    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.search.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', pass: 1, page: 1 },
    })
  })

  it('should log an apollo.enrich.failed event when bulk enrichment throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    mockSearchPeople.mockResolvedValue({ totalEntries: 1, candidates: [candidate('p1', 'p1.com')] })
    mockBulkMatchPeople.mockRejectedValue(new AppError('RATE_LIMITED', 'quota exhausted', {}))

    await expect(
      runDiscoveryForCampaign({} as never, { id: 'camp1', clientId: 'client1', dailyTarget: 4, icp }),
    ).rejects.toBeInstanceOf(AppError)

    expect(mockLogError.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      type: 'apollo.enrich.failed',
      source: 'apollo',
      payload: { campaignId: 'camp1', batchSize: 1 },
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: FAIL — `searchFailure` is `undefined` because nothing logs `apollo.search.failed` yet.

- [ ] **Step 3: Wrap the Apollo calls in `discover.ts`**

Add these imports at the top of `src/lib/pipeline/discover.ts`:

```ts
import { withExternalLogging, type ExternalCallContext } from '@/lib/events/with-external-logging'
import type { Json } from '@/types/database'
```

Add this helper just below the `toFreshCandidate` function:

```ts
// Every Apollo call in this file is attributed to the campaign's client, so an
// Apollo outage or quota exhaustion shows up on that client's Logs tab instead
// of only in a 500 the operator never sees.
function apolloContext(
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

Change the `runFirstPass` signature and its `searchPeople` call:

```ts
async function runFirstPass(
  campaign: CampaignForDiscovery,
  quota: number,
  known: Set<string>,
  companyPickCounts: Map<string, number>,
  domainBackedCompanyKeys: Set<string>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  for (let page = 1; page <= MAX_SEARCH_PAGES && picks.length < quota; page++) {
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE)
    const { candidates } = await withExternalLogging(
      'apollo',
      apolloContext(campaign, 'apollo.search.failed', { pass: 1, page }),
      () => searchPeople(params),
    )
```

The rest of `runFirstPass` is unchanged.

Change the `runSecondPass` signature and its `searchPeople` call:

```ts
async function runSecondPass(
  campaign: CampaignForDiscovery,
  quota: number,
  known: Set<string>,
  firstPassPicks: FreshCandidate[],
  targetDomains: string[],
  companyPickCounts: Map<string, number>,
): Promise<SearchPassResult> {
  const { icp } = campaign
  const picks: FreshCandidate[] = []
  let candidatesSeen = 0
  const remainingTargets = new Set(targetDomains)
  let page = 1
  for (let pagesSearched = 0; pagesSearched < MAX_SEARCH_PAGES && picks.length < quota && remainingTargets.size > 0; pagesSearched++) {
    const targetsBefore = remainingTargets.size
    const params = buildPeopleSearchParams(icp, page, SEARCH_PER_PAGE, [...remainingTargets])
    const { candidates } = await withExternalLogging(
      'apollo',
      apolloContext(campaign, 'apollo.search.failed', { pass: 2, page }),
      () => searchPeople(params),
    )
```

The rest of `runSecondPass` is unchanged.

In `enrichCandidates`, wrap the `bulkMatchPeople` call:

```ts
    const enrichedPeople = await withExternalLogging(
      'apollo',
      apolloContext(campaign, 'apollo.enrich.failed', { batchSize: batch.length }),
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
```

Finally update the two call sites inside `runDiscoveryForCampaign`:

```ts
    const firstPass = await runFirstPass(campaign, firstPassQuota, known, firstPassPickCounts, domainBackedCompanyKeys)
```

```ts
    const secondPass = targetDomains.length > 0 && secondPassQuota > 0
      ? await runSecondPass(campaign, secondPassQuota, known, firstPass.picks, targetDomains, verifiedCompanyCounts)
      : { picks: [] as FreshCandidate[], candidatesSeen: 0 }
```

Finally, tag the three existing `logEvent` calls in this file. Add `severity: 'error',` and `source: 'pipeline',` after the `type:` line of the `pipeline.discover.group_lead_failed` call (inside the `groupVerifiedLead` catch) and of the `pipeline.discover.failed` call (in the outer catch). Add only `source: 'pipeline',` after the `type:` line of the `pipeline.discover.completed` call — it stays `info`, which is the default. For example, the completed call becomes:

```ts
      await logEvent({
        clientId: campaign.clientId,
        actor: 'system',
        type: 'pipeline.discover.completed',
        source: 'pipeline',
        payload: { ...summary },
      })
```

and the failed call becomes:

```ts
      await logEvent({
        clientId: campaign.clientId,
        actor: 'system',
        type: 'pipeline.discover.failed',
        severity: 'error',
        source: 'pipeline',
        payload: {
          campaignId: campaign.id,
          error: error instanceof Error ? error.message : String(error),
        },
      })
```

- [ ] **Step 4: Run the discover tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/discover.test.ts`
Expected: PASS — all existing tests plus the new one.

- [ ] **Step 5: Write the failing test for BrightData attribution**

In `src/lib/research/tools.test.ts`, add this mock and shared context immediately below the `getExecute` helper (which ends at line 10):

```ts
const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))

const context = { clientId: 'client1', caseId: 'case1', actor: 'research_agent' }
```

Then update every existing `buildResearchTools({ research })` call in the file (lines 18, 26, 33, 41) to `buildResearchTools({ research }, context)`.

Then append this block to the end of the file. The existing tests call `getExecute(tools, 'search')({ query: 'Acme' }, {} as never)` — reuse that exact call shape:

```ts
describe('brightdata failure logging', () => {
  it('should log a brightdata.search.failed event and still return an error result to the model', async () => {
    logErrorMock.mockReset()
    const research = { search: vi.fn().mockRejectedValue(new Error('SERP 502')), scrape: vi.fn() }
    const tools = buildResearchTools({ research }, context)

    const result = await getExecute(tools, 'search')({ query: 'Acme' }, {} as never)

    expect(result).toEqual({ error: 'search failed' })
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'client1',
      caseId: 'case1',
      actor: 'research_agent',
      type: 'brightdata.search.failed',
      source: 'brightdata',
      payload: { query: 'Acme' },
    })
  })

  it('should log a brightdata.scrape.failed event and still return an error result to the model', async () => {
    logErrorMock.mockReset()
    const research = { search: vi.fn(), scrape: vi.fn().mockRejectedValue(new Error('403 blocked')) }
    const tools = buildResearchTools({ research }, context)

    const result = await getExecute(tools, 'scrape')({ url: 'https://acme.com' }, {} as never)

    expect(result).toEqual({ error: 'scrape failed' })
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      type: 'brightdata.scrape.failed',
      source: 'brightdata',
      payload: { url: 'https://acme.com' },
    })
  })
})
```

- [ ] **Step 6: Run the tools test to verify it fails**

Run: `pnpm vitest run src/lib/research/tools.test.ts`
Expected: FAIL — `buildResearchTools` takes one argument (type error) and no `brightdata.search.failed` is logged.

- [ ] **Step 7: Add context and logging to the research tools**

Replace the whole contents of `src/lib/research/tools.ts` with:

```ts
import { tool, type ToolSet } from 'ai'
import { z } from 'zod'
import { logError } from '@/lib/events/log-event'
import type { WebResearch } from './provider'

/**
 * Who this research run belongs to. Structurally satisfied by `LlmCallContext`
 * so `agent.ts` can pass the context it already has, without this module
 * depending on the LLM client.
 */
export interface ResearchToolContext {
  clientId: string
  caseId?: string | null
  actor: string
}

// The tool `execute` functions deliberately swallow provider failures and
// return an { error } result so a single bad search/scrape becomes a datum the
// model can route around, instead of throwing and killing the whole agent loop.
// Swallowing it in the loop is not a reason to hide it from the operator, so
// each failure is still recorded against the client before being downgraded.
export function buildResearchTools(
  deps: { research: WebResearch },
  context: ResearchToolContext,
): ToolSet {
  return {
    search: tool({
      description: 'Search the web and return the top result snippets (url, title, content).',
      inputSchema: z.object({ query: z.string().describe('The web search query') }),
      execute: async ({ query }: { query: string }) => {
        try {
          return await deps.research.search(query)
        } catch (error) {
          await logError({
            clientId: context.clientId,
            caseId: context.caseId ?? null,
            actor: context.actor,
            type: 'brightdata.search.failed',
            source: 'brightdata',
            error,
            payload: { query },
          })
          return { error: 'search failed' }
        }
      },
    }),
    scrape: tool({
      description: 'Fetch the full text of a specific result URL for deeper detail than a snippet.',
      inputSchema: z.object({ url: z.string().describe('The page URL to fetch') }),
      execute: async ({ url }: { url: string }) => {
        try {
          return await deps.research.scrape(url)
        } catch (error) {
          await logError({
            clientId: context.clientId,
            caseId: context.caseId ?? null,
            actor: context.actor,
            type: 'brightdata.scrape.failed',
            source: 'brightdata',
            error,
            payload: { url },
          })
          return { error: 'scrape failed' }
        }
      },
    }),
  }
}
```

In `src/lib/research/agent.ts`, change line 87 from `tools: buildResearchTools(deps),` to:

```ts
    tools: buildResearchTools(deps, context),
```

- [ ] **Step 8: Run the research tests to verify they pass**

Run: `pnpm vitest run src/lib/research/tools.test.ts src/lib/research/agent.test.ts`
Expected: PASS — all tests in both files.

- [ ] **Step 9: Extend the sender mock, then write the failing test for mailbox attribution**

`src/lib/mailbox/sender.test.ts` mocks `@/lib/events/log-event` with only `logEventSafe` (lines 17-20). The sender will now also import `logWarn`, and `withExternalLogging` imports `logError` from the same module.

Replace lines 17-20 of `src/lib/mailbox/sender.test.ts`:

```ts
const logEventSafeMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
}))
```

with:

```ts
const logEventSafeMock = vi.fn()
const logErrorMock = vi.fn()
const logWarnMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (...a: unknown[]) => logEventSafeMock(...a),
  logError: (...a: unknown[]) => logErrorMock(...a),
  logWarn: (...a: unknown[]) => logWarnMock(...a),
}))
```

Add `logErrorMock.mockReset(); logWarnMock.mockReset()` to the existing `beforeEach` block, next to `logEventSafeMock.mockReset()`.

Then append this block to the end of the file. It reuses the file's existing `mailbox`, `mailboxWith`, `okProvider` and `baseInput` helpers:

```ts
describe('mailbox failure attribution', () => {
  it('should log mailbox.send.failed against the client when the provider send throws', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailbox])
    claimMailboxSendMock.mockResolvedValue(mailbox)
    const provider = okProvider()
    provider.sendEmail.mockRejectedValue(new AppError('EXTERNAL_ERROR', 'Gmail 500', {}))
    getMailboxProviderMock.mockReturnValue(provider)

    await expect(sendViaMailbox({} as never, baseInput)).rejects.toBeInstanceOf(AppError)

    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      type: 'mailbox.send.failed',
      source: 'mailbox',
      payload: { mailboxId: 'm1', provider: 'gmail' },
    })
  })

  it('should log mailbox.none_healthy as a warning when every mailbox is unhealthy', async () => {
    listMailboxesByIdsMock.mockResolvedValue([mailboxWith({ health: 'blocked' })])

    await expect(sendViaMailbox({} as never, baseInput)).rejects.toBeInstanceOf(AppError)

    expect(logWarnMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      payload: { mailboxCount: 1 },
    })
  })
})
```

- [ ] **Step 10: Run the sender test to verify it fails**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: FAIL — `logErrorMock` and `logWarnMock` were never called.

- [ ] **Step 11: Add logging to the mailbox sender**

In `src/lib/mailbox/sender.ts`, change the import

```ts
import { logEventSafe } from '@/lib/events/log-event'
```

to

```ts
import { logEventSafe, logWarn } from '@/lib/events/log-event'
import { withExternalLogging } from '@/lib/events/with-external-logging'
```

Replace the no-healthy-mailbox guard in `sendViaMailbox` with:

```ts
  if (ordered.length === 0) {
    const error = new AppError('RATE_LIMITED', 'No healthy mailbox available', { clientId: input.clientId })
    // A warning, not an error: this is an expected daily-cap/health condition
    // the pipeline handles, but the operator still needs to see that this
    // client stopped sending.
    await logWarn({
      clientId: input.clientId,
      actor: 'system',
      type: 'mailbox.none_healthy',
      source: 'mailbox',
      error,
      payload: { mailboxCount: mailboxes.length },
    })
    throw error
  }
```

Replace the `provider.sendEmail` call with:

```ts
    const { result, tokens: refreshed } = await withExternalLogging(
      'mailbox',
      {
        clientId: input.clientId,
        actor: 'system',
        failureType: 'mailbox.send.failed',
        payload: { mailboxId: claimed.id, provider: claimed.provider },
      },
      () =>
        provider.sendEmail(tokens, {
          to: input.to,
          subject: input.subject,
          body: input.body,
          threadId: input.threadId ?? null,
          inReplyToMessageId: input.inReplyToMessageId ?? null,
          references: input.references ?? null,
        }),
    )
```

- [ ] **Step 12: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/mailbox/sender.test.ts`
Expected: PASS — all existing tests plus the 2 new ones.

- [ ] **Step 13: Verify the whole suite and types still pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all three exit 0.

- [ ] **Step 14: Commit**

```bash
git add src/lib/pipeline/discover.ts src/lib/pipeline/discover.test.ts src/lib/research/tools.ts src/lib/research/tools.test.ts src/lib/research/agent.ts src/lib/mailbox/sender.ts src/lib/mailbox/sender.test.ts
git commit -m "feat(logging): attribute Apollo, BrightData and mailbox failures to the client"
```

---

### Task 7: Route-level error attribution for the pipeline

**Files:**
- Modify: `src/app/api/pipeline/discover/route.ts`
- Modify: `src/app/api/pipeline/research/route.ts`
- Modify: `src/app/api/pipeline/write/route.ts`
- Modify: `src/app/api/pipeline/followup/route.ts`
- Modify: `src/app/api/inbound/reply/route.ts`
- Modify: `src/app/api/pipeline/research/route.test.ts`
- Modify: `src/app/api/pipeline/followup/route.test.ts`

**Interfaces:**
- Consumes: `logError` from `@/lib/events/log-event` (Task 2); existing `getSequenceById` from `@/lib/db/sequences` and `getEmailById` from `@/lib/db/emails`.
- Produces: new event types `pipeline.discover.route_failed`, `pipeline.research.route_failed`, `pipeline.write.route_failed`, `pipeline.followup.route_failed`, `inbound.reply.route_failed` — all `severity: 'error'`, `source: 'pipeline'`.

This is the safety net beneath Tasks 5-6: any failure that is *not* a vendor call (a DB error, an invariant violation, a bad campaign config) still lands on the right client's Logs tab instead of vanishing into a 500.

- [ ] **Step 1: Write the failing test**

In `src/app/api/pipeline/research/route.test.ts`, add this mock immediately after the `@/lib/research/brightdata` mock (line 19):

```ts
const logErrorMock = vi.fn()
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))
```

Add `logErrorMock.mockReset()` to the existing `beforeEach` block.

Then append this block to the end of the file. It reuses the file's `req()` helper and `CASE_ID` constant:

```ts
describe('research route error attribution', () => {
  it('should log the failure against the case client when the pipeline throws', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    getCaseByIdMock.mockResolvedValue({
      id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com',
    })
    getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'active' })
    listActiveLeadsMock.mockResolvedValue([])
    runResearchMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))

    const res = await POST(req({ caseId: CASE_ID }))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      caseId: CASE_ID,
      type: 'pipeline.research.route_failed',
      source: 'pipeline',
    })
  })

  it('should not log an error when the request signature is invalid', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature', {}))

    const res = await POST(req({ caseId: CASE_ID }))

    expect(res.status).toBe(401)
    expect(logErrorMock).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/api/pipeline/research/route.test.ts`
Expected: FAIL — `logErrorMock` was never called.

- [ ] **Step 3: Add error attribution to the three routes that already hold a client id**

In `src/app/api/pipeline/discover/route.ts`, add the import

```ts
import { logError } from '@/lib/events/log-event'
```

and rewrite the handler as:

```ts
export async function POST(request: Request) {
  // Captured as the handler progresses so the catch block can attribute the
  // failure. Stays null only for failures that happen before we know which
  // client this job belongs to (signature/parse errors).
  let clientId: string | null = null
  let campaignId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsedBody = bodySchema.parse(JSON.parse(rawBody))
    campaignId = parsedBody.campaignId

    const admin = createAdminClient()
    const campaign = await getCampaignById(admin, campaignId)
    if (!campaign) {
      return NextResponse.json({ error: 'campaign_not_found' }, { status: 404 })
    }
    clientId = campaign.client_id
    if (campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    const icp = apolloIcpSchema.parse(campaign.icp)
    const summary = await runDiscoveryForCampaign(admin, {
      id: campaign.id,
      clientId: campaign.client_id,
      dailyTarget: campaign.daily_target,
      icp,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId,
      actor: 'system',
      type: 'pipeline.discover.route_failed',
      source: 'pipeline',
      error,
      payload: { campaignId },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

In `src/app/api/pipeline/research/route.ts`, add the same import and rewrite the handler as:

```ts
export async function POST(request: Request) {
  let clientId: string | null = null
  let caseId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsedBody = bodySchema.parse(JSON.parse(rawBody))
    caseId = parsedBody.caseId
    const admin = createAdminClient()

    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
    clientId = kase.client_id
    if (kase.status !== 'new') return NextResponse.json({ ok: true, skipped: 'case_not_new' })

    const campaign = await getCampaignForCase(admin, caseId)
    if (!campaign || campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    // Claim the case so a concurrent/retried fan-out won't re-research it.
    await updateCaseStatus(admin, caseId, 'researching')

    const leads = await listActiveLeadsForCase(admin, caseId)
    const summary = await runResearchForCase(
      admin,
      { research: brightdataResearch },
      {
        clientId: kase.client_id,
        caseId,
        companyName: kase.company_name,
        companyDomain: kase.company_domain,
        valueProp: campaign.value_prop,
        leads: leads.map((l) => ({ fullName: l.full_name, title: l.title })),
      },
    )
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId,
      caseId,
      actor: 'system',
      type: 'pipeline.research.route_failed',
      source: 'pipeline',
      error,
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

In `src/app/api/pipeline/write/route.ts`, add the same import and rewrite the handler as:

```ts
export async function POST(request: Request) {
  let clientId: string | null = null
  let caseId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    const parsedBody = bodySchema.parse(JSON.parse(rawBody))
    caseId = parsedBody.caseId
    const admin = createAdminClient()

    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
    clientId = kase.client_id
    if (kase.status !== 'ready') return NextResponse.json({ ok: true, skipped: 'case_not_ready' })

    const campaign = await getCampaignForCase(admin, caseId)
    if (!campaign || campaign.status !== 'active') {
      return NextResponse.json({ ok: true, skipped: 'campaign_not_active' })
    }

    // Claim the case so a retried/concurrent fan-out won't re-enter write.
    await updateCaseStatus(admin, caseId, 'contacted')

    const summary = await runWriteForCase(admin, {
      clientId: kase.client_id,
      campaignId: campaign.id,
      caseId,
      replyMode: campaign.reply_mode,
      valueProp: campaign.value_prop,
      bookingLink: campaign.booking_link,
      mailboxIds: campaign.mailbox_ids,
      companyName: kase.company_name,
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId,
      caseId,
      actor: 'system',
      type: 'pipeline.write.route_failed',
      source: 'pipeline',
      error,
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Add error attribution to the two routes that must resolve the client on the error path**

`runFollowupStep` and `runReplyForInbound` resolve the client id internally, so these two routes look it up **only when the job fails** — no extra query on the hot path.

In `src/app/api/pipeline/followup/route.ts`, add the imports

```ts
import { getSequenceById } from '@/lib/db/sequences'
import { logError } from '@/lib/events/log-event'
```

and rewrite the handler as:

```ts
export async function POST(request: Request) {
  let sequenceId: string | null = null
  let step: number | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    sequenceId = parsed.data.sequenceId
    step = parsed.data.step
    const admin = createAdminClient()
    const summary = await runFollowupStep(admin, parsed.data)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: await resolveSequenceClientId(sequenceId),
      actor: 'system',
      type: 'pipeline.followup.route_failed',
      source: 'pipeline',
      error,
      payload: { sequenceId, step },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

/**
 * Error-path only: `runFollowupStep` owns the sequence lookup on the happy
 * path, so this second read costs nothing until something has already failed.
 * Returns null rather than throwing — a lookup failure here must not replace
 * the original error with a different one.
 */
async function resolveSequenceClientId(sequenceId: string | null): Promise<string | null> {
  if (!sequenceId) return null
  try {
    const sequence = await getSequenceById(createAdminClient(), sequenceId)
    return sequence?.client_id ?? null
  } catch {
    return null
  }
}
```

In `src/app/api/inbound/reply/route.ts`, add the imports

```ts
import { getEmailById } from '@/lib/db/emails'
import { logError } from '@/lib/events/log-event'
```

and rewrite the handler as:

```ts
export async function POST(request: Request) {
  let emailId: string | null = null
  try {
    const rawBody = await verifyQstashSignature(request)
    let json: unknown
    try {
      json = JSON.parse(rawBody)
    } catch {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    const parsed = bodySchema.safeParse(json)
    if (!parsed.success) {
      return NextResponse.json({ error: 'validation_error' }, { status: 400 })
    }
    emailId = parsed.data.emailId
    const admin = createAdminClient()
    const summary = await runReplyForInbound(admin, parsed.data)
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    await logError({
      clientId: await resolveEmailClientId(emailId),
      actor: 'system',
      type: 'inbound.reply.route_failed',
      source: 'pipeline',
      error,
      payload: { emailId },
    })
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}

/**
 * Error-path only: `runReplyForInbound` owns the email lookup on the happy
 * path. Returns null rather than throwing so a lookup failure cannot replace
 * the original error.
 */
async function resolveEmailClientId(emailId: string | null): Promise<string | null> {
  if (!emailId) return null
  try {
    const email = await getEmailById(createAdminClient(), emailId)
    return email?.client_id ?? null
  } catch {
    return null
  }
}
```

- [ ] **Step 5: Write and run the followup route test**

In `src/app/api/pipeline/followup/route.test.ts`, add these mocks immediately after the `@/lib/pipeline/followup` mock (line 8-11):

```ts
const getSequenceByIdMock = vi.fn()
const logErrorMock = vi.fn()
vi.mock('@/lib/db/sequences', () => ({ getSequenceById: (...a: unknown[]) => getSequenceByIdMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logError: (...a: unknown[]) => logErrorMock(...a) }))
```

Add `getSequenceByIdMock.mockReset(); logErrorMock.mockReset()` to the existing `beforeEach` block.

Then append this block to the end of the file. It reuses the file's `req()` helper and `SEQUENCE_ID` constant:

```ts
describe('followup route error attribution', () => {
  it('should resolve the sequence client on the error path and log the failure', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 1 }))
    runFollowupMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))
    getSequenceByIdMock.mockResolvedValue({ id: SEQUENCE_ID, client_id: 'c1' })

    const res = await POST(req({}))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: 'c1',
      type: 'pipeline.followup.route_failed',
      source: 'pipeline',
      payload: { sequenceId: SEQUENCE_ID, step: 1 },
    })
  })

  it('should log with a null client when the sequence lookup also fails', async () => {
    const { AppError } = await import('@/lib/errors/app-error')
    verifyMock.mockResolvedValue(JSON.stringify({ sequenceId: SEQUENCE_ID, step: 1 }))
    runFollowupMock.mockRejectedValue(new AppError('DB_ERROR', 'connection reset', {}))
    getSequenceByIdMock.mockRejectedValue(new AppError('DB_ERROR', 'still down', {}))

    const res = await POST(req({}))

    expect(res.status).toBe(500)
    expect(logErrorMock.mock.calls[0]?.[0]).toMatchObject({ clientId: null })
  })
})
```

Run: `pnpm vitest run src/app/api/pipeline src/app/api/inbound`
Expected: PASS — all pipeline and inbound route tests including the 4 new ones.

- [ ] **Step 6: Verify the whole suite and types still pass**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: all three exit 0.

- [ ] **Step 7: Commit**

```bash
git add src/app/api/pipeline/discover/route.ts src/app/api/pipeline/research/route.ts src/app/api/pipeline/write/route.ts src/app/api/pipeline/followup/route.ts src/app/api/inbound/reply/route.ts src/app/api/pipeline/research/route.test.ts src/app/api/pipeline/followup/route.test.ts
git commit -m "feat(logging): attribute pipeline route failures to the client"
```

---

### Task 8: Logs tab on the client detail page

**Files:**
- Create: `src/lib/ui/log.ts`
- Create: `src/lib/ui/log.test.ts`
- Create: `src/app/(app)/clients/[id]/logs-feed.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `listEventsForClient`, `EventRow` from `@/lib/db/events` (Task 4); `LogSeverity`, `LogSource`, `LogSeverityFilter`, `SEVERITIES_FOR_FILTER`, `LOG_SOURCES` from `@/types/logs` (Task 1); `StatusPill`, `FilterChips`, `EmptyState`, `formatRelative`, `formatAbsolute`, `humanizeEnum`, `truncate`.
- Produces:
  - `LOG_SEVERITY_META: Record<LogSeverity, StatusMeta>`, `LOG_SOURCE_META: Record<LogSource, StatusMeta>`, `LOG_SEVERITY_FILTER_LABEL: Record<LogSeverityFilter, string>`
  - `describeEvent(type: string, payload: Json): string`
  - `<LogsFeed />` server component.

- [ ] **Step 1: Write the failing test for the event humanizer**

Create `src/lib/ui/log.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { describeEvent, LOG_SEVERITY_META, LOG_SOURCE_META } from './log'
import { LOG_SEVERITIES, LOG_SOURCES } from '@/types/logs'

describe('describeEvent', () => {
  it('should report the lead tally when given a completed discovery run', () => {
    const result = describeEvent('pipeline.discover.completed', {
      campaignId: 'camp1',
      inserted: 14,
      verified: 9,
      candidatesSeen: 220,
    })

    expect(result).toBe('Discovery run finished — 14 leads found, 9 with a verified email.')
  })

  it('should report the dossier size when given a completed research run', () => {
    const result = describeEvent('pipeline.research.completed', { knowledgeCount: 7, agentsFailed: 1 })

    expect(result).toBe('Research finished — 7 dossier facts gathered, 1 agent failed.')
  })

  it('should report send and draft counts when given a completed write run', () => {
    const result = describeEvent('pipeline.write.completed', { sent: 3, drafted: 1, leadCount: 4 })

    expect(result).toBe('Outreach written for 4 leads — 3 sent, 1 left as a draft.')
  })

  it('should surface the error message when given an error payload with no builder', () => {
    const result = describeEvent('some.unmapped.failure', {
      errorCode: 'EXTERNAL_TIMEOUT',
      errorMessage: 'HTTP request failed',
    })

    expect(result).toBe('HTTP request failed')
  })

  it('should humanize the event type when the payload carries nothing useful', () => {
    const result = describeEvent('mailbox.connected', {})

    expect(result).toBe('Mailbox connected')
  })

  it('should not throw when the payload is not an object', () => {
    expect(describeEvent('pipeline.discover.completed', null)).toBe(
      'Discovery run finished — 0 leads found, 0 with a verified email.',
    )
  })
})

describe('log display metadata', () => {
  it('should provide a label and colour for every severity', () => {
    for (const severity of LOG_SEVERITIES) {
      expect(LOG_SEVERITY_META[severity].label.length).toBeGreaterThan(0)
      expect(LOG_SEVERITY_META[severity].color).toContain('var(--')
    }
  })

  it('should provide a label and colour for every source', () => {
    for (const source of LOG_SOURCES) {
      expect(LOG_SOURCE_META[source].label.length).toBeGreaterThan(0)
      expect(LOG_SOURCE_META[source].color).toContain('var(--')
    }
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/lib/ui/log.test.ts`
Expected: FAIL — `Failed to resolve import "./log"`.

- [ ] **Step 3: Implement the log display metadata and humanizer**

Create `src/lib/ui/log.ts`:

```ts
import type { Json } from '@/types/database'
import type { LogSeverity, LogSeverityFilter, LogSource } from '@/types/logs'
import { humanizeEnum } from '@/lib/format'
import type { StatusMeta } from './status'

export const LOG_SEVERITY_META: Record<LogSeverity, StatusMeta> = {
  info: { label: 'Info', color: 'var(--status-contacted)' },
  warn: { label: 'Warning', color: 'var(--status-hot-handoff)' },
  error: { label: 'Error', color: 'var(--status-lost)' },
}

export const LOG_SOURCE_META: Record<LogSource, StatusMeta> = {
  app: { label: 'App', color: 'var(--status-new)' },
  pipeline: { label: 'Pipeline', color: 'var(--status-researching)' },
  gemini: { label: 'Gemini', color: 'var(--status-ready)' },
  apollo: { label: 'Apollo', color: 'var(--status-contacted)' },
  brightdata: { label: 'BrightData', color: 'var(--status-in-conversation)' },
  mailbox: { label: 'Mailbox', color: 'var(--status-won)' },
  qstash: { label: 'QStash', color: 'var(--status-dead)' },
  db: { label: 'Database', color: 'var(--status-lost)' },
}

export const LOG_SEVERITY_FILTER_LABEL: Record<LogSeverityFilter, string> = {
  problems: 'Problems',
  errors: 'Errors',
  all: 'Everything',
}

// `payload` is `Json`, so every read has to narrow before indexing — a log row
// written by an older deploy may not carry the field a builder expects.
function readNumber(payload: Json, key: string): number {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return 0
  const value = payload[key]
  return typeof value === 'number' ? value : 0
}

function readString(payload: Json, key: string): string | null {
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null
  const value = payload[key]
  return typeof value === 'string' && value.length > 0 ? value : null
}

function plural(count: number, singular: string, pluralForm: string): string {
  return count === 1 ? singular : pluralForm
}

/**
 * Turns one event row into the sentence an operator reads in the feed. Keyed by
 * event type so each row says what actually happened ("14 leads found") rather
 * than exposing a raw JSON payload.
 */
const SENTENCE_BUILDERS: Record<string, (payload: Json) => string> = {
  'pipeline.discover.completed': (p) =>
    `Discovery run finished — ${readNumber(p, 'inserted')} leads found, ${readNumber(p, 'verified')} with a verified email.`,
  'pipeline.discover.failed': (p) =>
    `Discovery run failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.discover.group_lead_failed': (p) =>
    `Could not group a discovered lead into a company case: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.discover.route_failed': (p) =>
    `Discovery job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.research.completed': (p) =>
    `Research finished — ${readNumber(p, 'knowledgeCount')} dossier ${plural(readNumber(p, 'knowledgeCount'), 'fact', 'facts')} gathered, ${readNumber(p, 'agentsFailed')} ${plural(readNumber(p, 'agentsFailed'), 'agent', 'agents')} failed.`,
  'pipeline.research.agent_failed': (p) =>
    `A ${readString(p, 'role') ?? 'research'} agent failed (${readString(p, 'errorCode') ?? 'unknown'}).`,
  'pipeline.research.route_failed': (p) =>
    `Research job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.write.completed': (p) =>
    `Outreach written for ${readNumber(p, 'leadCount')} leads — ${readNumber(p, 'sent')} sent, ${readNumber(p, 'drafted')} left as a draft.`,
  'pipeline.write.route_failed': (p) =>
    `Write job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'pipeline.followup.sent': (p) => `Follow-up ${readNumber(p, 'step')} sent.`,
  'pipeline.followup.exhausted': () => 'Follow-up sequence finished with no reply.',
  'pipeline.followup.completed_on_reply': () => 'Follow-up sequence stopped — the lead replied.',
  'pipeline.followup.route_failed': (p) =>
    `Follow-up job crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'inbound.received': () => 'Inbound reply received.',
  'inbound.reply.route_failed': (p) =>
    `Reply handling crashed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'reply.answered': (p) => `Reply answered automatically (${readString(p, 'intent') ?? 'other'}).`,
  'reply.knowledge_gap': (p) =>
    `Reply escalated — the agent needs an answer: "${readString(p, 'question') ?? 'unknown question'}".`,
  'reply.knowledge_answered': () => 'Reply answered from an operator-supplied answer.',
  'reply.opt_out': () => 'Lead opted out — suppressed and sequence stopped.',
  'reply.price_handoff': () => 'Pricing question — handed off to a human and marked hot.',
  'llm.completed': (p) =>
    `Gemini call completed in ${readNumber(p, 'durationMs')}ms (${readNumber(p, 'promptTokens')} in / ${readNumber(p, 'completionTokens')} out tokens).`,
  'llm.failed': (p) =>
    `Gemini ${readString(p, 'operation') ?? 'call'} failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'apollo.search.failed': (p) =>
    `Apollo people search failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'apollo.enrich.failed': (p) =>
    `Apollo enrichment failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'brightdata.search.failed': (p) =>
    `Web search failed for "${readString(p, 'query') ?? 'unknown query'}": ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'brightdata.scrape.failed': (p) =>
    `Page fetch failed for ${readString(p, 'url') ?? 'an unknown URL'}: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'mailbox.send.failed': (p) =>
    `Sending from a mailbox failed: ${readString(p, 'errorMessage') ?? 'unknown error'}.`,
  'mailbox.none_healthy': (p) =>
    `No healthy mailbox available — ${readNumber(p, 'mailboxCount')} configured, all capped or blocked.`,
  'mailbox.connected': () => 'Mailbox connected.',
}

export function describeEvent(type: string, payload: Json): string {
  const build = SENTENCE_BUILDERS[type]
  if (build) return build(payload)
  // Unmapped error rows still read well: logError always writes errorMessage.
  const message = readString(payload, 'errorMessage')
  if (message) return message
  return humanizeEnum(type.replace(/\./g, ' '))
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/lib/ui/log.test.ts`
Expected: PASS — 8 tests.

- [ ] **Step 5: Build the logs feed component**

Create `src/app/(app)/clients/[id]/logs-feed.tsx`:

```tsx
import Link from 'next/link'
import { ListMagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import type { EventRow } from '@/lib/db/events'
import type { LogSeverityFilter, LogSource } from '@/types/logs'
import { LOG_SEVERITY_FILTERS, LOG_SOURCES } from '@/types/logs'
import { LOG_SEVERITY_FILTER_LABEL, LOG_SEVERITY_META, LOG_SOURCE_META, describeEvent } from '@/lib/ui/log'
import { formatAbsolute, formatRelative } from '@/lib/format'
import { StatusPill } from '@/components/status-dot'
import { EmptyState } from '@/components/empty-state'
import { FilterChips, type FilterOption } from '@/components/filter-chips'

interface LogsFeedProps {
  clientId: string
  events: EventRow[]
  severityFilter: LogSeverityFilter
  source: LogSource | null
  /** Cursor for the next (older) page, or null when this is the last page. */
  nextCursor: string | null
  now: Date
}

const SEVERITY_OPTIONS: readonly FilterOption[] = LOG_SEVERITY_FILTERS.map((value) => ({
  value,
  label: LOG_SEVERITY_FILTER_LABEL[value],
}))

const SOURCE_OPTIONS: readonly FilterOption[] = [
  { value: null, label: 'All sources' },
  ...LOG_SOURCES.map((value) => ({
    value,
    label: LOG_SOURCE_META[value].label,
    color: LOG_SOURCE_META[value].color,
  })),
]

export function LogsFeed({
  clientId,
  events,
  severityFilter,
  source,
  nextCursor,
  now,
}: LogsFeedProps): React.ReactElement {
  const pathname = `/clients/${clientId}`
  // `logBefore` is deliberately absent from `carry`: changing a filter must
  // start a fresh page rather than resume from the previous page's cursor.
  const carry = { tab: 'logs', logSeverity: severityFilter, logSource: source }

  return (
    <div className="flex flex-col gap-5">
      <div className="border-hairline flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border p-3">
        <FilterChips
          label="Show"
          param="logSeverity"
          options={SEVERITY_OPTIONS}
          active={severityFilter}
          carry={carry}
          pathname={pathname}
        />
        <FilterChips
          label="Source"
          param="logSource"
          options={SOURCE_OPTIONS}
          active={source}
          carry={carry}
          pathname={pathname}
        />
      </div>

      {events.length === 0 ? (
        <EmptyState
          icon={ListMagnifyingGlass}
          title="Nothing logged here"
          description={
            severityFilter === 'all'
              ? 'This client has no activity yet. Logs appear as soon as a campaign runs.'
              : 'No problems recorded for this client. Switch to "Everything" to see normal activity.'
          }
        />
      ) : (
        <ul className="flex flex-col gap-1.5">
          {events.map((event) => (
            <li
              key={event.id}
              className="border-hairline bg-surface flex flex-wrap items-start gap-x-3 gap-y-2 rounded-lg border p-3"
            >
              <time
                dateTime={event.created_at}
                title={formatAbsolute(event.created_at)}
                className="text-faint tnum w-16 shrink-0 pt-0.5 text-[11px]"
              >
                {formatRelative(event.created_at, now)}
              </time>
              <p className="min-w-0 flex-1 text-[13px] leading-relaxed">
                {describeEvent(event.type, event.payload)}
              </p>
              <div className="flex shrink-0 items-center gap-1.5">
                <StatusPill meta={LOG_SOURCE_META[event.source]} />
                <StatusPill meta={LOG_SEVERITY_META[event.severity]} />
              </div>
            </li>
          ))}
        </ul>
      )}

      {nextCursor ? (
        <Link
          href={buildCursorHref(pathname, severityFilter, source, nextCursor)}
          className="border-hairline text-muted-foreground hover:bg-accent hover:text-foreground self-center rounded-full border px-4 py-1.5 text-[11px] font-medium transition-colors duration-200"
        >
          Load older
        </Link>
      ) : null}
    </div>
  )
}

function buildCursorHref(
  pathname: string,
  severityFilter: LogSeverityFilter,
  source: LogSource | null,
  cursor: string,
): string {
  const params = new URLSearchParams({ tab: 'logs', logSeverity: severityFilter, logBefore: cursor })
  if (source) params.set('logSource', source)
  return `${pathname}?${params.toString()}`
}
```

- [ ] **Step 6: Wire the Logs tab into the client detail page**

In `src/app/(app)/clients/[id]/page.tsx`:

Add to the icon import on line 6 so it reads:

```tsx
import { ArrowLeft, Buildings, ChartLineUp, Lightning, ListMagnifyingGlass, UsersThree } from '@phosphor-icons/react/dist/ssr'
```

Add these imports below the existing `listCampaignsForClient` import:

```tsx
import { listEventsForClient } from '@/lib/db/events'
import { SEVERITIES_FOR_FILTER } from '@/types/logs'
import type { LogSeverityFilter, LogSource } from '@/types/logs'
import { LogsFeed } from './logs-feed'
```

Change the tab schema and add the log-filter schemas (replacing line 27). The values are spelled out as literals rather than derived from the `LOG_*` arrays because `z.enum` requires a non-empty tuple, and casting a `readonly` array into one would hide drift instead of catching it. The `LogSeverityFilter` / `LogSource` annotations on the parse results below are what catch drift: if a schema ever produces a value outside the shared union, that assignment fails to compile.

```tsx
const tabSchema = z.enum(['campaigns', 'analytics', 'users', 'logs'])

const logSeveritySchema = z.enum(['problems', 'errors', 'all'])
const logSourceSchema = z.enum(['app', 'pipeline', 'gemini', 'apollo', 'brightdata', 'mailbox', 'qstash', 'db'])
const logBeforeSchema = z.string().datetime()

// One extra row is fetched to decide whether a "Load older" link is needed,
// then dropped before rendering — cheaper than a separate count query.
const LOGS_PAGE_SIZE = 50
```

After the existing `const tab = ...` line, add the log query:

```tsx
  const severityFilter = logSeveritySchema.safeParse(rawSearchParams.logSeverity)
  const logSeverity: LogSeverityFilter = severityFilter.success ? severityFilter.data : 'problems'
  const sourceFilter = logSourceSchema.safeParse(rawSearchParams.logSource)
  const logSource: LogSource | null = sourceFilter.success ? sourceFilter.data : null
  const beforeFilter = logBeforeSchema.safeParse(rawSearchParams.logBefore)
  const logBefore = beforeFilter.success ? beforeFilter.data : null

  // Only queried when the tab is actually open: the feed is the most expensive
  // read on this page and the other three tabs never show it.
  const logRows =
    tab === 'logs'
      ? await listEventsForClient(admin, {
          clientId,
          severities: SEVERITIES_FOR_FILTER[logSeverity],
          source: logSource,
          limit: LOGS_PAGE_SIZE + 1,
          before: logBefore,
        })
      : []
  const hasOlderLogs = logRows.length > LOGS_PAGE_SIZE
  const logs = hasOlderLogs ? logRows.slice(0, LOGS_PAGE_SIZE) : logRows
  const nextLogCursor = hasOlderLogs ? (logs[logs.length - 1]?.created_at ?? null) : null
```

Add the tab trigger, immediately after the `users` trigger inside `<TabsList>`:

```tsx
          <TabsTrigger value="logs" asChild>
            <Link href={`/clients/${clientId}?tab=logs`}>
              <ListMagnifyingGlass size={14} weight="light" />
              Logs
            </Link>
          </TabsTrigger>
```

And add the tab content, immediately after the closing `</TabsContent>` of the `users` tab:

```tsx
        <TabsContent value="logs">
          <LogsFeed
            clientId={client.id}
            events={logs}
            severityFilter={logSeverity}
            source={logSource}
            nextCursor={nextLogCursor}
            now={now}
          />
        </TabsContent>
```

- [ ] **Step 7: Verify the page builds and renders**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all three exit 0.

Run: `pnpm build`
Expected: build succeeds with no type or lint errors.

Then start the dev server (`pnpm dev`), sign in as an operator, open a client, and click the **Logs** tab. Verify all four states:
- **Empty** — a brand-new client shows the "Nothing logged here" empty state.
- **Success** — a client whose pipeline has run shows humanized sentences with source and severity pills.
- **Filters** — clicking `Everything` / `Errors` / a source chip changes the list and keeps the tab selected; the URL is shareable.
- **Pagination** — with more than 50 matching rows, "Load older" appears and returns the next page.

- [ ] **Step 8: Commit**

```bash
git add src/lib/ui/log.ts src/lib/ui/log.test.ts "src/app/(app)/clients/[id]/logs-feed.tsx" "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat(logging): add filterable Logs tab to the client detail page"
```

---

### Task 9: 24h error indicator on the clients list

**Files:**
- Modify: `src/app/(app)/clients/page.tsx`

**Interfaces:**
- Consumes: `countRecentErrorsByClient` from `@/lib/db/events` (Task 4); `ClientErrorCount` from `@/types/logs`.
- Produces: no new exports — a health chip rendered on each row of `/clients`.

- [ ] **Step 1: Add the error counts to the page query**

In `src/app/(app)/clients/page.tsx`, replace the existing Phosphor import (line 4) with:

```tsx
import { Buildings, Warning } from '@phosphor-icons/react/dist/ssr'
```

And add these two imports below the existing `listClientsFull` import:

```tsx
import { countRecentErrorsByClient } from '@/lib/db/events'
import type { ClientErrorCount } from '@/types/logs'
```

Add the window constant above the component:

```tsx
// The window the health chip summarises. Short on purpose: an operator scanning
// this list wants "is this broken right now", not a lifetime error total.
const HEALTH_WINDOW_HOURS = 24
```

Replace the data-loading lines inside the component:

```tsx
  const admin = createAdminClient()
  const now = new Date()
  const since = new Date(now.getTime() - HEALTH_WINDOW_HOURS * 60 * 60 * 1000).toISOString()
  const [clients, errorCounts] = await Promise.all([
    listClientsFull(admin),
    countRecentErrorsByClient(admin, since),
  ])
```

(Remove the now-duplicated `const now = new Date()` that previously followed `listClientsFull`.)

- [ ] **Step 2: Render the health chip**

Add this component below the `HEALTH_WINDOW_HOURS` constant:

```tsx
interface ClientHealthChipProps {
  counts: ClientErrorCount | undefined
}

/**
 * Renders nothing when a client is healthy — an all-green list of "0 errors"
 * chips would train the operator to stop reading the column.
 */
function ClientHealthChip({ counts }: ClientHealthChipProps): React.ReactElement | null {
  if (!counts) return null
  const { errorCount, warnCount } = counts
  if (errorCount === 0 && warnCount === 0) return null

  const isError = errorCount > 0
  const count = isError ? errorCount : warnCount
  const noun = isError ? 'error' : 'warning'
  const color = isError ? 'var(--status-lost)' : 'var(--status-hot-handoff)'

  return (
    <span
      className="inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[11px] font-medium whitespace-nowrap"
      style={{ color, background: `color-mix(in oklch, ${color} 14%, transparent)` }}
    >
      <Warning size={11} weight="fill" aria-hidden />
      <span className="tnum">{count}</span>
      {count === 1 ? noun : `${noun}s`} in {HEALTH_WINDOW_HOURS}h
    </span>
  )
}
```

Then render it inside the row `<Link>`, immediately after the `<StatusPill ... />`:

```tsx
                  <ClientHealthChip counts={errorCounts.get(client.id)} />
```

- [ ] **Step 3: Verify types, lint and build**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all four exit 0.

- [ ] **Step 4: Verify the list renders all states**

With the dev server running, open `/clients` as an operator and verify:
- A client with no recent problems shows no chip (unchanged row).
- A client with recent errors shows a red `N errors in 24h` chip.
- A client with warnings but no errors shows an amber `N warnings in 24h` chip.
- The empty state (no clients at all) still renders.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/clients/page.tsx"
git commit -m "feat(logging): show a 24h error indicator on the clients list"
```

---

### Task 10: Retention purge cron

**Files:**
- Create: `src/app/api/pipeline/log-retention/route.ts`
- Create: `src/app/api/pipeline/log-retention/route.test.ts`
- Create: `scripts/schedule-log-retention-cron.ts`
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: `deleteExpiredEvents`, `EventRetention`, `PurgeSummary` from `@/lib/db/events` (Task 4); `verifyQstashSignature`; `logEventSafe`; `scheduleCron` from `@/lib/qstash/client`.
- Produces: `POST /api/pipeline/log-retention`, and a `logs.retention.completed` event (`severity: 'info'`, `source: 'db'`, `clientId: null`).

- [ ] **Step 1: Write the failing test**

Create `src/app/api/pipeline/log-retention/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
const deleteExpiredEventsMock = vi.fn()
const logEventSafeMock = vi.fn().mockResolvedValue(undefined)

vi.mock('@/lib/qstash/verify', () => ({ verifyQstashSignature: (r: Request) => verifyMock(r) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/events', () => ({
  deleteExpiredEvents: (...args: unknown[]) => deleteExpiredEventsMock(...args),
}))
vi.mock('@/lib/events/log-event', () => ({
  logEventSafe: (input: unknown) => logEventSafeMock(input),
}))

import { POST } from './route'
import { AppError } from '@/lib/errors/app-error'

function request(): Request {
  return new Request('http://localhost/api/pipeline/log-retention', { method: 'POST', body: '{}' })
}

describe('POST /api/pipeline/log-retention', () => {
  beforeEach(() => {
    verifyMock.mockReset().mockResolvedValue('{}')
    deleteExpiredEventsMock.mockReset()
    logEventSafeMock.mockClear()
  })

  it('should return 401 when the QStash signature is invalid', async () => {
    verifyMock.mockRejectedValue(new AppError('UNAUTHORIZED', 'bad signature', {}))

    const response = await POST(request())

    expect(response.status).toBe(401)
    expect(deleteExpiredEventsMock).not.toHaveBeenCalled()
  })

  it('should purge expired rows and return the summary when the signature is valid', async () => {
    deleteExpiredEventsMock.mockResolvedValue({ infoDeleted: 120, problemDeleted: 4 })

    const response = await POST(request())

    expect(response.status).toBe(200)
    await expect(response.json()).resolves.toEqual({
      ok: true,
      summary: { infoDeleted: 120, problemDeleted: 4 },
    })
    expect(deleteExpiredEventsMock.mock.calls[0]?.[2]).toEqual({ infoDays: 30, problemDays: 90 })
  })

  it('should log a retention event after a successful purge', async () => {
    deleteExpiredEventsMock.mockResolvedValue({ infoDeleted: 1, problemDeleted: 0 })

    await POST(request())

    expect(logEventSafeMock.mock.calls[0]?.[0]).toMatchObject({
      clientId: null,
      type: 'logs.retention.completed',
      severity: 'info',
      source: 'db',
      payload: { infoDeleted: 1, problemDeleted: 0 },
    })
  })

  it('should return 500 when the purge fails', async () => {
    deleteExpiredEventsMock.mockRejectedValue(new AppError('DB_ERROR', 'boom', {}))

    const response = await POST(request())

    expect(response.status).toBe(500)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm vitest run src/app/api/pipeline/log-retention/route.test.ts`
Expected: FAIL — `Failed to resolve import "./route"`.

- [ ] **Step 3: Implement the route**

Create `src/app/api/pipeline/log-retention/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { deleteExpiredEvents, type EventRetention } from '@/lib/db/events'
import { logEventSafe } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

// `info` rows are the high-volume ones (one per LLM call) and lose value fast.
// `warn`/`error` rows are what an operator goes back to weeks later, so they
// get a longer window.
const RETENTION: EventRetention = { infoDays: 30, problemDays: 90 }

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const summary = await deleteExpiredEvents(admin, new Date(), RETENTION)
    await logEventSafe({
      clientId: null,
      actor: 'system',
      type: 'logs.retention.completed',
      severity: 'info',
      source: 'db',
      payload: { ...summary, infoDays: RETENTION.infoDays, problemDays: RETENTION.problemDays },
    })
    return NextResponse.json({ ok: true, summary })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm vitest run src/app/api/pipeline/log-retention/route.test.ts`
Expected: PASS — 4 tests.

- [ ] **Step 5: Add the cron registration script**

Create `scripts/schedule-log-retention-cron.ts`:

```ts
// One-time setup: registers the QStash schedule that purges log rows past their
// retention window (30 days for info, 90 days for warn/error). Run once per
// environment after deploy:
//   Usage: tsx scripts/schedule-log-retention-cron.ts [cron-expression]
// Default cron: "20 3 * * *" (daily at 03:20 UTC, off the pipeline's peak).
import { scheduleCron } from '../src/lib/qstash/client'

async function main() {
  const cron = process.argv[2] ?? '20 3 * * *'
  const scheduleId = await scheduleCron('/api/pipeline/log-retention', cron)
  process.stdout.write(`Scheduled log-retention cron "${cron}": ${scheduleId}\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```

- [ ] **Step 6: Verify everything passes end to end**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm build`
Expected: all four exit 0.

- [ ] **Step 7: Update the roadmap**

In `.claude/roadmap.md`, add a completed entry describing this work. Follow whatever heading and checkbox convention the file already uses; the entry must record:
- Client-scoped logging shipped: `events.severity` + `events.source` (migration `0010_event_logging.sql`).
- `logError` / `logWarn` / `withExternalLogging` attribute Gemini, Apollo, BrightData, mailbox and pipeline-route failures to a client.
- Logs tab on `/clients/[id]` with severity/source filters and cursor pagination; 24h error chip on `/clients`.
- Nightly retention purge at `POST /api/pipeline/log-retention` (30d info / 90d warn+error), registered with `tsx scripts/schedule-log-retention-cron.ts`.

- [ ] **Step 8: Commit**

```bash
git add src/app/api/pipeline/log-retention/route.ts src/app/api/pipeline/log-retention/route.test.ts scripts/schedule-log-retention-cron.ts .claude/roadmap.md
git commit -m "feat(logging): add nightly log retention purge cron"
```

- [ ] **Step 9: Register the cron in each environment**

Run: `pnpm tsx scripts/schedule-log-retention-cron.ts`
Expected: `Scheduled log-retention cron "20 3 * * *": scd_...`

Run this once per environment (local/staging/production) with that environment's `QSTASH_TOKEN` and `APP_URL` in the environment. It is not idempotent — running it twice creates two schedules, so verify with the QStash console before re-running.

---

## Deployment checklist

Run once the plan is complete, in this order:

1. Apply `supabase/migrations/0010_event_logging.sql` to the target database (`supabase db push` for hosted, `supabase migration up --local` for local).
2. Deploy the application.
3. Register the retention cron: `pnpm tsx scripts/schedule-log-retention-cron.ts`.

Step 1 must land before step 2: the new code writes `severity`/`source` on every event insert, and an un-migrated database rejects those columns.
