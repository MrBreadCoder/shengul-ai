# P0 — Foundations Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stand up an authenticated Next.js app on Vercel + Supabase with the full Postgres schema, per-`client_id` Row-Level Security, mailbox OAuth (Gmail + Outlook) that can send a test email, an `events` audit-log helper, and a signature-verified QStash "hello" cron — but no lead pipeline yet.

**Architecture:** Next.js (App Router, TypeScript strict) is the single deployable. All data lives in Supabase Postgres, guarded by RLS so a client sees only its own rows while operators span all clients. External providers (mailbox send, scheduler) sit behind swappable interfaces per `architecture.md §10`. Server-side pipeline writes use the Supabase service-role key (bypasses RLS); browser/auth reads use anon key (enforced by RLS). Every state change is written to `events`.

**Tech Stack:** Next.js 15 (App Router, React 19) · TypeScript 5 (strict) · `@supabase/supabase-js` + `@supabase/ssr` · Supabase CLI (local Postgres + migrations) · Zod 3 · Vitest · `@upstash/qstash` · raw `fetch` + Zod for Gmail API & Microsoft Graph · pnpm · Vercel.

## Global Constraints

Copied from `.claude/rules/QUALITY.md`, `.claude/rules/ANTI_LAZY.md`, `architecture.md`, and `roadmap.md`. **Every task's requirements implicitly include this section.**

- **Package manager:** `pnpm` (all commands use `pnpm`).
- **TypeScript:** `strict: true`. No `any` (use `unknown` + narrow). No `!` non-null assertions without a proof comment. No barrel `index.ts` files. Named exports only, except Next.js pages/layouts/components (default export).
- **Runtime validation:** Zod for **all** external boundaries — env vars, route inputs, webhook payloads, OAuth token responses, external API responses. Never trust an external shape.
- **Errors:** Never throw bare `Error`. Always `throw new AppError(code, message, context)`. Catch external SDK/HTTP errors at the boundary and rethrow as `AppError`. No empty catch blocks; no `catch (e) { console.log(e) }`.
- **External calls:** Every external HTTP call has an explicit timeout (`AbortController`). No unbounded waits.
- **Naming:** Files `kebab-case.ts`. DB tables/columns `snake_case`; TypeScript `camelCase`. Booleans prefixed `is/has/can/should`. Zod schemas suffixed `Schema`.
- **DB access:** lives only in `src/lib/db/`. One function per DB operation. Map raw Supabase errors to `AppError` at the DB layer. Never inline queries in components/routes.
- **Testing:** Vitest, colocated `*.test.ts`. Arrange-Act-Assert. Test naming `it('should [behavior] when [condition]')`. 100% coverage on utility functions and Zod schemas. Every error path tested. Mock at the boundary (Supabase/HTTP); never mock our own business logic.
- **Observability:** Every state change writes to `events` via the shared helper. No `console.log` in production paths.
- **Completeness (ANTI_LAZY):** No stubs, no TODOs, no truncation, no `// ...`, no `YOUR_KEY_HERE`, no hardcoded mock returns. Every function fully implemented.
- **RLS:** Every table has RLS enabled with per-`client_id` isolation and an operator bypass. RLS is verified by an integration test.
- **Year is 2026.** After completing each task, tick its boxes in `roadmap.md` P0.

---

## File Structure

```
.
├── package.json                         # pnpm workspace root (the app)
├── next.config.ts
├── tsconfig.json                        # strict
├── vitest.config.ts
├── .env.example                         # every required var, no values
├── .env.local                           # real values (gitignored)
├── .gitignore
├── middleware.ts                        # Supabase session refresh + route guard
├── supabase/
│   ├── config.toml                      # supabase CLI local project
│   └── migrations/
│       ├── 0001_initial_schema.sql      # all architecture.md §5 tables + app_users
│       └── 0002_rls_policies.sql        # helper fns + policies for every table
├── src/
│   ├── app/
│   │   ├── layout.tsx
│   │   ├── page.tsx                      # redirect to /settings or /login
│   │   ├── login/page.tsx                # Supabase email/password sign-in
│   │   ├── settings/page.tsx             # DEMO: connect mailboxes + send test
│   │   └── api/
│   │       ├── cron/hello/route.ts       # QStash-signed hello cron
│   │       ├── mailboxes/
│   │       │   ├── google/connect/route.ts
│   │       │   ├── google/callback/route.ts
│   │       │   ├── outlook/connect/route.ts
│   │       │   ├── outlook/callback/route.ts
│   │       │   └── [id]/test-email/route.ts
│   │       └── auth/signout/route.ts
│   ├── lib/
│   │   ├── env.ts                        # Zod-validated process.env
│   │   ├── errors/app-error.ts
│   │   ├── http/fetch-json.ts            # fetch + timeout + Zod parse
│   │   ├── supabase/
│   │   │   ├── server.ts                 # RLS client (cookies, anon key)
│   │   │   ├── client.ts                 # browser client
│   │   │   ├── admin.ts                  # service-role client (bypasses RLS)
│   │   │   └── middleware.ts             # session refresh helper
│   │   ├── db/
│   │   │   ├── events.ts                 # insertEvent
│   │   │   ├── mailboxes.ts              # insert/get/update mailboxes
│   │   │   └── app-users.ts             # getAppUser
│   │   ├── events/log-event.ts           # logEvent() — the audit helper
│   │   ├── auth/require-user.ts          # session guard for routes/pages
│   │   ├── mailbox/
│   │   │   ├── provider.ts               # MailboxProvider interface + types
│   │   │   ├── gmail-provider.ts
│   │   │   ├── outlook-provider.ts
│   │   │   └── registry.ts               # provider(provider) → MailboxProvider
│   │   └── qstash/
│   │       ├── client.ts                 # QStash publish/schedule
│   │       └── verify.ts                 # Receiver signature verification
│   └── types/
│       ├── database.ts                   # supabase-generated types
│       └── domain.ts                     # branded IDs + shared domain types
```

---

## A note on TDD for infrastructure tasks

Pure "write a failing test first" fits code units (env schema, `AppError`, `logEvent`, providers, QStash verify). Some P0 work is infrastructure (create a Supabase project, apply a migration, register an OAuth app) where the "test" is a **verification command** with expected output, not a Vitest assertion. Those steps are marked **Verify:** and still gate the task. External account creation (Supabase, Google Cloud, Azure, Upstash) is done once by a human and is marked **Manual setup:** — the plan gives the exact console clicks and the env var each produces.

---

### Task 1: Repo scaffold, tooling, and error primitive

**Files:**
- Create: `package.json`, `tsconfig.json`, `next.config.ts`, `vitest.config.ts`, `.gitignore`, `.env.example`
- Create: `src/app/layout.tsx`, `src/app/page.tsx`
- Create: `src/lib/errors/app-error.ts`
- Test: `src/lib/errors/app-error.test.ts`

**Interfaces:**
- Produces: `class AppError extends Error` with constructor `(code: AppErrorCode, message: string, context?: Record<string, unknown>)`, public readonly `code`, `context`; `type AppErrorCode` union; `isAppError(e: unknown): e is AppError`.

- [ ] **Step 1: Scaffold Next.js in the repo root**

Run (accept the create-next-app prompts non-interactively):
```bash
cd /Users/macbookair/AI_B2B
pnpm dlx create-next-app@latest . --ts --app --src-dir --eslint --no-tailwind --import-alias "@/*" --use-pnpm --yes
```
If it refuses because the directory is non-empty, scaffold in a temp dir and copy:
```bash
pnpm dlx create-next-app@latest /tmp/aib2b-scaffold --ts --app --src-dir --eslint --no-tailwind --import-alias "@/*" --use-pnpm --yes
cp -r /tmp/aib2b-scaffold/{package.json,pnpm-lock.yaml,next.config.ts,tsconfig.json,next-env.d.ts,eslint.config.mjs,src,public,.gitignore} /Users/macbookair/AI_B2B/
rm -rf /tmp/aib2b-scaffold
```

- [ ] **Step 2: Enforce strict TypeScript and path alias**

Overwrite `tsconfig.json`:
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "ES2022"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "forceConsistentCasingInFileNames": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }],
    "paths": { "@/*": ["./src/*"] }
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 3: Add Vitest and scripts**

Run:
```bash
pnpm add -D vitest @vitest/coverage-v8
```
Create `vitest.config.ts`:
```ts
import { defineConfig } from 'vitest/config'
import { resolve } from 'node:path'

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    coverage: { provider: 'v8', reporter: ['text', 'html'] },
  },
  resolve: { alias: { '@': resolve(__dirname, 'src') } },
})
```
Merge these into `package.json` `"scripts"`:
```json
{
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "typecheck": "tsc --noEmit",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

- [ ] **Step 4: Write the failing test for `AppError`**

Create `src/lib/errors/app-error.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { AppError, isAppError } from './app-error'

describe('AppError', () => {
  it('should carry code, message, and context when constructed', () => {
    const err = new AppError('VALIDATION_ERROR', 'bad input', { field: 'email' })
    expect(err.code).toBe('VALIDATION_ERROR')
    expect(err.message).toBe('bad input')
    expect(err.context).toEqual({ field: 'email' })
    expect(err.name).toBe('AppError')
    expect(err).toBeInstanceOf(Error)
  })

  it('should default context to an empty object when omitted', () => {
    const err = new AppError('NOT_FOUND', 'missing')
    expect(err.context).toEqual({})
  })

  it('should identify AppError instances when isAppError is called', () => {
    expect(isAppError(new AppError('UNAUTHORIZED', 'no'))).toBe(true)
    expect(isAppError(new Error('plain'))).toBe(false)
    expect(isAppError('string')).toBe(false)
  })
})
```

- [ ] **Step 5: Run the test to verify it fails**

Run: `pnpm test src/lib/errors/app-error.test.ts`
Expected: FAIL — `Cannot find module './app-error'`.

- [ ] **Step 6: Implement `AppError`**

Create `src/lib/errors/app-error.ts`:
```ts
export type AppErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'EXTERNAL_TIMEOUT'
  | 'EXTERNAL_ERROR'
  | 'DB_ERROR'
  | 'CONFIG_ERROR'
  | 'INVARIANT_VIOLATION'

export class AppError extends Error {
  public readonly code: AppErrorCode
  public readonly context: Record<string, unknown>

