# Campaign settings: edit (operator) + read-only view (client) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let operators edit an existing campaign's name, value prop, booking link, daily target, and ICP filters after creation, and let clients see their own campaigns read-only instead of being redirected away from `/campaigns`.

**Architecture:** A shared Zod schema (`campaignSettingsSchema`) and a shared form-fields component (`CampaignSettingsFields`) are extracted from the existing create flow and reused by a new `PATCH /api/campaigns/[campaignId]` endpoint + `/campaigns/[campaignId]/edit` page. `/campaigns/page.tsx` branches on `appUser.role`: operators keep the current admin-client full view (now with an Edit action); clients get a new RLS-scoped read-only branch built from an extracted `CampaignCard` component.

**Tech Stack:** Next.js 15 (App Router, async route params), TypeScript strict, Zod, Supabase (Postgres + RLS), Vitest, next-intl.

## Global Constraints

- `strict: true` TypeScript — no `any`, no unexplained `!`.
- All external input (route bodies) validated with Zod.
- DB access only through `src/lib/db/*` helpers, never inline queries in routes/components; raw Supabase errors mapped to `AppError('DB_ERROR', ...)`.
- Every mutation route: validate → check auth (operator-only here) → call `lib/db` → best-effort `logEvent` → return.
- Named exports only (default exports reserved for Next.js pages/layouts).
- No `console.log`; no commented-out code; no `TODO`/`FIXME`.
- Every new/changed i18n string needs both `src/messages/en.json` and `src/messages/tr.json` entries — this repo has zero English-only or Turkish-only keys.
- This repo is **pnpm-only** (`npm install` corrupts the tree) — use `pnpm` for every command below.
- `dont branch use main` (per `CLAUDE.md`) — work directly on the current branch.
- Update `.claude/roadmap.md` when this feature is complete (final task).

---

### Task 1: Shared campaign-settings Zod schema

**Files:**
- Create: `src/lib/apollo/campaign-settings-schema.ts`
- Test: `src/lib/apollo/campaign-settings-schema.test.ts`
- Modify: `src/app/api/campaigns/route.ts`

**Interfaces:**
- Produces: `campaignSettingsSchema` (Zod object), `type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>` — exported from `src/lib/apollo/campaign-settings-schema.ts`. Fields: `name: string`, `valueProp: string`, `bookingLink: string | null`, `dailyTarget: number`, `personTitles: string[]`, `organizationLocations: string[]`, `employeeRangeMin: number | null`, `employeeRangeMax: number | null`, `keywords: string[]`, `excludeOrganizationLocations: string[]`, `excludeKeywords: string[]`, `personSeniorities: ApolloPersonSeniority[]`, `contactEmailStatuses: ApolloContactEmailStatus[]`.
- Consumes: `apolloPersonSeniorities`, `apolloContactEmailStatuses` from `./types` (same directory).

- [ ] **Step 1: Write the failing test**

Create `src/lib/apollo/campaign-settings-schema.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { campaignSettingsSchema } from './campaign-settings-schema'

describe('campaignSettingsSchema', () => {
  const valid = {
    name: 'Q3 launch',
    valueProp: 'We cut reconciliation time.',
  }

  it('should accept the minimum required fields and apply defaults', () => {
    const result = campaignSettingsSchema.parse(valid)
    expect(result.bookingLink).toBeNull()
    expect(result.dailyTarget).toBe(50)
    expect(result.personTitles).toEqual([])
    expect(result.contactEmailStatuses).toEqual([])
  })

  it('should reject a missing name', () => {
    const result = campaignSettingsSchema.safeParse({ valueProp: 'x' })
    expect(result.success).toBe(false)
  })

  it('should reject a missing valueProp', () => {
    const result = campaignSettingsSchema.safeParse({ name: 'x' })
    expect(result.success).toBe(false)
  })

  it('should reject a dailyTarget above 100', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, dailyTarget: 101 })
    expect(result.success).toBe(false)
  })

  it('should reject an invalid bookingLink URL', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, bookingLink: 'not-a-url' })
    expect(result.success).toBe(false)
  })

  it('should reject an unknown personSeniorities value', () => {
    const result = campaignSettingsSchema.safeParse({ ...valid, personSeniorities: ['ceo'] })
    expect(result.success).toBe(false)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/apollo/campaign-settings-schema.test.ts`
Expected: FAIL — `Cannot find module './campaign-settings-schema'`.

- [ ] **Step 3: Write the schema**

Create `src/lib/apollo/campaign-settings-schema.ts`:

```ts
import { z } from 'zod'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from './types'

// Shared between POST /api/campaigns (create) and PATCH /api/campaigns/[campaignId]
// (edit) — every field a campaign's settings form submits, except clientId
// (set once at creation, immutable afterward).
export const campaignSettingsSchema = z.object({
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
  personSeniorities: z.array(z.enum(apolloPersonSeniorities)).default([]),
  contactEmailStatuses: z.array(z.enum(apolloContactEmailStatuses)).default([]),
})

export type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/apollo/campaign-settings-schema.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Wire the shared schema into the existing create route**

In `src/app/api/campaigns/route.ts`, replace the top of the file (imports through `createCampaignSchema`) so it reads:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { insertCampaign } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { campaignSettingsSchema } from '@/lib/apollo/campaign-settings-schema'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const createCampaignSchema = campaignSettingsSchema.extend({
  clientId: z.string().uuid(),
})
```

(This drops the old inline `personTitles`/`organizationLocations`/… field declarations and the now-unused `apolloPersonSeniorities`/`apolloContactEmailStatuses` imports — everything else in the file, the `POST` function body, is unchanged.)

- [ ] **Step 6: Run the full campaigns route test suite to confirm no regression**

Run: `pnpm vitest run src/app/api/campaigns/route.test.ts`
Expected: PASS — identical behavior, just re-sourced validation.

- [ ] **Step 7: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 8: Commit**

```bash
git add src/lib/apollo/campaign-settings-schema.ts src/lib/apollo/campaign-settings-schema.test.ts src/app/api/campaigns/route.ts
git commit -m "refactor(campaigns): extract shared campaignSettingsSchema"
```

---

### Task 2: `updateCampaignSettings` DB helper

**Files:**
- Modify: `src/lib/db/campaigns.ts`
- Test: `src/lib/db/campaigns.test.ts`

**Interfaces:**
- Consumes: nothing new (uses existing `SupabaseClient<Database>`, `AppError`, `Json` from `@/types/database`).
- Produces: `interface CampaignSettingsPatch { name: string; value_prop: string; booking_link: string | null; daily_target: number; icp: Json }` and `updateCampaignSettings(supabase, id: string, patch: CampaignSettingsPatch): Promise<CampaignRow>` — both exported from `src/lib/db/campaigns.ts`, consumed by Task 3's `PATCH` route.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/db/campaigns.test.ts` (new `describe` block, alongside the existing `updateCampaignStatus` block):

