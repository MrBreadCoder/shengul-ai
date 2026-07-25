# Client Admin Page + Account-Creation Links + Per-Client Analytics Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the operator (the only human with an account today) a `/clients` admin page to see every client and its linked login accounts, a way to generate a one-time invite link that lets a client set their own password and log in, and a way to view the existing Analytics dashboard scoped to one client at a time ("one by one").

**Architecture:** Reuses the existing multi-tenant schema (`clients`, `app_users` with `role: 'operator' | 'client'`) and the existing operator/client role-gating pattern already used by `/campaigns` and `/api/campaigns` (Server Component `redirect`, Route Handler 403 JSON). Client provisioning goes through Supabase Auth Admin (`generateLink({ type: 'invite' })`), which creates the `auth.users` row and returns a shareable link with no email/SMTP dependency. A new `/auth/callback` route exchanges that link's code for a session; a new `/set-password` page lets the invited user set their password, after which they use the existing `/login` page like anyone else. Per-client analytics extends the existing `analytics_overview`/`analytics_daily` Postgres functions (`supabase/migrations/0008_analytics.sql`) with an optional trailing `p_client_id` parameter, following the exact pattern the file already uses for `p_campaign_id` — every affected table (`leads`, `cases`, `emails`, `sequences`, `suppressions`) already carries its own `client_id` column, so no new joins are needed. These functions are `security invoker`, so a client-role viewer is already hard-scoped to their own `client_id` by RLS regardless of this parameter; it only changes what an **operator** (who bypasses RLS via `is_operator()`) can choose to see.

**Tech Stack:** Next.js 16 (App Router, Route Handlers with `Promise` params), Supabase (`@supabase/supabase-js` admin client, `@supabase/ssr`, Postgres functions), Zod, Vitest, existing shadcn/ui + Phosphor icon component library.

## Global Constraints

- `strict: true` TypeScript, no `any`, no `!` without a justifying comment (per `.claude/QUALITY.md`).
- All external input (route bodies, Supabase Auth responses) validated with Zod or explicit null checks — never trust shape.
- Every thrown/returned error carries a machine-readable `code` via the existing `AppError` class (`src/lib/errors/app-error.ts`) — reuse existing codes, do not invent new ones.
- Data access lives exclusively in `src/lib/db/` — no inline Supabase queries in pages or routes.
- Every Route Handler: validate input → check auth/role → call lib functions → return result (same order as `src/app/api/campaigns/route.ts`).
- Named exports everywhere except Next.js pages/layouts (default export required by the framework).
- New page routes get `loading.tsx` + `error.tsx`, **except** standalone (non-`(app)`) auth pages, matching the existing `/login` route which has neither.
- Every new mutation writes an `events` row via `logEvent` (audit trail requirement already established in this codebase).
- Test file colocated as `*.test.ts`, Arrange-Act-Assert, mock at the Supabase/Zod boundary only — this repo's established pattern (see `src/lib/db/campaigns.test.ts`, `src/app/api/pipeline/mailbox-reset/route.test.ts`).

**Important environment note (not a code task — flag to the user before/while executing):** Supabase Auth's "Redirect URLs" allow-list (Dashboard → Authentication → URL Configuration) must include `${APP_URL}/auth/callback`, or `generateLink` will succeed but the resulting link will fail to redirect correctly. This is a hosted-project setting, not something any task below can configure.

**Important environment note for Task 10 (not a code task — flag to the user before/while executing):** the new migration must actually be applied to the target Supabase project (`supabase db push`, or `supabase migration up` against a local `supabase start`) before the per-client analytics filter will work — writing the `.sql` file alone does not change a running database.

---

### Task 1: Move & extend client DB access — `src/lib/db/clients.ts`

**Files:**
- Create: `src/lib/db/clients.ts`
- Create: `src/lib/db/clients.test.ts`
- Modify: `src/lib/db/campaigns.ts` (remove `listClients`, it moves to `clients.ts`)
- Modify: `src/lib/db/campaigns.test.ts` (remove the `describe('listClients', ...)` block, lines 95-111)
- Modify: `src/app/(app)/campaigns/page.tsx:6` (import `listClients` from `@/lib/db/clients` instead of `@/lib/db/campaigns`)

**Interfaces:**
- Produces: `ClientRow` (= `Database['public']['Tables']['clients']['Row']`), `ClientOption` (`Pick<ClientRow, 'id' | 'name'>`), `AppUserRow` (= `Database['public']['Tables']['app_users']['Row']`)
- Produces: `listClients(supabase): Promise<ClientOption[]>` (unchanged signature/behavior, moved verbatim)
- Produces: `listClientsFull(supabase): Promise<ClientRow[]>` — all columns, ordered by `name`
- Produces: `insertClient(supabase, row: ClientInsert): Promise<ClientRow>`
- Produces: `getClientById(supabase, id: string): Promise<ClientRow | null>`
- Produces: `listClientRoleAppUsers(supabase): Promise<AppUserRow[]>` — every `app_users` row with `role = 'client'`, across all clients (used once per page render, not per client, to avoid N+1)
- Produces: `insertAppUser(supabase, row: AppUserInsert): Promise<void>`
- Consumes: nothing from other new tasks

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/db/clients.test.ts
import { describe, it, expect } from 'vitest'
import {
  listClients,
  listClientsFull,
  insertClient,
  getClientById,
  listClientRoleAppUsers,
  insertAppUser,
} from './clients'
import { AppError } from '@/lib/errors/app-error'