  constructor(code: AppErrorCode, message: string, context: Record<string, unknown> = {}) {
    super(message)
    this.name = 'AppError'
    this.code = code
    this.context = context
    Object.setPrototypeOf(this, AppError.prototype)
  }
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError
}
```

- [ ] **Step 7: Replace the boilerplate root layout and page**

Overwrite `src/app/layout.tsx`:
```tsx
import type { Metadata } from 'next'
import type { ReactNode } from 'react'

export const metadata: Metadata = {
  title: 'AI B2B',
  description: 'AI B2B lead generation & outreach',
}

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  )
}
```
Overwrite `src/app/page.tsx`:
```tsx
import { redirect } from 'next/navigation'

export default function HomePage() {
  redirect('/settings')
}
```
Delete any leftover CSS-module imports create-next-app added (`src/app/page.module.css`, `globals.css` import if it references removed styles):
```bash
rm -f src/app/page.module.css
```

- [ ] **Step 8: Verify the toolchain is green**

Run: `pnpm test && pnpm typecheck`
Expected: tests PASS (3 passing); `tsc` exits 0 with no output.

- [ ] **Step 9: Commit**

```bash
git init -q 2>/dev/null; git add -A
git commit -m "chore: scaffold Next.js app with strict TS, Vitest, and AppError"
```

---

### Task 2: Environment / secrets module

Implements roadmap P0 item "Secrets management … in place." All secrets are declared once, validated with Zod at import, and read only through this module. Missing/blank required vars fail fast per QUALITY "validate config at startup."

**Files:**
- Create: `src/lib/env.ts`
- Create: `.env.example`
- Test: `src/lib/env.test.ts`

**Interfaces:**
- Produces: `env` — a frozen validated object; and `loadEnv(source: Record<string, string | undefined>): Env` (pure, used by tests). Keys: `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `SUPABASE_SERVICE_ROLE_KEY`, `APP_URL`, `GOOGLE_OAUTH_CLIENT_ID`, `GOOGLE_OAUTH_CLIENT_SECRET`, `MICROSOFT_OAUTH_CLIENT_ID`, `MICROSOFT_OAUTH_CLIENT_SECRET`, `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY`, `BRIGHTDATA_API_KEY`, `GEMINI_API_KEY`, `EMAILABLE_API_KEY`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/env.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { loadEnv } from './env'

const complete: Record<string, string> = {
  NEXT_PUBLIC_SUPABASE_URL: 'https://abc.supabase.co',
  NEXT_PUBLIC_SUPABASE_ANON_KEY: 'anon-key',
  SUPABASE_SERVICE_ROLE_KEY: 'service-key',
  APP_URL: 'http://localhost:3000',
  GOOGLE_OAUTH_CLIENT_ID: 'gid',
  GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
  MICROSOFT_OAUTH_CLIENT_ID: 'mid',
  MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
  QSTASH_TOKEN: 'qtoken',
  QSTASH_CURRENT_SIGNING_KEY: 'sig1',
  QSTASH_NEXT_SIGNING_KEY: 'sig2',
  BRIGHTDATA_API_KEY: 'bd',
  GEMINI_API_KEY: 'gem',
  EMAILABLE_API_KEY: 'em',
}