```ts
describe('updateCampaignSettings', () => {
  function mockSupabase(result: { data: unknown; error: unknown }) {
    return {
      from: () => ({ update: () => ({ eq: () => ({ select: () => ({ single: () => Promise.resolve(result) }) }) }) }),
    } as never
  }

  const patch = {
    name: 'Updated',
    value_prop: 'New prop',
    booking_link: null,
    daily_target: 25,
    icp: {},
  }

  it('should return the updated campaign row', async () => {
    const row = { id: 'camp1', name: 'Updated' }
    const result = await updateCampaignSettings(mockSupabase({ data: row, error: null }), 'camp1', patch)
    expect(result).toEqual(row)
  })

  it('should throw DB_ERROR on update failure', async () => {
    await expect(
      updateCampaignSettings(mockSupabase({ data: null, error: { message: 'boom' } }), 'camp1', patch),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

Also add `updateCampaignSettings` to the existing `import { ... } from './campaigns'` block at the top of the test file.

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: FAIL — `updateCampaignSettings` is not exported.

- [ ] **Step 3: Implement the helper**

In `src/lib/db/campaigns.ts`, add this import at the top (alongside the existing `AppError` import):

```ts
import type { Json } from '@/types/database'
```

Then add, directly after `updateCampaignStatus`:

```ts
export interface CampaignSettingsPatch {
  name: string
  value_prop: string
  booking_link: string | null
  daily_target: number
  icp: Json
}

// Full-replace update of a campaign's editable settings (name, value prop,
// booking link, daily target, ICP). client_id and status are not part of
// this patch — status has its own updateCampaignStatus, client_id is
// immutable once a campaign exists.
export async function updateCampaignSettings(
  supabase: SupabaseClient<Database>,
  id: string,
  patch: CampaignSettingsPatch,
): Promise<CampaignRow> {
  const { data, error } = await supabase.from('campaigns').update(patch).eq('id', id).select('*').single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update campaign settings', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm vitest run src/lib/db/campaigns.test.ts`
Expected: PASS (all `campaigns.test.ts` tests, including the 2 new ones).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/db/campaigns.ts src/lib/db/campaigns.test.ts
git commit -m "feat(campaigns): add updateCampaignSettings DB helper"
```

---

### Task 3: `PATCH /api/campaigns/[campaignId]` endpoint

**Files:**
- Modify: `src/app/api/campaigns/[campaignId]/route.ts`
- Test: `src/app/api/campaigns/[campaignId]/route.test.ts`

**Interfaces:**
- Consumes: `campaignSettingsSchema` (Task 1), `updateCampaignSettings` (Task 2), existing `getCampaignById`, `apolloIcpSchema`, `logEvent`, `isAppError`, `requireUser`, `createAdminClient` — all already imported/available in this file or importable from the same paths used by the sibling `POST` route.
- Produces: `PATCH` handler, same signature shape as the existing `DELETE`: `(request: Request, context: { params: Promise<{ campaignId: string }> }) => Promise<Response>`. Success response: `{ ok: true, campaign: CampaignRow }`.

- [ ] **Step 1: Write the failing tests**

Modify `src/app/api/campaigns/[campaignId]/route.test.ts` — update the mock setup and add a `PATCH` describe block. Full new file content:

```ts
import { describe, it, expect, vi, beforeEach } from 'vitest'

const requireUserMock = vi.fn()
const getCampaignByIdMock = vi.fn()
const deleteCampaignMock = vi.fn()
const updateCampaignSettingsMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/campaigns', () => ({
  getCampaignById: (...a: unknown[]) => getCampaignByIdMock(...a),
  deleteCampaign: (...a: unknown[]) => deleteCampaignMock(...a),
  updateCampaignSettings: (...a: unknown[]) => updateCampaignSettingsMock(...a),
}))
vi.mock('@/lib/events/log-event', () => ({ logEvent: (...a: unknown[]) => logEventMock(...a) }))

import { DELETE, PATCH } from './route'

function deleteReq(body: unknown) {
  return new Request('http://x', { method: 'DELETE', body: JSON.stringify(body) })
}
function patchReq(body: unknown) {
  return new Request('http://x', { method: 'PATCH', body: JSON.stringify(body) })
}
function ctx(campaignId: string) {
  return { params: Promise.resolve({ campaignId }) }
}
function validPatchBody(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Updated name',
    valueProp: 'Updated value prop',
    bookingLink: null,
    dailyTarget: 25,
    personTitles: [],
    organizationLocations: [],
    employeeRangeMin: null,
    employeeRangeMax: null,
    keywords: [],
    excludeOrganizationLocations: [],
    excludeKeywords: [],
    personSeniorities: [],
    contactEmailStatuses: [],
    ...overrides,
  }
}

beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getCampaignByIdMock.mockReset()
  deleteCampaignMock.mockReset()
  updateCampaignSettingsMock.mockReset()
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

describe('PATCH /api/campaigns/[campaignId]', () => {
  it('should return 403 when the caller is not an operator', async () => {
    requireUserMock.mockResolvedValue({ appUser: { id: 'u1', role: 'client' } })
    const res = await PATCH(patchReq(validPatchBody()), ctx('camp1'))
    expect(res.status).toBe(403)
  })

  it('should return 404 when the campaign does not exist', async () => {
    getCampaignByIdMock.mockResolvedValue(null)
    const res = await PATCH(patchReq(validPatchBody()), ctx('missing'))
    expect(res.status).toBe(404)
  })

  it('should return 400 when the body fails validation', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    const res = await PATCH(patchReq(validPatchBody({ name: '' })), ctx('camp1'))
    expect(res.status).toBe(400)
    expect(updateCampaignSettingsMock).not.toHaveBeenCalled()
  })

  it('should update the campaign and log the event on success', async () => {
    getCampaignByIdMock.mockResolvedValue({ id: 'camp1', client_id: 'c1', name: 'Acme launch' })
    const updated = { id: 'camp1', client_id: 'c1', name: 'Updated name' }
    updateCampaignSettingsMock.mockResolvedValue(updated)
    const res = await PATCH(patchReq(validPatchBody()), ctx('camp1'))
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json).toEqual({ ok: true, campaign: updated })
    expect(updateCampaignSettingsMock).toHaveBeenCalledWith(
      expect.anything(),
      'camp1',
      expect.objectContaining({ name: 'Updated name', daily_target: 25 }),
    )
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'campaign.updated' }))
  })
})
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/route.test.ts`
Expected: `DELETE` tests still PASS, `PATCH` tests FAIL — `PATCH is not exported`.

- [ ] **Step 3: Implement the PATCH handler**

In `src/app/api/campaigns/[campaignId]/route.ts`, update the imports at the top to:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById, deleteCampaign, updateCampaignSettings } from '@/lib/db/campaigns'
import { campaignSettingsSchema } from '@/lib/apollo/campaign-settings-schema'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'
```

Leave the existing `deleteSchema` const and `DELETE` function exactly as they are. Then append this new handler at the end of the file:

```ts
// Updates a campaign's editable settings (name, value prop, booking link,
// daily target, ICP filters). client_id and status are not editable here —
// status has its own stop/resume/delete actions, client_id is immutable.
export async function PATCH(request: Request, context: { params: Promise<{ campaignId: string }> }) {
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
    const body = campaignSettingsSchema.parse(await request.json())
    const icp = apolloIcpSchema.parse({
      personTitles: body.personTitles,
      organizationLocations: body.organizationLocations,
      employeeRangeMin: body.employeeRangeMin,
      employeeRangeMax: body.employeeRangeMax,
      keywords: body.keywords,
      excludeOrganizationLocations: body.excludeOrganizationLocations,
      excludeKeywords: body.excludeKeywords,
      personSeniorities: body.personSeniorities,
      contactEmailStatuses: body.contactEmailStatuses,
    })

    const updated = await updateCampaignSettings(admin, campaignId, {
      name: body.name,
      value_prop: body.valueProp,
      booking_link: body.bookingLink,
      daily_target: body.dailyTarget,
      icp,
    })

    try {
      await logEvent({
        clientId: campaign.client_id,
        actor: `human:${appUser.id}`,
        type: 'campaign.updated',
        payload: { campaignId, name: updated.name },
      })
    } catch {
      // Audit logging is best-effort — the update already succeeded.
    }
    return NextResponse.json({ ok: true, campaign: updated })
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

Run: `pnpm vitest run src/app/api/campaigns/[campaignId]/route.test.ts`
Expected: PASS — all 8 tests (4 `DELETE` + 4 `PATCH`).

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/campaigns/\[campaignId\]/route.ts src/app/api/campaigns/\[campaignId\]/route.test.ts
git commit -m "feat(campaigns): add PATCH /api/campaigns/[campaignId] to edit settings"
```

---

### Task 4: Extract shared `CampaignSettingsFields` + form utils, refactor `NewCampaignForm`

**Files:**
- Create: `src/app/(app)/campaigns/campaign-form-utils.ts`
- Create: `src/app/(app)/campaigns/campaign-settings-fields.tsx`
- Modify: `src/app/(app)/campaigns/new-campaign-form.tsx`

**Interfaces:**
- Produces: `splitCsv(value: FormDataEntryValue | null): string[]` and `getAllStrings(formData: FormData, name: string): string[]` from `campaign-form-utils.ts`. `Field` (component, props `{ id: string; label: string; hint?: string; children: React.ReactNode }`) and `CampaignSettingsFields` (component, props `{ defaultValues: CampaignSettingsDefaults }`) from `campaign-settings-fields.tsx`, where:
  ```ts
  interface CampaignSettingsDefaults {
    valueProp: string
    bookingLink: string
    dailyTarget: number
    personTitles: string
    organizationLocations: string
    excludeOrganizationLocations: string
    employeeMin: number | ''
    employeeMax: number | ''
    keywords: string
    excludeKeywords: string
    personSeniorities: readonly string[]
    contactEmailStatuses: readonly string[]
  }
  ```
- Consumes (Task 5): both `Field` and `CampaignSettingsFields` are imported by the new `EditCampaignForm`.

This task is a pure refactor (no behavior change) with no dedicated test file — this codebase has no component tests for `new-campaign-form.tsx` either (per `QUALITY.md`, React component coverage is "critical paths only"). Verification is `pnpm typecheck` + `pnpm lint` + the full test suite still green (nothing here touches tested code paths).

- [ ] **Step 1: Create the shared form-parsing utils**

Create `src/app/(app)/campaigns/campaign-form-utils.ts`:

```ts
// Shared FormData parsing between NewCampaignForm and EditCampaignForm —
// both submit the same comma-separated-text and multi-checkbox field shapes.

export function splitCsv(value: FormDataEntryValue | null): string[] {
  return String(value ?? '')
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean)
}

export function getAllStrings(formData: FormData, name: string): string[] {
  return formData.getAll(name).map(String)
}
```

- [ ] **Step 2: Create the shared settings-fields component**

Create `src/app/(app)/campaigns/campaign-settings-fields.tsx`:

```tsx
'use client'

import { useTranslations } from 'next-intl'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Checkbox } from '@/components/ui/checkbox'
import { apolloPersonSeniorities, apolloContactEmailStatuses } from '@/lib/apollo/types'

const SENIORITY_KEY: Record<(typeof apolloPersonSeniorities)[number], string> = {
  owner: 'seniority.owner',
  founder: 'seniority.founder',
  c_suite: 'seniority.c_suite',
  partner: 'seniority.partner',
  vp: 'seniority.vp',
  head: 'seniority.head',
  director: 'seniority.director',
  manager: 'seniority.manager',
  senior: 'seniority.senior',
  entry: 'seniority.entry',
  intern: 'seniority.intern',
}

const CONTACT_EMAIL_STATUS_KEY: Record<(typeof apolloContactEmailStatuses)[number], string> = {
  verified: 'contactEmailStatus.verified',
  unverified: 'contactEmailStatus.unverified',
  'likely to engage': 'contactEmailStatus.likelyToEngage',
  unavailable: 'contactEmailStatus.unavailable',
}

interface FieldProps {
  id: string
  label: string
  hint?: string
  children: React.ReactNode
}

export function Field({ id, label, hint, children }: FieldProps): React.ReactElement {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={id} className="text-xs">
        {label}
      </Label>
      {children}
      {hint ? <p className="text-faint text-[11px]">{hint}</p> : null}
    </div>
  )
}

export interface CampaignSettingsDefaults {
  valueProp: string
  bookingLink: string
  dailyTarget: number
  personTitles: string
  organizationLocations: string
  excludeOrganizationLocations: string
  employeeMin: number | ''
  employeeMax: number | ''
  keywords: string
  excludeKeywords: string
  personSeniorities: readonly string[]
  contactEmailStatuses: readonly string[]
}

interface CampaignSettingsFieldsProps {
  defaultValues: CampaignSettingsDefaults
}

// Shared between NewCampaignForm and EditCampaignForm: value prop, booking
// link, daily target, and the full ICP fieldset are identical in both create
// and edit — only the surrounding <form> (client selector vs. fixed client,
// submit target, submit label) differs between the two callers.
export function CampaignSettingsFields({ defaultValues }: CampaignSettingsFieldsProps): React.ReactElement {
  const t = useTranslations('campaigns')

  return (
    <>
      <Field
        id="valueProp"
        label={t('newCampaignForm.valuePropLabel')}
        hint={t('newCampaignForm.valuePropHint')}
      >
        <Textarea
          id="valueProp"
          name="valueProp"
          required
          rows={3}
          defaultValue={defaultValues.valueProp}
          placeholder="We cut invoice reconciliation time for finance teams running NetSuite."
          className="resize-y"
          toolparamdescription={t('newCampaignForm.valuePropToolParamDescription')}
        />
      </Field>

      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="bookingLink" label={t('newCampaignForm.bookingLinkLabel')} hint={t('newCampaignForm.bookingLinkHint')}>
          <Input
            id="bookingLink"
            name="bookingLink"
            type="url"
            defaultValue={defaultValues.bookingLink}
            placeholder="https://cal.com/you/30min"
            toolparamdescription={t('newCampaignForm.bookingLinkToolParamDescription')}
          />
        </Field>

        <Field id="dailyTarget" label={t('newCampaignForm.dailyTargetLabel')} hint={t('newCampaignForm.dailyTargetHint')}>
          <Input
            id="dailyTarget"
            name="dailyTarget"
            type="number"
            defaultValue={defaultValues.dailyTarget}
            min={1}
            max={100}
            className="tnum"
            toolparamdescription={t('newCampaignForm.dailyTargetToolParamDescription')}
          />
        </Field>
      </div>

      <fieldset className="border-hairline flex flex-col gap-5 border-t pt-5">
        <legend className="sr-only">{t('newCampaignForm.icpLegend')}</legend>
        <p className="text-xs font-medium">{t('newCampaignForm.icpLegend')}</p>

        <Field id="personTitles" label={t('newCampaignForm.personTitlesLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="personTitles"
            name="personTitles"
            defaultValue={defaultValues.personTitles}
            placeholder="vp sales, head of revenue, founder"
            toolparamdescription={t('newCampaignForm.personTitlesToolParamDescription')}
          />
        </Field>

        <Field id="organizationLocations" label={t('newCampaignForm.organizationLocationsLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="organizationLocations"
            name="organizationLocations"
            defaultValue={defaultValues.organizationLocations}
            placeholder="united states, united kingdom"
            toolparamdescription={t('newCampaignForm.organizationLocationsToolParamDescription')}
          />
        </Field>

        <Field
          id="excludeOrganizationLocations"
          label={t('newCampaignForm.excludeOrganizationLocationsLabel')}
          hint={t('newCampaignForm.excludeOrganizationLocationsHint')}
        >
          <Input
            id="excludeOrganizationLocations"
            name="excludeOrganizationLocations"
            defaultValue={defaultValues.excludeOrganizationLocations}
            placeholder="ireland, india"
            toolparamdescription={t('newCampaignForm.excludeOrganizationLocationsToolParamDescription')}
          />
        </Field>

        <div className="grid gap-5 sm:grid-cols-2">
          <Field id="employeeMin" label={t('newCampaignForm.employeeMinLabel')}>
            <Input
              id="employeeMin"
              name="employeeMin"
              type="number"
              min={1}
              defaultValue={defaultValues.employeeMin}
              placeholder="50"
              className="tnum"
              toolparamdescription={t('newCampaignForm.employeeMinToolParamDescription')}
            />
          </Field>
          <Field id="employeeMax" label={t('newCampaignForm.employeeMaxLabel')}>
            <Input
              id="employeeMax"
              name="employeeMax"
              type="number"
              min={1}
              defaultValue={defaultValues.employeeMax}
              placeholder="500"
              className="tnum"
              toolparamdescription={t('newCampaignForm.employeeMaxToolParamDescription')}
            />
          </Field>
        </div>

        <Field id="keywords" label={t('newCampaignForm.keywordsLabel')} hint={t('newCampaignForm.commaSeparatedHint')}>
          <Input
            id="keywords"
            name="keywords"
            defaultValue={defaultValues.keywords}
            placeholder="saas, logistics, fintech"
            toolparamdescription={t('newCampaignForm.keywordsToolParamDescription')}
          />
        </Field>

        <Field
          id="excludeKeywords"
          label={t('newCampaignForm.excludeKeywordsLabel')}
          hint={t('newCampaignForm.excludeKeywordsHint')}
        >
          <Input
            id="excludeKeywords"
            name="excludeKeywords"
            defaultValue={defaultValues.excludeKeywords}
            placeholder="staffing, agency, recruiting"
            toolparamdescription={t('newCampaignForm.excludeKeywordsToolParamDescription')}
          />
        </Field>

        <Field id="personSeniorities" label={t('newCampaignForm.personSenioritiesLabel')} hint={t('newCampaignForm.personSenioritiesHint')}>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {apolloPersonSeniorities.map((value) => (
              <label key={value} htmlFor={`personSeniorities-${value}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`personSeniorities-${value}`}
                  name="personSeniorities"
                  value={value}
                  defaultChecked={defaultValues.personSeniorities.includes(value)}
                  toolparamdescription={t('newCampaignForm.personSenioritiesToolParamDescription')}
                />
                {t(SENIORITY_KEY[value] as 'seniority.owner')}
              </label>
            ))}
          </div>
        </Field>

        <Field
          id="contactEmailStatuses"
          label={t('newCampaignForm.contactEmailStatusesLabel')}
          hint={t('newCampaignForm.contactEmailStatusesHint')}
        >
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {apolloContactEmailStatuses.map((value) => (
              <label key={value} htmlFor={`contactEmailStatuses-${value}`} className="flex items-center gap-2 text-xs">
                <Checkbox
                  id={`contactEmailStatuses-${value}`}
                  name="contactEmailStatuses"
                  value={value}
                  defaultChecked={defaultValues.contactEmailStatuses.includes(value)}
                  toolparamdescription={t('newCampaignForm.contactEmailStatusesToolParamDescription')}
                />
                {t(CONTACT_EMAIL_STATUS_KEY[value] as 'contactEmailStatus.verified')}
              </label>
            ))}
          </div>
        </Field>
      </fieldset>
    </>
  )
}
```

- [ ] **Step 3: Refactor `NewCampaignForm` to use the extracted pieces**

Replace the full contents of `src/app/(app)/campaigns/new-campaign-form.tsx` with:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { CampaignSettingsFields, Field } from './campaign-settings-fields'
import { splitCsv, getAllStrings } from './campaign-form-utils'

interface ClientOption {
  id: string
  name: string
}

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

type NewCampaignFormProps = { clients: ClientOption[] } | { fixedClientId: string; fixedClientName: string }

export function NewCampaignForm(props: NewCampaignFormProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })
  const isFixed = 'fixedClientId' in props
  // Radix Select renders a hidden input only when controlled, so the selected
  // client is held in React state rather than read off the form. When the
  // client is fixed by the route, this never changes.
  const [clientId, setClientId] = useState(isFixed ? props.fixedClientId : '')

  async function onSubmit(formData: FormData): Promise<void> {
    if (!clientId) {
      setState({ status: 'error', message: t('newCampaignForm.chooseClientFirst') })
      return
    }
    setState({ status: 'submitting' })

    const employeeMinRaw = formData.get('employeeMin')
    const employeeMaxRaw = formData.get('employeeMax')
    const bookingLinkRaw = formData.get('bookingLink')
    const body = {
      clientId,
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
    }

    try {
      const res = await fetch('/api/campaigns', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('newCampaignForm.rejected')
        setState({ status: 'error', message })
        toast.error(t('newCampaignForm.createFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success(t('newCampaignForm.createdToast'))
      // Server Components hold the campaign list, so refresh rather than reload.
      router.refresh()
    } catch {
      const message = t('newCampaignForm.networkError')
      setState({ status: 'error', message })
      toast.error(t('newCampaignForm.createFailedToast'), { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form
      action={onSubmit}
      // Declarative WebMCP: an agent may fill this in, but the operator presses
      // the button. No `toolautosubmit` — see `@/types/webmcp`.
      toolname="createCampaign"
      tooldescription={t('newCampaignForm.toolDescription')}
      className="border-hairline bg-surface flex flex-col gap-5 rounded-lg border p-5"
    >
      <div className="grid gap-5 sm:grid-cols-2">
        {isFixed ? null : (
          <Field id="clientId" label={t('newCampaignForm.clientLabel')}>
            {/* `name` makes Radix's hidden native select a named required field,
                which is what an agent (and Lighthouse) looks for. The submit
                handler still reads `clientId` from state. */}
            <Select value={clientId} onValueChange={setClientId} name="clientId" required>
              <SelectTrigger id="clientId" className="w-full">
                <SelectValue placeholder={t('newCampaignForm.clientPlaceholder')} />
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

        <Field id="name" label={t('newCampaignForm.nameLabel')}>
          <Input
            id="name"
            name="name"
            required
            placeholder="Q3 mid-market ops"
            toolparamdescription={t('newCampaignForm.nameToolParamDescription')}
          />
        </Field>
      </div>

      <CampaignSettingsFields
        defaultValues={{
          valueProp: '',
          bookingLink: '',
          dailyTarget: 50,
          personTitles: '',
          organizationLocations: '',
          excludeOrganizationLocations: '',
          employeeMin: '',
          employeeMax: '',
          keywords: '',
          excludeKeywords: '',
          personSeniorities: [],
          contactEmailStatuses: ['verified'],
        }}
      />

      <div className="border-hairline flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <Plus size={14} weight="bold" />
          {isSubmitting ? t('newCampaignForm.creating') : t('newCampaignForm.createButton')}
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

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `pnpm test`
Expected: same pass count as before this task (this is a pure refactor of untested UI files; every other test file is unaffected).

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/campaigns/campaign-form-utils.ts src/app/\(app\)/campaigns/campaign-settings-fields.tsx src/app/\(app\)/campaigns/new-campaign-form.tsx
git commit -m "refactor(campaigns): extract CampaignSettingsFields shared component"
```

