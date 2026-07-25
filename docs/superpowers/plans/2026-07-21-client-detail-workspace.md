# Client Detail Workspace Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn each client row on `/clients` into a full detail page at `/clients/[id]` — same header+tabs shape as `/cases/[id]` — with campaign creation, full analytics, and user management all inline (no redirects), plus rename and three lifecycle actions: pause operations, archive (stop operations + block login, keep the accounts), and permanently delete (3-step confirm).

**Architecture:** `/clients/[id]` mirrors `/cases/[id]`'s pattern exactly: an always-visible header (identity + status + lifecycle buttons) above a `Tabs` component (Campaigns / Analytics / Users), URL-driven via `searchParams` so filters and the active tab are shareable links, consistent with how `/analytics` already works. The three lifecycle actions map onto the existing `clients.status` enum (`active` / `paused` / `archived` — no schema change needed) plus real Supabase Auth bans for "archive" and real cascading deletes (already `on delete cascade` in the schema) plus Auth-user cleanup for "delete." Because `clients.status` driving a bulk `campaigns.status` flip is the actual mechanism that stops the pipeline, this plan also closes a gap found during investigation: `write` and `research` route handlers never checked `campaign.status`, and `runFollowupStep` didn't either — so today, pausing a campaign would stop new discovery but **not** stop an already-queued first-touch send or a scheduled follow-up nudge. Three small route/lib guards fix that, reusing data those functions already fetch.

**Tech Stack:** Next.js 16 (App Router, Route Handlers with `Promise` params), Supabase (`@supabase/supabase-js` admin client — `updateUserById` for bans, `deleteUser` for hard delete), Zod, Vitest, existing shadcn/ui (`Tabs`, `Dialog`) + Phosphor icons.

## Global Constraints

- Same as the prior plan (`docs/superpowers/plans/2026-07-21-client-admin-and-invites.md`): strict TypeScript, no `any`, Zod at every boundary, `AppError` with a `code` on every thrown error, data access only in `src/lib/db/`, named exports except pages, every mutation writes an `events` row, new routes get `loading.tsx`/`error.tsx`.
- This plan assumes the prior plan is fully implemented (confirmed on disk: `src/app/(app)/clients/`, `src/app/api/clients/`, `supabase/migrations/0009_analytics_client_filter.sql`, and the `client` filter in `/analytics` all exist as designed).
- Every FK to `clients` already carries `on delete cascade` (`supabase/migrations/0001_initial_schema.sql`), so a hard delete of a client row genuinely wipes every campaign/case/lead/email/sequence/mailbox/suppression/event/app_users row for that client at the database level — Task 8's confirmation UI must make that unambiguous before it fires.
- **Delete-semantics decision from the user:** three distinct, separately-triggerable actions — (1) "stop all operations" (pause, reversible, login unaffected), (2) "delete everything permanently" (irreversible, 3-step confirm), (3) "stop operations and block login, but keep the accounts" (archive, reversible, login banned not deleted).

---

## Group A — Client lifecycle: DB + API

### Task 1: `src/lib/db/clients.ts` — rename, status update, cascading delete

**Files:**
- Modify: `src/lib/db/clients.ts`
- Modify: `src/lib/db/clients.test.ts`

**Interfaces:**
- Produces: `updateClientName(supabase, id, name): Promise<ClientRow>`, `updateClientStatus(supabase, id, status: ClientRow['status']): Promise<ClientRow>`, `deleteClientCascade(supabase, id): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/db/clients.test.ts`:
```ts
describe('updateClientName', () => {
  it('should return the renamed client row', async () => {
    const row = { id: 'c1', name: 'New Name' }
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }) }),
    } as never
    const result = await updateClientName(supabase, 'c1', 'New Name')
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
    } as never
    await expect(updateClientName(supabase, 'c1', 'New Name')).rejects.toBeInstanceOf(AppError)
  })
})

describe('updateClientStatus', () => {
  it('should return the client row with the new status', async () => {
    const row = { id: 'c1', status: 'paused' }
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }) }) }),
    } as never
    const result = await updateClientStatus(supabase, 'c1', 'paused')
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }) }) }),
    } as never
    await expect(updateClientStatus(supabase, 'c1', 'paused')).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteClientCascade', () => {
  it('should resolve when the delete succeeds', async () => {
    const supabase = { from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: null }) }) }) } as never
    await expect(deleteClientCascade(supabase, 'c1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    const supabase = {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(deleteClientCascade(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})
```

Update the import line at the top of `clients.test.ts` to include the three new names:
```ts
import {
  listClients,
  listClientsFull,
  insertClient,
  getClientById,
  listClientRoleAppUsers,
  insertAppUser,
  updateClientName,
  updateClientStatus,
  deleteClientCascade,
} from './clients'
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: FAIL — the three new names don't exist yet

- [ ] **Step 3: Implement**

Append to `src/lib/db/clients.ts`:
```ts
export async function updateClientName(
  supabase: SupabaseClient<Database>,
  id: string,
  name: string,
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update({ name }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to rename client', { id, cause: error?.message })
  }
  return data
}

export async function updateClientStatus(
  supabase: SupabaseClient<Database>,
  id: string,
  status: ClientRow['status'],
): Promise<ClientRow> {
  const { data, error } = await supabase.from('clients').update({ status }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client status', { id, status, cause: error?.message })
  }
  return data
}

// Every FK to clients carries `on delete cascade` — this permanently removes
// every campaign, case, lead, email, sequence, mailbox, suppression, event,
// and app_users row for this client. Callers must delete the corresponding
// Supabase Auth users separately (auth.users has no FK to clients), and must
// have already confirmed this with the operator before calling.
export async function deleteClientCascade(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase.from('clients').delete().eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete client', { id, cause: error.message })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/clients.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts
git commit -m "feat: add rename, status update, and cascading delete to lib/db/clients"
```

---

### Task 2: `src/lib/db/campaigns.ts` — bulk pause/resume for a client

**Files:**
- Modify: `src/lib/db/campaigns.ts`
- Modify: `src/lib/db/campaigns.test.ts`

**Interfaces:**
- Produces: `pauseActiveCampaignsForClient(supabase, clientId): Promise<void>`, `resumeCampaignsForClient(supabase, clientId): Promise<void>`

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/db/campaigns.test.ts`:
```ts
describe('pauseActiveCampaignsForClient', () => {
  it('should resolve when the bulk update succeeds', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
    } as never
    await expect(pauseActiveCampaignsForClient(supabase, 'c1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the bulk update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(pauseActiveCampaignsForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})

describe('resumeCampaignsForClient', () => {
  it('should resolve when the bulk update succeeds', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: null }) }) }) }),
    } as never
    await expect(resumeCampaignsForClient(supabase, 'c1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the bulk update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }) }),
    } as never
    await expect(resumeCampaignsForClient(supabase, 'c1')).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `pauseActiveCampaignsForClient, resumeCampaignsForClient` to the existing import from `./campaigns` at the top of the file.

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: FAIL — the two new names don't exist yet

- [ ] **Step 3: Implement**

Append to `src/lib/db/campaigns.ts`:
```ts
// Only flips campaigns that were actually running — an already-paused or
// already-archived campaign the operator set aside deliberately stays as-is.
export async function pauseActiveCampaignsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ status: 'paused' })
    .eq('client_id', clientId)
    .eq('status', 'active')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to pause campaigns for client', { clientId, cause: error.message })
  }
}

// Symmetric counterpart used by both "resume" and "reactivate". There is no
// per-campaign pause toggle in this product yet, so every one of this
// client's paused campaigns is assumed to have been paused by the client-level
// action being reversed here.
export async function resumeCampaignsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ status: 'active' })
    .eq('client_id', clientId)
    .eq('status', 'paused')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to resume campaigns for client', { clientId, cause: error.message })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat: add bulk pause/resume of a client's campaigns"
