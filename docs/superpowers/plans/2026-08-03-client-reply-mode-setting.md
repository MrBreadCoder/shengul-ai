# Client-Configurable Reply Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a client choose, from `/settings`, how the AI handles lead replies across all of their campaigns — Automatic (`auto_send`), Manual (`human_approve`), or Hybrid — with the choice applying account-wide.

**Architecture:** Add `clients.reply_mode` as the account-level source of truth. The reply pipeline already reads `campaigns.reply_mode` exclusively via `getCampaignForCase()`, so no pipeline code changes — instead, a new Server Action writes the client's preference and bulk-syncs it onto every one of that client's campaign rows in the same call. New campaign creation picks up the client's current preference instead of the column default.

**Tech Stack:** Next.js Server Actions, Supabase/Postgres, Zod, Vitest.

## Global Constraints

- Reuses the existing `reply_mode` Postgres enum (`auto_send` | `human_approve` | `hybrid`) — no new enum type.
- No pipeline code (`src/lib/pipeline/*.ts`) changes — all reads continue through `getCampaignForCase()` → `campaigns.reply_mode`.
- Changing the setting bulk-updates **every** campaign for the client regardless of status (active, paused, archived) — no status filter.
- Setting is client-role only; no operator-facing control is added.
- No confirmation dialog on selecting Automatic — save-on-change, per the approved design.
- `src/types/database.ts` is hand-authored (no live `supabase gen types` connection available) — edit it by hand to match the migration exactly.
- Follow `.claude/QUALITY.md`: one function per DB operation, Zod validation on every Server Action input, `{ data, error }` handled on every Supabase call, `AppError` (never a bare `Error`) on every failure path.
- Design doc: `docs/superpowers/specs/2026-08-03-client-reply-mode-setting-design.md`.

---

### Task 1: Migration — `clients.reply_mode` column + hand-authored types

**Files:**
- Create: `supabase/migrations/0023_client_reply_mode.sql`
- Modify: `src/types/database.ts:12-39` (the `clients` table `Row`/`Insert`/`Update` shape)

**Interfaces:**
- Produces: `clients.reply_mode` column (Postgres, `reply_mode` enum, `not null default 'human_approve'`), and `Database['public']['Tables']['clients']['Row']['reply_mode']` / `['Insert']['reply_mode']` typed as `Database['public']['Enums']['reply_mode']` (optional on insert).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0023_client_reply_mode.sql`:

```sql
-- Client-configurable reply mode. Clients choose Automatic / Manual / Hybrid
-- from /settings; the value is synced onto every campaigns.reply_mode row for
-- that client so the existing pipeline read path (getCampaignForCase) needs
-- no changes. See docs/superpowers/specs/2026-08-03-client-reply-mode-setting-design.md.