describe('listClients', () => {
  it('should return the list of clients ordered by name', async () => {
    const rows = [{ id: 'c1', name: 'Acme' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listClients(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listClients(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('listClientsFull', () => {
  it('should return full client rows ordered by name', async () => {
    const rows = [{ id: 'c1', name: 'Acme', status: 'active', settings: {}, created_at: 'x', updated_at: 'x' }]
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listClientsFull(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ order: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listClientsFull(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertClient', () => {
  it('should return the created client row', async () => {
    const row = { id: 'c1', name: 'Acme' }
    const supabase = {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await insertClient(supabase, { name: 'Acme' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on insert failure', async () => {
    const supabase = {
      from: () => ({ insert: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(insertClient(supabase, { name: 'Acme' })).rejects.toBeInstanceOf(AppError)
  })
})

describe('getClientById', () => {
  it('should return the client row when found', async () => {
    const row = { id: 'c1', name: 'Acme' }
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: row, error: null }) }) }) }),
    } as never
    const result = await getClientById(supabase, 'c1')
    expect(result).toEqual(row)
  })

  it('should return null when not found', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: null }) }) }) }),
    } as never
    const result = await getClientById(supabase, 'missing')
    expect(result).toBeNull()
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => ({ maybeSingle: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(getClientById(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('listClientRoleAppUsers', () => {
  it('should return only client-role app_users rows', async () => {
    const rows = [{ id: 'u1', role: 'client', client_id: 'c1', created_at: 'x' }]
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: rows, error: null }) }) }),
    } as never
    const result = await listClientRoleAppUsers(supabase)
    expect(result).toEqual(rows)
  })

  it('should throw DB_ERROR on query failure', async () => {
    const supabase = {
      from: () => ({ select: () => ({ eq: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    } as never
    await expect(listClientRoleAppUsers(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('insertAppUser', () => {
  it('should resolve when the insert succeeds', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.resolve({ error: null }) }),
    } as never
    await expect(insertAppUser(supabase, { id: 'u1', role: 'client', client_id: 'c1' })).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR on insert failure', async () => {
    const supabase = {
      from: () => ({ insert: () => Promise.resolve({ error: { message: 'boom' } }) }),
    } as never
    await expect(insertAppUser(supabase, { id: 'u1', role: 'client', client_id: 'c1' })).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: FAIL — `Cannot find module './clients'`

- [ ] **Step 3: Implement `src/lib/db/clients.ts`**

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type ClientRow = Database['public']['Tables']['clients']['Row']
export type ClientInsert = Database['public']['Tables']['clients']['Insert']
export type ClientOption = Pick<ClientRow, 'id' | 'name'>
export type AppUserRow = Database['public']['Tables']['app_users']['Row']
export type AppUserInsert = Database['public']['Tables']['app_users']['Insert']

export async function listClients(supabase: SupabaseClient<Database>): Promise<ClientOption[]> {
  const { data, error } = await supabase.from('clients').select('id, name').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list clients', { cause: error.message })
  return data ?? []
}

export async function listClientsFull(supabase: SupabaseClient<Database>): Promise<ClientRow[]> {
  const { data, error } = await supabase.from('clients').select('*').order('name')
  if (error) throw new AppError('DB_ERROR', 'Failed to list clients', { cause: error.message })
  return data ?? []
}

export async function insertClient(
  supabase: SupabaseClient<Database>,
  row: ClientInsert,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').insert(row).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert client', { cause: error?.message })
  }
  return data
}

export async function getClientById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ClientRow | null> {
  const { data, error } = await supabase.from('clients').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load client', { id, cause: error.message })
  return data
}

// All client-role logins across every client, in one query — the admin page
// renders every client at once and must not issue one query per row.
export async function listClientRoleAppUsers(
  supabase: SupabaseClient<Database>,
): Promise<AppUserRow[]> {
  const { data, error } = await supabase.from('app_users').select('*').eq('role', 'client')
  if (error) throw new AppError('DB_ERROR', 'Failed to list client app_users', { cause: error.message })
  return data ?? []
}

export async function insertAppUser(
  supabase: SupabaseClient<Database>,
  row: AppUserInsert,
): Promise<void> {
  const { error } = await supabase.from('app_users').insert(row)
  if (error) throw new AppError('DB_ERROR', 'Failed to insert app_user', { cause: error.message })
}
```

- [ ] **Step 4: Remove the duplicate from `campaigns.ts` and its test, repoint the import**

In `src/lib/db/campaigns.ts`, delete the `listClients` function and its `ClientOption` type (both now live in `clients.ts`).

In `src/lib/db/campaigns.test.ts`, delete the `describe('listClients', ...)` block (lines 95-111) and remove `listClients` from the import on line 2.

In `src/app/(app)/campaigns/page.tsx:6`, change:
```ts
import { listCampaignsForClient, listClients } from '@/lib/db/campaigns'
```
to:
```ts
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listClients } from '@/lib/db/clients'
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/clients.test.ts src/lib/db/campaigns.test.ts`
Expected: PASS, all tests green

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 7: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts "src/app/(app)/campaigns/page.tsx"
git commit -m "refactor: move client DB access into lib/db/clients.ts"
```

---

### Task 2: Auth-admin user listing helper — `src/lib/supabase/list-auth-users.ts`

The clients admin page needs each client-role login's **email**, which lives in Supabase's `auth.users` (not exposed via the public schema). This wraps the paginated Admin API call into one typed, tested function.

**Files:**
- Create: `src/lib/supabase/list-auth-users.ts`
- Create: `src/lib/supabase/list-auth-users.test.ts`

**Interfaces:**
- Produces: `AuthUserSummary { id: string; email: string }`
- Produces: `listAllAuthUsers(admin: SupabaseClient<Database>): Promise<AuthUserSummary[]>`
- Consumes: nothing

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/supabase/list-auth-users.test.ts
import { describe, it, expect, vi } from 'vitest'
import { listAllAuthUsers } from './list-auth-users'
import { AppError } from '@/lib/errors/app-error'

function mockAdmin(pages: { users: { id: string; email?: string }[] }[]) {
  const listUsers = vi.fn()
  for (const page of pages) listUsers.mockResolvedValueOnce({ data: page, error: null })
  return { auth: { admin: { listUsers } } } as never
}

describe('listAllAuthUsers', () => {
  it('should return id/email pairs for a single page under the page size', async () => {
    const admin = mockAdmin([{ users: [{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'b@x.com' }] }])
    const result = await listAllAuthUsers(admin)
    expect(result).toEqual([{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'b@x.com' }])
  })

  it('should skip users with no email', async () => {
    const admin = mockAdmin([{ users: [{ id: 'u1', email: undefined }] }])
    const result = await listAllAuthUsers(admin)
    expect(result).toEqual([])
  })

  it('should page until a short page is returned', async () => {
    const fullPage = Array.from({ length: 200 }, (_, i) => ({ id: `u${i}`, email: `u${i}@x.com` }))
    const shortPage = [{ id: 'last', email: 'last@x.com' }]
    const admin = mockAdmin([{ users: fullPage }, { users: shortPage }])
    const result = await listAllAuthUsers(admin)
    expect(result).toHaveLength(201)
    expect(result[200]).toEqual({ id: 'last', email: 'last@x.com' })
  })

  it('should throw EXTERNAL_ERROR when the Admin API errors', async () => {
    const admin = {
      auth: { admin: { listUsers: vi.fn().mockResolvedValue({ data: null, error: { message: 'boom' } }) } },
    } as never
    await expect(listAllAuthUsers(admin)).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/supabase/list-auth-users.test.ts`
Expected: FAIL — `Cannot find module './list-auth-users'`

- [ ] **Step 3: Implement**

```ts
// src/lib/supabase/list-auth-users.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export interface AuthUserSummary {
  id: string
  email: string
}

// Supabase Admin API caps a page at 1000; 200 keeps each round-trip fast
// without materially risking missed rows at this product's expected client count.
const PAGE_SIZE = 200

export async function listAllAuthUsers(admin: SupabaseClient<Database>): Promise<AuthUserSummary[]> {
  const summaries: AuthUserSummary[] = []
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE })
    if (error) {
      throw new AppError('EXTERNAL_ERROR', 'Failed to list auth users', { cause: error.message })
    }
    for (const user of data.users) {
      if (user.email) summaries.push({ id: user.id, email: user.email })
    }
    if (data.users.length < PAGE_SIZE) break
    page += 1
  }
  return summaries
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/supabase/list-auth-users.test.ts`
Expected: PASS, 4 tests green

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/list-auth-users.ts src/lib/supabase/list-auth-users.test.ts
git commit -m "feat: add paginated Supabase auth-user listing helper"
```

---

### Task 3: `POST /api/clients` — create a client

**Files:**
- Create: `src/app/api/clients/route.ts`
- Create: `src/app/api/clients/route.test.ts`

**Interfaces:**
- Consumes: `insertClient` from Task 1 (`@/lib/db/clients`)
- Produces: `POST /api/clients` accepting `{ name: string }`, returns `{ ok: true, client: ClientRow }` on success

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/clients/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const insertClientMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({ insertClient: (...a: unknown[]) => insertClientMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

beforeEach(() => {
  requireUserMock.mockReset()
  insertClientMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ name: 'Acme' }))
    expect(res.status).toBe(403)
    expect(insertClientMock).not.toHaveBeenCalled()
  })

  it('should return 400 on validation error', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    const res = await POST(req({ name: '' }))
    expect(res.status).toBe(400)
  })

  it('should create the client and log the event on success', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertClientMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    const res = await POST(req({ name: 'Acme' }))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'Acme' } })
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.created' }),
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/api/clients/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/clients/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertClient } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createClientSchema = z.object({
  name: z.string().min(1),
})

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const body = createClientSchema.parse(await request.json())
    const admin = createAdminClient()
    const client = await insertClient(admin, { name: body.name })
    try {
      await logEvent({
        clientId: client.id,
        actor: `human:${appUser.id}`,
        type: 'client.created',
        payload: { name: client.name },
      })
    } catch {
      // Audit logging is best-effort — the client was already created successfully.
    }
    return NextResponse.json({ ok: true, client })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/clients/route.test.ts`
Expected: PASS, 3 tests green

- [ ] **Step 5: Commit**

```bash
git add src/app/api/clients/route.ts src/app/api/clients/route.test.ts
git commit -m "feat: add POST /api/clients for operator-only client creation"
```

---

### Task 4: `POST /api/clients/[clientId]/invite` — generate an account-creation link

This is the core "account creation link" feature: it creates the Supabase Auth user immediately (in an unconfirmed/invited state) via `generateLink`, links it to the client via `app_users`, and hands back a raw URL for the operator to send however they want — no SMTP/email dependency.

**Files:**
- Create: `src/app/api/clients/[clientId]/invite/route.ts`
- Create: `src/app/api/clients/[clientId]/invite/route.test.ts`

**Interfaces:**
- Consumes: `getClientById`, `insertAppUser` from Task 1 (`@/lib/db/clients`)
- Produces: `POST /api/clients/:clientId/invite` accepting `{ email: string }`, returns `{ ok: true, link: string, email: string }` on success

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/clients/[clientId]/invite/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const insertAppUserMock = vi.fn()
const logEventMock = vi.fn()
const generateLinkMock = vi.fn()
const deleteUserMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({
  createAdminClient: () => ({
    auth: { admin: { generateLink: (...a: unknown[]) => generateLinkMock(...a), deleteUser: (...a: unknown[]) => deleteUserMock(...a) } },
  }),
}))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  insertAppUser: (...a: unknown[]) => insertAppUserMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  insertAppUserMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
  generateLinkMock.mockReset()
  deleteUserMock.mockReset()
})

describe('POST /api/clients/[clientId]/invite', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(req({ email: 'a@x.com' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 on validation error', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    const res = await POST(req({ email: 'not-an-email' }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should return 409 when the email is already registered', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({ data: null, error: { message: 'Email already registered', code: 'email_exists' } })
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(409)
  })

  it('should clean up the auth user if the app_users insert fails', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({
      data: { user: { id: 'newuser1' }, properties: { action_link: 'https://x/invite?code=abc' } },
      error: null,
    })
    insertAppUserMock.mockRejectedValue(new Error('boom'))
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    expect(res.status).toBe(500)
    expect(deleteUserMock).toHaveBeenCalledWith('newuser1')
  })

  it('should create the invite and return the link on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    generateLinkMock.mockResolvedValue({
      data: { user: { id: 'newuser1' }, properties: { action_link: 'https://x/invite?code=abc' } },
      error: null,
    })
    insertAppUserMock.mockResolvedValue(undefined)
    const res = await POST(req({ email: 'a@x.com' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, link: 'https://x/invite?code=abc', email: 'a@x.com' })
    expect(insertAppUserMock).toHaveBeenCalledWith(expect.anything(), { id: 'newuser1', role: 'client', client_id: 'c1' })
    expect(logEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientId: 'c1', type: 'client.user_invited' }),
    )
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/invite/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/clients/[clientId]/invite/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, insertAppUser } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { env } from '@/lib/env'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const inviteSchema = z.object({
  email: z.string().email(),
})

function isDuplicateEmailError(error: { code?: string; message: string }): boolean {
  return error.code === 'email_exists' || /already registered|already exists/i.test(error.message)
}

export async function POST(request: Request, context: { params: Promise<{ clientId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { clientId } = await context.params
  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = inviteSchema.parse(await request.json())

    const { data, error } = await admin.auth.admin.generateLink({
      type: 'invite',
      email: body.email,
      options: { redirectTo: `${env.APP_URL}/auth/callback` },
    })
    if (error || !data.user) {
      const status = error && isDuplicateEmailError(error) ? 409 : 500
      return NextResponse.json(
        { error: status === 409 ? 'email_already_registered' : 'invite_failed' },
        { status },
      )
    }

    try {
      await insertAppUser(admin, { id: data.user.id, role: 'client', client_id: clientId })
    } catch (insertError) {
      // The auth user was already created by generateLink — without this
      // cleanup a failed app_users insert would leave an orphaned login with
      // no client link, invisible to this admin page but present in auth.users.
      await admin.auth.admin.deleteUser(data.user.id)
      throw insertError
    }

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.user_invited',
        payload: { email: body.email },
      })
    } catch {
      // Audit logging is best-effort — the invite was already created successfully.
    }

    return NextResponse.json({ ok: true, link: data.properties.action_link, email: body.email })
  } catch (error) {
    if (error instanceof z.ZodError) {
      return NextResponse.json({ error: 'validation_error', issues: error.flatten() }, { status: 400 })
    }
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/invite/route.test.ts"`
Expected: PASS, 6 tests green

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/invite/route.ts" "src/app/api/clients/[clientId]/invite/route.test.ts"
git commit -m "feat: add operator-only client invite-link generation endpoint"
```

---

### Task 5: `/auth/callback` — exchange the invite link for a session

**Files:**
- Create: `src/app/auth/callback/route.ts`
- Create: `src/app/auth/callback/route.test.ts`
- Modify: `src/lib/supabase/middleware.ts:25` (add `/auth/callback` to the public-route check)

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server` (existing)
- Produces: `GET /auth/callback?code=...&next=...` — redirects to `next` (default `/set-password`) on success, `/login` on failure

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/auth/callback/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const exchangeMock = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createServerClient: () => Promise.resolve({ auth: { exchangeCodeForSession: (...a: unknown[]) => exchangeMock(...a) } }),
}))