```

---

### Task 3: `src/lib/supabase/auth-admin.ts` — ban, unban, and delete auth users

**Files:**
- Create: `src/lib/supabase/auth-admin.ts`
- Create: `src/lib/supabase/auth-admin.test.ts`

**Interfaces:**
- Produces: `banAuthUsers(admin, userIds: string[]): Promise<void>`, `unbanAuthUsers(admin, userIds: string[]): Promise<void>`, `deleteAuthUsers(admin, userIds: string[]): Promise<void>`

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/supabase/auth-admin.test.ts
import { describe, it, expect, vi } from 'vitest'
import { banAuthUsers, unbanAuthUsers, deleteAuthUsers } from './auth-admin'
import { AppError } from '@/lib/errors/app-error'

function mockAdmin(fn: 'updateUserById' | 'deleteUser', impl: (...args: unknown[]) => Promise<{ error: unknown }>) {
  const mockFn = vi.fn(impl)
  return { admin: { auth: { admin: { [fn]: mockFn } } } as never, mockFn }
}

describe('banAuthUsers', () => {
  it('should call updateUserById with a long ban_duration for every id', async () => {
    const { admin, mockFn } = mockAdmin('updateUserById', () => Promise.resolve({ error: null }))
    await banAuthUsers(admin, ['u1', 'u2'])
    expect(mockFn).toHaveBeenCalledWith('u1', { ban_duration: '876000h' })
    expect(mockFn).toHaveBeenCalledWith('u2', { ban_duration: '876000h' })
  })

  it('should resolve when there are no ids', async () => {
    const { admin, mockFn } = mockAdmin('updateUserById', () => Promise.resolve({ error: null }))
    await expect(banAuthUsers(admin, [])).resolves.toBeUndefined()
    expect(mockFn).not.toHaveBeenCalled()
  })

  it('should throw EXTERNAL_ERROR when any ban fails', async () => {
    const { admin } = mockAdmin('updateUserById', () => Promise.resolve({ error: { message: 'boom' } }))
    await expect(banAuthUsers(admin, ['u1'])).rejects.toBeInstanceOf(AppError)
  })
})

describe('unbanAuthUsers', () => {
  it("should call updateUserById with ban_duration 'none' for every id", async () => {
    const { admin, mockFn } = mockAdmin('updateUserById', () => Promise.resolve({ error: null }))
    await unbanAuthUsers(admin, ['u1'])
    expect(mockFn).toHaveBeenCalledWith('u1', { ban_duration: 'none' })
  })

  it('should throw EXTERNAL_ERROR when any unban fails', async () => {
    const { admin } = mockAdmin('updateUserById', () => Promise.resolve({ error: { message: 'boom' } }))
    await expect(unbanAuthUsers(admin, ['u1'])).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteAuthUsers', () => {
  it('should call deleteUser for every id', async () => {
    const { admin, mockFn } = mockAdmin('deleteUser', () => Promise.resolve({ error: null }))
    await deleteAuthUsers(admin, ['u1', 'u2'])
    expect(mockFn).toHaveBeenCalledWith('u1')
    expect(mockFn).toHaveBeenCalledWith('u2')
  })

  it('should throw EXTERNAL_ERROR when any delete fails', async () => {
    const { admin } = mockAdmin('deleteUser', () => Promise.resolve({ error: { message: 'boom' } }))
    await expect(deleteAuthUsers(admin, ['u1'])).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/supabase/auth-admin.test.ts`
Expected: FAIL — `Cannot find module './auth-admin'`

- [ ] **Step 3: Implement**

```ts
// src/lib/supabase/auth-admin.ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

// Supabase has no "ban forever" value — ~100 years is the documented
// convention for an effectively permanent ban that `unbanAuthUsers` can still
// reverse (accounts are banned, never deleted, for the "archive" action).
const PERMANENT_BAN_DURATION = '876000h'

export async function banAuthUsers(admin: SupabaseClient<Database>, userIds: string[]): Promise<void> {
  const results = await Promise.all(
    userIds.map((id) => admin.auth.admin.updateUserById(id, { ban_duration: PERMANENT_BAN_DURATION })),
  )
  const failed = results.find((result) => result.error)
  if (failed?.error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to ban an auth user', { cause: failed.error.message })
  }
}

export async function unbanAuthUsers(admin: SupabaseClient<Database>, userIds: string[]): Promise<void> {
  const results = await Promise.all(
    userIds.map((id) => admin.auth.admin.updateUserById(id, { ban_duration: 'none' })),
  )
  const failed = results.find((result) => result.error)
  if (failed?.error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to unban an auth user', { cause: failed.error.message })
  }
}

// Called only after the corresponding clients row (and its cascaded app_users
// row) has already been deleted — auth.users has no FK to clients, so this is
// the only thing that removes the login itself.
export async function deleteAuthUsers(admin: SupabaseClient<Database>, userIds: string[]): Promise<void> {
  const results = await Promise.all(userIds.map((id) => admin.auth.admin.deleteUser(id)))
  const failed = results.find((result) => result.error)
  if (failed?.error) {
    throw new AppError('EXTERNAL_ERROR', 'Failed to delete an auth user', { cause: failed.error.message })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/supabase/auth-admin.test.ts`
Expected: PASS, 6 tests green

- [ ] **Step 5: Commit**

```bash
git add src/lib/supabase/auth-admin.ts src/lib/supabase/auth-admin.test.ts
git commit -m "feat: add ban/unban/delete helpers for Supabase auth users"
```

---

### Task 4: `PATCH /api/clients/[clientId]` — rename

**Files:**
- Create: `src/app/api/clients/[clientId]/route.ts`
- Create: `src/app/api/clients/[clientId]/route.test.ts`

**Interfaces:**
- Consumes: `getClientById`, `updateClientName` (Task 1)
- Produces: `PATCH /api/clients/:clientId` accepting `{ name: string }`, returns `{ ok: true, client: ClientRow }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/clients/[clientId]/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientNameMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientName: (...a: unknown[]) => updateClientNameMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { PATCH } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientNameMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('PATCH /api/clients/[clientId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(req({ name: 'New Name' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await PATCH(req({ name: 'New Name' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 on validation error', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Old' })
    const res = await PATCH(req({ name: '' }), ctx('c1'))
    expect(res.status).toBe(400)
  })

  it('should rename and log the event on success', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Old' })
    updateClientNameMock.mockResolvedValue({ id: 'c1', name: 'New Name' })
    const res = await PATCH(req({ name: 'New Name' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'New Name' } })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.renamed' }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/clients/[clientId]/route.ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientName } from '@/lib/db/clients'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const renameSchema = z.object({
  name: z.string().min(1),
})

export async function PATCH(request: Request, context: { params: Promise<{ clientId: string }> }) {
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
    const body = renameSchema.parse(await request.json())
    const updated = await updateClientName(admin, clientId, body.name)
    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.renamed',
        payload: { from: client.name, to: updated.name },
      })
    } catch {
      // Audit logging is best-effort — the rename already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
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

Run: `pnpm vitest run "src/app/api/clients/[clientId]/route.test.ts"`
Expected: PASS, 4 tests green

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/route.ts" "src/app/api/clients/[clientId]/route.test.ts"
git commit -m "feat: add PATCH /api/clients/[clientId] to rename a client"
```

---

### Task 5: `POST /api/clients/[clientId]/pause` — stop operations

**Files:**
- Create: `src/app/api/clients/[clientId]/pause/route.ts`
- Create: `src/app/api/clients/[clientId]/pause/route.test.ts`

**Interfaces:**
- Consumes: `getClientById`, `updateClientStatus` (Task 1), `pauseActiveCampaignsForClient` (Task 2)
- Produces: `POST /api/clients/:clientId/pause`, returns `{ ok: true, client: ClientRow }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/clients/[clientId]/pause/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientStatusMock = vi.fn()
const pauseCampaignsMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientStatus: (...a: unknown[]) => updateClientStatusMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ pauseActiveCampaignsForClient: (...a: unknown[]) => pauseCampaignsMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientStatusMock.mockReset()
  pauseCampaignsMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/pause', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(403)
    expect(getClientByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should pause campaigns and set status to paused', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'paused' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, client: { id: 'c1', name: 'Acme', status: 'paused' } })
    expect(pauseCampaignsMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(updateClientStatusMock).toHaveBeenCalledWith(expect.anything(), 'c1', 'paused')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.paused' }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/pause/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/clients/[clientId]/pause/route.ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientStatus } from '@/lib/db/clients'
import { pauseActiveCampaignsForClient } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ clientId: string }> }) {
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
    await pauseActiveCampaignsForClient(admin, clientId)
    const updated = await updateClientStatus(admin, clientId, 'paused')
    try {
      await logEvent({ clientId, actor: `human:${appUser.id}`, type: 'client.paused', payload: {} })
    } catch {
      // Audit logging is best-effort — the pause already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/pause/route.test.ts"`