describe('loadEnv', () => {
  it('should return a typed env object when all vars are present', () => {
    const env = loadEnv(complete)
    expect(env.NEXT_PUBLIC_SUPABASE_URL).toBe('https://abc.supabase.co')
    expect(env.APP_URL).toBe('http://localhost:3000')
  })

  it('should throw CONFIG_ERROR when a required var is missing', () => {
    const { QSTASH_TOKEN: _omit, ...partial } = complete
    expect(() => loadEnv(partial)).toThrowError(/QSTASH_TOKEN/)
  })

  it('should throw CONFIG_ERROR when APP_URL is not a valid url', () => {
    expect(() => loadEnv({ ...complete, APP_URL: 'not-a-url' })).toThrowError(/APP_URL/)
  })

  it('should reject blank strings for required vars', () => {
    expect(() => loadEnv({ ...complete, GEMINI_API_KEY: '' })).toThrowError(/GEMINI_API_KEY/)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/env.test.ts`
Expected: FAIL — `Cannot find module './env'`.

- [ ] **Step 3: Implement the env module**

Create `src/lib/env.ts`:
```ts
import { z } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const nonEmpty = z.string().min(1)

const envSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: z.string().url(),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: nonEmpty,
  SUPABASE_SERVICE_ROLE_KEY: nonEmpty,
  APP_URL: z.string().url(),
  GOOGLE_OAUTH_CLIENT_ID: nonEmpty,
  GOOGLE_OAUTH_CLIENT_SECRET: nonEmpty,
  MICROSOFT_OAUTH_CLIENT_ID: nonEmpty,
  MICROSOFT_OAUTH_CLIENT_SECRET: nonEmpty,
  QSTASH_TOKEN: nonEmpty,
  QSTASH_CURRENT_SIGNING_KEY: nonEmpty,
  QSTASH_NEXT_SIGNING_KEY: nonEmpty,
  BRIGHTDATA_API_KEY: nonEmpty,
  GEMINI_API_KEY: nonEmpty,
  EMAILABLE_API_KEY: nonEmpty,
})

export type Env = z.infer<typeof envSchema>

export function loadEnv(source: Record<string, string | undefined>): Env {
  const parsed = envSchema.safeParse(source)
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
    throw new AppError('CONFIG_ERROR', `Invalid environment configuration: ${issues}`, {
      issues: parsed.error.flatten().fieldErrors,
    })
  }
  return parsed.data
}

export const env: Env = loadEnv(process.env)
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/env.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Write `.env.example` and gitignore real secrets**

Create `.env.example`:
```bash
# Supabase
NEXT_PUBLIC_SUPABASE_URL=
NEXT_PUBLIC_SUPABASE_ANON_KEY=
SUPABASE_SERVICE_ROLE_KEY=
# App
APP_URL=http://localhost:3000
# Google OAuth (Gmail API)
GOOGLE_OAUTH_CLIENT_ID=
GOOGLE_OAUTH_CLIENT_SECRET=
# Microsoft OAuth (MS Graph)
MICROSOFT_OAUTH_CLIENT_ID=
MICROSOFT_OAUTH_CLIENT_SECRET=
# QStash
QSTASH_TOKEN=
QSTASH_CURRENT_SIGNING_KEY=
QSTASH_NEXT_SIGNING_KEY=
# Pipeline providers (declared now, used in later phases)
BRIGHTDATA_API_KEY=
GEMINI_API_KEY=
EMAILABLE_API_KEY=
```
Confirm `.env*.local` and `.env` are gitignored (create-next-app adds `.env*`); if not, append to `.gitignore`:
```bash
grep -q '^.env\*.local' .gitignore || printf '\n.env*.local\n' >> .gitignore
```

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add Zod-validated env module and .env.example"
```

---

### Task 3: Supabase local project + initial schema migration + generated types

Implements roadmap P0 "Supabase project: Postgres schema for all tables in `architecture.md §5`." Adds one table **not** in §5 — `app_users` — because RLS needs to map an authenticated user to a `client_id` and role. This is documented inline as a deliberate addition.

**Manual setup (human, once):** Create a Supabase project at https://supabase.com/dashboard → New project. From Project Settings → API copy `Project URL` → `NEXT_PUBLIC_SUPABASE_URL`, `anon public` → `NEXT_PUBLIC_SUPABASE_ANON_KEY`, `service_role` → `SUPABASE_SERVICE_ROLE_KEY` into `.env.local`. (Local dev uses the Supabase CLI below; the hosted project is the deploy target.)

**Files:**
- Create: `supabase/config.toml` (via CLI)
- Create: `supabase/migrations/0001_initial_schema.sql`
- Create: `src/types/database.ts` (generated)

**Interfaces:**
- Produces: Postgres tables `clients, campaigns, leads, cases, case_knowledge, emails, sequences, knowledge_requests, mailboxes, suppressions, events, app_users`; enum types listed below; generated `Database` type exported from `src/types/database.ts`.

- [ ] **Step 1: Initialize and start local Supabase**

Run:
```bash
pnpm add -D supabase
pnpm exec supabase init
pnpm exec supabase start
```
**Verify:** the command prints local `API URL` (http://127.0.0.1:54321), `anon key`, and `service_role key`. Put these three into `.env.local` for local runs.

- [ ] **Step 2: Write the initial schema migration**

Create `supabase/migrations/0001_initial_schema.sql`:
```sql
-- Extensions
create extension if not exists "pgcrypto";

-- ---------- Enums ----------
create type user_role            as enum ('operator', 'client');
create type client_status        as enum ('active', 'paused', 'archived');
create type campaign_status      as enum ('active', 'paused', 'archived');
create type reply_mode           as enum ('auto_send', 'human_approve', 'hybrid');
create type price_handoff_mode   as enum ('book_call_and_notify', 'notify_only', 'configurable');
create type lead_email_status    as enum ('unverified', 'verified', 'invalid', 'risky', 'not_found');
create type lead_status          as enum ('new', 'parked', 'active');
create type case_status          as enum ('new', 'researching', 'ready', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead');
create type knowledge_kind       as enum ('company', 'person', 'news', 'pain_point', 'answer');
create type email_direction      as enum ('outbound', 'inbound');
create type email_status         as enum ('draft', 'queued', 'sent', 'delivered', 'bounced', 'failed');
create type sequence_state       as enum ('active', 'paused', 'stopped', 'completed');
create type knowledge_req_status as enum ('open', 'answered', 'dismissed');
create type mailbox_provider     as enum ('gmail', 'outlook');
create type mailbox_health       as enum ('ok', 'warning', 'blocked');
create type suppression_reason   as enum ('replied', 'bounced', 'manual', 'price_handoff');
create type author_kind          as enum ('agent', 'human');

-- ---------- clients ----------
create table clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  status     client_status not null default 'active',
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- app_users (NOT in architecture §5; added for RLS user->client mapping) ----------
-- operators: role='operator', client_id null  -> span all clients
-- clients:   role='client',   client_id set   -> scoped to one client
create table app_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       user_role not null default 'client',
  client_id  uuid references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint app_users_client_role_ck
    check ((role = 'operator' and client_id is null) or (role = 'client' and client_id is not null))
);

-- ---------- campaigns ----------
create table campaigns (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete cascade,
  name               text not null,
  status             campaign_status not null default 'active',
  icp                jsonb not null default '{}'::jsonb,
  value_prop         text,
  booking_link       text,
  reply_mode         reply_mode not null default 'human_approve',
  price_handoff_mode price_handoff_mode not null default 'book_call_and_notify',
  mailbox_ids        uuid[] not null default '{}',
  daily_target       integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------- cases ----------
create table cases (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  company_name   text not null,
  company_domain text,
  status         case_status not null default 'new',
  summary        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- leads ----------
create table leads (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  case_id           uuid references cases(id) on delete set null,
  full_name         text not null,
  title             text,
  company_name      text,
  company_domain    text,
  linkedin_url      text,
  source            text,
  raw               jsonb not null default '{}'::jsonb,
  email             text,
  email_status      lead_email_status not null default 'unverified',
  email_verified_at timestamptz,
  status            lead_status not null default 'new',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------- case_knowledge (append-only) ----------
create table case_knowledge (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  case_id    uuid not null references cases(id) on delete cascade,
  kind       knowledge_kind not null,
  content    text not null,
  source_url text,
  citation   text,
  created_by author_kind not null default 'agent',
  created_at timestamptz not null default now()
);

-- ---------- emails ----------
create table emails (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete cascade,
  case_id             uuid references cases(id) on delete set null,
  lead_id             uuid references leads(id) on delete set null,
  thread_id           text,
  provider_message_id text,
  direction           email_direction not null,
  subject             text,
  body                text,
  status              email_status not null default 'draft',
  sequence_step       integer,
  mailbox_id          uuid,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

-- ---------- sequences ----------
create table sequences (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  case_id          uuid not null references cases(id) on delete cascade,
  lead_id          uuid not null references leads(id) on delete cascade,
  state            sequence_state not null default 'active',
  current_step     integer not null default 0,
  next_action_at   timestamptz,
  qstash_message_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- knowledge_requests ----------
create table knowledge_requests (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  case_id      uuid not null references cases(id) on delete cascade,
  lead_id      uuid references leads(id) on delete set null,
  email_id     uuid references emails(id) on delete set null,
  question     text not null,
  status       knowledge_req_status not null default 'open',
  human_answer text,
  answered_by  uuid references auth.users(id) on delete set null,
  answered_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------- mailboxes ----------
create table mailboxes (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  provider      mailbox_provider not null,
  email_address text not null,
  display_name  text,
  oauth         jsonb not null default '{}'::jsonb,
  daily_cap     integer not null default 20,
  sent_today    integer not null default 0,
  warmup_state  jsonb not null default '{}'::jsonb,
  health        mailbox_health not null default 'ok',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id, email_address)
);

-- ---------- suppressions ----------
create table suppressions (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  email      text not null,
  reason     suppression_reason not null,
  created_at timestamptz not null default now(),
  unique (client_id, email)
);

-- ---------- events (audit log) ----------
create table events (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references clients(id) on delete cascade,
  case_id    uuid references cases(id) on delete set null,
  actor      text not null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Indexes on WHERE-hot columns (QUALITY: index every hot-path filter) ----------
create index idx_campaigns_client         on campaigns(client_id);
create index idx_cases_client             on cases(client_id);
create index idx_cases_campaign           on cases(campaign_id);
create index idx_leads_client             on leads(client_id);
create index idx_leads_campaign           on leads(campaign_id);
create index idx_leads_case               on leads(case_id);
create index idx_case_knowledge_case      on case_knowledge(case_id);
create index idx_emails_client            on emails(client_id);
create index idx_emails_case              on emails(case_id);
create index idx_emails_thread            on emails(thread_id);
create index idx_sequences_client         on sequences(client_id);
create index idx_knowledge_requests_case  on knowledge_requests(case_id);
create index idx_mailboxes_client         on mailboxes(client_id);
create index idx_suppressions_client      on suppressions(client_id);
create index idx_events_client            on events(client_id);
create index idx_app_users_client         on app_users(client_id);
```

- [ ] **Step 3: Apply the migration locally**

Run: `pnpm exec supabase migration up`
**Verify:** run
```bash
pnpm exec supabase db diff --schema public
```
Expected: reports **no schema difference** (migration fully applied). Then confirm the table count:
```bash
psql "$(pnpm exec supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -c "select count(*) from information_schema.tables where table_schema='public';"
```
Expected: `12`.

- [ ] **Step 4: Generate TypeScript types**

Run:
```bash
pnpm exec supabase gen types typescript --local > src/types/database.ts
```
**Verify:** `src/types/database.ts` exists and exports `Database`; `grep -c "Tables:" src/types/database.ts` returns ≥ 1, and `grep -q "app_users" src/types/database.ts` succeeds.

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0 (generated types compile under strict mode).

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add initial Supabase schema (architecture §5 + app_users) and generated types"
```

---

### Task 4: RLS helper functions + policies + isolation integration test

Implements roadmap P0 "Supabase Auth + Row-Level Security policies (per-`client_id` isolation; operator role spans clients)." Server-side pipeline code uses the service-role key (bypasses RLS); RLS protects everything the anon/authenticated key reads.

**Files:**
- Create: `supabase/migrations/0002_rls_policies.sql`
- Test: `src/lib/supabase/rls.integration.test.ts`

**Interfaces:**
- Consumes: tables from Task 3.
- Produces: SQL functions `is_operator() -> boolean`, `current_client_id() -> uuid`; RLS enabled with SELECT policies (`is_operator() OR client_id = current_client_id()`) and operator-only write policies on every table.

- [ ] **Step 1: Write the RLS migration**

Create `supabase/migrations/0002_rls_policies.sql`:
```sql
-- Helper functions (security definer so they can read app_users under RLS)
create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where id = auth.uid() and role = 'operator');
$$;

create or replace function public.current_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from app_users where id = auth.uid();
$$;

-- Generic pattern:
--   SELECT: operator OR own client
--   WRITE (insert/update/delete): operator only (clients are read-only per architecture §11;
--   pipeline writes use the service-role key which bypasses RLS entirely)

-- clients (keyed by id, not client_id)
alter table clients enable row level security;
create policy clients_select on clients for select using (is_operator() or id = current_client_id());
create policy clients_write  on clients for all using (is_operator()) with check (is_operator());

-- app_users: a user may read their own row; operators read all; only operators write
alter table app_users enable row level security;
create policy app_users_select_self on app_users for select using (is_operator() or id = auth.uid());
create policy app_users_write on app_users for all using (is_operator()) with check (is_operator());

-- Tables carrying client_id — identical shape
do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','cases','leads','case_knowledge','emails',
    'sequences','knowledge_requests','mailboxes','suppressions','events'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy %I on %I for select using (is_operator() or client_id = current_client_id());',
      t || '_select', t);
    execute format(
      'create policy %I on %I for all using (is_operator()) with check (is_operator());',
      t || '_write', t);
  end loop;
end $$;
```

- [ ] **Step 2: Apply and confirm RLS is on**

Run: `pnpm exec supabase migration up`
**Verify:**
```bash
psql "$(pnpm exec supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" -c "select count(*) from pg_tables where schemaname='public' and rowsecurity=false;"
```
Expected: `0` (RLS enabled on every public table).

- [ ] **Step 3: Add the Supabase admin (service-role) client early — needed by the test**

Create `src/lib/supabase/admin.ts`:
```ts
import { createClient, type SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'

// Service-role client. BYPASSES RLS. Server-only. Never import into client components.
export function createAdminClient(): SupabaseClient<Database> {
  return createClient<Database>(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { autoRefreshToken: false, persistSession: false },
  })
}
```
Install the client lib:
```bash
pnpm add @supabase/supabase-js @supabase/ssr
```

- [ ] **Step 4: Write the failing RLS isolation integration test**

Create `src/lib/supabase/rls.integration.test.ts`:
```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'

// Integration test: runs against local `supabase start`. Reads local keys from env.
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

const clientAEmail = `a-${Date.now()}@test.local`
const clientBEmail = `b-${Date.now()}@test.local`
const password = 'test-password-123'

let clientAId = ''
let clientBId = ''

async function makeUser(email: string, clientId: string | null, role: 'operator' | 'client') {
  const { data, error } = await admin.auth.admin.createUser({
    email, password, email_confirm: true,
  })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: insErr } = await admin.from('app_users')
    .insert({ id: data.user.id, role, client_id: clientId })
  if (insErr) throw new Error(`app_users insert failed: ${insErr.message}`)
  return data.user.id
}

beforeAll(async () => {
  const { data: ca } = await admin.from('clients').insert({ name: 'Client A' }).select('id').single()
  const { data: cb } = await admin.from('clients').insert({ name: 'Client B' }).select('id').single()
  clientAId = ca!.id
  clientBId = cb!.id
  await makeUser(clientAEmail, clientAId, 'client')
  await makeUser(clientBEmail, clientBId, 'client')
  await admin.from('campaigns').insert([
    { client_id: clientAId, name: 'A campaign' },
    { client_id: clientBId, name: 'B campaign' },
  ])
}, 30_000)

describe('RLS per-client isolation', () => {
  it('should return only its own campaigns when a client user reads', async () => {
    const asA = createClient<Database>(url, anon, { auth: { persistSession: false } })
    await asA.auth.signInWithPassword({ email: clientAEmail, password })
    const { data, error } = await asA.from('campaigns').select('client_id')
    expect(error).toBeNull()
    expect(data).not.toBeNull()
    expect(data!.every((row) => row.client_id === clientAId)).toBe(true)
    expect(data!.some((row) => row.client_id === clientBId)).toBe(false)
  })

  it('should return zero rows when a client user reads another client via explicit filter', async () => {
    const asA = createClient<Database>(url, anon, { auth: { persistSession: false } })
    await asA.auth.signInWithPassword({ email: clientAEmail, password })
    const { data } = await asA.from('campaigns').select('id').eq('client_id', clientBId)
    expect(data).toEqual([])
  })

  it('should reject a client-user insert (write policy is operator-only)', async () => {
    const asA = createClient<Database>(url, anon, { auth: { persistSession: false } })
    await asA.auth.signInWithPassword({ email: clientAEmail, password })
    const { error } = await asA.from('campaigns').insert({ client_id: clientAId, name: 'hack' })
    expect(error).not.toBeNull()
  })
})
```

- [ ] **Step 5: Run the test to verify it passes**

Ensure local Supabase env is loaded, then run:
```bash
set -a; . ./.env.local; set +a
pnpm test src/lib/supabase/rls.integration.test.ts
```
Expected: PASS (3 passing). If sign-in fails, confirm `.env.local` holds the **local** anon/service keys from `supabase status`.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add RLS helper functions, per-client policies, and isolation integration test"
```

---

### Task 5: Supabase auth clients, session middleware, login page, operator seed

Implements roadmap P0 "Supabase Auth" and the demo's "log in as an operator."

**Files:**
- Create: `src/lib/supabase/server.ts`, `src/lib/supabase/client.ts`, `src/lib/supabase/middleware.ts`
- Create: `src/lib/auth/require-user.ts`
- Create: `src/lib/db/app-users.ts`
- Create: `middleware.ts`
- Create: `src/app/login/page.tsx`, `src/app/api/auth/signout/route.ts`
- Create: `scripts/seed-operator.ts`
- Test: `src/lib/db/app-users.test.ts`

**Interfaces:**
- Consumes: `createAdminClient` (Task 4), `Database`, `env`.
- Produces: `createServerClient()` (async, RLS anon client bound to request cookies), `createBrowserClient()`, `updateSession(request)`, `requireUser()` (returns `{ user, appUser }` or redirects), `getAppUser(supabase, userId)`.

- [ ] **Step 1: Server + browser + middleware Supabase clients**

Create `src/lib/supabase/server.ts`:
```ts
import { createServerClient as createSsrClient } from '@supabase/ssr'
import { cookies } from 'next/headers'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'

export async function createServerClient(): Promise<SupabaseClient<Database>> {
  const cookieStore = await cookies()
  return createSsrClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => cookieStore.getAll(),
        setAll: (toSet) => {
          for (const { name, value, options } of toSet) {
            cookieStore.set(name, value, options)
          }
        },
      },
    },
  )
}
```
Create `src/lib/supabase/client.ts`:
```ts
import { createBrowserClient as createSsrBrowserClient } from '@supabase/ssr'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'

export function createBrowserClient(): SupabaseClient<Database> {
  return createSsrBrowserClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  )
}
```
Create `src/lib/supabase/middleware.ts`:
```ts
import { createServerClient as createSsrClient } from '@supabase/ssr'
import { NextResponse, type NextRequest } from 'next/server'
import type { Database } from '@/types/database'
import { env } from '@/lib/env'

export async function updateSession(request: NextRequest): Promise<NextResponse> {
  let response = NextResponse.next({ request })
  const supabase = createSsrClient<Database>(
    env.NEXT_PUBLIC_SUPABASE_URL,
    env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    {
      cookies: {
        getAll: () => request.cookies.getAll(),
        setAll: (toSet) => {
          for (const { name, value } of toSet) request.cookies.set(name, value)
          response = NextResponse.next({ request })
          for (const { name, value, options } of toSet) response.cookies.set(name, value, options)
        },
      },
    },
  )
  const { data } = await supabase.auth.getUser()
  const isAuthed = data.user !== null
  const { pathname } = request.nextUrl
  const isPublic = pathname.startsWith('/login') || pathname.startsWith('/api/cron')
  if (!isAuthed && !isPublic) {
    const url = request.nextUrl.clone()
    url.pathname = '/login'
    return NextResponse.redirect(url)
  }
  return response
}
```

- [ ] **Step 2: Write the failing test for `getAppUser`**

Create `src/lib/db/app-users.test.ts`:
```ts
import { describe, it, expect, vi } from 'vitest'
import { getAppUser } from './app-users'
import { AppError } from '@/lib/errors/app-error'

function mockSupabase(result: { data: unknown; error: unknown }) {
  return {
    from: () => ({
      select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve(result) }) }),
    }),
  } as never
}