---

### Task 5: Edit page + `EditCampaignForm`

**Files:**
- Create: `src/app/(app)/campaigns/[campaignId]/edit/edit-campaign-form.tsx`
- Create: `src/app/(app)/campaigns/[campaignId]/edit/page.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/tr.json`

**Interfaces:**
- Consumes: `CampaignSettingsFields`, `Field` (Task 4), `splitCsv`, `getAllStrings` (Task 4), `PATCH /api/campaigns/[campaignId]` (Task 3), `apolloIcpSchema` + `type ApolloIcpFilters` from `@/lib/apollo/types`, `getCampaignById` + `type CampaignRow` from `@/lib/db/campaigns`, `getClientById` from `@/lib/db/clients`, `requireUser` from `@/lib/auth/require-user`, `createAdminClient` from `@/lib/supabase/admin`.
- Produces: route `/campaigns/[campaignId]/edit` (operator-only; redirects other roles to `/crm`, 404s on an unknown campaign id). No new exports consumed by later tasks.

No dedicated test — same rationale as Task 4 (no component/page tests exist elsewhere in `/campaigns`; `loading.tsx`/`error.tsx` from the parent `/campaigns` segment apply automatically to this nested route, so none are added here).

- [ ] **Step 1: Add the i18n keys this task needs**

In `src/messages/en.json`, inside the `"campaigns"` object, change the `"rowActions"` line's preceding sibling — insert a new `"editCampaignForm"` object right after the closing `},` of `"newCampaignForm"` (i.e. immediately before `"seniority": {`):

```json
    "editCampaignForm": {
      "pageTitle": "Edit campaign",
      "pageDescription": "Changes apply to the next discovery run — leads already found are untouched.",
      "saving": "Saving…",
      "saveButton": "Save changes",
      "savedToast": "Campaign updated",
      "saveFailedToast": "Could not save changes",
      "rejected": "The server rejected the update.",
      "networkError": "Network request failed. Check your connection and retry.",
      "unknownClient": "Unknown client"
    },
```

In `src/messages/tr.json`, insert the matching block at the same position:

```json
    "editCampaignForm": {
      "pageTitle": "Kampanyayı düzenle",
      "pageDescription": "Değişiklikler bir sonraki keşif çalışmasına uygulanır — zaten bulunan potansiyel müşteriler etkilenmez.",
      "saving": "Kaydediliyor…",
      "saveButton": "Değişiklikleri kaydet",
      "savedToast": "Kampanya güncellendi",
      "saveFailedToast": "Değişiklikler kaydedilemedi",
      "rejected": "Sunucu güncellemeyi reddetti.",
      "networkError": "Ağ isteği başarısız oldu. Bağlantınızı kontrol edip tekrar deneyin.",
      "unknownClient": "Bilinmeyen müşteri"
    },
```

- [ ] **Step 2: Create `EditCampaignForm`**

Create `src/app/(app)/campaigns/[campaignId]/edit/edit-campaign-form.tsx`:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { FloppyDisk } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { ApolloIcpFilters } from '@/lib/apollo/types'
import { CampaignSettingsFields, Field } from '../../campaign-settings-fields'
import { splitCsv, getAllStrings } from '../../campaign-form-utils'

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface EditCampaignFormProps {
  campaignId: string
  clientName: string
  name: string
  valueProp: string
  bookingLink: string | null
  dailyTarget: number
  icp: ApolloIcpFilters
}