import { GET } from './route'

beforeEach(() => { exchangeMock.mockReset() })

describe('GET /auth/callback', () => {
  it('should redirect to /login when no code is present', async () => {
    const res = await GET(new Request('http://localhost:3000/auth/callback'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login')
    expect(exchangeMock).not.toHaveBeenCalled()
  })

  it('should redirect to /login?error=invite_expired when the exchange fails', async () => {
    exchangeMock.mockResolvedValue({ error: { message: 'expired' } })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/login?error=invite_expired')
  })

  it('should redirect to the default next path on success', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/set-password')
  })

  it('should redirect to a custom next path when provided', async () => {
    exchangeMock.mockResolvedValue({ error: null })
    const res = await GET(new Request('http://localhost:3000/auth/callback?code=abc&next=/crm'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toBe('http://localhost:3000/crm')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/app/auth/callback/route.test.ts`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/auth/callback/route.ts
import { NextResponse } from 'next/server'
import { createServerClient } from '@/lib/supabase/server'

export const runtime = 'nodejs'

export async function GET(request: Request) {
  const url = new URL(request.url)
  const code = url.searchParams.get('code')
  const next = url.searchParams.get('next') ?? '/set-password'

  if (!code) {
    return NextResponse.redirect(new URL('/login', url))
  }

  const supabase = await createServerClient()
  const { error } = await supabase.auth.exchangeCodeForSession(code)
  if (error) {
    return NextResponse.redirect(new URL('/login?error=invite_expired', url))
  }

  return NextResponse.redirect(new URL(next, url))
}
```

- [ ] **Step 4: Add `/auth/callback` to the middleware's public-route allow-list**

In `src/lib/supabase/middleware.ts:25`, change:
```ts
const isPublic = pathname.startsWith('/login') || pathname.startsWith('/api/cron')
```
to:
```ts
const isPublic =
  pathname.startsWith('/login') || pathname.startsWith('/api/cron') || pathname.startsWith('/auth/callback')
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `pnpm vitest run src/app/auth/callback/route.test.ts`
Expected: PASS, 4 tests green

- [ ] **Step 6: Commit**

```bash
git add src/app/auth/callback/route.ts src/app/auth/callback/route.test.ts src/lib/supabase/middleware.ts
git commit -m "feat: add /auth/callback to exchange invite links for a session"
```

---

### Task 6: `/set-password` — the invited user sets their password

**Files:**
- Create: `src/app/set-password/page.tsx`
- Create: `src/app/set-password/set-password-form.tsx`

**Interfaces:**
- Consumes: `createServerClient` (`@/lib/supabase/server`), `createBrowserClient` (`@/lib/supabase/client`)
- Produces: standalone page at `/set-password`, no props consumed by later tasks

- [ ] **Step 1: Implement the Server Component page**

Mirrors `src/app/login/page.tsx`'s standalone styling (no `(app)` layout, no nav). A visitor with no valid session (link expired, direct navigation) is bounced to `/login` — matching how `requireUser` redirects everywhere else in this app.

```tsx
// src/app/set-password/page.tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { createServerClient } from '@/lib/supabase/server'
import { SetPasswordForm } from './set-password-form'

export const metadata: Metadata = { title: 'Set your password' }

export default async function SetPasswordPage(): Promise<React.ReactElement> {
  const supabase = await createServerClient()
  const { data } = await supabase.auth.getUser()
  if (!data.user) redirect('/login')

  return (
    <main className="grid min-h-[100dvh] place-items-center px-4 py-16">
      <div className="w-full max-w-[360px]">
        <div className="flex items-center gap-2.5">
          <span
            aria-hidden
            className="bg-primary/15 text-primary grid size-8 place-items-center rounded-md text-sm font-bold"
          >
            B
          </span>
          <span className="text-sm font-semibold tracking-tight">Beacon</span>
        </div>

        <h1 className="mt-8 text-xl font-semibold tracking-tight">Set your password</h1>
        <p className="text-muted-foreground mt-1.5 text-sm">
          Signed in as {data.user.email}. Choose a password to finish setting up your account.
        </p>

        <SetPasswordForm />
      </div>
    </main>
  )
}
```

- [ ] **Step 2: Implement the Client Component form**

```tsx
// src/app/set-password/set-password-form.tsx
'use client'

import { useState, type FormEvent } from 'react'
import { useRouter } from 'next/navigation'
import { Warning } from '@phosphor-icons/react'
import { createBrowserClient } from '@/lib/supabase/client'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

const MIN_PASSWORD_LENGTH = 8

export function SetPasswordForm(): React.ReactElement {
  const router = useRouter()
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [isSubmitting, setIsSubmitting] = useState(false)

  async function onSubmit(event: FormEvent): Promise<void> {
    event.preventDefault()
    setError(null)

    if (password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`)
      return
    }
    if (password !== confirm) {
      setError('Passwords do not match.')
      return
    }

    setIsSubmitting(true)
    const supabase = createBrowserClient()
    const { error: updateError } = await supabase.auth.updateUser({ password })
    if (updateError) {
      setError('Could not set your password. Try requesting a new invite link.')
      setIsSubmitting(false)
      return
    }
    router.push('/crm')
    router.refresh()
  }

  return (
    <form onSubmit={onSubmit} className="mt-7 flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <Label htmlFor="password" className="text-xs">
          New password
        </Label>
        <Input
          id="password"
          type="password"
          value={password}
          required
          autoComplete="new-password"
          autoFocus
          onChange={(event) => setPassword(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-2">
        <Label htmlFor="confirm" className="text-xs">
          Confirm password
        </Label>
        <Input
          id="confirm"
          type="password"
          value={confirm}
          required
          autoComplete="new-password"
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>

      {error ? (
        <p
          role="alert"
          className="text-destructive flex items-start gap-2 rounded-md px-3 py-2 text-xs"
          style={{ background: 'color-mix(in oklch, var(--destructive) 12%, transparent)' }}
        >
          <Warning size={14} weight="fill" className="mt-px shrink-0" />
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={isSubmitting} className="mt-1 w-full">
        {isSubmitting ? 'Saving…' : 'Set password and continue'}
      </Button>
    </form>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 4: Commit**

```bash
git add src/app/set-password/page.tsx src/app/set-password/set-password-form.tsx
git commit -m "feat: add /set-password for invited users to activate their account"
```

---

### Task 7: Client status colour map — `src/lib/ui/status.ts`

**Files:**
- Modify: `src/lib/ui/status.ts` (add `CLIENT_STATUS`, following the exact pattern of `CASE_STATUS`/`MAILBOX_HEALTH` already in the file)

**Interfaces:**
- Produces: `CLIENT_STATUS: Record<Database['public']['Enums']['client_status'], StatusMeta>`
- Consumes: `StatusMeta` (existing, same file)

- [ ] **Step 1: Add the type import and the map**

At the top of `src/lib/ui/status.ts`, add to the existing type-alias block:
```ts
type ClientStatus = Database['public']['Enums']['client_status']
```

Add near the other maps (after `MAILBOX_HEALTH`, matching its 3-value enum shape):
```ts
export const CLIENT_STATUS: Record<ClientStatus, StatusMeta> = {
  active: { label: 'Active', color: 'var(--status-won)' },
  paused: { label: 'Paused', color: 'var(--status-hot-handoff)' },
  archived: { label: 'Archived', color: 'var(--status-dead)' },
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 3: Commit**

```bash
git add src/lib/ui/status.ts
git commit -m "feat: add client status colour map for the clients admin page"
```

---

### Task 8: `/clients` admin page — list clients, create clients, invite users

**Files:**
- Create: `src/app/(app)/clients/page.tsx`
- Create: `src/app/(app)/clients/new-client-form.tsx`
- Create: `src/app/(app)/clients/invite-user-dialog.tsx`
- Create: `src/app/(app)/clients/loading.tsx`
- Create: `src/app/(app)/clients/error.tsx`
- Modify: `src/components/shell/nav.tsx` (add a `Clients` nav entry, operator-only)

**Interfaces:**
- Consumes: `listClientsFull`, `listClientRoleAppUsers` (Task 1), `listAllAuthUsers` (Task 2), `CLIENT_STATUS` (Task 7), `requireUser` (existing), `POST /api/clients` (Task 3), `POST /api/clients/:clientId/invite` (Task 4)

- [ ] **Step 1: Implement `new-client-form.tsx`**

Same shape as `src/app/(app)/campaigns/new-campaign-form.tsx`'s submit handling, trimmed to one field.

```tsx
// src/app/(app)/clients/new-client-form.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

export function NewClientForm(): React.ReactElement {
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onSubmit(formData: FormData): Promise<void> {
    setState({ status: 'submitting' })
    const name = String(formData.get('name') ?? '')
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'The server rejected the client.'
        setState({ status: 'error', message })
        toast.error('Could not create client', { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success('Client created')
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Could not create client', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form action={onSubmit} className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-5 sm:flex-row sm:items-end">
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="name" className="text-xs">
          Client name
        </Label>
        <Input id="name" name="name" required placeholder="Acme Corp" />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <Plus size={14} weight="bold" />
          {isSubmitting ? 'Creating…' : 'Create client'}
        </Button>
        {state.status === 'error' ? (
          <span role="alert" className="text-destructive text-xs">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  )
}
```

- [ ] **Step 2: Implement `invite-user-dialog.tsx`**

```tsx
// src/app/(app)/clients/invite-user-dialog.tsx
'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, EnvelopeSimple, LinkSimple } from '@phosphor-icons/react'
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

type InviteState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'success'; link: string }

export function InviteUserDialog({ clientId }: { clientId: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [state, setState] = useState<InviteState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not create the invite.'
        setState({ status: 'error', message })
        return
      }
      const link =
        typeof json === 'object' && json !== null && 'link' in json ? String((json as { link: unknown }).link) : ''
      setState({ status: 'success', link })
    } catch {
      setState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  async function copyLink(link: string): Promise<void> {
    await navigator.clipboard.writeText(link)
    toast.success('Link copied')
  }

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setEmail('')
      setState({ status: 'idle' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <EnvelopeSimple size={13} weight="light" />
          Invite user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an account-creation link</DialogTitle>
        </DialogHeader>

        {state.status === 'success' ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Send this link to the client. It lets them set their own password and sign in — it is not reusable
              once they do.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={state.link} className="text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={() => copyLink(state.link)}>
                <Copy size={13} weight="light" />
                Copy
              </Button>
            </div>
          </div>
        ) : (
          <form onSubmit={onSubmit} className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <Label htmlFor={`invite-email-${clientId}`} className="text-xs">
                Client's email
              </Label>
              <Input
                id={`invite-email-${clientId}`}
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@client.com"
              />
            </div>
            {state.status === 'error' ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" size="sm" disabled={state.status === 'submitting'}>
                <LinkSimple size={13} weight="light" />
                {state.status === 'submitting' ? 'Generating…' : 'Generate link'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: Implement the page**

```tsx
// src/app/(app)/clients/page.tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Buildings, ChartLineUp } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listClientsFull, listClientRoleAppUsers } from '@/lib/db/clients'
import { listAllAuthUsers } from '@/lib/supabase/list-auth-users'
import { formatRelative } from '@/lib/format'
import { CLIENT_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'
import { NewClientForm } from './new-client-form'
import { InviteUserDialog } from './invite-user-dialog'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Clients' }

export default async function ClientsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') redirect('/crm')

  const admin = createAdminClient()
  const [clients, clientAppUsers, authUsers] = await Promise.all([
    listClientsFull(admin),
    listClientRoleAppUsers(admin),
    listAllAuthUsers(admin),
  ])
  const now = new Date()

  const emailById = new Map(authUsers.map((user) => [user.id, user.email]))
  const usersByClient = new Map<string, { id: string; email: string }[]>()
  for (const row of clientAppUsers) {
    if (!row.client_id) continue
    const list = usersByClient.get(row.client_id) ?? []
    list.push({ id: row.id, email: emailById.get(row.id) ?? 'unknown' })
    usersByClient.set(row.client_id, list)
  }

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader
        title="Clients"
        description="Every client the agent runs campaigns for, and who can log in on their behalf."
      />

      <Section title="New client">
        <NewClientForm />
      </Section>

      <Section title="All clients" aside={clients.length > 0 ? `${clients.length} total` : undefined}>
        {clients.length === 0 ? (
          <EmptyState
            icon={Buildings}
            title="No clients yet"
            description="Create one above, then set up a campaign and invite a login for it."
          />
        ) : (
          <ul className="flex flex-col gap-3">
            {clients.map((client) => {
              const users = usersByClient.get(client.id) ?? []
              return (
                <li key={client.id} className="border-hairline bg-surface flex flex-col gap-3 rounded-lg border p-4">
                  <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
                    <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{client.name}</p>
                    <StatusPill meta={CLIENT_STATUS[client.status]} />
                    <span className="text-faint text-[11px]">Created {formatRelative(client.created_at, now)}</span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2">
                    {users.length === 0 ? (
                      <span className="text-faint text-[11px]">No login yet</span>
                    ) : (
                      users.map((user) => (
                        <span
                          key={user.id}
                          className="bg-accent text-muted-foreground rounded-full px-2 py-0.5 text-[11px]"
                        >
                          {user.email}
                        </span>
                      ))
                    )}
                    <InviteUserDialog clientId={client.id} />
                    <Button type="button" variant="outline" size="sm" asChild>
                      <Link href={`/analytics?client=${client.id}`}>
                        <ChartLineUp size={13} weight="light" />
                        View analytics
                      </Link>
                    </Button>
                  </div>
                </li>
              )
            })}
          </ul>
        )}
      </Section>
    </div>
  )
}
```

- [ ] **Step 4: Add `loading.tsx` and `error.tsx`**

```tsx
// src/app/(app)/clients/loading.tsx
import { PageSkeleton } from '@/components/page-skeleton'

export default function Loading(): React.ReactElement {
  return <PageSkeleton variant="list" />
}
```

```tsx
// src/app/(app)/clients/error.tsx
'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel title="Clients unavailable" description="The client list could not be loaded." reset={reset} />
  )
}
```

- [ ] **Step 5: Add the nav entry**

In `src/components/shell/nav.tsx`, add `Buildings` to the icon import (line 6-15) and insert a new entry into `SECONDARY_NAV` (line 34-37), before the `Campaigns` entry:

```ts
import {
  ChartLineUp,
  Envelope,
  Gear,
  Kanban,
  Lightning,
  type IconProps,
  Stack,
  Buildings,
  Tray,
} from '@phosphor-icons/react'
```

```ts
const SECONDARY_NAV: readonly NavItem[] = [
  { href: '/clients', label: 'Clients', icon: Buildings, operatorOnly: true },
  { href: '/campaigns', label: 'Campaigns', icon: Lightning, operatorOnly: true },
  { href: '/settings', label: 'Settings', icon: Gear },
]
```

- [ ] **Step 6: Typecheck and lint**

Run: `pnpm exec tsc --noEmit && pnpm exec eslint src/app/\(app\)/clients src/components/shell/nav.tsx`
Expected: no errors

- [ ] **Step 7: Manual smoke test**

Run: `pnpm dev`, sign in as the seeded operator (`pnpm seed:dev` if no local data exists), visit `/clients`. Confirm: the page loads, "New client" creates a row that appears without a manual refresh, "Invite user" on a client returns a copyable link, "View analytics" on a client row navigates to `/analytics?client=<that client's id>` (fully wired up once Task 14 lands), and signing in as a client-role user does not show "Clients" in the nav and hitting `/clients` directly redirects to `/crm`.

- [ ] **Step 8: Commit**

```bash
git add "src/app/(app)/clients" src/components/shell/nav.tsx
git commit -m "feat: add /clients admin page with client creation and invite links"
```

---

### Task 9: Lock in the existing operator-only campaign creation restriction with tests

Investigation confirmed `src/app/(app)/campaigns/page.tsx:25` (`redirect('/crm')` for non-operators) and `src/app/api/campaigns/route.ts:27-29` (403 JSON for non-operators) **already** restrict campaign creation to the operator role — this was true before this plan. There is currently no automated test guarding it, so a future change could silently regress it. This task only adds the missing regression test; it does not change any production behavior.

**Files:**
- Create: `src/app/api/campaigns/route.test.ts`

**Interfaces:**
- Consumes: nothing new — mocks the same dependencies Task 3's test mocks (`requireUser`, `createAdminClient`, `insertCampaign`, `logEvent`)

- [ ] **Step 1: Write the tests**

```ts
// src/app/api/campaigns/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const insertCampaignMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({ insertCampaign: (...a: unknown[]) => insertCampaignMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

const validBody = {
  clientId: '11111111-1111-1111-1111-111111111111',
  name: 'Q3 campaign',
  valueProp: 'We save you time',
}

beforeEach(() => {
  requireUserMock.mockReset()
  insertCampaignMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/campaigns', () => {
  it('should return 403 when the caller has the client role', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(req(validBody))
    expect(res.status).toBe(403)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })

  it('should return 400 on validation error', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    const res = await POST(req({ ...validBody, name: '' }))
    expect(res.status).toBe(400)
  })

  it('should create the campaign for an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })
    const res = await POST(req(validBody))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', name: 'Q3 campaign' } })
  })
})
```

- [ ] **Step 2: Run tests to verify they pass immediately** (this is a regression test for existing behavior, not TDD-red-then-green — confirm it's already green)

Run: `pnpm vitest run src/app/api/campaigns/route.test.ts`
Expected: PASS, 3 tests green, with **no changes to `route.ts`**. If any test fails, that means the production restriction has already regressed — stop and investigate `src/app/api/campaigns/route.ts:27-29` before continuing this plan.

- [ ] **Step 3: Commit**

```bash
git add src/app/api/campaigns/route.test.ts
git commit -m "test: lock in operator-only campaign creation with a regression test"
```

---

### Task 10: DB migration — add `p_client_id` to `analytics_overview` and `analytics_daily`

Adds an optional trailing `p_client_id uuid default null` parameter to the two Postgres functions backing the Analytics dashboard's top-line stats and daily trend, so an operator can scope them to one client. Existing callers that only pass `p_from`/`p_to`/`p_campaign_id` are unaffected — the new parameter defaults to `null` (no filter), exactly like `p_campaign_id` already does. Uses `DROP FUNCTION` + `CREATE FUNCTION` (not `CREATE OR REPLACE`) because adding a parameter changes the function's argument-type signature — `CREATE OR REPLACE` would leave the old 3-argument overload behind as dead code instead of replacing it.

**Files:**
- Create: `supabase/migrations/0009_analytics_client_filter.sql`
- Modify: `src/types/database.ts:545-571` (the `analytics_overview` and `analytics_daily` `Args` types — this file is hand-authored to match migrations exactly, per its own header comment)

**Interfaces:**
- Produces: `public.analytics_overview(p_from, p_to, p_campaign_id default null, p_client_id default null)` — same return columns as before
- Produces: `public.analytics_daily(p_from, p_to, p_campaign_id default null, p_client_id default null)` — same return columns as before
- Consumes: nothing from earlier tasks

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/0009_analytics_client_filter.sql
--
-- Adds an optional p_client_id filter to analytics_overview / analytics_daily,
-- so an operator (who bypasses RLS via is_operator()) can scope the dashboard
-- to one client at a time. A client-role caller is already restricted to their
-- own client_id by RLS regardless of this parameter — see the SECURITY INVOKER
-- note at the top of 0008_analytics.sql, which still applies unchanged.
--
-- Every filtered table already carries its own client_id column, so this
-- filters directly on that column rather than joining through campaigns.

drop function if exists public.analytics_overview(timestamptz, timestamptz, uuid);

create function public.analytics_overview(
  p_from         timestamptz,
  p_to           timestamptz,
  p_campaign_id  uuid default null,
  p_client_id    uuid default null
)
returns table (
  leads_discovered        bigint,
  leads_verified          bigint,
  cases_created           bigint,
  emails_sent             bigint,
  first_touch_sent        bigint,
  followups_sent          bigint,
  emails_bounced          bigint,
  emails_failed           bigint,
  replies_received        bigint,
  leads_contacted         bigint,
  leads_replied           bigint,
  suppressions_added      bigint,
  active_sequences        bigint
)
language sql
stable
as $$
  select
    -- leads_discovered
    (select count(*) from public.leads l
      where l.created_at >= p_from and l.created_at < p_to
        and (p_campaign_id is null or l.campaign_id = p_campaign_id)
        and (p_client_id is null or l.client_id = p_client_id)),
    -- leads_verified
    (select count(*) from public.leads l
      where l.created_at >= p_from and l.created_at < p_to
        and l.email_status = 'verified'
        and (p_campaign_id is null or l.campaign_id = p_campaign_id)
        and (p_client_id is null or l.client_id = p_client_id)),
    -- cases_created
    (select count(*) from public.cases c
      where c.created_at >= p_from and c.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or c.client_id = p_client_id)),
    -- emails_sent
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- first_touch_sent (sequence_step 0 is the cold open)
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.sequence_step = 0
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- followups_sent
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.sequence_step > 0
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- emails_bounced
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status = 'bounced'
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- emails_failed
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status = 'failed'
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- replies_received
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'inbound'
        and e.created_at >= p_from and e.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- leads_contacted (distinct people we actually emailed in the window)
    (select count(distinct e.lead_id) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.lead_id is not null
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- leads_replied (distinct people who wrote back in the window)
    (select count(distinct e.lead_id) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'inbound'
        and e.lead_id is not null
        and e.created_at >= p_from and e.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- suppressions_added. Suppressions carry no campaign_id, so this
    -- intentionally ignores p_campaign_id (the UI labels it as such), but it
    -- does honour p_client_id since suppressions do carry client_id.
    (select count(*) from public.suppressions s
      where s.created_at >= p_from and s.created_at < p_to
        and (p_client_id is null or s.client_id = p_client_id)),
    -- active_sequences (SNAPSHOT: follow-up cadences still running)
    (select count(*) from public.sequences q
       left join public.cases c on c.id = q.case_id
      where q.state = 'active'
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or q.client_id = p_client_id));
$$;

drop function if exists public.analytics_daily(timestamptz, timestamptz, uuid);

create function public.analytics_daily(
  p_from        timestamptz,
  p_to          timestamptz,
  p_campaign_id uuid default null,
  p_client_id   uuid default null
)
returns table (
  day              date,
  leads_discovered bigint,
  emails_sent      bigint,
  replies_received bigint
)
language sql
stable
as $$
  with days as (
    select generate_series(
             date_trunc('day', p_from),
             date_trunc('day', p_to - interval '1 microsecond'),
             interval '1 day'
           )::date as day
  ),
  discovered as (
    select date_trunc('day', l.created_at)::date as day, count(*) as n
      from public.leads l
     where l.created_at >= p_from and l.created_at < p_to
       and (p_campaign_id is null or l.campaign_id = p_campaign_id)
       and (p_client_id is null or l.client_id = p_client_id)
     group by 1
  ),
  sent as (
    select date_trunc('day', coalesce(e.sent_at, e.created_at))::date as day, count(*) as n
      from public.emails e
      left join public.cases c on c.id = e.case_id
     where e.direction = 'outbound'
       and e.status in ('sent', 'delivered', 'bounced')
       and coalesce(e.sent_at, e.created_at) >= p_from
       and coalesce(e.sent_at, e.created_at) < p_to
       and (p_campaign_id is null or c.campaign_id = p_campaign_id)
       and (p_client_id is null or e.client_id = p_client_id)
     group by 1
  ),
  replies as (
    select date_trunc('day', e.created_at)::date as day, count(*) as n
      from public.emails e
      left join public.cases c on c.id = e.case_id
     where e.direction = 'inbound'
       and e.created_at >= p_from and e.created_at < p_to
       and (p_campaign_id is null or c.campaign_id = p_campaign_id)
       and (p_client_id is null or e.client_id = p_client_id)
     group by 1
  )
  select d.day,
         coalesce(discovered.n, 0),
         coalesce(sent.n, 0),
         coalesce(replies.n, 0)
    from days d
    left join discovered on discovered.day = d.day
    left join sent       on sent.day = d.day
    left join replies    on replies.day = d.day
   order by d.day;
$$;

grant execute on function public.analytics_overview(timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.analytics_daily(timestamptz, timestamptz, uuid, uuid)    to authenticated;
```

- [ ] **Step 2: Apply the migration locally and verify it compiles**

Run: `supabase start` (if not already running), then `supabase migration up`
Expected: migration `0009_analytics_client_filter.sql` applies with no SQL errors; `supabase db diff` shows no drift afterward.

- [ ] **Step 3: Update `src/types/database.ts`**

At line 546 (inside `analytics_overview.Args`), change:
```ts
Args: { p_from: string; p_to: string; p_campaign_id?: string | null }
```
to:
```ts
Args: { p_from: string; p_to: string; p_campaign_id?: string | null; p_client_id?: string | null }
```

At line 564 (inside `analytics_daily.Args`), make the identical change.

- [ ] **Step 4: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/0009_analytics_client_filter.sql src/types/database.ts
git commit -m "feat: add p_client_id filter to analytics_overview and analytics_daily"
```

---

### Task 11: `src/lib/db/analytics.ts` — thread `clientId` through `getOverviewMetrics`/`getDailyMetrics`

**Files:**
- Modify: `src/lib/db/analytics.ts`
- Modify: `src/lib/db/analytics.test.ts`

**Interfaces:**
- Consumes: the new `p_client_id` parameter from Task 10
- Produces: `MetricsRange` gains `clientId: string | null` (now required on every call site — Task 14 is the only production call site and is updated there)

- [ ] **Step 1: Update the failing/changed tests first**

In `src/lib/db/analytics.test.ts`, change line 17's shared fixture:
```ts
const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-21T00:00:00.000Z', campaignId: null, clientId: null }
```

Add a new assertion in the existing `describe('getOverviewMetrics', ...)` block (after the existing "should pass the campaign filter through" test, matching its structure):
```ts
it('should pass the client filter through to the rpc call', async () => {
  const { supabase, rpc } = mockRpc({ data: [overviewRow], error: null })
  await getOverviewMetrics(supabase, { ...RANGE, clientId: 'client-1' })
  expect(rpc).toHaveBeenCalledWith('analytics_overview', {
    p_from: RANGE.from,
    p_to: RANGE.to,
    p_campaign_id: null,
    p_client_id: 'client-1',
  })
})
```

Add the equivalent in `describe('getDailyMetrics', ...)`:
```ts
it('should pass the client filter through to the rpc call', async () => {
  const { supabase, rpc } = mockRpc({ data: [], error: null })
  await getDailyMetrics(supabase, { ...RANGE, clientId: 'client-1' })
  expect(rpc).toHaveBeenCalledWith('analytics_daily', {
    p_from: RANGE.from,
    p_to: RANGE.to,
    p_campaign_id: null,
    p_client_id: 'client-1',
  })
})
```

- [ ] **Step 2: Run tests to verify the new assertions fail**

Run: `pnpm vitest run src/lib/db/analytics.test.ts`
Expected: FAIL on the two new tests — `rpc` was called without `p_client_id`

- [ ] **Step 3: Implement**

In `src/lib/db/analytics.ts`, change the `MetricsRange` interface:
```ts
export interface MetricsRange {
  from: string
  to: string
  campaignId: string | null
  clientId: string | null
}
```

Change `getOverviewMetrics`:
```ts
export async function getOverviewMetrics(
  supabase: SupabaseClient<Database>,
  { from, to, campaignId, clientId }: MetricsRange,
): Promise<OverviewMetrics> {
  const { data, error } = await supabase.rpc('analytics_overview', {
    p_from: from,
    p_to: to,
    p_campaign_id: campaignId,
    p_client_id: clientId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load analytics overview', {
      from,
      to,
      campaignId,
      clientId,
      cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  const row = data && data.length > 0 ? data[0]! : null
  if (!row) return ZERO_OVERVIEW
  return {
    leadsDiscovered: row.leads_discovered,
    leadsVerified: row.leads_verified,
    casesCreated: row.cases_created,
    emailsSent: row.emails_sent,
    firstTouchSent: row.first_touch_sent,
    followupsSent: row.followups_sent,
    emailsBounced: row.emails_bounced,
    emailsFailed: row.emails_failed,
    repliesReceived: row.replies_received,
    leadsContacted: row.leads_contacted,
    leadsReplied: row.leads_replied,
    suppressionsAdded: row.suppressions_added,
    activeSequences: row.active_sequences,
  }
}
```

Change `getDailyMetrics`:
```ts
export async function getDailyMetrics(
  supabase: SupabaseClient<Database>,
  { from, to, campaignId, clientId }: MetricsRange,
): Promise<DailyMetric[]> {
  const { data, error } = await supabase.rpc('analytics_daily', {
    p_from: from,
    p_to: to,
    p_campaign_id: campaignId,
    p_client_id: clientId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load daily analytics', {
      from,
      to,
      campaignId,
      clientId,
      cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({
    day: row.day,
    leadsDiscovered: row.leads_discovered,
    emailsSent: row.emails_sent,
    repliesReceived: row.replies_received,
  }))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/analytics.test.ts`
Expected: PASS, all tests green (existing tests still pass because `RANGE` now includes `clientId: null`, which maps to `p_client_id: null` — behaviorally identical to before this task for every pre-existing call)

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/analytics.ts src/lib/db/analytics.test.ts
git commit -m "feat: thread clientId through getOverviewMetrics and getDailyMetrics"
```

---

### Task 12: Integration test — operator scoping to a single client

Extends the existing RLS integration test fixture (two clients, A and B, already seeded in `beforeAll`) to cover the new parameter. This is the only place in the test suite that exercises the real Postgres function body rather than a mocked `rpc` call, so it is the correct place to prove the SQL filter itself is correct, not just that the JS wrapper passes the parameter through.

**Files:**
- Modify: `src/lib/db/analytics.integration.test.ts`

**Interfaces:**
- Consumes: `clientAId`, `clientBId`, `clientBEmail` (operator) already set up in the file's `beforeAll`

- [ ] **Step 1: Add the test**

Append inside the existing `describe('analytics_overview RLS scoping', ...)` block, after the "should honour a campaign filter within the caller's own client" test:

```ts
it('should let an operator scope the overview to a single client', async () => {
  const supabase = await signedInClient(clientBEmail) // clientBEmail is seeded as an operator
  const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: null, clientId: clientAId })
  expect(overview.leadsDiscovered).toBe(3)
  expect(overview.leadsVerified).toBe(2)
})

it('should return zero rows for an operator scoped to a client with no matching data in range', async () => {
  const supabase = await signedInClient(clientBEmail)
  const overview = await getOverviewMetrics(supabase, {
    from: '1990-01-01T00:00:00.000Z',
    to: '1990-01-02T00:00:00.000Z',
    campaignId: null,
    clientId: clientAId,
  })
  expect(overview.leadsDiscovered).toBe(0)
})
```

Update every pre-existing call to `getOverviewMetrics` in this file (the three inside `describe('analytics_overview RLS scoping', ...)`) to add `clientId: null`, since `MetricsRange` now requires it — e.g. `{ ...RANGE, campaignId: null }` becomes `{ ...RANGE, campaignId: null, clientId: null }`.

- [ ] **Step 2: Run the integration suite**

Run: `set -a; . ./.env.local; set +a; pnpm test:integration`
Expected: PASS, including the two new tests (requires a local `supabase start` with migration `0009` applied from Task 10)

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/analytics.integration.test.ts
git commit -m "test: cover operator single-client scoping in the analytics integration suite"
```

---

### Task 13: `src/lib/analytics/range.ts` — accept a `client` search param

**Files:**
- Modify: `src/lib/analytics/range.ts`
- Modify: `src/lib/analytics/range.test.ts`

**Interfaces:**
- Produces: `analyticsSearchParamsSchema` gains `client: z.string().uuid().optional()`
- Consumes: nothing new

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/analytics/range.test.ts`, inside `describe('analyticsSearchParamsSchema', ...)`:
```ts
it('should accept a uuid client filter', () => {
  const id = '22222222-2222-4222-8222-222222222222'
  const parsed = analyticsSearchParamsSchema.safeParse({ client: id })
  expect(parsed.success && parsed.data.client).toBe(id)
})

it('should reject a non-uuid client filter', () => {
  expect(analyticsSearchParamsSchema.safeParse({ client: 'nope' }).success).toBe(false)
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/analytics/range.test.ts`
Expected: FAIL — `data.client` is `undefined` where a uuid was expected; the reject case unexpectedly succeeds

- [ ] **Step 3: Implement**

In `src/lib/analytics/range.ts`, change:
```ts
export const analyticsSearchParamsSchema = z.object({
  days: z.coerce.number().int().optional(),
  campaign: z.string().uuid().optional(),
})
```
to:
```ts
export const analyticsSearchParamsSchema = z.object({
  days: z.coerce.number().int().optional(),
  campaign: z.string().uuid().optional(),
  client: z.string().uuid().optional(),
})
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/analytics/range.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
git add src/lib/analytics/range.ts src/lib/analytics/range.test.ts
git commit -m "feat: accept a client search param in the analytics range schema"
```

---

### Task 14: `/analytics` page + filters — client selector for the operator

Adds a "Client" dropdown next to the existing "Campaign" dropdown, visible only to operators (a client-role viewer only ever sees their own data, so the selector would be redundant for them). Selecting a client also narrows the Campaign dropdown to that client's campaigns — combining an unrelated client + campaign filter would silently return zero rows, which is confusing UX, so this task keeps the two filters consistent with each other client-side (no extra query — the operator's full campaign list is already fetched by the existing `listCampaignsForClient(supabase, appUser.client_id)` call, which for an operator's `null` client_id already returns every campaign; this task only filters that array before it reaches the UI).

**Files:**
- Modify: `src/app/(app)/analytics/filters.tsx`
- Modify: `src/app/(app)/analytics/page.tsx`

**Interfaces:**
- Consumes: `analyticsSearchParamsSchema` (Task 13), `getOverviewMetrics`/`getDailyMetrics` with `clientId` (Task 11), `listClients` (`@/lib/db/clients`, from the earlier client-admin tasks)
- Produces: `/analytics?client=<uuid>` is a supported, shareable URL (matches the "View analytics" link added to the `/clients` page in Task 8)

- [ ] **Step 1: Update `filters.tsx`**

Add a `ClientOption` type, a `clients` prop, and a client `Select`, following the exact pattern the existing campaign `Select` already uses:

```tsx
// src/app/(app)/analytics/filters.tsx
'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { RANGE_OPTIONS, type RangeDays } from '@/lib/analytics/range'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface CampaignOption {
  id: string
  name: string
  clientId: string
}

export interface ClientOption {
  id: string
  name: string
}

interface AnalyticsFiltersProps {
  days: RangeDays
  campaignId: string | null
  clientId: string | null
  campaigns: CampaignOption[]
  clients: ClientOption[]
}

/** Sentinel for "no filter" — Radix Select forbids an empty item value. */
const ALL_CAMPAIGNS = '__all'
const ALL_CLIENTS = '__all'

// The current filter state arrives as props from the server, so this component
// never reads useSearchParams — it just rebuilds the URL from what it was given.
function buildHref(days: RangeDays, campaignId: string | null, clientId: string | null): string {
  const params = new URLSearchParams()
  params.set('days', String(days))
  if (campaignId) params.set('campaign', campaignId)
  if (clientId) params.set('client', clientId)
  return `/analytics?${params.toString()}`
}

export function AnalyticsFilters({
  days,
  campaignId,
  clientId,
  campaigns,
  clients,
}: AnalyticsFiltersProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const visibleCampaigns = clientId ? campaigns.filter((campaign) => campaign.clientId === clientId) : campaigns

  const onRangeClick = (nextDays: RangeDays): void => {
    startTransition(() => {
      router.push(buildHref(nextDays, campaignId, clientId))
    })
  }

  const onCampaignChange = (value: string): void => {
    const nextCampaign = value === ALL_CAMPAIGNS ? null : value
    startTransition(() => {
      router.push(buildHref(days, nextCampaign, clientId))
    })
  }

  const onClientChange = (value: string): void => {
    const nextClient = value === ALL_CLIENTS ? null : value
    // Switching clients drops the campaign filter — a campaign from a
    // different client would otherwise combine into an always-empty result.
    startTransition(() => {
      router.push(buildHref(days, null, nextClient))
    })
  }

  return (
    <div className="border-hairline flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border p-3">
      <div role="group" aria-label="Date range" className="flex items-center gap-1.5">
        <span className="text-faint mr-0.5 text-[11px]">Range</span>
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onRangeClick(option)}
            disabled={isPending}
            aria-pressed={option === days}
            className={cn(
              'tnum rounded-full px-2.5 py-1 text-[11px] font-medium',
              'transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
              'disabled:cursor-wait',
              option === days
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {option}d
          </button>
        ))}
      </div>

      {clients.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-faint text-[11px]">Client</span>
          <Select value={clientId ?? ALL_CLIENTS} onValueChange={onClientChange} disabled={isPending}>
            <SelectTrigger size="sm" className="w-[200px]" aria-label="Client">
              <SelectValue placeholder="All clients" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CLIENTS}>All clients</SelectItem>
              {clients.map((client) => (
                <SelectItem key={client.id} value={client.id}>
                  {client.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="text-faint text-[11px]">Campaign</span>
        <Select
          value={campaignId ?? ALL_CAMPAIGNS}
          onValueChange={onCampaignChange}
          disabled={isPending || visibleCampaigns.length === 0}
        >
          <SelectTrigger size="sm" className="w-[200px]" aria-label="Campaign">
            <SelectValue placeholder="All campaigns" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CAMPAIGNS}>All campaigns</SelectItem>
            {visibleCampaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isPending ? (
        <span role="status" className="text-faint text-[11px]">
          Updating…
        </span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Update `page.tsx`**

Change the imports and search-param parsing block:
```tsx
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listClients } from '@/lib/db/clients'
import {
  getOverviewMetrics,
  getDailyMetrics,
  getCampaignMetrics,
  getMailboxMetrics,
  getEventCounts,
} from '@/lib/db/analytics'
import { analyticsSearchParamsSchema, parseRangeDays, rangeFromDays } from '@/lib/analytics/range'
```

Replace the body from `const campaigns = ...` through the `Promise.all` block with:
```tsx
  const { appUser } = await requireUser()
  const supabase = await createServerClient()

  // URL params are untrusted input that reaches SQL — validate, then whitelist.
  const parsed = analyticsSearchParamsSchema.safeParse(await searchParams)
  const days = parseRangeDays(parsed.success ? parsed.data.days : undefined)
  const requestedCampaignId = parsed.success ? (parsed.data.campaign ?? null) : null
  const requestedClientId = parsed.success ? (parsed.data.client ?? null) : null

  const isOperator = appUser.role === 'operator'
  const [rawCampaigns, clientOptions] = await Promise.all([
    listCampaignsForClient(supabase, appUser.client_id),
    isOperator ? listClients(supabase) : Promise.resolve([]),
  ])
  const campaigns = rawCampaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    clientId: campaign.client_id,
  }))

  // Only an operator may filter by client; only honour a client that exists.
  const clientId =
    isOperator && clientOptions.some((client) => client.id === requestedClientId) ? requestedClientId : null
  // Only honour a campaign the viewer can actually see, and that belongs to
  // the selected client (if one is selected).
  const campaignId = campaigns.some(
    (campaign) => campaign.id === requestedCampaignId && (!clientId || campaign.clientId === clientId),
  )
    ? requestedCampaignId
    : null

  const { from, to } = rangeFromDays(days, new Date())
  const [overview, daily, byCampaign, mailboxes, eventCounts] = await Promise.all([
    getOverviewMetrics(supabase, { from, to, campaignId, clientId }),
    getDailyMetrics(supabase, { from, to, campaignId, clientId }),
    getCampaignMetrics(supabase, { from, to }),
    getMailboxMetrics(supabase),
    getEventCounts(supabase, { from, to, limit: EVENT_TYPE_LIMIT }),
  ])
```

Update the `scopedCampaigns` computation (still used by the "Campaigns" table section further down) to also respect the client filter:
```tsx
  const scopedCampaigns = byCampaign.filter(
    (row) => (!campaignId || row.campaignId === campaignId) && (!clientId || row.clientId === clientId),
  )
```

Update the `<AnalyticsFilters .../>` call to pass the two new props:
```tsx
      <AnalyticsFilters days={days} campaignId={campaignId} clientId={clientId} campaigns={campaigns} clients={clientOptions} />
```

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors (note: `getCampaignMetrics`'s return rows already carry `clientId` per `src/lib/db/analytics.ts`'s existing `CampaignMetrics` mapping — the `scopedCampaigns` filter above needs no new field)

- [ ] **Step 4: Manual smoke test**

Run: `pnpm dev`, sign in as the operator, visit `/clients`, click "View analytics" on a client with data. Confirm: the Client dropdown shows that client selected, the Campaign dropdown only lists that client's campaigns, all stat tiles/daily trend/campaign table reflect only that client's numbers, and switching back to "All clients" restores the full cross-client view. Then sign in as a client-role user and confirm the Client dropdown does not render on `/analytics` at all.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/analytics/filters.tsx" "src/app/(app)/analytics/page.tsx"
git commit -m "feat: add an operator-only client filter to the Analytics dashboard"
```

---

### Task 15: Update the roadmap

**Files:**
- Modify: `.claude/roadmap.md`

**Interfaces:** none — documentation only

- [ ] **Step 1: Append a dated section**

Append to the end of `.claude/roadmap.md`, following the file's existing dated-section convention:

```markdown

## Client Admin Page + Account-Creation Links (2026-07-21)

Gives the operator a `/clients` page to see every client and its linked
logins, plus a way to provision a client login without ever handling a raw
password.

- [x] `src/lib/db/clients.ts` — client CRUD + `listClientRoleAppUsers`, `listClients` moved here from `campaigns.ts`.
- [x] `src/lib/supabase/list-auth-users.ts` — paginated `auth.admin.listUsers()` wrapper for joining `app_users` to an email.
- [x] `POST /api/clients` — operator-only client creation.
- [x] `POST /api/clients/[clientId]/invite` — generates a Supabase `generateLink({ type: 'invite' })` URL, links the resulting auth user to the client via `app_users`, with auth-user cleanup if the link insert fails.
- [x] `/auth/callback` + `/set-password` — exchanges the invite code for a session and lets the invited user set their password, reusing the existing `/login` page afterward.
- [x] `/clients` admin page, nav entry (operator-only, same pattern as `/campaigns`).
- [x] Regression test added confirming campaign creation was already, and remains, operator-only (`src/app/api/campaigns/route.test.ts`).
- [x] `supabase/migrations/0009_analytics_client_filter.sql` — optional `p_client_id` filter added to `analytics_overview`/`analytics_daily`, mirroring the existing `p_campaign_id` pattern; RLS/`SECURITY INVOKER` semantics for client-role viewers unchanged.
- [x] `/analytics` gains an operator-only "Client" filter (`AnalyticsFilters`), scoping every stat tile, the daily trend, and the campaign table to one client at a time; the Campaign dropdown narrows to that client's campaigns to avoid an always-empty combined filter.
- [x] `/clients` page links each client row straight to `/analytics?client=<id>`.

**Operational notes:**
- Supabase Dashboard → Authentication → URL Configuration must allow-list `${APP_URL}/auth/callback`, or invite links will fail to redirect.
- Migration `0009_analytics_client_filter.sql` must be applied (`supabase db push` / `supabase migration up`) to the target project before the client analytics filter works.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: update roadmap.md with client admin + invite links progress"
```

---

## Self-Review

**Spec coverage:**
- "Admin page to manage all my clients" → Task 8 (`/clients` page: list, create, view linked logins).
- "Remove the ability to create campaigns [for] clients, only I can create them" → already true in the codebase (Task 9 adds the missing regression test rather than re-implementing something that already works).
- "I should be able to create account creation links" → Tasks 3-6 (client creation API, invite-link API, callback exchange, set-password page) plus the "Invite user" dialog in Task 8 that surfaces the generated link.
- "I also want to see all clients analytics one by one" → Tasks 10-14: `p_client_id` added to the analytics SQL functions, threaded through `getOverviewMetrics`/`getDailyMetrics`, exposed as a `client` URL param, and surfaced as an operator-only dropdown on `/analytics` (plus a direct "View analytics" link per row on `/clients`, wired into Task 8) — the operator picks one client at a time, matching "one by one" literally rather than trying to show every client on one screen.

**Placeholder scan:** no `TBD`/`TODO`/`implement later` strings; every step shows complete code, not descriptions of code.

**Type consistency:** `ClientRow`, `AppUserRow`, `AppUserInsert` (Task 1) are the exact names imported in Tasks 3, 4, and 8. `AuthUserSummary` (Task 2) matches its use in Task 8. `CLIENT_STATUS` (Task 7) matches its use in Task 8. The invite route's response shape `{ ok: true, link, email }` (Task 4) matches what `invite-user-dialog.tsx` (Task 8) reads. `MetricsRange.clientId` (Task 11) matches the call sites added in Task 14. `CampaignOption.clientId` and `ClientOption` (Task 14's `filters.tsx`) match the shapes built from `listCampaignsForClient`/`listClients` in Task 14's `page.tsx`. The `/analytics?client=<id>` link added to Task 8's `/clients` page matches the `client` param `analyticsSearchParamsSchema` (Task 13) and `page.tsx` (Task 14) both read.