describe('getAppUser', () => {
  it('should return the app user row when found', async () => {
    const row = { id: 'u1', role: 'operator', client_id: null }
    const result = await getAppUser(mockSupabase({ data: row, error: null }), 'u1')
    expect(result).toEqual(row)
  })

  it('should return null when no row exists', async () => {
    const result = await getAppUser(mockSupabase({ data: null, error: null }), 'u1')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR when the query errors', async () => {
    await expect(
      getAppUser(mockSupabase({ data: null, error: { message: 'boom' } }), 'u1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/lib/db/app-users.test.ts`
Expected: FAIL — `Cannot find module './app-users'`.

- [ ] **Step 4: Implement `getAppUser`**

Create `src/lib/db/app-users.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type AppUser = Database['public']['Tables']['app_users']['Row']

export async function getAppUser(
  supabase: SupabaseClient<Database>,
  userId: string,
): Promise<AppUser | null> {
  const { data, error } = await supabase
    .from('app_users')
    .select('*')
    .eq('id', userId)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load app_user', { userId, cause: error.message })
  }
  return data
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/lib/db/app-users.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 6: Implement `requireUser` guard**

Create `src/lib/auth/require-user.ts`:
```ts
import { redirect } from 'next/navigation'
import type { User } from '@supabase/supabase-js'
import { createServerClient } from '@/lib/supabase/server'
import { getAppUser, type AppUser } from '@/lib/db/app-users'

export interface AuthedUser {
  user: User
  appUser: AppUser
}

// For pages/route handlers. Redirects to /login if no session or no app_users row.
export async function requireUser(): Promise<AuthedUser> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')
  const appUser = await getAppUser(supabase, data.user.id)
  if (!appUser) redirect('/login')
  return { user: data.user, appUser }
}
```

- [ ] **Step 7: Root middleware**

Create `middleware.ts` (repo root):
```ts
import { type NextRequest } from 'next/server'
import { updateSession } from '@/lib/supabase/middleware'

export async function middleware(request: NextRequest) {
  return updateSession(request)
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'],
}
```

- [ ] **Step 8: Login page + signout route**

Create `src/app/login/page.tsx`:
```tsx
'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

export default function LoginPage() {
  const router = useRouter()
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    setIsSubmitting(true)
    setError(null)
    const supabase = createBrowserClient()
    const { error: signInError } = await supabase.auth.signInWithPassword({ email, password })
    if (signInError) {
      setError('Invalid email or password.')
      setIsSubmitting(false)
      return
    }
    router.push('/settings')
    router.refresh()
  }

  return (
    <main style={{ maxWidth: 360, margin: '80px auto', fontFamily: 'system-ui' }}>
      <h1>Sign in</h1>
      <form onSubmit={onSubmit}>
        <label>
          Email
          <input type="email" value={email} required
            onChange={(e) => setEmail(e.target.value)} style={{ width: '100%' }} />
        </label>
        <label>
          Password
          <input type="password" value={password} required
            onChange={(e) => setPassword(e.target.value)} style={{ width: '100%' }} />
        </label>
        {error && <p role="alert" style={{ color: 'crimson' }}>{error}</p>}
        <button type="submit" disabled={isSubmitting}>
          {isSubmitting ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </main>
  )
}
```
Create `src/app/api/auth/signout/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'
import { env } from '@/lib/env'

export async function POST() {
  const supabase = await createServerClient()
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login', env.APP_URL), { status: 303 })
}
```

- [ ] **Step 9: Operator seed script**

Create `scripts/seed-operator.ts`:
```ts
import { createClient } from '@supabase/supabase-js'
import type { Database } from '../src/types/database'

// Usage: tsx scripts/seed-operator.ts <email> <password>
async function main() {
  const [email, password] = process.argv.slice(2)
  if (!email || !password) throw new Error('Usage: seed-operator <email> <password>')
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL
  const service = process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!url || !service) throw new Error('Missing Supabase env')
  const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: insErr } = await admin
    .from('app_users')
    .insert({ id: data.user.id, role: 'operator', client_id: null })
  if (insErr) throw new Error(`app_users insert failed: ${insErr.message}`)
  process.stdout.write(`Operator created: ${email} (${data.user.id})\n`)
}

main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```
Add to `package.json` scripts: `"seed:operator": "tsx scripts/seed-operator.ts"` and install tsx:
```bash
pnpm add -D tsx
```

- [ ] **Step 10: Verify login end-to-end**

Run:
```bash
set -a; . ./.env.local; set +a
pnpm seed:operator operator@test.local 'operator-pass-123'
pnpm dev
```
**Verify:** open http://localhost:3000 → redirected to `/login`; sign in with `operator@test.local` / `operator-pass-123` → land on `/settings` (blank for now, no redirect back to login). `pnpm test && pnpm typecheck` both green.

- [ ] **Step 11: Commit**

```bash
git add -A
git commit -m "feat: add Supabase auth clients, session middleware, login, and operator seed"
```

---

### Task 6: events audit-log helper

Implements roadmap P0 "`events` audit-log helper used everywhere." Every later state change calls this.

**Files:**
- Create: `src/lib/db/events.ts`
- Create: `src/lib/events/log-event.ts`
- Test: `src/lib/events/log-event.test.ts`

**Interfaces:**
- Consumes: `createAdminClient` (Task 4), `AppError`.
- Produces: `logEvent(input: LogEventInput): Promise<void>` where `LogEventInput = { clientId: string | null; caseId?: string | null; actor: string; type: string; payload?: Record<string, unknown> }`; and `insertEvent(supabase, row)`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/events/log-event.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const insertMock = vi.fn()
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({ from: () => ({ insert: insertMock }) }),
}))

import { logEvent } from './log-event'
import { AppError } from '@/lib/errors/app-error'

describe('logEvent', () => {
  beforeEach(() => insertMock.mockReset())

  it('should insert an event row with defaults when minimal input is given', async () => {
    insertMock.mockResolvedValue({ error: null })
    await logEvent({ clientId: 'c1', actor: 'system', type: 'mailbox.connected' })
    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1', case_id: null, actor: 'system', type: 'mailbox.connected', payload: {},
    })
  })

  it('should pass caseId and payload through when provided', async () => {
    insertMock.mockResolvedValue({ error: null })
    await logEvent({ clientId: 'c1', caseId: 'case9', actor: 'agent:lead-gen', type: 'lead.found', payload: { n: 3 } })
    expect(insertMock).toHaveBeenCalledWith({
      client_id: 'c1', case_id: 'case9', actor: 'agent:lead-gen', type: 'lead.found', payload: { n: 3 },
    })
  })

  it('should throw DB_ERROR when the insert fails', async () => {
    insertMock.mockResolvedValue({ error: { message: 'nope' } })
    await expect(
      logEvent({ clientId: 'c1', actor: 'system', type: 'x' }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/events/log-event.test.ts`
Expected: FAIL — `Cannot find module './log-event'`.

- [ ] **Step 3: Implement the DB insert and the helper**

Create `src/lib/db/events.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EventInsert = Database['public']['Tables']['events']['Insert']

export async function insertEvent(
  supabase: SupabaseClient<Database>,
  row: EventInsert,
): Promise<void> {
  const { error } = await supabase.from('events').insert(row)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert event', { type: row.type, cause: error.message })
  }
}
```
Create `src/lib/events/log-event.ts`:
```ts
import { createAdminClient } from '@/lib/supabase/admin'
import { insertEvent } from '@/lib/db/events'

export interface LogEventInput {
  clientId: string | null
  caseId?: string | null
  actor: string
  type: string
  payload?: Record<string, unknown>
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
    payload: input.payload ?? {},
  })
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/events/log-event.test.ts`
Expected: PASS (3 passing).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add events audit-log helper (logEvent + insertEvent)"
```

---

### Task 7: QStash client, signature verification, and hello cron

Implements roadmap P0 "QStash configured; a 'hello' cron + signed-request verification proven end-to-end."

**Manual setup (human, once):** Create an Upstash account → QStash. From the QStash console copy `QSTASH_TOKEN`, `QSTASH_CURRENT_SIGNING_KEY`, `QSTASH_NEXT_SIGNING_KEY` into `.env.local`.

**Files:**
- Create: `src/lib/qstash/client.ts`, `src/lib/qstash/verify.ts`
- Create: `src/app/api/cron/hello/route.ts`
- Test: `src/lib/qstash/verify.test.ts`

**Interfaces:**
- Consumes: `env`, `AppError`, `logEvent`.
- Produces: `verifyQstashSignature(request: Request): Promise<string>` (returns raw body, throws `AppError('UNAUTHORIZED')` on bad/missing signature); `scheduleCron(destinationPath, cron)`, `publishJson(destinationPath, body)`.

- [ ] **Step 1: Install QStash SDK**

Run: `pnpm add @upstash/qstash`

- [ ] **Step 2: Write the failing test for signature verification**

Create `src/lib/qstash/verify.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const verifyMock = vi.fn()
vi.mock('@upstash/qstash', () => ({
  Receiver: class {
    verify = verifyMock
  },
}))

import { verifyQstashSignature } from './verify'
import { AppError } from '@/lib/errors/app-error'

function req(body: string, signature: string | null): Request {
  const headers = new Headers()
  if (signature !== null) headers.set('upstash-signature', signature)
  return new Request('http://localhost/api/cron/hello', { method: 'POST', body, headers })
}

describe('verifyQstashSignature', () => {
  beforeEach(() => verifyMock.mockReset())

  it('should return the raw body when the signature is valid', async () => {
    verifyMock.mockResolvedValue(true)
    const body = await verifyQstashSignature(req('{"hi":true}', 'sig'))
    expect(body).toBe('{"hi":true}')
  })

  it('should throw UNAUTHORIZED when the signature header is missing', async () => {
    await expect(verifyQstashSignature(req('{}', null))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })

  it('should throw UNAUTHORIZED when verification returns false', async () => {
    verifyMock.mockResolvedValue(false)
    await expect(verifyQstashSignature(req('{}', 'bad'))).rejects.toBeInstanceOf(AppError)
  })

  it('should throw UNAUTHORIZED when the receiver throws', async () => {
    verifyMock.mockRejectedValue(new Error('sig mismatch'))
    await expect(verifyQstashSignature(req('{}', 'bad'))).rejects.toMatchObject({ code: 'UNAUTHORIZED' })
  })
})
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `pnpm test src/lib/qstash/verify.test.ts`
Expected: FAIL — `Cannot find module './verify'`.

- [ ] **Step 4: Implement verify + client**

Create `src/lib/qstash/verify.ts`:
```ts
import { Receiver } from '@upstash/qstash'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'

const receiver = new Receiver({
  currentSigningKey: env.QSTASH_CURRENT_SIGNING_KEY,
  nextSigningKey: env.QSTASH_NEXT_SIGNING_KEY,
})

// Verifies an inbound QStash request. Returns the raw body (needed because the
// signature is over the exact bytes). Throws UNAUTHORIZED on any failure.
export async function verifyQstashSignature(request: Request): Promise<string> {
  const signature = request.headers.get('upstash-signature')
  if (!signature) {
    throw new AppError('UNAUTHORIZED', 'Missing upstash-signature header')
  }
  const body = await request.text()
  let isValid = false
  try {
    isValid = await receiver.verify({ signature, body })
  } catch (cause) {
    throw new AppError('UNAUTHORIZED', 'QStash signature verification threw', {
      cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
  if (!isValid) {
    throw new AppError('UNAUTHORIZED', 'Invalid QStash signature')
  }
  return body
}
```
Create `src/lib/qstash/client.ts`:
```ts
import { Client } from '@upstash/qstash'
import { env } from '@/lib/env'
import { AppError } from '@/lib/errors/app-error'

const client = new Client({ token: env.QSTASH_TOKEN })

function destination(path: string): string {
  return new URL(path, env.APP_URL).toString()
}

export async function publishJson(path: string, body: Record<string, unknown>): Promise<string> {
  try {
    const res = await client.publishJSON({ url: destination(path), body })
    return res.messageId
  } catch (cause) {
    throw new AppError('EXTERNAL_ERROR', 'QStash publish failed', {
      path, cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}

export async function scheduleCron(path: string, cron: string): Promise<string> {
  try {
    const res = await client.schedules.create({ destination: destination(path), cron })
    return res.scheduleId
  } catch (cause) {
    throw new AppError('EXTERNAL_ERROR', 'QStash schedule create failed', {
      path, cron, cause: cause instanceof Error ? cause.message : String(cause),
    })
  }
}
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `pnpm test src/lib/qstash/verify.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 6: Implement the hello cron route**

Create `src/app/api/cron/hello/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    await logEvent({ clientId: null, actor: 'system', type: 'cron.hello', payload: { at: new Date().toISOString() } })
    return NextResponse.json({ ok: true })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
```

- [ ] **Step 7: Prove it end-to-end against real QStash**

Deploy will happen in Task 10/11; for now prove locally that unsigned requests are rejected:
```bash
set -a; . ./.env.local; set +a
pnpm dev
# in another shell:
curl -s -o /dev/null -w "%{http_code}\n" -X POST http://localhost:3000/api/cron/hello -d '{}'
```
Expected: `401` (missing signature). The **signed** end-to-end proof (a real QStash-delivered request logging a `cron.hello` event) is completed in Task 11 after the app is deployed to a public URL. Note this dependency here; do not mark the roadmap "QStash proven end-to-end" box until Task 11.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add QStash client, signature verification, and hello cron route"
```

---

### Task 8: MailboxProvider interface, HTTP helper, and registry

Establishes the swappable `MailboxProvider` interface (`architecture.md §10`) that Gmail (Task 9) and Outlook (Task 10) implement.

**Files:**
- Create: `src/lib/http/fetch-json.ts`
- Create: `src/lib/mailbox/provider.ts`
- Create: `src/lib/db/mailboxes.ts`
- Test: `src/lib/http/fetch-json.test.ts`
- Test: `src/lib/mailbox/provider.test.ts`

**Interfaces:**
- Consumes: `AppError`, `Database`, `SupabaseClient`.
- Produces:
  - `fetchJson<T>(url, options, schema): Promise<T>` — timeout via `AbortController` (default 8000ms), Zod-parses the JSON body, maps failures to `AppError`.
  - `type MailboxTokens = { accessToken: string; refreshToken: string; expiresAt: string }`
  - `type SendEmailInput = { to: string; subject: string; body: string }`
  - `type SendEmailResult = { providerMessageId: string; threadId: string }`
  - `interface MailboxProvider { readonly provider: 'gmail' | 'outlook'; buildAuthUrl(state: string): string; exchangeCode(code: string): Promise<{ tokens: MailboxTokens; emailAddress: string; displayName: string | null }>; sendEmail(tokens: MailboxTokens, input: SendEmailInput): Promise<{ result: SendEmailResult; tokens: MailboxTokens }> }`
  - DB fns: `insertMailbox`, `getMailboxById`, `updateMailboxOauth`.

- [ ] **Step 1: Write the failing test for `fetchJson`**

Create `src/lib/http/fetch-json.test.ts`:
```ts
import { describe, it, expect, vi, afterEach } from 'vitest'
import { z } from 'zod'
import { fetchJson } from './fetch-json'

const schema = z.object({ id: z.string() })

afterEach(() => vi.restoreAllMocks())

describe('fetchJson', () => {
  it('should return parsed data when the response is ok and valid', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: 'x' }), { status: 200 }),
    ))
    const data = await fetchJson('http://x', { method: 'GET' }, schema)
    expect(data).toEqual({ id: 'x' })
  })

  it('should throw EXTERNAL_ERROR when the status is not ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response('nope', { status: 500 }),
    ))
    await expect(fetchJson('http://x', { method: 'GET' }, schema)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_ERROR when the body fails schema validation', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ wrong: 1 }), { status: 200 }),
    ))
    await expect(fetchJson('http://x', { method: 'GET' }, schema)).rejects.toMatchObject({ code: 'EXTERNAL_ERROR' })
  })

  it('should throw EXTERNAL_TIMEOUT when the request aborts', async () => {
    vi.stubGlobal('fetch', vi.fn().mockImplementation((_url, opts: RequestInit) => {
      return new Promise((_resolve, reject) => {
        const signal = opts.signal as AbortSignal
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
      })
    }))
    await expect(fetchJson('http://x', { method: 'GET' }, schema, 10)).rejects.toMatchObject({ code: 'EXTERNAL_TIMEOUT' })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/http/fetch-json.test.ts`
Expected: FAIL — `Cannot find module './fetch-json'`.

- [ ] **Step 3: Implement `fetchJson`**

Create `src/lib/http/fetch-json.ts`:
```ts
import type { ZodType } from 'zod'
import { AppError } from '@/lib/errors/app-error'

const DEFAULT_TIMEOUT_MS = 8000

export async function fetchJson<T>(
  url: string,
  options: RequestInit,
  schema: ZodType<T>,
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  let response: Response
  try {
    response = await fetch(url, { ...options, signal: controller.signal })
  } catch (cause) {
    const isAbort = cause instanceof DOMException && cause.name === 'AbortError'
    throw new AppError(isAbort ? 'EXTERNAL_TIMEOUT' : 'EXTERNAL_ERROR', 'HTTP request failed', {
      url, cause: cause instanceof Error ? cause.message : String(cause),
    })
  } finally {
    clearTimeout(timer)
  }
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    throw new AppError('EXTERNAL_ERROR', `HTTP ${response.status}`, { url, status: response.status, body: text.slice(0, 500) })
  }
  const json: unknown = await response.json().catch(() => undefined)
  const parsed = schema.safeParse(json)
  if (!parsed.success) {
    throw new AppError('EXTERNAL_ERROR', 'Unexpected response shape', { url, issues: parsed.error.flatten() })
  }
  return parsed.data
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/http/fetch-json.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Define the MailboxProvider interface and a validity test**

Create `src/lib/mailbox/provider.ts`:
```ts
export interface MailboxTokens {
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO timestamp
}

export interface SendEmailInput {
  to: string
  subject: string
  body: string
}

export interface SendEmailResult {
  providerMessageId: string
  threadId: string
}

export interface ExchangeResult {
  tokens: MailboxTokens
  emailAddress: string
  displayName: string | null
}

export interface MailboxProvider {
  readonly provider: 'gmail' | 'outlook'
  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<ExchangeResult>
  // Returns the send result plus (possibly refreshed) tokens to persist.
  sendEmail(
    tokens: MailboxTokens,
    input: SendEmailInput,
  ): Promise<{ result: SendEmailResult; tokens: MailboxTokens }>
}
```
Create `src/lib/mailbox/provider.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import type { MailboxProvider } from './provider'

// A compile-and-shape guard: a conforming object satisfies the interface.
describe('MailboxProvider contract', () => {
  it('should accept a conforming implementation shape', () => {
    const fake: MailboxProvider = {
      provider: 'gmail',
      buildAuthUrl: (state) => `https://auth?state=${state}`,
      exchangeCode: async () => ({
        tokens: { accessToken: 'a', refreshToken: 'r', expiresAt: '2026-01-01T00:00:00Z' },
        emailAddress: 'x@y.com',
        displayName: null,
      }),
      sendEmail: async (tokens) => ({
        result: { providerMessageId: 'm', threadId: 't' },
        tokens,
      }),
    }
    expect(fake.provider).toBe('gmail')
    expect(fake.buildAuthUrl('s')).toContain('state=s')
  })
})
```

- [ ] **Step 6: Implement mailbox DB access**

Create `src/lib/db/mailboxes.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type MailboxRow = Database['public']['Tables']['mailboxes']['Row']
export type MailboxInsert = Database['public']['Tables']['mailboxes']['Insert']