export function EditCampaignForm({
  campaignId,
  clientName,
  name,
  valueProp,
  bookingLink,
  dailyTarget,
  icp,
}: EditCampaignFormProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onSubmit(formData: FormData): Promise<void> {
    setState({ status: 'submitting' })

    const employeeMinRaw = formData.get('employeeMin')
    const employeeMaxRaw = formData.get('employeeMax')
    const bookingLinkRaw = formData.get('bookingLink')
    const body = {
      name: String(formData.get('name') ?? ''),
      valueProp: String(formData.get('valueProp') ?? ''),
      bookingLink: bookingLinkRaw ? String(bookingLinkRaw) : null,
      dailyTarget: Number(formData.get('dailyTarget') ?? 50),
      personTitles: splitCsv(formData.get('personTitles')),
      organizationLocations: splitCsv(formData.get('organizationLocations')),
      employeeRangeMin: employeeMinRaw ? Number(employeeMinRaw) : null,
      employeeRangeMax: employeeMaxRaw ? Number(employeeMaxRaw) : null,
      keywords: splitCsv(formData.get('keywords')),
      excludeOrganizationLocations: splitCsv(formData.get('excludeOrganizationLocations')),
      excludeKeywords: splitCsv(formData.get('excludeKeywords')),
      personSeniorities: getAllStrings(formData, 'personSeniorities'),
      contactEmailStatuses: getAllStrings(formData, 'contactEmailStatuses'),
    }

    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('editCampaignForm.rejected')
        setState({ status: 'error', message })
        toast.error(t('editCampaignForm.saveFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success(t('editCampaignForm.savedToast'))
      router.push('/campaigns')
      router.refresh()
    } catch {
      const message = t('editCampaignForm.networkError')
      setState({ status: 'error', message })
      toast.error(t('editCampaignForm.saveFailedToast'), { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form action={onSubmit} className="border-hairline bg-surface flex flex-col gap-5 rounded-lg border p-5">
      <div className="grid gap-5 sm:grid-cols-2">
        <Field id="clientNameReadonly" label={t('newCampaignForm.clientLabel')}>
          <Input id="clientNameReadonly" value={clientName} disabled readOnly />
        </Field>

        <Field id="name" label={t('newCampaignForm.nameLabel')}>
          <Input id="name" name="name" required defaultValue={name} placeholder="Q3 mid-market ops" />
        </Field>
      </div>

      <CampaignSettingsFields
        defaultValues={{
          valueProp,
          bookingLink: bookingLink ?? '',
          dailyTarget,
          personTitles: icp.personTitles.join(', '),
          organizationLocations: icp.organizationLocations.join(', '),
          excludeOrganizationLocations: icp.excludeOrganizationLocations.join(', '),
          employeeMin: icp.employeeRangeMin ?? '',
          employeeMax: icp.employeeRangeMax ?? '',
          keywords: icp.keywords.join(', '),
          excludeKeywords: icp.excludeKeywords.join(', '),
          personSeniorities: icp.personSeniorities,
          contactEmailStatuses: icp.contactEmailStatuses,
        }}
      />

      <div className="border-hairline flex flex-wrap items-center gap-3 border-t pt-5">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <FloppyDisk size={14} weight="bold" />
          {isSubmitting ? t('editCampaignForm.saving') : t('editCampaignForm.saveButton')}
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

- [ ] **Step 3: Create the edit page**

Create `src/app/(app)/campaigns/[campaignId]/edit/page.tsx`:

```tsx
import type { Metadata } from 'next'
import { notFound, redirect } from 'next/navigation'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { getCampaignById } from '@/lib/db/campaigns'
import { getClientById } from '@/lib/db/clients'
import { apolloIcpSchema } from '@/lib/apollo/types'
import { PageHeader } from '@/components/page-header'
import { EditCampaignForm } from './edit-campaign-form'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Edit campaign' }

export default async function EditCampaignPage({
  params,
}: {
  params: Promise<{ campaignId: string }>
}): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'operator') redirect('/crm')
  const t = await getTranslations('campaigns')

  const { campaignId } = await params
  const admin = createAdminClient()
  const campaign = await getCampaignById(admin, campaignId)
  if (!campaign) notFound()

  const client = await getClientById(admin, campaign.client_id)
  // Every row's icp column was written by this same schema (POST /api/campaigns
  // and this route's own PATCH both validate through it before insert/update),
  // so re-parsing it back to typed fields should never fail in practice.
  const icp = apolloIcpSchema.parse(campaign.icp)

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <PageHeader title={t('editCampaignForm.pageTitle')} description={t('editCampaignForm.pageDescription')} />
      <EditCampaignForm
        campaignId={campaign.id}
        clientName={client?.name ?? t('editCampaignForm.unknownClient')}
        name={campaign.name}
        valueProp={campaign.value_prop ?? ''}
        bookingLink={campaign.booking_link}
        dailyTarget={campaign.daily_target}
        icp={icp}
      />
    </div>
  )
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `pnpm test`
Expected: same pass count as after Task 4.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/campaigns/\[campaignId\]/edit src/messages/en.json src/messages/tr.json
git commit -m "feat(campaigns): add /campaigns/[campaignId]/edit page"
```

---

### Task 6: "Edit" action on `CampaignRowActions`

**Files:**
- Modify: `src/app/(app)/campaigns/campaign-row-actions.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/tr.json`

**Interfaces:**
- Consumes: `next/link`'s default `Link`, `PencilSimple` from `@phosphor-icons/react`. No new exports.

- [ ] **Step 1: Add the `editTrigger` i18n key**

In `src/messages/en.json`, inside `"campaigns" → "rowActions"`, add `"editTrigger"` as the first key (right after the opening `"rowActions": {`, before `"requestFailed"`):

```json
      "editTrigger": "Edit",
```

In `src/messages/tr.json`, same position:

```json
      "editTrigger": "Düzenle",
```

- [ ] **Step 2: Add the Edit link to `CampaignRowActions`**

In `src/app/(app)/campaigns/campaign-row-actions.tsx`, replace the existing
`import { Pause, Play } from '@phosphor-icons/react'` line with:

```ts
import Link from 'next/link'
import { Pause, Play, PencilSimple } from '@phosphor-icons/react'
```

(This adds the new `Link` import and adds `PencilSimple` to the existing icon import — every other import in the file, including `Button`, stays as-is.)

Then update the component's doc comment and return block. Replace:

```tsx
// Archived campaigns show only Delete: there is no per-campaign archive
// action in this product yet (only the client-level archive path exists),
// so an already-archived campaign is already considered halted — a
// redundant Stop button there would be confusing.
export function CampaignRowActions({ campaignId, campaignName, status }: CampaignRowActionsProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [resumeState, setResumeState] = useState<SubmitState>({ status: 'idle' })

  async function runResume(): Promise<void> {
    setResumeState({ status: 'submitting' })
    const result = await postAction(campaignId, 'resume', t)
    if (!result.ok) {
      toast.error(t('rowActions.resumeFailedToast'), { description: result.message })
      setResumeState({ status: 'idle' })
      return
    }
    toast.success(t('rowActions.resumedToast', { campaignName }))
    setResumeState({ status: 'idle' })
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'active' ? (
```

with:

```tsx
// Editing is available at every status (active, paused, archived) — changing
// settings only changes what the next discovery/pipeline run does, not any
// history. Archived campaigns show Edit + Delete only: there is no
// per-campaign archive action in this product yet (only the client-level
// archive path exists), so an already-archived campaign has no Stop/Resume.
export function CampaignRowActions({ campaignId, campaignName, status }: CampaignRowActionsProps): React.ReactElement {
  const t = useTranslations('campaigns')
  const router = useRouter()
  const [resumeState, setResumeState] = useState<SubmitState>({ status: 'idle' })

  async function runResume(): Promise<void> {
    setResumeState({ status: 'submitting' })
    const result = await postAction(campaignId, 'resume', t)
    if (!result.ok) {
      toast.error(t('rowActions.resumeFailedToast'), { description: result.message })
      setResumeState({ status: 'idle' })
      return
    }
    toast.success(t('rowActions.resumedToast', { campaignName }))
    setResumeState({ status: 'idle' })
    router.refresh()
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button type="button" variant="outline" size="sm" asChild>
        <Link href={`/campaigns/${campaignId}/edit`}>
          <PencilSimple size={13} weight="light" />
          {t('rowActions.editTrigger')}
        </Link>
      </Button>

      {status === 'active' ? (
```

Leave the rest of the file (the `paused` branch and `<DeleteCampaignDialog .../>`) unchanged.

- [ ] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 4: Run the full test suite to confirm no regression**

Run: `pnpm test`
Expected: same pass count as after Task 5.

- [ ] **Step 5: Commit**

```bash
git add src/app/\(app\)/campaigns/campaign-row-actions.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(campaigns): add Edit action to campaign row"
```

---

### Task 7: Client-facing read-only campaigns view

**Files:**
- Create: `src/app/(app)/campaigns/campaign-card.tsx`
- Modify: `src/app/(app)/campaigns/page.tsx`
- Modify: `src/messages/en.json`
- Modify: `src/messages/tr.json`

**Interfaces:**
- Consumes: `createServerClient` from `@/lib/supabase/server` (RLS-scoped client, same pattern as `src/app/(app)/settings/page.tsx`), existing `listCampaignsForClient`, `listClients`, `CampaignRowActions` (Task 6 output, unchanged signature).
- Produces: `CampaignCard` component, props `{ campaign: CampaignRow; leadsPerDayLabel: string; mailboxCountLabel: string; createdRelativeLabel: string; animationDelayMs: number; actions?: React.ReactNode }`. No later task consumes this.

No dedicated test — `page.tsx` has none today either (it's a Server Component composing already-tested `lib/db` calls); `CampaignCard` is presentational only.

- [ ] **Step 1: Add the client-branch i18n keys**

In `src/messages/en.json`, inside the `"campaigns"` object, change:

```json
    "pageDescription": "A campaign defines who the agent looks for and what it says. Discovery runs daily against these filters.",
```

to:

```json
    "pageDescription": "A campaign defines who the agent looks for and what it says. Discovery runs daily against these filters.",
    "clientPageDescription": "Campaigns your operator runs on your behalf. Discovery, writing, and follow-ups run against these settings daily.",
```

and change:

```json
    "noCampaignsDescription": "Create one above. The discovery cron picks it up on its next run.",
```

to:

```json
    "noCampaignsDescription": "Create one above. The discovery cron picks it up on its next run.",
    "noCampaignsDescriptionClient": "Your operator hasn't set one up yet. Check back once a campaign is running.",
```

In `src/messages/tr.json`, matching edits — change:

```json
    "pageDescription": "Bir kampanya, ajanın kimi aradığını ve ne söylediğini tanımlar. Keşif her gün bu filtrelere göre çalışır.",
```

to:

```json
    "pageDescription": "Bir kampanya, ajanın kimi aradığını ve ne söylediğini tanımlar. Keşif her gün bu filtrelere göre çalışır.",
    "clientPageDescription": "Operatörünüzün sizin adınıza yürüttüğü kampanyalar. Keşif, yazma ve takipler her gün bu ayarlara göre çalışır.",
```

and change:

```json
    "noCampaignsDescription": "Yukarıdan bir tane oluşturun. Keşif zamanlayıcısı bir sonraki çalışmasında onu alır.",
```

to:

```json
    "noCampaignsDescription": "Yukarıdan bir tane oluşturun. Keşif zamanlayıcısı bir sonraki çalışmasında onu alır.",
    "noCampaignsDescriptionClient": "Operatörünüz henüz bir tane oluşturmadı. Bir kampanya çalışmaya başladığında tekrar kontrol edin.",
```

- [ ] **Step 2: Extract `CampaignCard`**

Create `src/app/(app)/campaigns/campaign-card.tsx`:

```tsx
import { StatusPill } from '@/components/status-dot'
import { CAMPAIGN_STATUS } from '@/lib/ui/status'
import type { CampaignRow } from '@/lib/db/campaigns'

interface CampaignCardProps {
  campaign: CampaignRow
  leadsPerDayLabel: string
  mailboxCountLabel: string
  createdRelativeLabel: string
  animationDelayMs: number
  /** Row actions (Edit/Stop/Resume/Delete). Omitted entirely for the
   *  client-facing read-only view — no `actions` means no bordered action
   *  strip renders at all, not an empty one. */
  actions?: React.ReactNode
}

export function CampaignCard({
  campaign,
  leadsPerDayLabel,
  mailboxCountLabel,
  createdRelativeLabel,
  animationDelayMs,
  actions,
}: CampaignCardProps): React.ReactElement {
  return (
    <li
      className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4"
      style={{ animationDelay: `${animationDelayMs}ms` }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
        <StatusPill meta={CAMPAIGN_STATUS[campaign.status]} />
      </div>

      <p className="text-muted-foreground mt-2.5 max-w-[70ch] text-sm leading-relaxed">
        {campaign.value_prop}
      </p>

      <div className="text-faint mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="tnum">{leadsPerDayLabel}</span>
        <span className="tnum">{mailboxCountLabel}</span>
        <span className="ml-auto">{createdRelativeLabel}</span>
      </div>

      {actions ? (
        <div className="border-hairline mt-3 flex items-center gap-2 border-t pt-3">{actions}</div>
      ) : null}
    </li>
  )
}
```

- [ ] **Step 3: Rewrite `page.tsx` to branch on role**

Replace the full contents of `src/app/(app)/campaigns/page.tsx` with:

```tsx
import type { Metadata } from 'next'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import { createServerClient } from '@/lib/supabase/server'
import { listCampaignsForClient, type CampaignRow } from '@/lib/db/campaigns'
import { listClients, type ClientOption } from '@/lib/db/clients'
import { formatRelative } from '@/lib/format'
import { PageHeader, Section } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { NewCampaignForm } from './new-campaign-form'
import { CampaignRowActions } from './campaign-row-actions'
import { CampaignCard } from './campaign-card'
import { CampaignsWebMcpTools } from './campaigns-webmcp-tools'
import type { CampaignDirectoryEntry } from '@/types/webmcp-app'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Campaigns' }

/**
 * Narrows a row to the fields the `listCampaigns` WebMCP tool answers with. The
 * mailbox ids themselves stay behind — an agent needs to know how many
 * mailboxes a campaign sends from, not which.
 */
function toWebMcpEntry({
  id,
  client_id,
  name,
  status,
  value_prop,
  daily_target,
  mailbox_ids,
  created_at,
}: CampaignRow): CampaignDirectoryEntry {
  return {
    id,
    clientId: client_id,
    name,
    status,
    valueProp: value_prop,
    dailyTarget: daily_target,
    mailboxCount: mailbox_ids.length,
    createdAt: created_at,
  }
}

export default async function CampaignsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  const t = await getTranslations('campaigns')
  const isOperator = appUser.role === 'operator'
  const now = new Date()

  // Operators see every campaign via the admin client (no RLS filtering
  // needed — they're allowed to see all of them) plus the new-campaign form
  // and Edit/Stop/Resume/Delete actions. Clients get a read-only view of only
  // their own campaigns: the session-scoped client lets Postgres RLS
  // (`campaigns_select`) do that filtering, the same pattern already used for
  // reply_mode/mailboxes on /settings.
  let campaigns: CampaignRow[]
  let clients: ClientOption[] = []
  if (isOperator) {
    const admin = createAdminClient()
    ;[campaigns, clients] = await Promise.all([
      listCampaignsForClient(admin, null),
      listClients(admin),
    ])
  } else {
    const supabase = await createServerClient()
    campaigns = await listCampaignsForClient(supabase, null)
  }

  return (
    <div className="flex max-w-3xl flex-col gap-10">
      <CampaignsWebMcpTools campaigns={campaigns.map(toWebMcpEntry)} />
      <PageHeader
        title={t('pageTitle')}
        description={isOperator ? t('pageDescription') : t('clientPageDescription')}
      />

      {isOperator ? (
        <Section title={t('newCampaignSectionTitle')}>
          {clients.length === 0 ? (
            <EmptyState
              icon={Lightning}
              title={t('noClientsTitle')}
              description={t('noClientsDescription')}
            />
          ) : (
            <NewCampaignForm clients={clients} />
          )}
        </Section>
      ) : null}

      <Section
        title={t('allCampaignsSectionTitle')}
        aside={campaigns.length > 0 ? t('allCampaignsAside', { count: campaigns.length }) : undefined}
      >
        {campaigns.length === 0 ? (
          <EmptyState
            icon={Lightning}
            title={t('noCampaignsTitle')}
            description={isOperator ? t('noCampaignsDescription') : t('noCampaignsDescriptionClient')}
          />
        ) : (
          <ul className="flex flex-col gap-2">
            {campaigns.map((campaign, index) => (
              <CampaignCard
                key={campaign.id}
                campaign={campaign}
                leadsPerDayLabel={t('leadsPerDay', { count: campaign.daily_target })}
                mailboxCountLabel={t('mailboxCount', { count: campaign.mailbox_ids.length })}
                createdRelativeLabel={t('createdRelative', { relative: formatRelative(campaign.created_at, now) })}
                animationDelayMs={Math.min(index, 10) * 30}
                actions={
                  isOperator ? (
                    <CampaignRowActions campaignId={campaign.id} campaignName={campaign.name} status={campaign.status} />
                  ) : undefined
                }
              />
            ))}
          </ul>
        )}
      </Section>
    </div>
  )
}
```

- [ ] **Step 4: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: clean.

- [ ] **Step 5: Run the full test suite to confirm no regression**

Run: `pnpm test`
Expected: same pass count as after Task 6.

- [ ] **Step 6: Commit**

```bash
git add src/app/\(app\)/campaigns/campaign-card.tsx src/app/\(app\)/campaigns/page.tsx src/messages/en.json src/messages/tr.json
git commit -m "feat(campaigns): add read-only campaigns view for clients"
```

---

### Task 8: Update the roadmap

**Files:**
- Modify: `.claude/roadmap.md`

**Interfaces:** none — documentation only.

- [ ] **Step 1: Add a roadmap entry**

Read `.claude/roadmap.md` and append a new entry at the end, matching the
existing convention exactly (see the "Lazy-start warmup ramp (2026-08-06)"
entry already there): a `## <Title> (YYYY-MM-DD)` heading, a short narrative
of the problem/change, a `Spec:`/`Plan:` line, a "Shipped" bullet list, and a
"Verification:" line with the *actual* `pnpm typecheck`/`pnpm test` output
from this run (fill in real numbers — don't copy the example below verbatim):

```markdown
## Campaign settings edit + client read-only view (2026-08-06)

Operators previously couldn't change a campaign's name, value prop, booking
link, daily target, or ICP filters after creation — only status
(stop/resume/delete) was editable. Clients hitting `/campaigns` were
redirected to `/crm` with no visibility into their own campaigns at all.

Spec: [[2026-08-06-campaign-settings-edit-design]]
(`docs/superpowers/specs/2026-08-06-campaign-settings-edit-design.md`).
Plan: `docs/superpowers/plans/2026-08-06-campaign-settings-edit.md`, 8 tasks.

Shipped:
- Shared `campaignSettingsSchema` (`src/lib/apollo/campaign-settings-schema.ts`)
  used by both `POST /api/campaigns` (create) and the new
  `PATCH /api/campaigns/[campaignId]` (edit).
- `updateCampaignSettings` DB helper (`src/lib/db/campaigns.ts`).
- Operator-only edit page at `/campaigns/[campaignId]/edit`, reachable via a
  new Edit action on every campaign row regardless of status.
- `CampaignSettingsFields` extracted from `new-campaign-form.tsx` and reused
  by the new `EditCampaignForm` — avoids duplicating the ~180-line ICP
  fieldset.
- `/campaigns` now branches on role: operators keep the full admin-client
  view; clients get a new RLS-scoped read-only view (`CampaignCard`) instead
  of being redirected to `/crm`.

Verification: `pnpm typecheck` clean, `pnpm lint` clean, `pnpm test` →
**<N> files / <N> tests passing**.
```

- [ ] **Step 2: Commit**

```bash
git add .claude/roadmap.md
git commit -m "docs(roadmap): campaign settings edit + client read-only view shipped"
```

---

## Self-Review

**Spec coverage:**
- Operator edit of name/valueProp/bookingLink/dailyTarget/ICP → Tasks 1–6. ✅
- Edit allowed at any campaign status → Task 6 (Edit link renders unconditionally; PATCH route has no status gate). ✅
- Dedicated edit page → Task 5. ✅
- No WebMCP tool for editing → `EditCampaignForm`'s `<form>` has no `toolname` (Task 5, confirmed). ✅
- Client read-only view via RLS → Task 7. ✅
- Shared Zod schema, shared form-fields component → Tasks 1, 4. ✅
- Tests for DB helper + PATCH route → Tasks 2, 3. ✅
- i18n both locales for every new string → every task touching copy edits both `en.json` and `tr.json`. ✅
- Roadmap update → Task 8. ✅

**Placeholder scan:** no `TBD`/`TODO`/"add logic here" — every step has complete code. ✅

**Type consistency:** `CampaignSettingsPatch` (Task 2) fields (`name`, `value_prop`, `booking_link`, `daily_target`, `icp`) match exactly what the `PATCH` handler (Task 3) constructs and what `campaigns` table columns expect. `CampaignSettingsDefaults` (Task 4) fields match exactly what `NewCampaignForm` (Task 4) and `EditCampaignForm` (Task 5) each pass in. `CampaignCard`'s props (Task 7) match exactly what `page.tsx` (Task 7) passes. ✅