alter table clients add column reply_mode reply_mode not null default 'human_approve';
```

- [ ] **Step 2: Update the hand-authored database types**

In `src/types/database.ts`, the `clients` table entry currently reads (lines 12-39):

```ts
      clients: {
        Row: {
          id: string
          name: string
          status: Database['public']['Enums']['client_status']
          settings: Json
          warmup_profile: Database['public']['Enums']['warmup_profile']
          mailreach_enabled: boolean
          domain: string | null
          logo_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          status?: Database['public']['Enums']['client_status']
          settings?: Json
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          mailreach_enabled?: boolean
          domain?: string | null
          logo_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
```

Add `reply_mode` to both `Row` and `Insert` (immediately after `mailreach_enabled` to mirror the migration's column order):

```ts
      clients: {
        Row: {
          id: string
          name: string
          status: Database['public']['Enums']['client_status']
          settings: Json
          warmup_profile: Database['public']['Enums']['warmup_profile']
          mailreach_enabled: boolean
          reply_mode: Database['public']['Enums']['reply_mode']
          domain: string | null
          logo_url: string | null
          created_at: string
          updated_at: string
        }
        Insert: {
          id?: string
          name: string
          status?: Database['public']['Enums']['client_status']
          settings?: Json
          warmup_profile?: Database['public']['Enums']['warmup_profile']
          mailreach_enabled?: boolean
          reply_mode?: Database['public']['Enums']['reply_mode']
          domain?: string | null
          logo_url?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
```

(`Update` is already `Partial<Insert>`, so it picks up the new field automatically — no separate edit needed there.)

- [ ] **Step 3: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: no errors related to `clients` or `reply_mode`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0023_client_reply_mode.sql src/types/database.ts
git commit -m "feat: add clients.reply_mode column"
```

---

### Task 2: `updateClientReplyMode` in `lib/db/clients.ts`

**Files:**
- Modify: `src/lib/db/clients.ts` (add function after `updateClientMailreachEnabled`, currently ending around line 136)
- Test: `src/lib/db/clients.test.ts` (add `describe('updateClientReplyMode', ...)` after the `updateClientMailreachEnabled` block, currently ending around line 294)

**Interfaces:**
- Consumes: `ClientRow` (already exported from this file, `src/lib/db/clients.ts:6`).
- Produces: `updateClientReplyMode(supabase: SupabaseClient<Database>, id: string, mode: Database['public']['Enums']['reply_mode']): Promise<ClientRow>` — used by Task 5.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db/clients.test.ts` (after the `updateClientMailreachEnabled` describe block, before the file's closing):

```ts
describe('updateClientReplyMode', () => {
  it('should persist the mode and return the updated row', async () => {
    const row = { id: 'c1', reply_mode: 'auto_send' }
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: row, error: null }) }) }),
    })
    const result = await updateClientReplyMode({ from: () => ({ update }) } as never, 'c1', 'auto_send')
    expect(update).toHaveBeenCalledWith({ reply_mode: 'auto_send' })
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR when the update fails', async () => {
    const update = vi.fn().mockReturnValue({
      eq: () => ({ select: () => ({ single: () => Promise.resolve({ data: null, error: { message: 'boom' } }) }) }),
    })
    await expect(
      updateClientReplyMode({ from: () => ({ update }) } as never, 'c1', 'auto_send'),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Also add `updateClientReplyMode` to the top-of-file import from `./clients`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/clients.test.ts -t "updateClientReplyMode"`
Expected: FAIL — `updateClientReplyMode` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/clients.ts`, add after `updateClientMailreachEnabled` (around line 136):

```ts
export async function updateClientReplyMode(
  supabase: SupabaseClient<Database>,
  id: string,
  mode: Database['public']['Enums']['reply_mode'],
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({ reply_mode: mode })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client reply mode', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/db/clients.test.ts -t "updateClientReplyMode"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/clients.ts src/lib/db/clients.test.ts
git commit -m "feat: add updateClientReplyMode"
```

---

### Task 3: `syncReplyModeForClient` in `lib/db/campaigns.ts`

**Files:**
- Modify: `src/lib/db/campaigns.ts` (add function after `pauseActiveCampaignsForClient`/`resumeCampaignsForClient`, currently ending around line 96)
- Test: `src/lib/db/campaigns.test.ts` (add `describe('syncReplyModeForClient', ...)` after the `resumeCampaignsForClient` block, currently ending around line 163)

**Interfaces:**
- Consumes: nothing new.
- Produces: `syncReplyModeForClient(supabase: SupabaseClient<Database>, clientId: string, mode: Database['public']['Enums']['reply_mode']): Promise<void>` — used by Task 5.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db/campaigns.test.ts` (after the `resumeCampaignsForClient` describe block):

```ts
describe('syncReplyModeForClient', () => {
  it('should bulk-update every campaign for the client regardless of status', async () => {
    const update = vi.fn().mockReturnValue({ eq: () => Promise.resolve({ error: null }) })
    const supabase = { from: () => ({ update }) } as never
    await expect(syncReplyModeForClient(supabase, 'c1', 'auto_send')).resolves.toBeUndefined()
    expect(update).toHaveBeenCalledWith({ reply_mode: 'auto_send' })
  })

  it('should throw DB_ERROR when the bulk update fails', async () => {
    const supabase = {
      from: () => ({ update: () => ({ eq: () => Promise.resolve({ error: { message: 'boom' } }) }) }),
    } as never
    await expect(syncReplyModeForClient(supabase, 'c1', 'auto_send')).rejects.toBeInstanceOf(AppError)
  })
})
```

Also add `syncReplyModeForClient` to the top-of-file import from `./campaigns`.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/db/campaigns.test.ts -t "syncReplyModeForClient"`
Expected: FAIL — `syncReplyModeForClient` is not exported.

- [ ] **Step 3: Write the implementation**

In `src/lib/db/campaigns.ts`, add after `resumeCampaignsForClient` (around line 96):

```ts
// No status filter, unlike pauseActiveCampaignsForClient/resumeCampaignsForClient
// — every campaign (active, paused, or archived) must reflect the client's
// current preference immediately, so a paused campaign is already correct if
// it is ever resumed.
export async function syncReplyModeForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
  mode: Database['public']['Enums']['reply_mode'],
): Promise<void> {
  const { error } = await supabase
    .from('campaigns')
    .update({ reply_mode: mode })
    .eq('client_id', clientId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to sync reply mode for client', { clientId, cause: error.message })
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/db/campaigns.test.ts -t "syncReplyModeForClient"`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat: add syncReplyModeForClient"
```

---

### Task 4: New campaigns default to the client's current reply mode

**Files:**
- Modify: `src/app/api/campaigns/route.ts`
- Test: `src/app/api/campaigns/route.test.ts`

**Interfaces:**
- Consumes: `getClientById(supabase, id): Promise<ClientRow | null>` (already exists, `src/lib/db/clients.ts:35-42`); `ClientRow['reply_mode']` from Task 1.
- Produces: nothing new for later tasks — this closes the loop so newly created campaigns aren't silently created on the DB default.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/campaigns/route.test.ts`, add `getClientByIdMock` to the mock setup and two new test cases. The full updated top-of-file mocks and a new describe block:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const insertCampaignMock = vi.fn()
const logEventMock = vi.fn()
const getClientByIdMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({ insertCampaign: (...a: unknown[]) => insertCampaignMock(...a) }))
vi.mock('@/lib/db/clients', () => ({ getClientById: (...a: unknown[]) => getClientByIdMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { POST } from './route'

function req(body: unknown) {
  return new Request('http://x', { method: 'POST', body: JSON.stringify(body) })
}

const validBody = {
  clientId: '11111111-1111-4111-8111-111111111111',
  name: 'Q3 campaign',
  valueProp: 'We save you time',
}

beforeEach(() => {
  requireUserMock.mockReset()
  insertCampaignMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
  getClientByIdMock.mockReset().mockResolvedValue({ id: validBody.clientId, reply_mode: 'human_approve' })
})
```

(The existing four `describe('POST /api/campaigns', ...)` tests keep passing unmodified since `getClientByIdMock` now defaults to a resolved client in `beforeEach`.) Add two new tests inside that same `describe` block:

```ts
  it('should use the client current reply_mode as the new campaign default', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue({ id: validBody.clientId, reply_mode: 'auto_send' })
    insertCampaignMock.mockResolvedValue({ id: 'camp1', name: 'Q3 campaign' })

    await POST(req(validBody))

    expect(insertCampaignMock).toHaveBeenCalledWith(
      {},
      expect.objectContaining({ reply_mode: 'auto_send' }),
    )
  })

  it('should return 404 when the client does not exist', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'operator' } })
    getClientByIdMock.mockResolvedValue(null)

    const res = await POST(req(validBody))

    expect(res.status).toBe(404)
    expect(insertCampaignMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify the two new ones fail**

Run: `pnpm exec vitest run src/app/api/campaigns/route.test.ts`
Expected: the two new tests FAIL (`getClientById` isn't called by `route.ts` yet, so `reply_mode` isn't in the insert payload and there's no 404 path); the four pre-existing tests still PASS.

- [ ] **Step 3: Write the implementation**

In `src/app/api/campaigns/route.ts`, add the import and insert the client lookup + 404 branch, then pass `reply_mode` through to `insertCampaign`:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createCampaignSchema = z.object({
  clientId: z.string().uuid(),
  name: z.string().min(1),
  valueProp: z.string().min(1),
  bookingLink: z.string().url().nullable().default(null),
  dailyTarget: z.number().int().min(1).max(100).default(50),
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nullable().default(null),
  employeeRangeMax: z.number().int().nullable().default(null),
  keywords: z.array(z.string()).default([]),
  excludeOrganizationLocations: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
})

export async function POST(request: Request) {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') {
    return NextResponse.json({ error: 'forbidden' }, { status: 403 })
  }

  try {
    const body = createCampaignSchema.parse(await request.json())
    const icp = apolloIcpSchema.parse({
      personTitles: body.personTitles,
      organizationLocations: body.organizationLocations,
      employeeRangeMin: body.employeeRangeMin,
      employeeRangeMax: body.employeeRangeMax,
      keywords: body.keywords,
      excludeOrganizationLocations: body.excludeOrganizationLocations,
      excludeKeywords: body.excludeKeywords,
    })
    const admin = createAdminClient()
    // The campaign inherits the client's current reply-mode preference rather
    // than the column default, so a client already on auto_send doesn't get a
    // new campaign silently created on human_approve.
    const client = await getClientById(admin, body.clientId)
    if (!client) {
      return NextResponse.json({ error: 'client_not_found' }, { status: 404 })
    }
    const campaign = await insertCampaign(admin, {
      client_id: body.clientId,
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      reply_mode: client.reply_mode,
      icp,
    })
    try {
      await logEvent({
        clientId: body.clientId,
        actor: `human:${appUser.id}`,
        type: 'campaign.created',
        payload: { campaignId: campaign.id, name: campaign.name },
      })
    } catch {
      // Audit logging is best-effort — the campaign was created successfully
      // and must not be reported as failed just because the log write failed.
    }
    return NextResponse.json({ ok: true, campaign })
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

Run: `pnpm exec vitest run src/app/api/campaigns/route.test.ts`
Expected: PASS (all six tests)

- [ ] **Step 5: Commit**

```bash
git add src/app/api/campaigns/route.ts src/app/api/campaigns/route.test.ts
git commit -m "feat: default new campaigns to the client's reply mode"
```

---

### Task 5: `updateReplyMode` Server Action

**Files:**
- Create: `src/app/(app)/settings/reply-mode-actions.ts`
- Test: `src/app/(app)/settings/reply-mode-actions.test.ts`

**Interfaces:**
- Consumes: `updateClientReplyMode` (Task 2), `syncReplyModeForClient` (Task 3), `requireUser()` (`@/lib/auth/require-user`), `createAdminClient()` (`@/lib/supabase/admin`), `logEvent()` (`@/lib/events/log-event`), `AppError` (`@/lib/errors/app-error`).
- Produces: `updateReplyMode(formData: FormData): Promise<void>` — used by Task 6's `ReplyModeSection` component.

- [ ] **Step 1: Write the failing test**

Create `src/app/(app)/settings/reply-mode-actions.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { updateReplyMode } from './reply-mode-actions'

const hoisted = vi.hoisted(() => ({
  requireUser: vi.fn(),
  updateClientReplyMode: vi.fn(),
  syncReplyModeForClient: vi.fn(),
  logEvent: vi.fn(),
}))

vi.mock('@/lib/auth/require-user', () => ({ requireUser: hoisted.requireUser }))
vi.mock('@/lib/db/clients', () => ({ updateClientReplyMode: hoisted.updateClientReplyMode }))
vi.mock('@/lib/db/campaigns', () => ({ syncReplyModeForClient: hoisted.syncReplyModeForClient }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/events/log-event', () => ({ logEvent: hoisted.logEvent }))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

function form(replyMode: string): FormData {
  const data = new FormData()
  data.append('replyMode', replyMode)
  return data
}

beforeEach(() => {
  vi.clearAllMocks()
  hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'client', client_id: 'c1' } })
  hoisted.updateClientReplyMode.mockResolvedValue({ id: 'c1', reply_mode: 'auto_send' })
  hoisted.syncReplyModeForClient.mockResolvedValue(undefined)
})

describe('updateReplyMode', () => {
  it('should update the client and sync every campaign for the caller own account', async () => {
    await updateReplyMode(form('auto_send'))

    expect(hoisted.updateClientReplyMode).toHaveBeenCalledWith({}, 'c1', 'auto_send')
    expect(hoisted.syncReplyModeForClient).toHaveBeenCalledWith({}, 'c1', 'auto_send')
    expect(hoisted.logEvent).toHaveBeenCalledWith(expect.objectContaining({
      clientId: 'c1',
      type: 'client.reply_mode_changed',
      payload: { replyMode: 'auto_send' },
    }))
  })

  it('should reject an operator, who does not own a reply-mode preference', async () => {
    hoisted.requireUser.mockResolvedValue({ appUser: { id: 'u1', role: 'operator', client_id: null } })

    await expect(updateReplyMode(form('auto_send'))).rejects.toThrow()
    expect(hoisted.updateClientReplyMode).not.toHaveBeenCalled()
  })

  it('should reject an invalid reply mode value', async () => {
    await expect(updateReplyMode(form('not_a_real_mode'))).rejects.toThrow()
    expect(hoisted.updateClientReplyMode).not.toHaveBeenCalled()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/app/\(app\)/settings/reply-mode-actions.test.ts`
Expected: FAIL — `./reply-mode-actions` does not exist.

- [ ] **Step 3: Write the implementation**

Create `src/app/(app)/settings/reply-mode-actions.ts`:

```ts
'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { updateClientReplyMode } from '@/lib/db/clients'
import { syncReplyModeForClient } from '@/lib/db/campaigns'
import { logEvent } from '@/lib/events/log-event'
import { AppError } from '@/lib/errors/app-error'

const SETTINGS_PATH = '/settings'

const replyModeSchema = z.enum(['auto_send', 'human_approve', 'hybrid'])

export async function updateReplyMode(formData: FormData): Promise<void> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    throw new AppError('FORBIDDEN', 'Only a client may change their reply mode', { role: appUser.role })
  }

  const parsed = replyModeSchema.safeParse(formData.get('replyMode'))
  if (!parsed.success) {
    throw new AppError('VALIDATION_ERROR', 'Invalid reply mode', { issues: parsed.error.flatten() })
  }

  const admin = createAdminClient()
  // Both writes target the same terminal value, not a delta — if the sync
  // half fails, retrying the action re-applies the same mode idempotently.
  await updateClientReplyMode(admin, appUser.client_id, parsed.data)
  await syncReplyModeForClient(admin, appUser.client_id, parsed.data)
  await logEvent({
    clientId: appUser.client_id,
    actor: `human:${appUser.id}`,
    type: 'client.reply_mode_changed',
    payload: { replyMode: parsed.data },
  })
  revalidatePath(SETTINGS_PATH)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/app/\(app\)/settings/reply-mode-actions.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/reply-mode-actions.ts" "src/app/(app)/settings/reply-mode-actions.test.ts"
git commit -m "feat: add updateReplyMode server action"
```

---

### Task 6: `ReplyModeSection` UI, wired into `/settings`

**Files:**
- Create: `src/app/(app)/settings/reply-mode-section.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `updateReplyMode` (Task 5); `getClientById` (`@/lib/db/clients`, existing); `ClientRow['reply_mode']` (Task 1); `Section` (`@/components/page-header`, existing).
- Produces: `ReplyModeSection({ currentMode }: { currentMode: Database['public']['Enums']['reply_mode'] })` — a client component, leaf of this feature (nothing downstream consumes it).

- [ ] **Step 1: Write the component**

Create `src/app/(app)/settings/reply-mode-section.tsx`:

```tsx
'use client'

import { useState, useTransition } from 'react'
import type { Database } from '@/types/database'
import { updateReplyMode } from './reply-mode-actions'

type ReplyMode = Database['public']['Enums']['reply_mode']

const REPLY_MODE_LABEL: Record<ReplyMode, string> = {
  auto_send: 'Automatic',
  human_approve: 'Manual',
  hybrid: 'Hybrid',
}

const REPLY_MODE_HELP: Record<ReplyMode, string> = {
  auto_send: 'The AI sends replies to leads immediately, with no review.',
  human_approve: 'Every reply is drafted for your team to review and send from the Inbox.',
  hybrid: 'The AI sends high-confidence replies automatically and drafts the rest for review.',
}

const REPLY_MODES = Object.keys(REPLY_MODE_LABEL) as ReplyMode[]

interface ReplyModeSectionProps {
  currentMode: ReplyMode
}

export function ReplyModeSection({ currentMode }: ReplyModeSectionProps): React.ReactElement {
  const [mode, setMode] = useState<ReplyMode>(currentMode)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onChange(next: ReplyMode): void {
    const previous = mode
    setError(null)
    setMode(next)
    const formData = new FormData()
    formData.set('replyMode', next)
    startTransition(async () => {
      try {
        await updateReplyMode(formData)
      } catch {
        setError('Could not save that change. Please try again.')
        setMode(previous)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">Reply mode</span>
        <select
          value={mode}
          disabled={isPending}
          onChange={(event) => onChange(event.target.value as ReplyMode)}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {REPLY_MODES.map((value) => (
            <option key={value} value={value}>
              {REPLY_MODE_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground text-[12px]">{REPLY_MODE_HELP[mode]}</p>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: Wire it into the settings page**

In `src/app/(app)/settings/page.tsx`, add the import and, for client-role viewers, fetch the client row and render the new section.

Add to the imports (after the `MailboxesWebMcpTools` import):

```ts
import { getClientById } from '@/lib/db/clients'
import { ReplyModeSection } from './reply-mode-section'
```

Change the body of `SettingsPage` from:

```tsx
export default async function SettingsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // RLS-scoped on purpose. The admin client would bypass `mailboxes_select` and
  // show a client-role user every other client's connected addresses.
  const supabase = await createServerClient()
  const connected = await listMailboxesForViewer(supabase)

  return (
```

to:

```tsx
export default async function SettingsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  // RLS-scoped on purpose. The admin client would bypass `mailboxes_select` and
  // show a client-role user every other client's connected addresses.
  const supabase = await createServerClient()
  const connected = await listMailboxesForViewer(supabase)
  // Reply mode is a client-owned preference — an operator viewing their own
  // /settings has no client_id and nothing to scope it to.
  const client = appUser.client_id ? await getClientById(supabase, appUser.client_id) : null

  return (
```

Then add a new `Section` right after the `PageHeader` block and before `Section title="Connect a mailbox"`:

```tsx
      {client ? (
        <Section title="Reply mode">
          <ReplyModeSection currentMode={client.reply_mode} />
        </Section>
      ) : null}

```

- [ ] **Step 3: Typecheck and run the full test suite**

Run: `pnpm typecheck && pnpm test`
Expected: no errors; all existing and new tests pass. (No new automated test is added for this component — matching the codebase's existing convention of leaving small settings selects like `mailbox-controls.tsx` and `pipeline-picker.tsx` untested at the component level, per `QUALITY.md`'s "React components: critical paths only." The Server Action underneath, which holds all the actual logic, is fully covered by Task 5.)

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/settings/reply-mode-section.tsx" "src/app/(app)/settings/page.tsx"
git commit -m "feat: add reply mode setting to the settings page"
```

- [ ] **Step 5: Manual verification**

1. Run `pnpm dev`, apply the migration to your local Supabase instance (`supabase db reset` or your project's usual migration-apply step).
2. Sign in as a client-role user, open `/settings`, confirm the "Reply mode" section renders with "Manual" selected (the column default).
3. Switch it to "Automatic", confirm the help text updates and no error appears.
4. In the DB, confirm `clients.reply_mode = 'auto_send'` for that client and every row in `campaigns` with that `client_id` also reads `reply_mode = 'auto_send'`, regardless of campaign status.
5. As an operator, create a new campaign for that same client (`POST /api/campaigns`) and confirm the new row is inserted with `reply_mode = 'auto_send'`, not the column default.
6. Sign in as an operator and open `/settings` — confirm no "Reply mode" section renders (operator has no `client_id`).

---

## Task Order

Tasks 1 → 2 → 3 → 4 → 5 → 6, strictly sequential: each later task's tests mock the previous task's exports, and Task 4 depends on the `reply_mode` column existing (Task 1) though not on Tasks 2/3/5/6.