export async function insertMailbox(
  supabase: SupabaseClient<Database>,
  row: MailboxInsert,
): Promise<MailboxRow> {
  const { data, error } = await supabase.from('mailboxes').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert mailbox', { cause: error?.message })
  }
  return data
}

export async function getMailboxById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<MailboxRow | null> {
  const { data, error } = await supabase.from('mailboxes').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load mailbox', { id, cause: error.message })
  return data
}

export async function updateMailboxOauth(
  supabase: SupabaseClient<Database>,
  id: string,
  oauth: Record<string, unknown>,
): Promise<void> {
  const { error } = await supabase.from('mailboxes').update({ oauth }).eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox oauth', { id, cause: error.message })
}
```

- [ ] **Step 7: Run the mailbox unit tests**

Run: `pnpm test src/lib/mailbox/provider.test.ts && pnpm typecheck`
Expected: PASS (1 passing); typecheck exits 0.

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "feat: add fetchJson helper, MailboxProvider interface, and mailbox DB access"
```

---

### Task 9: Gmail provider (OAuth + send)

Implements the Gmail half of roadmap P0 "connect a Gmail account (Gmail API) … send a test email."

**Manual setup (human, once):** Google Cloud Console → create/select a project → enable the **Gmail API** → OAuth consent screen (External, add your test user) → Credentials → OAuth client ID (Web application) → Authorized redirect URI `http://localhost:3000/api/mailboxes/google/callback` (and the deployed equivalent later). Copy client id/secret into `GOOGLE_OAUTH_CLIENT_ID` / `GOOGLE_OAUTH_CLIENT_SECRET`.