Expected: PASS, 3 tests green

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/pause"
git commit -m "feat: add POST /api/clients/[clientId]/pause"
```

---

### Task 6: `POST /api/clients/[clientId]/resume` — restore operations (and login, if archived)

**Files:**
- Create: `src/app/api/clients/[clientId]/resume/route.ts`
- Create: `src/app/api/clients/[clientId]/resume/route.test.ts`

**Interfaces:**
- Consumes: `getClientById`, `updateClientStatus` (Task 1), `resumeCampaignsForClient` (Task 2), `listClientRoleAppUsers` (existing), `unbanAuthUsers` (Task 3)
- Produces: `POST /api/clients/:clientId/resume`, returns `{ ok: true, client: ClientRow }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/clients/[clientId]/resume/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientStatusMock = vi.fn()
const resumeCampaignsMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const unbanAuthUsersMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientStatus: (...a: unknown[]) => updateClientStatusMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ resumeCampaignsForClient: (...a: unknown[]) => resumeCampaignsMock(...a) }))
vi.mock('@/lib/supabase/auth-admin', () => ({ unbanAuthUsers: (...a: unknown[]) => unbanAuthUsersMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientStatusMock.mockReset()
  resumeCampaignsMock.mockReset().mockResolvedValue(undefined)
  listClientRoleAppUsersMock.mockReset().mockResolvedValue([])
  unbanAuthUsersMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/resume', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should resume campaigns and set status to active without unbanning from a paused state', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'paused' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(resumeCampaignsMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(unbanAuthUsersMock).not.toHaveBeenCalled()
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.resumed' }))
  })

  it('should unban every client-role user when resuming from archived', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'archived' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    listClientRoleAppUsersMock.mockResolvedValue([
      { id: 'u1', client_id: 'c1' },
      { id: 'u2', client_id: 'other' },
    ])
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(unbanAuthUsersMock).toHaveBeenCalledWith(expect.anything(), ['u1'])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/resume/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/clients/[clientId]/resume/route.ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientStatus, listClientRoleAppUsers } from '@/lib/db/clients'
import { resumeCampaignsForClient } from '@/lib/db/campaigns'
import { unbanAuthUsers } from '@/lib/supabase/auth-admin'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ clientId: string }> }) {
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
    await resumeCampaignsForClient(admin, clientId)

    if (client.status === 'archived') {
      const appUsers = await listClientRoleAppUsers(admin)
      const userIds = appUsers.filter((row) => row.client_id === clientId).map((row) => row.id)
      await unbanAuthUsers(admin, userIds)
    }

    const updated = await updateClientStatus(admin, clientId, 'active')
    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.resumed',
        payload: { from: client.status },
      })
    } catch {
      // Audit logging is best-effort — the resume already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/resume/route.test.ts"`
Expected: PASS, 4 tests green

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/resume"
git commit -m "feat: add POST /api/clients/[clientId]/resume"
```

---

### Task 7: `POST /api/clients/[clientId]/archive` — stop operations and block login

**Files:**
- Create: `src/app/api/clients/[clientId]/archive/route.ts`
- Create: `src/app/api/clients/[clientId]/archive/route.test.ts`

**Interfaces:**
- Consumes: `getClientById`, `updateClientStatus`, `listClientRoleAppUsers` (Task 1/existing), `pauseActiveCampaignsForClient` (Task 2), `banAuthUsers` (Task 3)
- Produces: `POST /api/clients/:clientId/archive`, returns `{ ok: true, client: ClientRow }`

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/clients/[clientId]/archive/route.test.ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientStatusMock = vi.fn()
const pauseCampaignsMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const banAuthUsersMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientStatus: (...a: unknown[]) => updateClientStatusMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/db/campaigns', () => ({ pauseActiveCampaignsForClient: (...a: unknown[]) => pauseCampaignsMock(...a) }))
vi.mock('@/lib/supabase/auth-admin', () => ({ banAuthUsers: (...a: unknown[]) => banAuthUsersMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(clientId: string) {
  return { params: Promise.resolve({ clientId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientStatusMock.mockReset()
  pauseCampaignsMock.mockReset().mockResolvedValue(undefined)
  listClientRoleAppUsersMock.mockReset().mockResolvedValue([{ id: 'u1', client_id: 'c1' }, { id: 'u2', client_id: 'other' }])
  banAuthUsersMock.mockReset().mockResolvedValue(undefined)
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/clients/[clientId]/archive', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should pause campaigns, ban only this client\'s users, and set status to archived', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'active' })
    updateClientStatusMock.mockResolvedValue({ id: 'c1', name: 'Acme', status: 'archived' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.status).toBe('archived')
    expect(pauseCampaignsMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(banAuthUsersMock).toHaveBeenCalledWith(expect.anything(), ['u1'])
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.archived' }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/archive/route.test.ts"`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/clients/[clientId]/archive/route.ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, updateClientStatus, listClientRoleAppUsers } from '@/lib/db/clients'
import { pauseActiveCampaignsForClient } from '@/lib/db/campaigns'
import { banAuthUsers } from '@/lib/supabase/auth-admin'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ clientId: string }> }) {
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
    await pauseActiveCampaignsForClient(admin, clientId)

    const appUsers = await listClientRoleAppUsers(admin)
    const userIds = appUsers.filter((row) => row.client_id === clientId).map((row) => row.id)
    await banAuthUsers(admin, userIds)

    const updated = await updateClientStatus(admin, clientId, 'archived')
    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.archived',
        payload: { bannedUserCount: userIds.length },
      })
    } catch {
      // Audit logging is best-effort — the archive already succeeded.
    }
    return NextResponse.json({ ok: true, client: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/archive/route.test.ts"`
Expected: PASS, 3 tests green

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/archive"
git commit -m "feat: add POST /api/clients/[clientId]/archive"
```

---

### Task 8: `DELETE /api/clients/[clientId]` — permanent delete, name-confirmed

**Files:**
- Create: `src/app/api/clients/[clientId]/route.test.ts` (extend — same file as Task 4, add a `describe('DELETE ...)` block)
- Modify: `src/app/api/clients/[clientId]/route.ts` (add the `DELETE` export alongside the existing `PATCH`)

**Interfaces:**
- Consumes: `getClientById`, `deleteClientCascade`, `listClientRoleAppUsers` (Task 1/existing), `deleteAuthUsers` (Task 3)
- Produces: `DELETE /api/clients/:clientId` accepting `{ confirmName: string }`, returns `{ ok: true }`

- [ ] **Step 1: Write the failing tests**

Append to `src/app/api/clients/[clientId]/route.test.ts`. First extend its `vi.mock('@/lib/db/clients', ...)` to also export `deleteClientCascade` and `listClientRoleAppUsers`, and add a new `vi.mock('@/lib/supabase/auth-admin', ...)`:
```ts
const deleteClientCascadeMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const deleteAuthUsersMock = vi.fn()

vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientName: (...a: unknown[]) => updateClientNameMock(...a),
  deleteClientCascade: (...a: unknown[]) => deleteClientCascadeMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/supabase/auth-admin', () => ({ deleteAuthUsers: (...a: unknown[]) => deleteAuthUsersMock(...a) }))

import { PATCH, DELETE } from './route'
```
(Replace the earlier `import { PATCH } from './route'` line with the combined one above, and add the three new `mockReset()` calls into the existing `beforeEach`.)

```ts
function deleteReq(body: unknown) {
  return new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) })
}

describe('DELETE /api/clients/[clientId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(deleteReq({ confirmName: 'Acme' }), ctx('c1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the client does not exist', async () => {
    getClientByIdMock.mockResolvedValue(null)
    const res = await DELETE(deleteReq({ confirmName: 'Acme' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the confirmation name does not match', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    const res = await DELETE(deleteReq({ confirmName: 'wrong' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(deleteClientCascadeMock).not.toHaveBeenCalled()
  })

  it('should delete the client and its auth users when the name matches', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme' })
    listClientRoleAppUsersMock.mockResolvedValue([{ id: 'u1', client_id: 'c1' }, { id: 'u2', client_id: 'other' }])
    deleteClientCascadeMock.mockResolvedValue(undefined)
    deleteAuthUsersMock.mockResolvedValue(undefined)
    const res = await DELETE(deleteReq({ confirmName: 'Acme' }), ctx('c1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteClientCascadeMock).toHaveBeenCalledWith(expect.anything(), 'c1')
    expect(deleteAuthUsersMock).toHaveBeenCalledWith(expect.anything(), ['u1'])
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.deleted' }))
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run "src/app/api/clients/[clientId]/route.test.ts"`
Expected: FAIL — `DELETE` is not exported from `./route`

- [ ] **Step 3: Implement**

Add to `src/app/api/clients/[clientId]/route.ts` (alongside the existing `PATCH`, extending its imports):
```ts
import { getClientById, updateClientName, deleteClientCascade, listClientRoleAppUsers } from '@/lib/db/clients'
import { deleteAuthUsers } from '@/lib/supabase/auth-admin'
```
```ts
const deleteSchema = z.object({
  confirmName: z.string().min(1),
})

// Fetches the client and its own linked users first, then deletes the row
// (cascading to every campaign/case/lead/email/sequence/mailbox/suppression/
// event/app_users row for it), then deletes the now-orphaned Supabase Auth
// users — auth.users has no FK to clients, so this last step is the only
// thing that actually removes those logins. This is irreversible.
export async function DELETE(request: Request, context: { params: Promise<{ clientId: string }> }) {
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
    const body = deleteSchema.parse(await request.json())
    if (body.confirmName !== client.name) {
      return NextResponse.json({ error: 'name_mismatch' }, { status: 400 })
    }

    const appUsers = await listClientRoleAppUsers(admin)
    const userIds = appUsers.filter((row) => row.client_id === clientId).map((row) => row.id)

    await deleteClientCascade(admin, clientId)
    await deleteAuthUsers(admin, userIds)

    try {
      await logEvent({
        clientId,
        actor: `human:${appUser.id}`,
        type: 'client.deleted',
        payload: { name: client.name, deletedUserCount: userIds.length },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded, and
      // clientId no longer references a real row, but events.client_id has
      // no FK (see events table definition), so this insert is still valid.
    }
    return NextResponse.json({ ok: true })
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

Run: `pnpm vitest run "src/app/api/clients/[clientId]/route.test.ts"`
Expected: PASS, all tests green (4 from Task 4 + 4 new)

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/clients/[clientId]/route.ts" "src/app/api/clients/[clientId]/route.test.ts"
git commit -m "feat: add DELETE /api/clients/[clientId] with name-confirmed permanent deletion"
```

---

## Group B — Pipeline guards (make "stop operations" actually stop operations)

Investigation finding: `discover/route.ts` already skips a non-active campaign (`src/app/api/pipeline/discover/route.ts:24`), so Task 5's pause correctly stops **new** discovery. But `write/route.ts` and `research/route.ts` fetch the campaign and never check its status, and `runFollowupStep` (`src/lib/pipeline/followup.ts`) does the same — so today, a case already sitting at `ready` or a sequence already scheduled would keep sending even after a client is paused. These three tasks close that gap, reusing data each function already fetches (no new queries).

### Task 9: Guard `research/route.ts` on campaign status

**Files:**
- Modify: `src/app/api/pipeline/research/route.ts`
- Modify: `src/app/api/pipeline/research/route.test.ts`

**Interfaces:**
- Consumes: `getCampaignForCase` (existing) — reordered to run before the case is claimed

- [ ] **Step 1: Write the failing test**

Add to `src/app/api/pipeline/research/route.test.ts`, and update the existing "should run research" test's `getCampaignForCaseMock` value to include `status: 'active'` (it currently returns `{ id: 'camp1', value_prop: 'v' }`, which would newly read as "not active" and break once the guard exists):
```ts
// change the existing passing test's fixture:
getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'active' })
```
```ts
it('should skip without claiming the case when the campaign is not active', async () => {
  getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'new', company_name: 'Acme', company_domain: 'acme.com' })
  getCampaignForCaseMock.mockResolvedValue({ id: 'camp1', value_prop: 'v', status: 'paused' })
  const res = await POST(req({ caseId: CASE_ID }))
  const json = await res.json()
  expect(json.skipped).toBe('campaign_not_active')
  expect(updateCaseStatusMock).not.toHaveBeenCalled()
  expect(runResearchMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm vitest run src/app/api/pipeline/research/route.test.ts`
Expected: FAIL — nothing skips yet, `updateCaseStatusMock` gets called

- [ ] **Step 3: Implement**

In `src/app/api/pipeline/research/route.ts`, reorder so the campaign is fetched and checked *before* the case is claimed:
```ts
    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
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
```
(Note `campaign.value_prop` is no longer optional-chained since the null case is now handled by the guard above — `campaign` is narrowed to non-null past that point.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/pipeline/research/route.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/research/route.ts src/app/api/pipeline/research/route.test.ts
git commit -m "fix: skip research for a case whose campaign is not active"
```

---

### Task 10: Guard `write/route.ts` on campaign status

**Files:**
- Modify: `src/app/api/pipeline/write/route.ts`
- Modify: `src/app/api/pipeline/write/route.test.ts`

**Interfaces:**
- Consumes: `getCampaignForCase` (existing) — reordered to run before the case is claimed

- [ ] **Step 1: Write the failing test**

Update the existing "should run write when the case is ready" test's `getCampaignForCaseMock` fixture to add `status: 'active'`:
```ts
getCampaignForCaseMock.mockResolvedValue({
  id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'active',
})
```
Add:
```ts
it('should skip without claiming the case when the campaign is not active', async () => {
  getCaseByIdMock.mockResolvedValue({ id: CASE_ID, client_id: 'c1', status: 'ready', company_name: 'Acme' })
  getCampaignForCaseMock.mockResolvedValue({
    id: 'camp1', reply_mode: 'auto_send', value_prop: 'v', booking_link: 'b', mailbox_ids: ['m1'], status: 'paused',
  })
  const res = await POST(req({ caseId: CASE_ID }))
  const json = await res.json()
  expect(json.skipped).toBe('campaign_not_active')
  expect(updateCaseStatusMock).not.toHaveBeenCalled()
  expect(runWriteMock).not.toHaveBeenCalled()
})
```

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm vitest run src/app/api/pipeline/write/route.test.ts`
Expected: FAIL — nothing skips yet

- [ ] **Step 3: Implement**

In `src/app/api/pipeline/write/route.ts`, reorder so the campaign check happens before the case is claimed:
```ts
    const kase = await getCaseById(admin, caseId)
    if (!kase) return NextResponse.json({ error: 'case_not_found' }, { status: 404 })
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/app/api/pipeline/write/route.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/app/api/pipeline/write/route.ts src/app/api/pipeline/write/route.test.ts
git commit -m "fix: skip write for a case whose campaign is not active"
```

---

### Task 11: Guard `runFollowupStep` on campaign status, with retry rescheduling

Unlike `write`/`research` (which have a periodic fanout cron that automatically retries any case left in its pre-claim status — `write-fanout`/`research-fanout`), follow-ups have no such sweep: they exist purely as a chain of delayed QStash messages that `runFollowupStep` itself re-publishes at the end of each successful run. So simply skipping without rescheduling would silently strand the sequence forever, even after the client is resumed. This task reschedules the same step at a fixed retry delay instead.

**Files:**
- Modify: `src/lib/pipeline/followup.ts`
- Modify: `src/lib/pipeline/followup.test.ts`

**Interfaces:**
- Consumes: `getCampaignForCase` (existing, already called at `followup.ts:137`)
- Produces: `FollowupSummary['action']` gains no new value — a paused-campaign skip still reports `'skipped'`, same as the existing suppression-check skip

- [ ] **Step 1: Write the failing test**

In `src/lib/pipeline/followup.test.ts`, first add `status: 'active'` to the shared `beforeEach` fixture so existing tests keep passing:
```ts
getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'active' })
```
Then add:
```ts
it('should skip and reschedule the same step when the campaign is not active', async () => {
  getSequenceByIdMock.mockResolvedValue({
    id: 'seq1', client_id: 'c1', case_id: 'case1', lead_id: 'lead1', state: 'active', current_step: 0,
  })
  hasInboundReplyMock.mockResolvedValue(false)
  getLeadByIdMock.mockResolvedValue({ id: 'lead1', email: 'a@x.com' })
  isSuppressedMock.mockResolvedValue(false)
  getCampaignForCaseMock.mockResolvedValue({ mailbox_ids: ['m1'], value_prop: 'v', status: 'paused' })
  publishDelayMock.mockResolvedValue('msg-retry-1')

  const result = await runFollowupStep(supabase, { sequenceId: 'seq1', step: 1 })

  expect(result).toEqual({ sequenceId: 'seq1', action: 'skipped' })
  expect(generateTextMock).not.toHaveBeenCalled()
  expect(sendViaMailboxMock).not.toHaveBeenCalled()
  expect(publishDelayMock).toHaveBeenCalledWith(
    '/api/pipeline/followup',
    { sequenceId: 'seq1', step: 1 },
    expect.any(Number),
  )
})
```
(Match this test's setup style — `supabase`, `getSequenceByIdMock`, etc. — to whatever fixture variables the existing tests in this file already use; check the top of `followup.test.ts` for the exact mock names before writing this block, since they were established in the file this plan did not create.)

- [ ] **Step 2: Run tests to verify the new one fails**

Run: `pnpm vitest run src/lib/pipeline/followup.test.ts`
Expected: FAIL — today it proceeds to `generateText`/send instead of skipping

- [ ] **Step 3: Implement**

In `src/lib/pipeline/followup.ts`, add a retry-delay constant near the existing `FOLLOWUP_DELAYS_SECONDS`:
```ts
// How long before retrying a followup step that was skipped because the
// campaign was paused/archived at the time. Independent of the normal
// step-to-step cadence in FOLLOWUP_DELAYS_SECONDS.
const PAUSED_CAMPAIGN_RETRY_SECONDS = DAY_SECONDS
```

Insert the guard immediately after the existing `const campaign = await getCampaignForCase(supabase, sequence.case_id)` line (`followup.ts:137`), before `nudgeBody` is generated:
```ts
  const campaign = await getCampaignForCase(supabase, sequence.case_id)
  if (!campaign || campaign.status !== 'active') {
    // Reschedule the same step rather than advancing or stopping — a paused
    // client is expected to resume, and the sequence must pick back up then.
    const messageId = await publishJsonWithDelay(
      '/api/pipeline/followup',
      { sequenceId: sequence.id, step: input.step },
      PAUSED_CAMPAIGN_RETRY_SECONDS,
    )
    await advanceSequence(supabase, sequence.id, {
      currentStep: sequence.current_step,
      nextActionAt: null,
      qstashMessageId: messageId,
    })
    return { sequenceId: sequence.id, action: 'skipped' }
  }
```

Then remove the now-redundant optional chaining below it (`campaign?.value_prop` → `campaign.value_prop`, `campaign?.booking_link` → `campaign.booking_link`, `campaign?.mailbox_ids` → `campaign.mailbox_ids`), since `campaign` is narrowed to non-null past the guard.

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/pipeline/followup.test.ts`
Expected: PASS, all tests green

- [ ] **Step 5: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts
git commit -m "fix: reschedule follow-ups instead of sending them for a paused campaign"
```

---

## Group C — Analytics reuse

### Task 12: Extract `AnalyticsView` so `/clients/[id]` can embed it

Refactor-only: no behavior change for `/analytics`. The whole data-fetch-and-render body of the page becomes a shared async Server Component so the client detail page (Task 13) can render the exact same stat tiles / daily trend / campaign table / mailbox table / event log, forced to one client, without duplicating ~250 lines of JSX.

**Files:**
- Create: `src/app/(app)/analytics/analytics-view.tsx`
- Modify: `src/app/(app)/analytics/page.tsx`

**Interfaces:**
- Produces: `AnalyticsView({ searchParams, scope }: { searchParams: Promise<Record<string, string | string[] | undefined>>; scope: { kind: 'global' } | { kind: 'client'; clientId: string } })`
- Consumes: everything `/analytics/page.tsx` currently imports (`getOverviewMetrics`, `getDailyMetrics`, `getCampaignMetrics`, `getMailboxMetrics`, `getEventCounts`, `listCampaignsForClient`, `listClients`, `analyticsSearchParamsSchema`, `rangeFromDays`, etc.)

- [ ] **Step 1: Create `analytics-view.tsx` with everything from `page.tsx` moved in**

```tsx
// src/app/(app)/analytics/analytics-view.tsx
import Link from 'next/link'
import { ChartLineUp } from '@phosphor-icons/react/dist/ssr'
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
import { rate, formatPercent, formatCount, formatDateTime } from '@/lib/analytics/rates'
import { humanizeEnum } from '@/lib/format'
import { MAILBOX_HEALTH } from '@/lib/ui/status'
import { Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { StatusPill } from '@/components/status-dot'
import {
  Table,
  TableBody,
  TableCaption,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { StatTile } from './stat-tile'
import { SparklineChart } from './sparkline-chart'
import { AnalyticsFilters } from './filters'

const EVENT_TYPE_LIMIT = 12
const TREND_TABLE_DAYS = 14

const TILE_GRID = 'grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4'

export type AnalyticsScope = { kind: 'global' } | { kind: 'client'; clientId: string }

interface AnalyticsViewProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
  scope: AnalyticsScope
}

export async function AnalyticsView({ searchParams, scope }: AnalyticsViewProps): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  const supabase = await createServerClient()

  // URL params are untrusted input that reaches SQL — validate, then whitelist.
  const parsed = analyticsSearchParamsSchema.safeParse(await searchParams)
  const days = parseRangeDays(parsed.success ? parsed.data.days : undefined)
  const requestedCampaignId = parsed.success ? (parsed.data.campaign ?? null) : null
  // In 'client' scope the client filter is fixed by the route, not the URL.
  const requestedClientId = scope.kind === 'client' ? scope.clientId : parsed.success ? (parsed.data.client ?? null) : null

  const isOperator = appUser.role === 'operator'
  const showClientPicker = scope.kind === 'global' && isOperator
  const [rawCampaigns, clientOptions] = await Promise.all([
    listCampaignsForClient(supabase, appUser.client_id),
    showClientPicker ? listClients(supabase) : Promise.resolve([]),
  ])
  const campaigns = rawCampaigns.map((campaign) => ({
    id: campaign.id,
    name: campaign.name,
    clientId: campaign.client_id,
  }))

  const clientId =
    scope.kind === 'client'
      ? scope.clientId
      : isOperator && clientOptions.some((client) => client.id === requestedClientId)
        ? requestedClientId
        : null
  const campaignId = campaigns.some(
    (campaign) => campaign.id === requestedCampaignId && (!clientId || campaign.clientId === clientId),
  )
    ? requestedCampaignId
    : null

  const { from, to } = rangeFromDays(days, new Date())
  const [overview, daily, byCampaign, allMailboxes, eventCounts] = await Promise.all([
    getOverviewMetrics(supabase, { from, to, campaignId, clientId }),
    getDailyMetrics(supabase, { from, to, campaignId, clientId }),
    getCampaignMetrics(supabase, { from, to }),
    getMailboxMetrics(supabase),
    getEventCounts(supabase, { from, to, limit: EVENT_TYPE_LIMIT }),
  ])

  const replyRate = rate(overview.leadsReplied, overview.leadsContacted)
  const bounceRate = rate(overview.emailsBounced, overview.emailsSent)
  const failureRate = rate(overview.emailsFailed, overview.emailsSent + overview.emailsFailed)
  const verifiedRate = rate(overview.leadsVerified, overview.leadsDiscovered)
  const trendRows = daily.slice(-TREND_TABLE_DAYS).reverse()
  const scopedCampaigns = byCampaign.filter(
    (row) => (!campaignId || row.campaignId === campaignId) && (!clientId || row.clientId === clientId),
  )
  const mailboxes = clientId ? allMailboxes.filter((mailbox) => mailbox.clientId === clientId) : allMailboxes
  const hasAnyData = overview.leadsDiscovered + overview.emailsSent + overview.repliesReceived > 0

  return (
    <div className="flex flex-col gap-8">
      <AnalyticsFilters
        days={days}
        campaignId={campaignId}
        clientId={showClientPicker ? clientId : null}
        campaigns={campaigns}
        clients={showClientPicker ? clientOptions : []}
        basePath={scope.kind === 'client' ? `/clients/${scope.clientId}` : '/analytics'}
        fixedParams={scope.kind === 'client' ? { tab: 'analytics' } : {}}
      />

      {!hasAnyData ? (
        <EmptyState
          icon={ChartLineUp}
          title="No pipeline activity in this range"
          description="Run discovery or widen the date range above. Metrics appear the moment the first lead lands."
        />
      ) : null}

      <Section title="Outreach">
        <div className={TILE_GRID}>
          <StatTile
            label="Emails sent"
            value={formatCount(overview.emailsSent)}
            hint={`${formatCount(overview.firstTouchSent)} first touch · ${formatCount(overview.followupsSent)} follow-ups`}
          />
          <StatTile
            label="Replies"
            value={formatCount(overview.repliesReceived)}
            hint={`${formatCount(overview.leadsReplied)} people replied`}
          />
          <StatTile
            label="Reply rate"
            value={formatPercent(replyRate)}
            hint={`of ${formatCount(overview.leadsContacted)} people contacted`}
          />
          <StatTile
            label="Bounce rate"
            value={formatPercent(bounceRate)}
            hint={`${formatCount(overview.emailsBounced)} bounced`}
          />
          <StatTile
            label="Send failures"
            value={formatCount(overview.emailsFailed)}
            hint={`${formatPercent(failureRate)} of send attempts`}
          />
          <StatTile
            label="Active sequences"
            value={formatCount(overview.activeSequences)}
            hint="Follow-ups still running right now"
          />
        </div>
      </Section>

      <Section title="Pipeline">
        <div className={TILE_GRID}>
          <StatTile label="Leads discovered" value={formatCount(overview.leadsDiscovered)} />
          <StatTile
            label="Verified emails"
            value={formatCount(overview.leadsVerified)}
            hint={`${formatPercent(verifiedRate)} of discovered`}
          />
          <StatTile label="Cases created" value={formatCount(overview.casesCreated)} />
          <StatTile
            label="Suppressions added"
            value={formatCount(overview.suppressionsAdded)}
            hint="Ignores the campaign filter, honours the client filter"
          />
        </div>
      </Section>

      <Section title="Daily trend" aside={`Last ${Math.min(TREND_TABLE_DAYS, daily.length)} days shown below`}>
        <div className="grid gap-3 md:grid-cols-3">
          <SparklineChart
            title="Emails sent"
            color="var(--status-contacted)"
            total={formatCount(overview.emailsSent)}
            values={daily.map((day) => day.emailsSent)}
          />
          <SparklineChart
            title="Replies"
            color="var(--status-won)"
            total={formatCount(overview.repliesReceived)}
            values={daily.map((day) => day.repliesReceived)}
          />
          <SparklineChart
            title="Leads discovered"
            color="var(--status-ready)"
            total={formatCount(overview.leadsDiscovered)}
            values={daily.map((day) => day.leadsDiscovered)}
          />
        </div>

        {trendRows.length > 0 ? (
          <div className="border-hairline mt-1 overflow-x-auto rounded-lg border">
            <Table>
              <TableCaption className="sr-only">Daily totals, most recent first, in UTC</TableCaption>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Day (UTC)</TableHead>
                  <TableHead scope="col" className="text-right">Discovered</TableHead>
                  <TableHead scope="col" className="text-right">Sent</TableHead>
                  <TableHead scope="col" className="text-right">Replies</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {trendRows.map((day) => (
                  <TableRow key={day.day}>
                    <TableCell className="font-mono text-xs">{day.day}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(day.leadsDiscovered)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(day.emailsSent)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(day.repliesReceived)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        ) : null}
      </Section>

      <Section title="Campaigns">
        {scopedCampaigns.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No campaigns yet.{' '}
            <Link href={scope.kind === 'client' ? `/clients/${scope.clientId}?tab=campaigns` : '/campaigns'} className="text-primary underline underline-offset-2">
              Create one
            </Link>
            .
          </p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table className="min-w-[900px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Campaign</TableHead>
                  <TableHead scope="col">Status</TableHead>
                  {['Discovered', 'Verified', 'Sent', 'Contacted', 'Replied', 'Reply rate', 'In conv.', 'Hot', 'Won', 'Dead'].map(
                    (heading) => (
                      <TableHead key={heading} scope="col" className="text-right">
                        {heading}
                      </TableHead>
                    ),
                  )}
                </TableRow>
              </TableHeader>
              <TableBody>
                {scopedCampaigns.map((row) => (
                  <TableRow key={row.campaignId}>
                    <TableCell className="font-medium">{row.campaignName}</TableCell>
                    <TableCell className="text-muted-foreground">{humanizeEnum(row.campaignStatus)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsDiscovered)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsVerified)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.emailsSent)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsContacted)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.leadsReplied)}</TableCell>
                    <TableCell className="tnum text-right">{formatPercent(rate(row.leadsReplied, row.leadsContacted))}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesInConversation)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesHotHandoff)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesWon)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(row.casesDead)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Mailboxes">
        {mailboxes.length === 0 ? (
          <p className="text-muted-foreground text-sm">
            No mailboxes connected.{' '}
            <Link href="/settings" className="text-primary underline underline-offset-2">
              Connect one
            </Link>
            .
          </p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table className="min-w-[760px]">
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Mailbox</TableHead>
                  <TableHead scope="col">Provider</TableHead>
                  <TableHead scope="col">Health</TableHead>
                  <TableHead scope="col" className="text-right">Today</TableHead>
                  <TableHead scope="col" className="text-right">Cap used</TableHead>
                  <TableHead scope="col" className="text-right">Sent all-time</TableHead>
                  <TableHead scope="col" className="text-right">Bounce rate</TableHead>
                  <TableHead scope="col">Last send</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {mailboxes.map((mailbox) => (
                  <TableRow key={mailbox.mailboxId}>
                    <TableCell className="font-medium">{mailbox.emailAddress}</TableCell>
                    <TableCell className="text-muted-foreground">{mailbox.provider}</TableCell>
                    <TableCell>
                      <StatusPill meta={MAILBOX_HEALTH[mailbox.health]} />
                    </TableCell>
                    <TableCell className="tnum text-right">
                      {formatCount(mailbox.sentToday)} / {formatCount(mailbox.dailyCap)}
                    </TableCell>
                    <TableCell className="tnum text-right">{formatPercent(rate(mailbox.sentToday, mailbox.dailyCap))}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(mailbox.sentTotal)}</TableCell>
                    <TableCell className="tnum text-right">{formatPercent(rate(mailbox.bouncedTotal, mailbox.sentTotal))}</TableCell>
                    <TableCell className="text-muted-foreground font-mono text-xs">{formatDateTime(mailbox.lastSentAt)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>

      <Section title="Agent activity" className="pb-4">
        {eventCounts.length === 0 ? (
          <p className="text-muted-foreground text-sm">No agent events logged in this range.</p>
        ) : (
          <div className="border-hairline overflow-x-auto rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead scope="col">Event</TableHead>
                  <TableHead scope="col" className="text-right">Count</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {eventCounts.map((event) => (
                  <TableRow key={event.type}>
                    <TableCell>{humanizeEnum(event.type)}</TableCell>
                    <TableCell className="tnum text-right">{formatCount(event.count)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        )}
      </Section>
    </div>
  )
}
```

Note two new `AnalyticsFilters` props appear here (`basePath`, `fixedParams`) that Task 12b below adds — `filters.tsx` must be updated in the same task since `analytics-view.tsx` won't typecheck without them.

- [ ] **Step 2: Update `filters.tsx` to support a non-`/analytics` base path**

Modify `src/app/(app)/analytics/filters.tsx`: add `basePath` and `fixedParams` props, and use them when building the href instead of hardcoding `/analytics`.

Change the props interface:
```ts
interface AnalyticsFiltersProps {
  days: RangeDays
  campaignId: string | null
  clientId: string | null
  campaigns: CampaignOption[]
  clients: ClientOption[]
  /** Where filter changes navigate to. Defaults to /analytics. */
  basePath?: string
  /** Extra query params always re-appended (e.g. `{ tab: 'analytics' }` from the client detail page). */
  fixedParams?: Record<string, string>
}
```

Change `buildHref` to a closure built once per render instead of a free function, so it can see `basePath`/`fixedParams`:
```ts
export function AnalyticsFilters({
  days,
  campaignId,
  clientId,
  campaigns,
  clients,
  basePath = '/analytics',
  fixedParams = {},
}: AnalyticsFiltersProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const buildHref = (nextDays: RangeDays, nextCampaignId: string | null, nextClientId: string | null): string => {
    const params = new URLSearchParams(fixedParams)
    params.set('days', String(nextDays))
    if (nextCampaignId) params.set('campaign', nextCampaignId)
    if (nextClientId) params.set('client', nextClientId)
    return `${basePath}?${params.toString()}`
  }

  const visibleCampaigns = clientId ? campaigns.filter((campaign) => campaign.clientId === clientId) : campaigns
```
(Delete the old module-level `buildHref` function and the two `ALL_CAMPAIGNS`/`ALL_CLIENTS` sentinel-based `onCampaignChange`/`onClientChange`/`onRangeClick` bodies stay exactly as they were, just calling this closure instead of the removed free function — they already call `buildHref(...)` by name, so no other line changes.)

- [ ] **Step 3: Replace `page.tsx`'s body with a call into `AnalyticsView`**

```tsx
// src/app/(app)/analytics/page.tsx
import type { Metadata } from 'next'
import { PageHeader } from '@/components/page-header'
import { AnalyticsView } from './analytics-view'
import { RealtimeRefresher } from './realtime-refresher'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Analytics' }

interface AnalyticsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps): Promise<React.ReactElement> {
  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresher />
      <PageHeader
        title="Analytics"
        description="Numbers recompute live as the pipeline runs."
        actions={
          <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden className="bg-primary size-1.5 animate-pulse rounded-full" style={{ animationDuration: '2.4s' }} />
            Live
          </span>
        }
      />
      <AnalyticsView searchParams={searchParams} scope={{ kind: 'global' }} />
    </div>
  )
}
```

- [ ] **Step 4: Typecheck and run the full suite**

Run: `pnpm exec tsc --noEmit && pnpm vitest run`
Expected: no type errors; every existing test still green (this task changes no tested function signatures, only JSX composition)

- [ ] **Step 5: Manual smoke test**

Run: `pnpm dev`, visit `/analytics` as the operator. Confirm it renders identically to before (same sections, same numbers, range/campaign/client filters all still work, days pill toggles the URL).

- [ ] **Step 6: Commit**

```bash
git add "src/app/(app)/analytics"
git commit -m "refactor: extract AnalyticsView so it can be embedded in the client detail page"
```

---

## Group D — The `/clients/[id]` detail page

### Task 13: `/clients/[id]` — header, lifecycle actions, tab shell

**Files:**
- Create: `src/app/(app)/clients/[id]/page.tsx`
- Create: `src/app/(app)/clients/[id]/not-found.tsx`
- Create: `src/app/(app)/clients/[id]/loading.tsx`
- Create: `src/app/(app)/clients/[id]/error.tsx`
- Create: `src/app/(app)/clients/[id]/rename-client-dialog.tsx`
- Create: `src/app/(app)/clients/[id]/client-lifecycle-actions.tsx`
- Create: `src/app/(app)/clients/[id]/delete-client-dialog.tsx`

**Interfaces:**
- Consumes: `getClientById`, `listClientRoleAppUsers` (existing), `listAllAuthUsers` (existing), `CLIENT_STATUS` (existing), `InviteUserDialog` (existing, from `../invite-user-dialog`), `AnalyticsView` (Task 12), `NewCampaignForm` (Task 14 gives it a `fixedClientId` prop), `listCampaignsForClient` (existing)
- Produces: `/clients/[id]?tab=campaigns|analytics|users&days=&campaign=` — the shareable URL shape the "View analytics" link (already on `/clients/page.tsx`) should be updated to target in Task 15

- [ ] **Step 1: `not-found.tsx`, `loading.tsx`, `error.tsx`**

```tsx
// src/app/(app)/clients/[id]/not-found.tsx
import Link from 'next/link'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default function ClientNotFound(): React.ReactElement {
  return (
    <EmptyState
      icon={MagnifyingGlass}
      title="Client not found"
      description="This client does not exist, or you do not have access to it."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/clients">Back to clients</Link>
        </Button>
      }
    />
  )
}
```

```tsx
// src/app/(app)/clients/[id]/loading.tsx
import { PageSkeleton } from '@/components/page-skeleton'

export default function Loading(): React.ReactElement {
  return <PageSkeleton variant="list" />
}
```

```tsx
// src/app/(app)/clients/[id]/error.tsx
'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return <ErrorPanel title="Client unavailable" description="This client's page could not be loaded." reset={reset} />
}
```

- [ ] **Step 2: `rename-client-dialog.tsx`**

```tsx
// src/app/(app)/clients/[id]/rename-client-dialog.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilSimple } from '@phosphor-icons/react'
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

type RenameState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

export function RenameClientDialog({ clientId, currentName }: { clientId: string; currentName: string }): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(currentName)
  const [state, setState] = useState<RenameState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not rename the client.'
        setState({ status: 'error', message })
        toast.error('Rename failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success('Client renamed')
      router.refresh()
    } catch {
      setState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) setName(currentName)
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Rename client">
          <PencilSimple size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename client</DialogTitle>
        </DialogHeader>
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientName" className="text-xs">
              Name
            </Label>
            <Input id="clientName" value={name} onChange={(event) => setName(event.target.value)} required />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting' || name.trim().length === 0}>
              {state.status === 'submitting' ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 3: `delete-client-dialog.tsx`** (the 3-step permanent delete)

```tsx
// src/app/(app)/clients/[id]/delete-client-dialog.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash } from '@phosphor-icons/react'
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

// Three-step by design: (1) open this dialog, which states the blast radius,
// (2) type the exact client name to arm the button, (3) click the armed
// button. There is no fourth "are you sure" — the typed name IS the
// confirmation, and the button stays disabled until it matches exactly.
type DeleteState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface DeleteClientDialogProps {
  clientId: string
  clientName: string
  campaignCount: number
  userCount: number
}

export function DeleteClientDialog({
  clientId,
  clientName,
  campaignCount,
  userCount,
}: DeleteClientDialogProps): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [state, setState] = useState<DeleteState>({ status: 'idle' })

  const isArmed = confirmName === clientName

  async function onConfirm(): Promise<void> {
    if (!isArmed) return
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not delete the client.'
        setState({ status: 'error', message })
        toast.error('Delete failed', { description: message })
        return
      }
      toast.success(`${clientName} deleted`)
      router.push('/clients')
      router.refresh()
    } catch {
      setState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setConfirmName('')
          setState({ status: 'idle' })
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          <Trash size={13} weight="light" />
          Delete permanently
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {clientName} permanently</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            This deletes {campaignCount} campaign{campaignCount === 1 ? '' : 's'} and every case, lead, email, and
            sequence under {campaignCount === 1 ? 'it' : 'them'}, plus {userCount} login
            {userCount === 1 ? '' : 's'} for this client. There is no undo.
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmName" className="text-xs">
              Type <span className="font-mono">{clientName}</span> to confirm
            </Label>
            <Input
              id="confirmName"
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
              autoComplete="off"
            />
          </div>

          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button type="button" variant="destructive" size="sm" disabled={!isArmed || state.status === 'submitting'} onClick={onConfirm}>
            {state.status === 'submitting' ? 'Deleting…' : 'Delete forever'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: `client-lifecycle-actions.tsx`** (Pause/Resume, Archive/Reactivate — state-dependent)

```tsx
// src/app/(app)/clients/[id]/client-lifecycle-actions.tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Lock, Pause, Play } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { Database } from '@/types/database'

type ClientStatus = Database['public']['Enums']['client_status']

type ActionState = { status: 'idle' } | { status: 'submitting'; action: 'pause' | 'resume' | 'archive' }

async function postAction(clientId: string, action: 'pause' | 'resume' | 'archive'): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/clients/${clientId}/${action}`, { method: 'POST' })
  if (res.ok) return { ok: true }
  const json: unknown = await res.json().catch(() => ({}))
  const message =
    typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'Request failed.'
  return { ok: false, message }
}

export function ClientLifecycleActions({ clientId, status }: { clientId: string; status: ClientStatus }): React.ReactElement {
  const router = useRouter()
  const [state, setState] = useState<ActionState>({ status: 'idle' })

  async function run(action: 'pause' | 'resume' | 'archive', successMessage: string): Promise<void> {
    setState({ status: 'submitting', action })
    const result = await postAction(clientId, action)
    if (!result.ok) {
      toast.error('Action failed', { description: result.message })
      setState({ status: 'idle' })
      return
    }
    toast.success(successMessage)
    setState({ status: 'idle' })
    router.refresh()
  }

  const isBusy = state.status === 'submitting'

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'active' ? (
        <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => run('pause', 'Operations paused')}>
          <Pause size={13} weight="light" />
          {state.status === 'submitting' && state.action === 'pause' ? 'Pausing…' : 'Pause operations'}
        </Button>
      ) : null}

      {status === 'paused' ? (
        <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => run('resume', 'Operations resumed')}>
          <Play size={13} weight="light" />
          {state.status === 'submitting' && state.action === 'resume' ? 'Resuming…' : 'Resume operations'}
        </Button>
      ) : null}

      {status !== 'archived' ? (
        <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => run('archive', 'Client archived — login blocked')}>
          <Lock size={13} weight="light" />
          {state.status === 'submitting' && state.action === 'archive' ? 'Archiving…' : 'Stop + block login'}
        </Button>
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => run('resume', 'Client reactivated')}>
          <Play size={13} weight="light" />
          {state.status === 'submitting' && state.action === 'resume' ? 'Reactivating…' : 'Reactivate'}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 5: `page.tsx`** — header + tab shell, wired to `AnalyticsView` and the dialogs above

```tsx
// src/app/(app)/clients/[id]/page.tsx
import type { Metadata } from 'next'
import Link from 'next/link'
import { notFound } from 'next/navigation'
import { z } from 'zod'
import { ArrowLeft, Buildings, ChartLineUp, Lightning, UsersThree } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getClientById, listClientRoleAppUsers } from '@/lib/db/clients'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listAllAuthUsers } from '@/lib/supabase/list-auth-users'
import { formatRelative } from '@/lib/format'
import { CLIENT_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { EmptyState } from '@/components/empty-state'
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs'
import { AnalyticsView } from '../../analytics/analytics-view'
import { NewCampaignForm } from '../../campaigns/new-campaign-form'
import { InviteUserDialog } from '../invite-user-dialog'
import { RenameClientDialog } from './rename-client-dialog'
import { ClientLifecycleActions } from './client-lifecycle-actions'
import { DeleteClientDialog } from './delete-client-dialog'

export const dynamic = 'force-dynamic'

const paramsSchema = z.object({ id: z.string().uuid() })
const tabSchema = z.enum(['campaigns', 'analytics', 'users'])

interface ClientDetailPageProps {
  params: Promise<{ id: string }>
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export async function generateMetadata({ params }: ClientDetailPageProps): Promise<Metadata> {
  const parsed = paramsSchema.safeParse(await params)
  if (!parsed.success) return { title: 'Client' }
  const admin = createAdminClient()
  const client = await getClientById(admin, parsed.data.id)
  return { title: client?.name ?? 'Client' }
}

export default async function ClientDetailPage({ params, searchParams }: ClientDetailPageProps): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') notFound()

  const parsedParams = paramsSchema.safeParse(await params)
  if (!parsedParams.success) notFound()
  const clientId = parsedParams.data.id

  const admin = createAdminClient()
  const client = await getClientById(admin, clientId)
  if (!client) notFound()

  const [campaigns, clientAppUsers, authUsers] = await Promise.all([
    listCampaignsForClient(admin, clientId),
    listClientRoleAppUsers(admin),
    listAllAuthUsers(admin),
  ])
  const emailById = new Map(authUsers.map((user) => [user.id, user.email]))
  const users = clientAppUsers
    .filter((row) => row.client_id === clientId)
    .map((row) => ({ id: row.id, email: emailById.get(row.id) ?? 'unknown' }))

  const rawSearchParams = await searchParams
  const requestedTab = tabSchema.safeParse(rawSearchParams.tab)
  const tab = requestedTab.success ? requestedTab.data : 'campaigns'

  const now = new Date()

  return (
    <div className="flex flex-col gap-8">
      <header className="flex flex-col gap-5">
        <Link
          href="/clients"
          className="text-muted-foreground hover:text-foreground inline-flex w-fit items-center gap-1.5 text-xs transition-colors duration-200"
        >
          <ArrowLeft size={13} weight="light" />
          Clients
        </Link>

        <div className="flex flex-wrap items-start gap-4">
          <span className="bg-accent text-muted-foreground grid size-11 shrink-0 place-items-center rounded-lg">
            <Buildings size={20} weight="light" />
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5">
              <h1 className="truncate text-2xl font-semibold tracking-tight">{client.name}</h1>
              <RenameClientDialog clientId={client.id} currentName={client.name} />
            </div>
            <div className="text-muted-foreground mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
              <span>Created {formatRelative(client.created_at, now)}</span>
              <span>{campaigns.length} campaigns</span>
              <span>{users.length} logins</span>
            </div>
          </div>
          <StatusPill meta={CLIENT_STATUS[client.status]} className="mt-1 px-2.5 py-1 text-xs" />
        </div>

        <div className="border-hairline flex flex-wrap items-center justify-between gap-3 border-t pt-5">
          <ClientLifecycleActions clientId={client.id} status={client.status} />
          <DeleteClientDialog
            clientId={client.id}
            clientName={client.name}
            campaignCount={campaigns.length}
            userCount={users.length}
          />
        </div>
      </header>

      <Tabs value={tab} className="gap-5">
        <TabsList>
          <TabsTrigger value="campaigns" asChild>
            <Link href={`/clients/${clientId}?tab=campaigns`}>
              <Lightning size={14} weight="light" />
              Campaigns
              <span className="tnum text-faint">{campaigns.length}</span>
            </Link>
          </TabsTrigger>
          <TabsTrigger value="analytics" asChild>
            <Link href={`/clients/${clientId}?tab=analytics`}>
              <ChartLineUp size={14} weight="light" />
              Analytics
            </Link>
          </TabsTrigger>
          <TabsTrigger value="users" asChild>
            <Link href={`/clients/${clientId}?tab=users`}>
              <UsersThree size={14} weight="light" />
              Users
              <span className="tnum text-faint">{users.length}</span>
            </Link>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="campaigns">
          <div className="flex max-w-3xl flex-col gap-6">
            <NewCampaignForm fixedClientId={client.id} fixedClientName={client.name} />
            {campaigns.length === 0 ? (
              <EmptyState icon={Lightning} title="No campaigns yet" description="Create one above." />
            ) : (
              <ul className="flex flex-col gap-2">
                {campaigns.map((campaign) => (
                  <li key={campaign.id} className="border-hairline bg-surface rounded-lg border p-4">
                    <p className="text-[13px] font-medium">{campaign.name}</p>
                    <p className="text-muted-foreground mt-1 text-sm">{campaign.value_prop}</p>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>

        <TabsContent value="analytics">
          <AnalyticsView searchParams={searchParams} scope={{ kind: 'client', clientId: client.id }} />
        </TabsContent>

        <TabsContent value="users">
          <div className="flex max-w-2xl flex-col gap-3">
            <InviteUserDialog clientId={client.id} />
            {users.length === 0 ? (
              <EmptyState icon={UsersThree} title="No logins yet" description="Invite one above." />
            ) : (
              <ul className="flex flex-col gap-2">
                {users.map((user) => (
                  <li key={user.id} className="border-hairline bg-surface rounded-lg border p-3 text-sm">
                    {user.email}
                  </li>
                ))}
              </ul>
            )}
          </div>
        </TabsContent>
      </Tabs>
    </div>
  )
}
```

- [ ] **Step 6: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: errors expected at this point only for `NewCampaignForm`'s missing `fixedClientId`/`fixedClientName` props — resolved in Task 14

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/clients/[id]"
git commit -m "feat: add /clients/[id] detail page with header, lifecycle actions, and tabs"
```

---

### Task 14: `NewCampaignForm` gains an optional fixed client (no dropdown, no redirect)

**Files:**
- Modify: `src/app/(app)/campaigns/new-campaign-form.tsx`

**Interfaces:**
- Produces: `NewCampaignForm` accepts either `{ clients: ClientOption[] }` (existing `/campaigns` page usage, unchanged) or `{ fixedClientId: string; fixedClientName: string }` (new, used by Task 13's Campaigns tab)

- [ ] **Step 1: Widen the props type and skip the dropdown when a client is fixed**

Change the props type and the top of the component:
```ts
type NewCampaignFormProps = { clients: ClientOption[] } | { fixedClientId: string; fixedClientName: string }

export function NewCampaignForm(props: NewCampaignFormProps): React.ReactElement {
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const isFixed = 'fixedClientId' in props
  // Radix Select renders a hidden input only when controlled, so the selected
  // client is held in React state rather than read off the form. When the
  // client is fixed by the route, this never changes.
  const [clientId, setClientId] = useState(isFixed ? props.fixedClientId : '')
```

Change the client-required validation at the top of `onSubmit` to only apply when not fixed (it already reads `clientId` state, which is now pre-populated when fixed, so the check as written already passes for the fixed case — no change needed there).

Replace the `<Field id="clientId" label="Client">` block:
```tsx
        {isFixed ? null : (
          <Field id="clientId" label="Client">
            <Select value={clientId} onValueChange={setClientId} required>
              <SelectTrigger id="clientId" className="w-full">
                <SelectValue placeholder="Select a client" />
              </SelectTrigger>
              <SelectContent>
                {props.clients.map((client) => (
                  <SelectItem key={client.id} value={client.id}>
                    {client.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
        )}
```
(Grid layout: when `isFixed`, the "Campaign name" field that used to sit beside "Client" in the `sm:grid-cols-2` row now has the row to itself — that's fine, `grid-cols-2` naturally lets a single child span one cell without any extra markup change needed.)

The submit success path currently does `router.refresh()` — no redirect existed before and none is added now, satisfying "I don't want a redirect" for campaign creation on this form in both its uses.

- [ ] **Step 2: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors — this resolves the two errors left over from Task 13

- [ ] **Step 3: Manual smoke test**

Run: `pnpm dev`, visit `/campaigns` (existing dropdown flow still works) and `/clients/<id>?tab=campaigns` (no dropdown, client pre-filled, creating a campaign stays on the page and the new campaign appears in the list below without navigating away).

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/campaigns/new-campaign-form.tsx"
git commit -m "feat: let NewCampaignForm take a fixed client instead of a dropdown"
```

---

### Task 15: `/clients` list — link to the detail page instead of showing everything inline

**Files:**
- Modify: `src/app/(app)/clients/page.tsx`

**Interfaces:**
- Consumes: nothing new
- Produces: each row is a `Link` to `/clients/[id]`; the inline invite dialog, user badges, and "View analytics" button move to the detail page (Task 13) and are removed from the list row

- [ ] **Step 1: Simplify the list row**

Replace the `<li>` body inside the `clients.map(...)` block in `src/app/(app)/clients/page.tsx` (the row previously built with `InviteUserDialog`/user badges/"View analytics") with a plain link card, and drop the now-unused `usersByClient`/`emailById`/`listClientRoleAppUsers`/`listAllAuthUsers`/`InviteUserDialog`/`Button`/`Link`-to-analytics wiring that existed only to build that inline row:
```tsx
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { Buildings } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listClientsFull } from '@/lib/db/clients'
import { formatRelative } from '@/lib/format'
import { CLIENT_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewClientForm } from './new-client-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Clients' }

export default async function ClientsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') redirect('/crm')

  const admin = createAdminClient()
  const clients = await listClientsFull(admin)
  const now = new Date()

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader
        title="Clients"
        description="Every client the agent runs campaigns for. Open one to manage its campaigns, analytics, and logins."
      />

      <Section title="New client">
        <NewClientForm />
      </Section>

      <Section title="All clients" aside={clients.length > 0 ? `${clients.length} total` : undefined}>
        {clients.length === 0 ? (
          <EmptyState
            icon={Buildings}
            title="No clients yet"
            description="Create one above, then open it to set up a campaign and invite a login."
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {clients.map((client) => (
              <li key={client.id}>
                <Link
                  href={`/clients/${client.id}`}
                  className="border-hairline bg-surface hover:bg-accent/40 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg border p-4 transition-colors duration-200"
                >
                  <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{client.name}</p>
                  <StatusPill meta={CLIENT_STATUS[client.status]} />
                  <span className="text-faint text-[11px]">Created {formatRelative(client.created_at, now)}</span>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
```

- [ ] **Step 2: Delete the now-unused `invite-user-dialog.tsx` import site check**

`InviteUserDialog` itself stays (Task 13's Users tab still imports it from `../invite-user-dialog`) — only `page.tsx`'s own import of it is removed, which the rewrite above already does.

- [ ] **Step 3: Typecheck**

Run: `pnpm exec tsc --noEmit`
Expected: no errors, no unused-import warnings

- [ ] **Step 4: Manual smoke test**

Run: `pnpm dev`, visit `/clients`. Confirm: rows are simple link cards, clicking one navigates to `/clients/<id>` and shows the full header + tabs from Task 13.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/clients/page.tsx"
git commit -m "refactor: /clients list links to the new detail page instead of inlining everything"
```

---

### Task 16: Update the roadmap

**Files:**
- Modify: `.claude/roadmap.md`

- [ ] **Step 1: Append a dated section**

```markdown

## Client Detail Workspace (2026-07-21)

`/clients/[id]` replaces the flat `/clients` list rows with a full workspace,
mirroring `/cases/[id]`'s header+tabs shape.

- [x] Rename (`PATCH /api/clients/[clientId]`), and three lifecycle actions on
      `clients.status` (no schema change): pause (`POST .../pause`, stops new
      discovery and bulk-pauses active campaigns), resume (`POST .../resume`,
      reverses either pause or archive, unbanning logins if it was archived),
      archive (`POST .../archive`, pause + `banAuthUsers` on every client-role
      login — accounts kept, not deleted).
- [x] Permanent delete (`DELETE /api/clients/[clientId]`) — name-typed 3-step
      confirm in the UI, cascades via existing FKs, then deletes the
      now-orphaned Supabase Auth users (the one thing the DB cascade can't
      reach).
- [x] Closed a real gap found while building "pause": `write` and `research`
      route handlers, and `runFollowupStep`, never checked `campaign.status`,
      so a paused client's in-flight sends would have kept going. All three
      now skip (write/research self-heal via their existing fanout crons;
      followups reschedule the same step after a retry delay).
- [x] `AnalyticsView` extracted from `/analytics/page.tsx` so the exact same
      stat tiles/daily trend/campaign table/mailbox table/event log render
      inside the client detail page's Analytics tab, forced to one client, no
      redirect.
- [x] `NewCampaignForm` takes an optional `fixedClientId` — the Campaigns tab
      creates a campaign inline, no dropdown, no redirect, same underlying
      `/api/campaigns` endpoint.
- [x] `/clients` list simplified to link cards into `/clients/[id]`.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs: update roadmap.md with client detail workspace progress"
```

---

## Self-Review

**Spec coverage:**
- "All the Clients should be like the case ui we have" → Task 13 mirrors `/cases/[id]`'s header + `Tabs` structure exactly.
- "Every analytic and everything should be there" → Task 12 extracts the full existing Analytics dashboard into `AnalyticsView`; Task 13's Analytics tab renders it scoped to the client, in place, no link-out.
- "update name and delete client things" → Task 4 (rename), Task 8 (permanent delete), both wired into Task 13's header.
- Delete semantics from the user's own follow-up answer → three distinct actions: Task 5 (pause = stop operations only), Task 7 (archive = stop operations + ban login, accounts kept), Task 8 (permanent delete, 3-step: open dialog → type exact name → click the now-armed button).
- "the campaign creations should be in there i dont want a redirect" → Task 14 lets `NewCampaignForm` skip its client dropdown when embedded in Task 13's Campaigns tab; submission was already a `router.refresh()`, never a redirect, in both places.
- Correctness of "stop all operations" (not explicitly asked for, but required for the pause/archive buttons to not be misleading) → Group B (Tasks 9–11).

**Placeholder scan:** no `TBD`/`TODO`/"similar to above" strings; every step shows complete code.

**Type consistency:** `ClientRow['status']` (Task 1) is the same union `updateClientStatus` accepts everywhere it's called (Tasks 5–7). `pauseActiveCampaignsForClient`/`resumeCampaignsForClient` (Task 2) match their call sites in Tasks 5–7 exactly. `banAuthUsers`/`unbanAuthUsers`/`deleteAuthUsers` (Task 3) match Tasks 6–8. `AnalyticsScope` (Task 12) matches the `scope` prop Task 13 passes. `NewCampaignFormProps` (Task 14) matches both call sites (`/campaigns/page.tsx`, unchanged, and Task 13's Campaigns tab).

**One deliberate scope line:** this plan does not add a per-campaign pause/resume toggle (none exists in the product today) — `resumeCampaignsForClient` assumes every one of a client's paused campaigns was paused by the client-level action being reversed, which is true for as long as that remains the only way a campaign becomes paused.
