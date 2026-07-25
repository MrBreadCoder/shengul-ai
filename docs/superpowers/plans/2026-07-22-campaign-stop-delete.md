# Campaign Stop & Delete Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an operator stop (pause) or permanently delete an individual campaign from both the all-clients `/campaigns` list and the client workspace's campaigns tab, with a resume path back to active.

**Architecture:** Four new operator-only Route Handlers under `src/app/api/campaigns/[campaignId]/` (`stop`, `resume`, `stats`, and a bare `DELETE`) backed by three new `src/lib/db/` functions (`updateCampaignStatus`, `deleteCampaign`, plus count helpers in `cases.ts`/`leads.ts`). A shared client component (`CampaignRowActions`, with `DeleteCampaignDialog` as its delete sub-piece) is wired into both list pages. Stop/Resume toggle the existing `campaign_status` enum between `active` and `paused` — no schema migration needed. Delete is a single-row delete that relies on the FK cascade already in place from `campaigns.id` to `cases`/`leads` (and transitively `emails`/`sequences`). No QStash cleanup is required: every pipeline stage (`discover`, `research`, `write`, `followup`) already re-checks `campaign.status === 'active'` (or the campaign's continued existence) on each run, so a stale queued message just no-ops.

**Tech Stack:** Next.js App Router (Route Handlers, Server Components), Supabase (Postgres + generated types), Zod, Vitest, Tailwind, shadcn/ui (`Dialog`, `Button`, `Input`, `Label`), `sonner` toasts, `@phosphor-icons/react`.

## Global Constraints

- Operator-only: every new route checks `appUser.role !== 'operator'` → `403 { error: 'forbidden' }`, exactly like every existing client-lifecycle route.
- Every DB function throws `AppError('DB_ERROR', ...)` on a Supabase error — never lets a raw Supabase error escape `src/lib/db/`.
- Every route handler catches thrown errors and maps them via `isAppError(error) ? error.code : 'unknown'` → `500`.
- Audit log writes (`logEvent`) are always best-effort (`try { } catch { /* comment */ }`) and never allowed to turn a successful mutation into a failed response.
- No new campaign status values — stop/resume only ever set `'paused'` / `'active'`, reusing the existing `campaign_status` enum (`active | paused | archived`).
- Delete requires the operator to type the exact campaign name to arm the destructive button (type-to-confirm), matching `DeleteClientDialog`.
- UI components in this codebase have no automated tests (`vitest.config.ts` only includes `src/**/*.test.ts`, not `.tsx`, and there is no `@testing-library/react` dependency) — component work is verified manually in the browser, not via Vitest.

---

### Task 1: DB layer — `updateCampaignStatus` and `deleteCampaign`

**Files:**
- Modify: `src/lib/db/campaigns.ts`
- Test: `src/lib/db/campaigns.test.ts`

**Interfaces:**
- Consumes: `CampaignRow` type (already exported from this file), `AppError` from `@/lib/errors/app-error`.
- Produces: `updateCampaignStatus(supabase, id: string, status: CampaignRow['status']): Promise<CampaignRow>` and `deleteCampaign(supabase, id: string): Promise<void>`, both used by the stop/resume/delete routes in Tasks 4, 5, and 7.

- [ ] **Step 1: Write the failing tests**

Append to `src/lib/db/campaigns.test.ts` (add `updateCampaignStatus` and `deleteCampaign` to the existing import on line 2-10):

```ts
import {
  insertCampaign,
  getCampaignById,
  listActiveCampaigns,
  listCampaignsForClient,
  getCampaignForCase,
  pauseActiveCampaignsForClient,
  resumeCampaignsForClient,
  updateCampaignStatus,
  deleteCampaign,
} from './campaigns'
```

Then append these two new `describe` blocks at the end of the file:

```ts
describe('updateCampaignStatus', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  it('should return the updated campaign row', async () => {
    const row = { id: 'camp1', status: 'paused' }
    const result = await updateCampaignStatus(mockSupabase({ data: row, error: null }), 'camp1', 'paused')
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateCampaignStatus(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1', 'paused'),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('deleteCampaign', () => {
  function mockSupabase(result: { error: unknown }) {
    return {
      from: () => ({ delete: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should resolve when the delete succeeds', async () => {
    await expect(deleteCampaign(mockSupabase({ error: null }), 'camp1')).resolves.toBeUndefined()
  })

  it('should throw DB_ERROR when the delete fails', async () => {
    await expect(deleteCampaign(mockSupabase({ error: { message: 'boom' } }), 'camp1')).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: FAIL — `updateCampaignStatus` and `deleteCampaign` are not exported from `./campaigns`.

- [ ] **Step 3: Implement**

Append to `src/lib/db/campaigns.ts`:

```ts
export async function updateCampaignStatus(
  supabase: SupabaseClient<Database>,
  id: string,
  status: CampaignRow['status'],
): Promise<CampaignRow> {
  const { data, error } = await supabase.from('campaigns').update({ status }).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update campaign status', { id, status, cause: error?.message })
  }
  return data
}