**Files:**
- Create: `src/lib/mailbox/gmail-provider.ts`
- Test: `src/lib/mailbox/gmail-provider.test.ts`

**Interfaces:**
- Consumes: `fetchJson`, `env`, `MailboxProvider` types, `AppError`.
- Produces: `gmailProvider: MailboxProvider` (const object). Scopes: `https://www.googleapis.com/auth/gmail.send` + `.../userinfo.email` + `.../userinfo.profile`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/mailbox/gmail-provider.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchJsonMock = vi.fn()
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: fetchJsonMock }))
vi.mock('@/lib/env', () => ({
  env: {
    GOOGLE_OAUTH_CLIENT_ID: 'gid',
    GOOGLE_OAUTH_CLIENT_SECRET: 'gsecret',
    APP_URL: 'http://localhost:3000',
  },
}))

import { gmailProvider } from './gmail-provider'

describe('gmailProvider', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  it('should build an auth url with the send scope and state', () => {
    const url = gmailProvider.buildAuthUrl('state123')
    expect(url).toContain('accounts.google.com')
    expect(url).toContain('state=state123')
    expect(decodeURIComponent(url)).toContain('gmail.send')
    expect(decodeURIComponent(url)).toContain('access_type=offline')
  })

  it('should exchange a code into tokens and profile', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      .mockResolvedValueOnce({ email: 'me@gmail.com', name: 'Me' })
    const result = await gmailProvider.exchangeCode('code1')
    expect(result.emailAddress).toBe('me@gmail.com')
    expect(result.displayName).toBe('Me')
    expect(result.tokens.accessToken).toBe('at')
    expect(result.tokens.refreshToken).toBe('rt')
    expect(new Date(result.tokens.expiresAt).getTime()).toBeGreaterThan(Date.now())
  })

  it('should send an email and return provider + thread ids', async () => {
    fetchJsonMock.mockResolvedValueOnce({ id: 'msg1', threadId: 'thr1' })
    const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const { result } = await gmailProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'Hi', body: 'Body' })
    expect(result).toEqual({ providerMessageId: 'msg1', threadId: 'thr1' })
  })

  it('should refresh the token before sending when expired', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ access_token: 'new-at', expires_in: 3600 }) // refresh
      .mockResolvedValueOnce({ id: 'msg2', threadId: 'thr2' })             // send
    const expired = { accessToken: 'old', refreshToken: 'rt', expiresAt: new Date(Date.now() - 1000).toISOString() }
    const { result, tokens } = await gmailProvider.sendEmail(expired, { to: 'x@y.com', subject: 'S', body: 'B' })
    expect(tokens.accessToken).toBe('new-at')
    expect(result.providerMessageId).toBe('msg2')
    expect(fetchJsonMock).toHaveBeenCalledTimes(2)
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `pnpm test src/lib/mailbox/gmail-provider.test.ts`
Expected: FAIL — `Cannot find module './gmail-provider'`.

- [ ] **Step 3: Implement the Gmail provider**

Create `src/lib/mailbox/gmail-provider.ts`:
```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `pnpm test src/lib/mailbox/gmail-provider.test.ts`
Expected: PASS (4 passing).

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add Gmail MailboxProvider (OAuth exchange, token refresh, send)"
```

---

### Task 10: Outlook provider + registry + OAuth routes + /settings demo (send test email, log event)

Implements the Outlook half plus the **full P0 demo**: connect Gmail + Outlook, store tokens in `mailboxes`, send a test email from each, see the event logged.

**Manual setup (human, once):** Azure Portal → App registrations → New registration (single tenant or "personal + work" per account type) → Redirect URI (Web) `http://localhost:3000/api/mailboxes/outlook/callback` → API permissions → Microsoft Graph delegated: `Mail.Send`, `User.Read`, `offline_access` → Certificates & secrets → new client secret. Copy app (client) id/secret into `MICROSOFT_OAUTH_CLIENT_ID` / `MICROSOFT_OAUTH_CLIENT_SECRET`.

**Files:**
- Create: `src/lib/mailbox/outlook-provider.ts`, `src/lib/mailbox/registry.ts`
- Create: `src/app/api/mailboxes/google/connect/route.ts`, `.../google/callback/route.ts`
- Create: `src/app/api/mailboxes/outlook/connect/route.ts`, `.../outlook/callback/route.ts`
- Create: `src/app/api/mailboxes/[id]/test-email/route.ts`
- Create: `src/app/settings/page.tsx`, `src/app/settings/connect-buttons.tsx`, `src/app/settings/mailbox-row.tsx`
- Create: `src/lib/db/clients.ts` (get-or-create demo client for the operator)
- Test: `src/lib/mailbox/outlook-provider.test.ts`, `src/lib/mailbox/registry.test.ts`

**Interfaces:**
- Consumes: `gmailProvider`, `fetchJson`, `env`, `requireUser`, `createAdminClient`, `insertMailbox`, `getMailboxById`, `updateMailboxOauth`, `logEvent`, `MailboxProvider`.
- Produces: `outlookProvider: MailboxProvider`; `getMailboxProvider(provider): MailboxProvider`; `getOrCreateOperatorClient(supabase): Promise<string>`.

- [ ] **Step 1: Write failing tests for Outlook provider and registry**