// Every FK to campaigns carries `on delete cascade` — this permanently
// removes every case, lead, email, and sequence row for this campaign.
// Callers must have already confirmed this with the operator before calling.
export async function deleteCampaign(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase.from('campaigns').delete().eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete campaign', { id, cause: error.message })
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: PASS — all tests in the file, including the two new `describe` blocks.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat: add updateCampaignStatus and deleteCampaign to campaigns db layer"
```

---

### Task 2: DB layer — `countCasesForCampaign`

**Files:**
- Modify: `src/lib/db/cases.ts`
- Test: `src/lib/db/cases.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors/app-error` (already imported in this file).
- Produces: `countCasesForCampaign(supabase, campaignId: string): Promise<number>`, used by the stats route in Task 6.

- [ ] **Step 1: Write the failing test**

Read `src/lib/db/cases.test.ts` first to match its existing mock style, then append:

```ts
describe('countCasesForCampaign', () => {
  function mockSupabase(result: { count: number | null; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should return the count of cases for the campaign', async () => {
    const result = await countCasesForCampaign(mockSupabase({ count: 3, error: null }), 'camp1')
    expect(result).toBe(3)
  })

  it('should return 0 when count is null', async () => {
    const result = await countCasesForCampaign(mockSupabase({ count: null, error: null }), 'camp1')
    expect(result).toBe(0)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      countCasesForCampaign(mockSupabase({ count: null, error: { message: 'boom' } }), 'camp1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Add `countCasesForCampaign` to this test file's import from `./cases`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/cases.test.ts`
Expected: FAIL — `countCasesForCampaign` is not exported from `./cases`.

- [ ] **Step 3: Implement**

Append to `src/lib/db/cases.ts`:

```ts
// Blast-radius count for the campaign delete confirmation dialog — a head
// count avoids fetching every case row just to show a number.
export async function countCasesForCampaign(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('cases')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count cases for campaign', { campaignId, cause: error.message })
  }
  return count ?? 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/cases.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/cases.ts src/lib/db/cases.test.ts
git commit -m "feat: add countCasesForCampaign to cases db layer"
```

---

### Task 3: DB layer — `countLeadsForCampaign`

**Files:**
- Modify: `src/lib/db/leads.ts`
- Test: `src/lib/db/leads.test.ts`

**Interfaces:**
- Consumes: `AppError` from `@/lib/errors/app-error` (already imported in this file).
- Produces: `countLeadsForCampaign(supabase, campaignId: string): Promise<number>`, used by the stats route in Task 6.

- [ ] **Step 1: Write the failing test**

Append to `src/lib/db/leads.test.ts` (add `countLeadsForCampaign` to the import from `./leads`):

```ts
describe('countLeadsForCampaign', () => {
  function mockSupabase(result: { count: number | null; error: unknown }) {
    return {
      from: () => ({ select: () => ({ eq: () => Promise.resolve(result) }) }),
    } as never
  }

  it('should return the count of leads for the campaign', async () => {
    const result = await countLeadsForCampaign(mockSupabase({ count: 5, error: null }), 'camp1')
    expect(result).toBe(5)
  })

  it('should return 0 when count is null', async () => {
    const result = await countLeadsForCampaign(mockSupabase({ count: null, error: null }), 'camp1')
    expect(result).toBe(0)
  })

  it('should throw DB_ERROR on query failure', async () => {
    await expect(
      countLeadsForCampaign(mockSupabase({ count: null, error: { message: 'boom' } }), 'camp1'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: FAIL — `countLeadsForCampaign` is not exported from `./leads`.

- [ ] **Step 3: Implement**

Append to `src/lib/db/leads.ts`:

```ts
// Blast-radius count for the campaign delete confirmation dialog — a head
// count avoids fetching every lead row just to show a number.
export async function countLeadsForCampaign(
  supabase: SupabaseClient<Database>,
  campaignId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('leads')
    .select('id', { count: 'exact', head: true })
    .eq('campaign_id', campaignId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count leads for campaign', { campaignId, cause: error.message })
  }
  return count ?? 0
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/leads.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/leads.ts src/lib/db/leads.test.ts
git commit -m "feat: add countLeadsForCampaign to leads db layer"
```

---

### Task 4: API route — `POST /api/campaigns/[campaignId]/stop`

**Files:**
- Create: `src/app/api/campaigns/[campaignId]/stop/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/stop/route.test.ts`

**Interfaces:**
- Consumes: `getCampaignById`, `updateCampaignStatus` from `@/lib/db/campaigns` (Task 1); `requireUser` from `@/lib/auth/require-user`; `createAdminClient` from `@/lib/supabase/admin`; `logEvent` from `@/lib/events/log-event`; `isAppError` from `@/lib/errors/app-error`.
- Produces: `POST` handler returning `{ ok: true, campaign: CampaignRow }` on success, consumed by `CampaignRowActions` in Task 9 via `fetch('/api/campaigns/{id}/stop', { method: 'POST' })`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/campaigns/[campaignId]/stop/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const updateCampaignStatusMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  updateCampaignStatus: (...a: unknown[]) => updateCampaignStatusMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  updateCampaignStatusMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/campaigns/[campaignId]/stop', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    expect(res.status).toBe(403)
    expect(getCampaignByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the campaign is not active', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(updateCampaignStatusMock).not.toHaveBeenCalled()
  })

  it('should stop an active campaign and log the event', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active' })
    updateCampaignStatusMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' } })
    expect(updateCampaignStatusMock).toHaveBeenCalledWith(expect.anything(), 'camp1', 'paused')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.stopped' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/stop/route.test.ts`
Expected: FAIL — `./route` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/app/api/campaigns/[campaignId]/stop/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, updateCampaignStatus } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (campaign.status !== 'active') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }

  try {
    const updated = await updateCampaignStatus(admin, campaignId, 'paused')
    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.stopped',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the stop already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/stop/route.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/campaigns/[campaignId]/stop/route.ts" "src/app/api/campaigns/[campaignId]/stop/route.test.ts"
git commit -m "feat: add POST /api/campaigns/[campaignId]/stop route"
```

---

### Task 5: API route — `POST /api/campaigns/[campaignId]/resume`

**Files:**
- Create: `src/app/api/campaigns/[campaignId]/resume/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/resume/route.test.ts`

**Interfaces:**
- Consumes: same as Task 4.
- Produces: `POST` handler returning `{ ok: true, campaign: CampaignRow }`, consumed by `CampaignRowActions` in Task 9.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/campaigns/[campaignId]/resume/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const updateCampaignStatusMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  updateCampaignStatus: (...a: unknown[]) => updateCampaignStatusMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  updateCampaignStatusMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('POST /api/campaigns/[campaignId]/resume', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    expect(res.status).toBe(403)
    expect(getCampaignByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the campaign is not paused', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(updateCampaignStatusMock).not.toHaveBeenCalled()
  })

  it('should resume a paused campaign and log the event', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'paused' })
    updateCampaignStatusMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active' })
    const res = await POST(new Request('http://x', { method: 'POST' }), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: { id: 'camp1', client_id: 'c1', name: 'Acme launch', status: 'active' } })
    expect(updateCampaignStatusMock).toHaveBeenCalledWith(expect.anything(), 'camp1', 'active')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.resumed' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/resume/route.test.ts`
Expected: FAIL — `./route` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/app/api/campaigns/[campaignId]/resume/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, updateCampaignStatus } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function POST(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }
  if (campaign.status !== 'paused') {
    return NextResponse.json({ error: 'invalid_status' }, { status: 400 })
  }

  try {
    const updated = await updateCampaignStatus(admin, campaignId, 'active')
    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.resumed',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the resume already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: updated })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/resume/route.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/campaigns/[campaignId]/resume/route.ts" "src/app/api/campaigns/[campaignId]/resume/route.test.ts"
git commit -m "feat: add POST /api/campaigns/[campaignId]/resume route"
```

---

### Task 6: API route — `GET /api/campaigns/[campaignId]/stats`

**Files:**
- Create: `src/app/api/campaigns/[campaignId]/stats/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/stats/route.test.ts`

**Interfaces:**
- Consumes: `getCampaignById` from `@/lib/db/campaigns`; `countCasesForCampaign` from `@/lib/db/cases` (Task 2); `countLeadsForCampaign` from `@/lib/db/leads` (Task 3).
- Produces: `GET` handler returning `{ ok: true, caseCount: number, leadCount: number }`, consumed by `DeleteCampaignDialog` in Task 9 via `fetch('/api/campaigns/{id}/stats')` when the dialog opens.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/campaigns/[campaignId]/stats/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const countCasesForCampaignMock = vi.fn()
const countLeadsForCampaignMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({ getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a) }))
vi.mock('@/lib/db/cases', () => ({ countCasesForCampaign: (...a: unknown[]) => countCasesForCampaignMock(...a) }))
vi.mock('@/lib/db/leads', () => ({ countLeadsForCampaign: (...a: unknown[]) => countLeadsForCampaignMock(...a) }))

import { GET } from './route'

function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  countCasesForCampaignMock.mockReset()
  countLeadsForCampaignMock.mockReset()
})

describe('GET /api/campaigns/[campaignId]/stats', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await GET(new Request('http://x'), ctx('camp1'))
    expect(res.status).toBe(403)
    expect(getCampaignByIdMock).not.toHaveBeenCalled()
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await GET(new Request('http://x'), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return the case and lead counts', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', name: 'Acme launch' })
    countCasesForCampaignMock.mockResolvedValue(3)
    countLeadsForCampaignMock.mockResolvedValue(7)
    const res = await GET(new Request('http://x'), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, caseCount: 3, leadCount: 7 })
    expect(countCasesForCampaignMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(countLeadsForCampaignMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/stats/route.test.ts`
Expected: FAIL — `./route` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/app/api/campaigns/[campaignId]/stats/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById } from '@/lib/db/campaigns'
import { countCasesForCampaign } from '@/lib/db/cases'
import { countLeadsForCampaign } from '@/lib/db/leads'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

export async function GET(_request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const [caseCount, leadCount] = await Promise.all([
      countCasesForCampaign(admin, campaignId),
      countLeadsForCampaign(admin, campaignId),
    ])
    return NextResponse.json({ ok: true, caseCount, leadCount })
  } catch (error) {
    const code = isAppError(error) ? error.code : 'unknown'
    return NextResponse.json({ error: code }, { status: 500 })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/stats/route.test.ts`
Expected: PASS — all 3 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/campaigns/[campaignId]/stats/route.ts" "src/app/api/campaigns/[campaignId]/stats/route.test.ts"
git commit -m "feat: add GET /api/campaigns/[campaignId]/stats route"
```

---

### Task 7: API route — `DELETE /api/campaigns/[campaignId]`

**Files:**
- Create: `src/app/api/campaigns/[campaignId]/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/route.test.ts`

**Interfaces:**
- Consumes: `getCampaignById`, `deleteCampaign` from `@/lib/db/campaigns` (Task 1).
- Produces: `DELETE` handler returning `{ ok: true }`, consumed by `DeleteCampaignDialog` in Task 9 via `fetch('/api/campaigns/{id}', { method: 'DELETE', body: JSON.stringify({ confirmName }) })`.

- [ ] **Step 1: Write the failing test**

Create `src/app/api/campaigns/[campaignId]/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const deleteCampaignMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  deleteCampaign: (...a: unknown[]) => deleteCampaignMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { DELETE } from './route'

function deleteReq(body: unknown) {
  return new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) })
}
function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  deleteCampaignMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})

describe('DELETE /api/campaigns/[campaignId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await DELETE(deleteReq({ confirmName: 'Acme launch' }), ctx('camp1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await DELETE(deleteReq({ confirmName: 'Acme launch' }), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the confirmation name does not match', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    const res = await DELETE(deleteReq({ confirmName: 'wrong' }), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(deleteCampaignMock).not.toHaveBeenCalled()
  })

  it('should delete the campaign and log the event when the name matches', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    deleteCampaignMock.mockResolvedValue(undefined)
    const res = await DELETE(deleteReq({ confirmName: 'Acme launch' }), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true })
    expect(deleteCampaignMock).toHaveBeenCalledWith(expect.anything(), 'camp1')
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.deleted' }))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/route.test.ts`
Expected: FAIL — `./route` does not exist yet.

- [ ] **Step 3: Implement**

Create `src/app/api/campaigns/[campaignId]/route.ts`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, deleteCampaign } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const deleteSchema = z.object({
  confirmName: z.string().min(1),
})

// Deletes the campaign row, cascading (via FK) to every case, lead, email,
// and sequence under it. Irreversible.
export async function DELETE(request: Request, context: { params: Promise<{ campaignId: string }> }) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  const { campaignId } = await context.params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 })
  }

  try {
    const body = deleteSchema.parse(await request.json())
    if (body.confirmName !== campaign.name) {
      return NextResponse.json({ error: 'name_mismatch' }, { status: 400 })
    }

    await deleteCampaign(admin, campaignId)

    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.deleted',
        payload: { campaignId, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the delete already succeeded, and
      // campaignId no longer references a real row, but events.client_id
      // still references a real client, so this insert is still valid.
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

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/route.test.ts`
Expected: PASS — all 4 tests.

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/campaigns/[campaignId]/route.ts" "src/app/api/campaigns/[campaignId]/route.test.ts"
git commit -m "feat: add DELETE /api/campaigns/[campaignId] route"
```

---

### Task 8: `CAMPAIGN_STATUS` status metadata

**Files:**
- Modify: `src/lib/ui/status.ts`

**Interfaces:**
- Consumes: `Database['public']['Enums']['campaign_status']` from `@/types/database` (already imported as a pattern in this file for other enums).
- Produces: `CAMPAIGN_STATUS: Record<CampaignStatus, StatusMeta>`, used by `StatusPill` in Tasks 10 and 11.

- [ ] **Step 1: Implement**

In `src/lib/ui/status.ts`, add the type alias next to the other `type X = Database['public']['Enums']['...']` lines near the top (after `type ClientStatus = ...` on line 9):

```ts
type CampaignStatus = Database['public']['Enums']['campaign_status']
```

Then add the record after `CLIENT_STATUS` (after the closing brace on line 57), preserving the exact same colors currently hardcoded inline in `src/app/(app)/campaigns/page.tsx` so this is a pure refactor with no visual change:

```ts
export const CAMPAIGN_STATUS: Record<CampaignStatus, StatusMeta> = {
  active: { label: 'Active', color: 'var(--status-won)' },
  paused: { label: 'Paused', color: 'var(--status-researching)' },
  archived: { label: 'Archived', color: 'var(--status-dead)' },
}
```

- [ ] **Step 2: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: No new errors (the file still compiles — `Database['public']['Enums']['campaign_status']` matches the same 3-value union already used in `campaigns.ts`).

- [ ] **Step 3: Commit**

```bash
git add src/lib/ui/status.ts
git commit -m "feat: add CAMPAIGN_STATUS status metadata"
```

---

### Task 9: `CampaignRowActions` and `DeleteCampaignDialog` components

**Files:**
- Create: `src/app/(app)/campaigns/campaign-row-actions.tsx`
- Create: `src/app/(app)/campaigns/delete-campaign-dialog.tsx`

**Interfaces:**
- Consumes: `Button`, `Dialog`/`DialogContent`/`DialogFooter`/`DialogHeader`/`DialogTitle`/`DialogTrigger` from `@/components/ui/*`; `Input` from `@/components/ui/input`; `Label` from `@/components/ui/label`; `toast` from `sonner`; icons from `@phosphor-icons/react`; `Database` type from `@/types/database`. Calls the routes built in Tasks 4-7.
- Produces: `CampaignRowActions({ campaignId, campaignName, status }): React.ReactElement`, consumed by `src/app/(app)/campaigns/page.tsx` (Task 10) and `src/app/(app)/clients/[id]/page.tsx` (Task 11) via `import { CampaignRowActions } from './campaign-row-actions'` / `'../../campaigns/campaign-row-actions'` respectively.

No automated test for this task — this codebase has no React component test setup (`vitest.config.ts` only globs `src/**/*.test.ts`, and there is no `@testing-library/react` dependency in `package.json`). Verification is manual, in Task 12.

- [ ] **Step 1: Create the delete dialog**

Create `src/app/(app)/campaigns/delete-campaign-dialog.tsx`:

```tsx
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

type StatsState =
  | { status: 'loading' }
  | { status: 'loaded'; caseCount: number; leadCount: number }
  | { status: 'error' }

type DeleteState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface DeleteCampaignDialogProps {
  campaignId: string
  campaignName: string
}

// Three-step by design, same as DeleteClientDialog: (1) open the dialog,
// which fetches and states the blast radius, (2) type the exact campaign
// name to arm the button, (3) click the armed button.
export function DeleteCampaignDialog({ campaignId, campaignName }: DeleteCampaignDialogProps): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [stats, setStats] = useState<StatsState>({ status: 'loading' })
  const [state, setState] = useState<DeleteState>({ status: 'idle' })

  const isArmed = confirmName === campaignName && stats.status === 'loaded'

  async function loadStats(): Promise<void> {
    setStats({ status: 'loading' })
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/stats`)
      if (!res.ok) {
        setStats({ status: 'error' })
        return
      }
      const json = (await res.json()) as { caseCount: number; leadCount: number }
      setStats({ status: 'loaded', caseCount: json.caseCount, leadCount: json.leadCount })
    } catch {
      setStats({ status: 'error' })
    }
  }

  async function onConfirm(): Promise<void> {
    if (!isArmed) return
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not delete the campaign.'
        setState({ status: 'error', message })
        toast.error('Delete failed', { description: message })
        return
      }
      toast.success(`${campaignName} deleted`)
      setOpen(false)
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
        if (next) {
          void loadStats()
        } else {
          setConfirmName('')
          setState({ status: 'idle' })
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          <Trash size={13} weight="light" />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {campaignName} permanently</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {stats.status === 'loading' ? (
            <p className="text-muted-foreground text-sm">Checking what this deletes…</p>
          ) : stats.status === 'error' ? (
            <p role="alert" className="text-destructive text-sm">
              Could not load the case and lead counts for this campaign. Close and reopen this dialog to retry.
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              This deletes {stats.caseCount} case{stats.caseCount === 1 ? '' : 's'} and {stats.leadCount} lead
              {stats.leadCount === 1 ? '' : 's'} under this campaign, plus every email and sequence tied to them.
              There is no undo.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor={`confirmName-${campaignId}`} className="text-xs">
              Type <span className="font-mono">{campaignName}</span> to confirm
            </Label>
            <Input
              id={`confirmName-${campaignId}`}
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
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!isArmed || state.status === 'submitting'}
            onClick={onConfirm}
          >
            {state.status === 'submitting' ? 'Deleting…' : 'Delete forever'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Create the row actions component**

Create `src/app/(app)/campaigns/campaign-row-actions.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pause, Play } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { Database } from '@/types/database'
import { DeleteCampaignDialog } from './delete-campaign-dialog'

type CampaignStatus = Database['public']['Enums']['campaign_status']

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

async function postAction(campaignId: string, action: 'stop' | 'resume'): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/campaigns/${campaignId}/${action}`, { method: 'POST' })
  if (res.ok) return { ok: true }
  const json: unknown = await res.json().catch(() => ({}))
  const message =
    typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'Request failed.'
  return { ok: false, message }
}

interface StopCampaignDialogProps {
  campaignId: string
  campaignName: string
  onDone: () => void
}

// Two-step by design, same as ClientLifecycleActions' pause/archive dialog:
// stopping changes externally-visible behaviour (discovery/research/writing/
// follow-ups halt), so it never fires on a single click. Resume, below, only
// ever restores a safer prior state, so it stays a single click.
function StopCampaignDialog({ campaignId, campaignName, onDone }: StopCampaignDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onConfirm(): Promise<void> {
    setState({ status: 'submitting' })
    const result = await postAction(campaignId, 'stop')
    if (!result.ok) {
      const message = result.message ?? 'Request failed.'
      setState({ status: 'error', message })
      toast.error('Stop failed', { description: message })
      return
    }
    setState({ status: 'idle' })
    setOpen(false)
    toast.success(`${campaignName} stopped`)
    onDone()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setState({ status: 'idle' })
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <Pause size={13} weight="light" />
          Stop
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Stop {campaignName}?</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">
          Discovery, research, writing, and follow-ups for this campaign halt on the next pipeline tick. Any
          already-queued work for it will no-op safely. You can resume at any time.
        </p>
        {state.status === 'error' ? (
          <p role="alert" className="text-destructive text-xs">
            {state.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" size="sm" disabled={state.status === 'submitting'} onClick={onConfirm}>
            {state.status === 'submitting' ? 'Stopping…' : 'Yes, stop campaign'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

interface CampaignRowActionsProps {
  campaignId: string
  campaignName: string
  status: CampaignStatus
}

// Archived campaigns show only Delete: there is no per-campaign archive
// action in this product yet (only the client-level archive path exists),
// so an already-archived campaign is already considered halted — a
// redundant Stop button there would be confusing.
export function CampaignRowActions({ campaignId, campaignName, status }: CampaignRowActionsProps): React.ReactElement {
  const router = useRouter()
  const [resumeState, setResumeState] = useState<SubmitState>({ status: 'idle' })

  async function runResume(): Promise<void> {
    setResumeState({ status: 'submitting' })
    const result = await postAction(campaignId, 'resume')
    if (!result.ok) {
      toast.error('Resume failed', { description: result.message })
      setResumeState({ status: 'idle' })
      return
    }
    toast.success(`${campaignName} resumed`)
    setResumeState({ status: 'idle' })
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'active' ? (
        <StopCampaignDialog campaignId={campaignId} campaignName={campaignName} onDone={() => router.refresh()} />
      ) : null}

      {status === 'paused' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={resumeState.status === 'submitting'}
          onClick={() => void runResume()}
        >
          <Play size={13} weight="light" />
          {resumeState.status === 'submitting' ? 'Resuming…' : 'Resume'}
        </Button>
      ) : null}

      <DeleteCampaignDialog campaignId={campaignId} campaignName={campaignName} />
    </div>
  )
}
```

- [ ] **Step 3: Typecheck**

Run: `pnpm tsc --noEmit`
Expected: No errors.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/campaigns/campaign-row-actions.tsx" "src/app/(app)/campaigns/delete-campaign-dialog.tsx"
git commit -m "feat: add CampaignRowActions and DeleteCampaignDialog components"
```

---

### Task 10: Wire actions into the all-clients `/campaigns` page

**Files:**
- Modify: `src/app/(app)/campaigns/page.tsx`

**Interfaces:**
- Consumes: `CampaignRowActions` from `./campaign-row-actions` (Task 9); `CAMPAIGN_STATUS` from `@/lib/ui/status` (Task 8); `StatusPill` from `@/components/status-dot`.

- [ ] **Step 1: Update imports**

In `src/app/(app)/campaigns/page.tsx`, replace the import block (lines 1-11):

```ts
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listClients } from '@/lib/db/clients'
import { formatRelative, humanizeEnum } from '@/lib/format'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewCampaignForm } from './new-campaign-form'
```

with:

```ts
import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import { listClients } from '@/lib/db/clients'
import { formatRelative } from '@/lib/format'
import { CAMPAIGN_STATUS } from '@/lib/ui/status'
import { StatusPill } from '@/components/status-dot'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewCampaignForm } from './new-campaign-form'
import { CampaignRowActions } from './campaign-row-actions'
```

- [ ] **Step 2: Remove the now-redundant local color map**

Delete lines 17-22 (the `CAMPAIGN_STATUS_COLOR` constant and its comment):

```ts
/** Campaign status is its own small vocabulary, unrelated to case status. */
const CAMPAIGN_STATUS_COLOR = {
  active: 'var(--status-won)',
  paused: 'var(--status-researching)',
  archived: 'var(--status-dead)',
} as const
```

- [ ] **Step 3: Replace the campaign row rendering**

Replace the `campaigns.map` block (originally lines 66-99):

```tsx
{campaigns.map((campaign, index) => {
  const color = CAMPAIGN_STATUS_COLOR[campaign.status]
  return (
    <li
      key={campaign.id}
      className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4"
      style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
        <span
          className="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium"
          style={{
            color,
            background: `color-mix(in oklch, ${color} 14%, transparent)`,
          }}
        >
          <span aria-hidden className="size-1.5 rounded-full" style={{ background: color }} />
          {humanizeEnum(campaign.status)}
        </span>
      </div>

      <p className="text-muted-foreground mt-2.5 max-w-[70ch] text-sm leading-relaxed">
        {campaign.value_prop}
      </p>

      <div className="text-faint mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="tnum">{campaign.daily_target} leads/day</span>
        <span className="tnum">{campaign.mailbox_ids.length} mailboxes</span>
        <span className="ml-auto">Created {formatRelative(campaign.created_at, now)}</span>
      </div>
    </li>
  )
})}
```

with:

```tsx
{campaigns.map((campaign, index) => (
  <li
    key={campaign.id}
    className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4"
    style={{ animationDelay: `${Math.min(index, 10) * 30}ms` }}
  >
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
      <StatusPill meta={CAMPAIGN_STATUS[campaign.status]} />
    </div>

    <p className="text-muted-foreground mt-2.5 max-w-[70ch] text-sm leading-relaxed">
      {campaign.value_prop}
    </p>

    <div className="text-faint mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
      <span className="tnum">{campaign.daily_target} leads/day</span>
      <span className="tnum">{campaign.mailbox_ids.length} mailboxes</span>
      <span className="ml-auto">Created {formatRelative(campaign.created_at, now)}</span>
    </div>

    <div className="border-hairline mt-3 flex items-center gap-2 border-t pt-3">
      <CampaignRowActions campaignId={campaign.id} campaignName={campaign.name} status={campaign.status} />
    </div>
  </li>
))}
```

- [ ] **Step 4: Typecheck and run the full test suite**

Run: `pnpm tsc --noEmit && pnpm test`
Expected: No errors; all existing tests (including `src/app/api/campaigns/route.test.ts`) still pass.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/campaigns/page.tsx"
git commit -m "feat: add stop/resume/delete row actions to the campaigns list"
```

---

### Task 11: Wire actions into the client workspace campaigns tab

**Files:**
- Modify: `src/app/(app)/clients/[id]/page.tsx`

**Interfaces:**
- Consumes: `CampaignRowActions` from `../../campaigns/campaign-row-actions` (Task 9, same relative-import pattern already used for `NewCampaignForm` on line 22); `CAMPAIGN_STATUS` added to the existing `@/lib/ui/status` import.

- [ ] **Step 1: Update imports**

In `src/app/(app)/clients/[id]/page.tsx`, update the `@/lib/ui/status` import (line 16):

```ts
import { CLIENT_STATUS } from '@/lib/ui/status'
```

to:

```ts
import { CLIENT_STATUS, CAMPAIGN_STATUS } from '@/lib/ui/status'
```

Add a new import after the `NewCampaignForm` import (after line 22):

```ts
import { CampaignRowActions } from '../../campaigns/campaign-row-actions'
```

- [ ] **Step 2: Update the campaigns tab row rendering**

Replace the campaigns `<ul>` block inside `TabsContent value="campaigns"` (originally lines 197-204):

```tsx
<ul className="flex flex-col gap-2">
  {campaigns.map((campaign) => (
    <li key={campaign.id} className="border-hairline bg-surface rounded-lg border p-4">
      <p className="text-[13px] font-medium">{campaign.name}</p>
      <p className="text-muted-foreground mt-1 text-sm">{campaign.value_prop}</p>
    </li>
  ))}
</ul>
```

with:

```tsx
<ul className="flex flex-col gap-2">
  {campaigns.map((campaign) => (
    <li key={campaign.id} className="border-hairline bg-surface rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
        <StatusPill meta={CAMPAIGN_STATUS[campaign.status]} />
      </div>
      <p className="text-muted-foreground mt-1 text-sm">{campaign.value_prop}</p>
      <div className="border-hairline mt-3 flex items-center gap-2 border-t pt-3">
        <CampaignRowActions campaignId={campaign.id} campaignName={campaign.name} status={campaign.status} />
      </div>
    </li>
  ))}
</ul>
```

(`StatusPill` is already imported on line 17 for the client-level status pill in the page header, so no new import is needed for it.)

- [ ] **Step 3: Typecheck and run the full test suite**

Run: `pnpm tsc --noEmit && pnpm test`
Expected: No errors; all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/clients/[id]/page.tsx"
git commit -m "feat: add stop/resume/delete row actions to the client campaigns tab"
```

---

### Task 12: Manual verification

**Files:** none (verification only)

- [ ] **Step 1: Start the dev server**

Run: `pnpm dev`

- [ ] **Step 2: Verify on the all-clients `/campaigns` page**

As an operator: log in, go to `/campaigns`. For an **active** campaign, confirm a "Stop" button is visible; click it, confirm the dialog text, click "Yes, stop campaign", confirm a success toast appears and the row's status pill updates to "Paused" with a "Resume" button in its place. Click "Resume" and confirm it flips back to "Active" with a "Stop" button, no dialog required.

- [ ] **Step 3: Verify delete on `/campaigns`**

Click "Delete" on any campaign row. Confirm the dialog shows a loading state briefly, then the real case/lead counts. Confirm the "Delete forever" button stays disabled until the campaign name is typed exactly. Type it, click "Delete forever", confirm a success toast and that the row disappears from the list.

- [ ] **Step 4: Verify the client workspace campaigns tab**

Go to `/clients/[id]` for a client with at least one campaign, open the "Campaigns" tab. Confirm the same status pill, Stop/Resume, and Delete controls appear per row and behave identically to Step 2-3.

- [ ] **Step 5: Verify role gating**

Log in as a `client`-role user (or hit the routes directly with a client session) and confirm `POST /api/campaigns/[id]/stop`, `/resume`, `GET /api/campaigns/[id]/stats`, and `DELETE /api/campaigns/[id]` all return `403`.

- [ ] **Step 6: Run the full test suite one more time**

Run: `pnpm test && pnpm tsc --noEmit`
Expected: All green, no type errors.