Create `src/lib/mailbox/outlook-provider.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchJsonMock = vi.fn()
vi.mock('@/lib/http/fetch-json', () => ({ fetchJson: fetchJsonMock }))
vi.mock('@/lib/env', () => ({
  env: {
    MICROSOFT_OAUTH_CLIENT_ID: 'mid',
    MICROSOFT_OAUTH_CLIENT_SECRET: 'msecret',
    APP_URL: 'http://localhost:3000',
  },
}))

import { outlookProvider } from './outlook-provider'

describe('outlookProvider', () => {
  beforeEach(() => fetchJsonMock.mockReset())

  it('should build an auth url with Mail.Send and offline_access', () => {
    const url = outlookProvider.buildAuthUrl('st')
    expect(url).toContain('login.microsoftonline.com')
    expect(url).toContain('state=st')
    expect(decodeURIComponent(url)).toContain('Mail.Send')
    expect(decodeURIComponent(url)).toContain('offline_access')
  })

  it('should exchange a code into tokens and profile', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      .mockResolvedValueOnce({ mail: 'me@outlook.com', displayName: 'Me O' })
    const result = await outlookProvider.exchangeCode('c')
    expect(result.emailAddress).toBe('me@outlook.com')
    expect(result.displayName).toBe('Me O')
    expect(result.tokens.refreshToken).toBe('rt')
  })

  it('should fall back to userPrincipalName when mail is null', async () => {
    fetchJsonMock
      .mockResolvedValueOnce({ access_token: 'at', refresh_token: 'rt', expires_in: 3600 })
      .mockResolvedValueOnce({ mail: null, userPrincipalName: 'me@corp.com', displayName: null })
    const result = await outlookProvider.exchangeCode('c')
    expect(result.emailAddress).toBe('me@corp.com')
  })

  it('should send mail and synthesize ids (Graph sendMail returns 202 no body)', async () => {
    fetchJsonMock.mockResolvedValueOnce({}) // sendMail: empty/accepted
    const tokens = { accessToken: 'at', refreshToken: 'rt', expiresAt: new Date(Date.now() + 60_000).toISOString() }
    const { result } = await outlookProvider.sendEmail(tokens, { to: 'x@y.com', subject: 'S', body: 'B' })
    expect(result.providerMessageId).toMatch(/^outlook-/)
    expect(result.threadId).toMatch(/^outlook-/)
  })
})
```
Create `src/lib/mailbox/registry.test.ts`:
```ts
import { describe, it, expect } from 'vitest'
import { getMailboxProvider } from './registry'

describe('getMailboxProvider', () => {
  it('should return the gmail provider when asked for gmail', () => {
    expect(getMailboxProvider('gmail').provider).toBe('gmail')
  })
  it('should return the outlook provider when asked for outlook', () => {
    expect(getMailboxProvider('outlook').provider).toBe('outlook')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `pnpm test src/lib/mailbox/outlook-provider.test.ts src/lib/mailbox/registry.test.ts`
Expected: FAIL — modules not found.

- [ ] **Step 3: Implement the Outlook provider**

Create `src/lib/mailbox/outlook-provider.ts`:
```ts
import { z } from 'zod'
import { randomUUID } from 'node:crypto'
import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { AppError } from '@/lib/errors/app-error'
import type { ExchangeResult, MailboxProvider, MailboxTokens, SendEmailInput } from './provider'

const REDIRECT_PATH = '/api/mailboxes/outlook/callback'
const AUTH_BASE = 'https://login.microsoftonline.com/common/oauth2/v2.0'
const SCOPES = ['https://graph.microsoft.com/Mail.Send', 'https://graph.microsoft.com/User.Read', 'offline_access'].join(' ')

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

async function refreshAccessToken(tokens: MailboxTokens): Promise<MailboxTokens> {
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
    accessToken: res.access_token,
    refreshToken: res.refresh_token ?? tokens.refreshToken,
    expiresAt: expiresAtFrom(res.expires_in),
  }
}

async function ensureFresh(tokens: MailboxTokens): Promise<MailboxTokens> {
  const isExpired = new Date(tokens.expiresAt).getTime() <= Date.now() + 30_000
  return isExpired ? refreshAccessToken(tokens) : tokens
}

export const outlookProvider: MailboxProvider = {
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
      tokens: { accessToken: token.access_token, refreshToken: token.refresh_token, expiresAt: expiresAtFrom(token.expires_in) },
      emailAddress,
      displayName: profile.displayName ?? null,
    }
  },

  async sendEmail(tokens: MailboxTokens, input: SendEmailInput) {
    const fresh = await ensureFresh(tokens)
    await fetchJson(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${fresh.accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: {
            subject: input.subject,
            body: { contentType: 'Text', content: input.body },
            toRecipients: [{ emailAddress: { address: input.to } }],
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
}
```

- [ ] **Step 4: Implement the registry**

Create `src/lib/mailbox/registry.ts`:
```ts
import type { Database } from '@/types/database'
import type { MailboxProvider } from './provider'
import { gmailProvider } from './gmail-provider'
import { outlookProvider } from './outlook-provider'

type ProviderName = Database['public']['Enums']['mailbox_provider']

export function getMailboxProvider(provider: ProviderName): MailboxProvider {
  switch (provider) {
    case 'gmail':
      return gmailProvider
    case 'outlook':
      return outlookProvider
    default: {
      const exhaustive: never = provider
      throw new Error(`Unknown mailbox provider: ${String(exhaustive)}`)
    }
  }
}
```

- [ ] **Step 5: Run the provider + registry tests**

Run: `pnpm test src/lib/mailbox/outlook-provider.test.ts src/lib/mailbox/registry.test.ts`
Expected: PASS (4 + 2 = 6 passing).

- [ ] **Step 6: Add the demo client helper**

Because P0 has no campaign UI yet, the demo needs a `client_id` to attach mailboxes to. Create `src/lib/db/clients.ts`:
```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

const DEMO_CLIENT_NAME = 'Demo Client'

// P0 has no campaign/client UI. The operator demo attaches mailboxes to a single
// stable "Demo Client". Idempotent: returns the existing row's id or creates it.
export async function getOrCreateOperatorClient(
  supabase: SupabaseClient<Database>,
): Promise<string> {
  const { data: existing, error: selErr } = await supabase
    .from('clients').select('id').eq('name', DEMO_CLIENT_NAME).maybeSingle()
  if (selErr) throw new AppError('DB_ERROR', 'Failed to look up demo client', { cause: selErr.message })
  if (existing) return existing.id

  const { data: created, error: insErr } = await supabase
    .from('clients').insert({ name: DEMO_CLIENT_NAME }).select('id').single()
  if (insErr || !created) throw new AppError('DB_ERROR', 'Failed to create demo client', { cause: insErr?.message })
  return created.id
}
```

- [ ] **Step 7: Implement the OAuth connect routes**

Create `src/app/api/mailboxes/google/connect/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { gmailProvider } from '@/lib/mailbox/gmail-provider'

export const runtime = 'nodejs'

export async function GET() {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  // state carries the initiating user id; validated on callback via session.
  return NextResponse.redirect(gmailProvider.buildAuthUrl(appUser.id))
}
```
Create `src/app/api/mailboxes/outlook/connect/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { outlookProvider } from '@/lib/mailbox/outlook-provider'

export const runtime = 'nodejs'

export async function GET() {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }
  return NextResponse.redirect(outlookProvider.buildAuthUrl(appUser.id))
}
```

- [ ] **Step 8: Implement the OAuth callback routes**

Create `src/app/api/mailboxes/google/callback/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { gmailProvider } from '@/lib/mailbox/gmail-provider'
import { insertMailbox } from '@/lib/db/mailboxes'
import { getOrCreateOperatorClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || state !== appUser.id) {
    return NextResponse.redirect(new URL('/settings?error=oauth', env.APP_URL))
  }
  try {
    const exchange = await gmailProvider.exchangeCode(code)
    const admin = createAdminClient()
    const clientId = await getOrCreateOperatorClient(admin)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'gmail',
      email_address: exchange.emailAddress,
      display_name: exchange.displayName,
      oauth: { ...exchange.tokens },
    })
    await logEvent({
      clientId, actor: `human:${appUser.id}`, type: 'mailbox.connected',
      payload: { mailboxId: mailbox.id, provider: 'gmail', emailAddress: exchange.emailAddress },
    })
    return NextResponse.redirect(new URL('/settings?connected=gmail', env.APP_URL))
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return NextResponse.redirect(new URL(`/settings?error=${reason}`, env.APP_URL))
  }
}
```
Create `src/app/api/mailboxes/outlook/callback/route.ts` (identical shape, Outlook provider):
```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { outlookProvider } from '@/lib/mailbox/outlook-provider'
import { insertMailbox } from '@/lib/db/mailboxes'
import { getOrCreateOperatorClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const state = url.searchParams.get('state')
  if (!code || state !== appUser.id) {
    return NextResponse.redirect(new URL('/settings?error=oauth', env.APP_URL))
  }
  try {
    const exchange = await outlookProvider.exchangeCode(code)
    const admin = createAdminClient()
    const clientId = await getOrCreateOperatorClient(admin)
    const mailbox = await insertMailbox(admin, {
      client_id: clientId,
      provider: 'outlook',
      email_address: exchange.emailAddress,
      display_name: exchange.displayName,
      oauth: { ...exchange.tokens },
    })
    await logEvent({
      clientId, actor: `human:${appUser.id}`, type: 'mailbox.connected',
      payload: { mailboxId: mailbox.id, provider: 'outlook', emailAddress: exchange.emailAddress },
    })
    return NextResponse.redirect(new URL('/settings?connected=outlook', env.APP_URL))
  } catch (error) {
    const reason = isAppError(error) ? error.code : 'unknown'
    return NextResponse.redirect(new URL(`/settings?error=${reason}`, env.APP_URL))
  }
}
```

- [ ] **Step 9: Implement the send-test-email route**

Create `src/app/api/mailboxes/[id]/test-email/route.ts`:
```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getMailboxById, updateMailboxOauth } from '@/lib/db/mailboxes'
import { getMailboxProvider } from '@/lib/mailbox/registry'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import type { MailboxTokens } from '@/lib/mailbox/provider'

export const runtime = 'nodejs'

const oauthSchema = z.object({
  accessToken: z.string(),
  refreshToken: z.string(),
  expiresAt: z.string(),
})

export async function POST(request: Request, context: { params: Promise<{ id: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') return NextResponse.json({ error: 'forbidden' }, { status: 403 })

  const { id } = await context.params
  try {
    const admin = createAdminClient()
    const mailbox = await getMailboxById(admin, id)
    if (!mailbox) return NextResponse.json({ error: 'not_found' }, { status: 404 })

    const tokens: MailboxTokens = oauthSchema.parse(mailbox.oauth)
    const provider = getMailboxProvider(mailbox.provider)
    const { result, tokens: nextTokens } = await provider.sendEmail(tokens, {
      to: mailbox.email_address, // test email to self
      subject: 'AI B2B test email',
      body: 'This is a P0 connectivity test from AI B2B. If you received this, sending works.',
    })
    if (nextTokens.accessToken !== tokens.accessToken) {
      await updateMailboxOauth(admin, id, { ...nextTokens })
    }
    await logEvent({
      clientId: mailbox.client_id, actor: `human:${appUser.id}`, type: 'mailbox.test_email_sent',
      payload: { mailboxId: id, provider: mailbox.provider, providerMessageId: result.providerMessageId },
    })
    return NextResponse.json({ ok: true, providerMessageId: result.providerMessageId })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 10: Build the /settings demo page**

Create `src/app/settings/page.tsx`:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { ConnectButtons } from './connect-buttons'
import { MailboxRow } from './mailbox-row'

export const dynamic = 'force-dynamic'

export default async function SettingsPage() {
  const { appUser } = await requireUser()
  const admin = createAdminClient()
  const { data: mailboxes } = await admin
    .from('mailboxes')
    .select('id, provider, email_address, display_name, health, created_at')
    .order('created_at', { ascending: false })

  return (
    <main style={{ maxWidth: 640, margin: '48px auto', fontFamily: 'system-ui' }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <h1>Settings</h1>
        <form action="/api/auth/signout" method="post">
          <button type="submit">Sign out</button>
        </form>
      </header>
      <p>Signed in as {appUser.role}.</p>

      <section>
        <h2>Connect a mailbox</h2>
        <ConnectButtons />
      </section>

      <section>
        <h2>Connected mailboxes</h2>
        {(!mailboxes || mailboxes.length === 0) && <p>No mailboxes connected yet.</p>}
        <ul style={{ listStyle: 'none', padding: 0 }}>
          {mailboxes?.map((m) => (
            <li key={m.id} style={{ border: '1px solid #ddd', borderRadius: 8, padding: 12, marginBottom: 8 }}>
              <MailboxRow
                id={m.id}
                provider={m.provider}
                emailAddress={m.email_address}
                displayName={m.display_name}
                health={m.health}
              />
            </li>
          ))}
        </ul>
      </section>
    </main>
  )
}
```
Create `src/app/settings/connect-buttons.tsx`:
```tsx
export function ConnectButtons() {
  return (
    <div style={{ display: 'flex', gap: 12 }}>
      <a href="/api/mailboxes/google/connect">
        <button type="button">Connect Gmail</button>
      </a>
      <a href="/api/mailboxes/outlook/connect">
        <button type="button">Connect Outlook</button>
      </a>
    </div>
  )
}
```
Create `src/app/settings/mailbox-row.tsx`:
```tsx
'use client'

import { useState } from 'react'

interface MailboxRowProps {
  id: string
  provider: 'gmail' | 'outlook'
  emailAddress: string
  displayName: string | null
  health: 'ok' | 'warning' | 'blocked'
}

type SendState =
  | { status: 'idle' }
  | { status: 'sending' }
  | { status: 'sent'; providerMessageId: string }
  | { status: 'error'; message: string }

export function MailboxRow(props: MailboxRowProps) {
  const [state, setState] = useState<SendState>({ status: 'idle' })

  async function sendTest() {
    setState({ status: 'sending' })
    try {
      const res = await fetch(`/api/mailboxes/${props.id}/test-email`, { method: 'POST' })
      const json: unknown = await res.json()
      if (!res.ok) {
        const message = typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'failed'
        setState({ status: 'error', message })
        return
      }
      const providerMessageId = typeof json === 'object' && json !== null && 'providerMessageId' in json
        ? String((json as { providerMessageId: unknown }).providerMessageId) : ''
      setState({ status: 'sent', providerMessageId })
    } catch {
      setState({ status: 'error', message: 'network' })
    }
  }

  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <div>
        <strong>{props.provider}</strong> — {props.emailAddress}
        {props.displayName ? ` (${props.displayName})` : ''} · health: {props.health}
      </div>
      <div>
        <button type="button" onClick={sendTest} disabled={state.status === 'sending'}>
          {state.status === 'sending' ? 'Sending…' : 'Send test email'}
        </button>
        {state.status === 'sent' && <span role="status" style={{ color: 'green', marginLeft: 8 }}>Sent ✓</span>}
        {state.status === 'error' && <span role="alert" style={{ color: 'crimson', marginLeft: 8 }}>Error: {state.message}</span>}
      </div>
    </div>
  )
}
```

- [ ] **Step 11: Verify the whole unit suite and typecheck**

Run: `pnpm test && pnpm typecheck`
Expected: all tests PASS; `tsc` exits 0.

- [ ] **Step 12: Manual demo verification (the P0 demo)**

Run:
```bash
set -a; . ./.env.local; set +a
pnpm dev
```
**Verify** (with real Google + Microsoft test accounts configured in the manual-setup steps):
1. Visit http://localhost:3000 → redirected to `/login` → sign in as operator → `/settings`.
2. Click **Connect Gmail** → Google consent → redirected back with `?connected=gmail`; the mailbox appears in the list.
3. Click **Connect Outlook** → Microsoft consent → redirected back with `?connected=outlook`; the mailbox appears.
4. Click **Send test email** on each row → each shows "Sent ✓"; check each inbox received the test message.
5. Confirm the events landed:
```bash
psql "$(pnpm exec supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')" \
  -c "select actor, type, payload->>'provider' as provider from events order by created_at desc limit 6;"
```
Expected rows include `mailbox.connected` (gmail + outlook) and `mailbox.test_email_sent` (gmail + outlook).

- [ ] **Step 13: Commit**

```bash
git add -A
git commit -m "feat: add Outlook provider, mailbox registry, OAuth routes, and /settings demo"
```

---

### Task 11: Deploy to Vercel + prove QStash hello cron end-to-end

Completes roadmap P0 "Next.js app … deployed to Vercel" and closes the QStash end-to-end proof deferred from Task 7.

**Manual setup (human):** In the hosted Supabase project (Task 3 manual setup), apply the migrations: `pnpm exec supabase link --project-ref <ref>` then `pnpm exec supabase db push`. Re-run `pnpm seed:operator <email> <password>` against the **hosted** env to create the production operator.

**Files:**
- Modify: OAuth redirect URIs in Google Cloud + Azure to add the deployed callback URLs.
- No new source files (uses `scheduleCron` from Task 7).

- [ ] **Step 1: Deploy to Vercel**

Run:
```bash
pnpm dlx vercel --yes
pnpm dlx vercel env pull .env.vercel.local
```
Then, in the Vercel dashboard (Project → Settings → Environment Variables), set every key from `.env.example` with the **hosted** values (hosted Supabase URL/keys, QStash keys, Google/Microsoft OAuth, `APP_URL` = the deployed https URL, and the pipeline provider keys). Redeploy:
```bash
pnpm dlx vercel --prod --yes
```
**Verify:** the production URL loads and redirects to `/login`.

- [ ] **Step 2: Add production OAuth redirect URIs**

In Google Cloud Console (OAuth client) add: `https://<your-vercel-domain>/api/mailboxes/google/callback`.
In Azure App registration add: `https://<your-vercel-domain>/api/mailboxes/outlook/callback`.
**Verify:** sign in on production, connect one mailbox, send a test email (repeat Task 10 Step 12 against production).

- [ ] **Step 3: Register the QStash hello schedule**

Create `scripts/register-hello-cron.ts`:
```ts
import { scheduleCron } from '../src/lib/qstash/client'

// Registers the hello cron to fire every 5 minutes at the deployed APP_URL.
async function main() {
  const scheduleId = await scheduleCron('/api/cron/hello', '*/5 * * * *')
  process.stdout.write(`Hello cron scheduled: ${scheduleId}\n`)
}
main().catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`)
  process.exit(1)
})
```
Add script `"cron:hello": "tsx scripts/register-hello-cron.ts"`. Run against the hosted env (APP_URL must be the production URL):
```bash
set -a; . ./.env.vercel.local; set +a
pnpm cron:hello
```
**Verify:** prints a schedule id. In the Upstash QStash console the schedule appears with destination `https://<domain>/api/cron/hello`.

- [ ] **Step 4: Prove the signed cron end-to-end**

Either wait for the 5-minute fire, or trigger once from the QStash console ("Publish"/"Run now") to the same URL. Then query the hosted DB events:
```bash
# Using the hosted Supabase connection string from the dashboard:
psql "<HOSTED_DB_URL>" -c "select actor, type, created_at from events where type='cron.hello' order by created_at desc limit 3;"
```
Expected: at least one `cron.hello` row (actor `system`) — proving QStash signed the request, `verifyQstashSignature` accepted it, and `logEvent` wrote the audit row. This closes the "QStash proven end-to-end" P0 item.

- [ ] **Step 5: Tick the roadmap and commit**

Edit `roadmap.md` P0 section: check every box now satisfied. Then:
```bash
git add -A
git commit -m "chore: deploy to Vercel, register hello cron, and complete P0 end-to-end proof"
```

---

## Self-Review

**1. Spec coverage (roadmap P0 items → task):**
- Next.js scaffolded → Task 1. Deployed to Vercel → Task 11. ✓
- Supabase schema for all `architecture §5` tables → Task 3 (all 11 §5 tables + `app_users`). ✓
- Supabase Auth + RLS (per-`client_id`; operator spans clients) → Task 4 (policies + helpers) + Task 5 (auth). ✓
- Mailbox OAuth Gmail (Gmail API) + Outlook (MS Graph); store tokens in `mailboxes`; send test email from each → Tasks 8–10. ✓
- `events` audit-log helper used everywhere → Task 6; used in Tasks 7, 10, 11. ✓
- QStash hello cron + signed-request verification end-to-end → Task 7 (code + local 401 proof) + Task 11 (real signed proof). ✓
- Secrets management (Brightdata, Gemini, Emailable, QStash, OAuth) → Task 2 (all declared/validated). ✓
- Demo (login as operator, connect Gmail+Outlook, send test, see event) → Task 10 Step 12. ✓

**2. Placeholder scan:** No `TODO`/`// ...`/`YOUR_KEY`/"add error handling" left. Every route has explicit try/catch mapping to `AppError`; every external call goes through `fetchJson` (timeout) or a wrapped SDK call. The only intentionally-deferred item (real signed QStash proof) is explicitly called out in Task 7 Step 7 and closed in Task 11 — not a silent stub.

**3. Type consistency:** `MailboxTokens { accessToken, refreshToken, expiresAt }` is defined once (Task 8) and consumed identically by both providers and the test-email route's `oauthSchema`. `MailboxProvider.sendEmail` returns `{ result, tokens }` in the interface and both implementations; the test-email route destructures exactly that. `logEvent(LogEventInput)` signature (Task 6) matches all call sites (Tasks 7, 10). `getMailboxProvider(provider)` name matches the registry test. `createAdminClient` / `createServerClient` / `createBrowserClient` names are consistent across defining and consuming tasks. `getOrCreateOperatorClient` name matches its Task 10 call sites.

**Gap deliberately closed in-plan:** `architecture §5` has no user→client mapping table, which RLS requires. Task 3 adds `app_users` with a documented check constraint; Task 4's helpers (`is_operator`, `current_client_id`) and Task 5's `requireUser` depend on it. This is flagged inline so a reviewer sees it is intentional, not schema drift.

---

## Execution Handoff

**Plan complete and saved to `docs/superpowers/plans/2026-07-18-p0-foundations.md`. Two execution options:**

**1. Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

**2. Inline Execution** — Execute tasks in this session using executing-plans, batch execution with checkpoints.

**Which approach?**
