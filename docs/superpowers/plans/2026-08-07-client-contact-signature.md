# Client Contact Signature Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every client a phone number, address, and optional signer name/title, and deterministically append them as a signature block to first-touch and follow-up outbound emails once a phone number is on file.

**Architecture:** Four new nullable columns on `clients` (`phone`, `address`, `signature_name`, `signature_title`). A pure `appendSignatureBlock` function in `src/lib/pipeline/signature.ts` builds the block and is called from `write.ts` and `followup.ts` right after the AI generates the body, before the body is claimed/sent — never left to the LLM's discretion. An operator edits the four fields from one new dialog on the client detail page, via the existing `PATCH /api/clients/[clientId]` route.

**Tech Stack:** Next.js App Router, Supabase (Postgres + generated types), Zod, Vitest, next-intl (en/tr).

## Global Constraints

- No `any` — use proper types or `unknown` + narrowing (QUALITY.md).
- Zod validates every external input; empty string on an optional text field clears it to `null`, matching the existing `domainSchema` convention (`src/lib/validation/domain.ts`).
- Every Supabase call destructures `{ data, error }` and both are handled; DB errors are mapped to `AppError`, never passed raw to callers.
- Named exports only (no default exports outside Next.js pages/layouts/components).
- Signature closing line is always English (`"Best regards,"`), matching the "always write in English" instruction already enforced in `write.ts`/`followup.ts`'s system prompts regardless of `client.default_locale`.
- The signature block is gated entirely on `phone` being non-null — address/name/title alone never trigger it (confirmed requirement).
- `en.json`/`tr.json` must keep identical key structure and no empty string values — enforced by `src/messages/messages.test.ts`.
- Test file colocated next to the file it tests (`feature.test.ts` beside `feature.ts`), Vitest, Arrange-Act-Assert.
- Spec: `docs/superpowers/specs/2026-08-07-client-contact-signature-design.md` — read it before starting if anything below is ambiguous.

---

### Task 1: Migration + generated DB types

**Files:**
- Create: `supabase/migrations/0031_client_contact_signature.sql`
- Modify: `src/types/database.ts:12-45` (the `clients` table's `Row`/`Insert` shapes)

**Interfaces:**
- Produces: `clients.phone`, `clients.address`, `clients.signature_name`, `clients.signature_title` — all `string | null`, all nullable columns, no defaults. Every later task reads these through `ClientRow` (`src/lib/db/clients.ts`'s existing `export type ClientRow = Database['public']['Tables']['clients']['Row']`).

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/0031_client_contact_signature.sql`:

```sql
-- Client contact/signature info for outbound email — an optional
-- deterministic signature block appended (in code, not by the AI) to
-- first-touch and follow-up emails once a phone number is on file. See
-- docs/superpowers/specs/2026-08-07-client-contact-signature-design.md

alter table clients
  add column phone text,
  add column address text,
  add column signature_name text,
  add column signature_title text;
```

- [ ] **Step 2: Update the generated database types**

In `src/types/database.ts`, find the `clients` table block (starts around line 12). Add the four new fields to both `Row` and `Insert`:

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
          followup_delays_days: number[]
          default_locale: Database['public']['Enums']['app_locale']
          domain: string | null
          logo_url: string | null
          phone: string | null
          address: string | null
          signature_name: string | null
          signature_title: string | null
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
          followup_delays_days?: number[]
          default_locale?: Database['public']['Enums']['app_locale']
          domain?: string | null
          logo_url?: string | null
          phone?: string | null
          address?: string | null
          signature_name?: string | null
          signature_title?: string | null
          created_at?: string
          updated_at?: string
        }
        Update: Partial<Database['public']['Tables']['clients']['Insert']>
        Relationships: []
      }
```

(`Update` is already `Partial<Insert>` — no separate edit needed there.)

- [ ] **Step 3: Verify the project still typechecks**

Run: `pnpm typecheck`
Expected: no new errors (nothing consumes the new fields yet, so this only confirms the type edit itself is syntactically valid).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/0031_client_contact_signature.sql src/types/database.ts
git commit -m "feat(db): add phone/address/signature_name/signature_title to clients

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 2: Phone validation schema

**Files:**
- Create: `src/lib/validation/phone.ts`
- Test: `src/lib/validation/phone.test.ts`

**Interfaces:**
- Consumes: nothing (pure Zod schema).
- Produces: `export const phoneSchema: z.ZodType<string | null, ..., string>` — `.parse(raw: string)` returns a trimmed phone string or `null` for empty input. Consumed by Task 5 (API route).

- [ ] **Step 1: Write the failing test**

Create `src/lib/validation/phone.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { phoneSchema } from './phone'

describe('phoneSchema', () => {
  it('should accept a plain international number', () => {
    expect(phoneSchema.parse('+1 555 123 4567')).toBe('+1 555 123 4567')
  })

  it('should accept a number with parens and hyphens', () => {
    expect(phoneSchema.parse('(505) 555-1234')).toBe('(505) 555-1234')
  })

  it('should trim surrounding whitespace', () => {
    expect(phoneSchema.parse('  +1 555 123 4567  ')).toBe('+1 555 123 4567')
  })

  it('should transform empty input into null', () => {
    expect(phoneSchema.parse('')).toBeNull()
  })

  it('should transform whitespace-only input into null', () => {
    expect(phoneSchema.parse('   ')).toBeNull()
  })

  it('should reject a value with fewer than 7 digits', () => {
    expect(() => phoneSchema.parse('123 456')).toThrow()
  })

  it('should reject a value containing letters', () => {
    expect(() => phoneSchema.parse('call me maybe')).toThrow()
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/validation/phone.test.ts`
Expected: FAIL — `Cannot find module './phone'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/validation/phone.ts`:

```ts
import { z } from 'zod'

// Lenient international format: digits, spaces, parens, hyphens, dots, and an
// optional leading +. Not a strict E.164 validator — this only needs to catch
// obvious garbage before a value goes into a signature line, not validate a
// dialable number.
const PHONE_PATTERN = /^\+?[0-9()\-.\s]{7,25}$/

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length
}

// Transforms a raw form value into a trimmed phone string or `null` (empty
// input clears the field). `.optional()` at the call site distinguishes
// "field not sent" (leave alone) from "field sent empty" (clear it) — same
// convention as domainSchema.
export const phoneSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length === 0 || (PHONE_PATTERN.test(value) && digitCount(value) >= 7), {
    message: 'must be a valid phone number, e.g. +1 555 123 4567',
  })
  .transform((value) => (value.length === 0 ? null : value))
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/validation/phone.test.ts`
Expected: PASS (7/7)

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/phone.ts src/lib/validation/phone.test.ts
git commit -m "feat(validation): add phoneSchema

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 3: Signature block builder

**Files:**
- Create: `src/lib/pipeline/signature.ts`
- Test: `src/lib/pipeline/signature.test.ts`

**Interfaces:**
- Consumes: nothing (pure function).
- Produces: `export interface ClientSignatureContext { companyName: string; signatureName: string | null; signatureTitle: string | null; phone: string | null; address: string | null; domain: string | null }` and `export function appendSignatureBlock(body: string, signature: ClientSignatureContext): string`. Consumed by Task 6 (`write.ts`) and Task 7 (`followup.ts`).

- [ ] **Step 1: Write the failing test**

Create `src/lib/pipeline/signature.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { appendSignatureBlock, type ClientSignatureContext } from './signature'

const base: ClientSignatureContext = {
  companyName: 'Uniforms Fashion',
  signatureName: null,
  signatureTitle: null,
  phone: null,
  address: null,
  domain: null,
}

describe('appendSignatureBlock', () => {
  it('should return the body unchanged when phone is null, even with address set', () => {
    expect(appendSignatureBlock('Hi Jane...', { ...base, address: '123 Main St' })).toBe('Hi Jane...')
  })

  it('should append a minimal block with just company name and phone', () => {
    const result = appendSignatureBlock('Hi Jane...', { ...base, phone: '+1 555 123 4567' })
    expect(result).toBe('Hi Jane...\n\nBest regards,\n\nUniforms Fashion\n\n+1 555 123 4567')
  })

  it('should append every field when all are set', () => {
    const result = appendSignatureBlock('Hi Jane...', {
      companyName: 'Uniforms Fashion',
      signatureName: 'John Smith',
      signatureTitle: 'Sales Director',
      phone: '+1 (505) 555-1234',
      address: '123 Main St, Istanbul, Turkey',
      domain: 'uniformsfashion.com',
    })
    expect(result).toBe(
      'Hi Jane...\n\nBest regards,\n\nJohn Smith\nSales Director\nUniforms Fashion\n\n' +
        '+1 (505) 555-1234\n123 Main St, Istanbul, Turkey\nuniformsfashion.com',
    )
  })

  it('should omit signatureTitle when only signatureName is set', () => {
    const result = appendSignatureBlock('Hi.', { ...base, phone: '+1 5551234567', signatureName: 'John Smith' })
    expect(result).toBe('Hi.\n\nBest regards,\n\nJohn Smith\nUniforms Fashion\n\n+1 5551234567')
  })

  it('should omit address and domain when neither is set', () => {
    const result = appendSignatureBlock('Hi.', { ...base, phone: '+1 5551234567' })
    expect(result).not.toContain('\nnull')
    expect(result.endsWith('+1 5551234567')).toBe(true)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec vitest run src/lib/pipeline/signature.test.ts`
Expected: FAIL — `Cannot find module './signature'`

- [ ] **Step 3: Write the implementation**

Create `src/lib/pipeline/signature.ts`:

```ts
// Deterministic signature block appended to outbound email bodies — never
// generated by the AI. `bookingLink` is proof that "optional" content handed
// to the model as context gets silently omitted (see the SYSTEM_PROMPT in
// write.ts); a phone number the client explicitly asked for must not be
// subject to that same discretion. See
// docs/superpowers/specs/2026-08-07-client-contact-signature-design.md

const SIGNATURE_CLOSING = 'Best regards,'

export interface ClientSignatureContext {
  companyName: string
  signatureName: string | null
  signatureTitle: string | null
  phone: string | null
  address: string | null
  domain: string | null
}

function presentLines(values: (string | null)[]): string[] {
  return values.filter((value): value is string => value !== null && value.trim().length > 0)
}

// Appends a fixed-format signature after the AI-generated body. Gated
// entirely on `phone`: no phone on file means no signature at all, even if
// address/name/title are set. Closing line is always English, matching the
// "always write in English" instruction write.ts/followup.ts's system
// prompts already enforce regardless of client locale.
export function appendSignatureBlock(body: string, signature: ClientSignatureContext): string {
  if (!signature.phone) return body

  const identityLines = presentLines([signature.signatureName, signature.signatureTitle, signature.companyName])
  const contactLines = presentLines([signature.phone, signature.address, signature.domain])

  const block = [SIGNATURE_CLOSING, identityLines.join('\n'), contactLines.join('\n')].join('\n\n')
  return `${body}\n\n${block}`
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm exec vitest run src/lib/pipeline/signature.test.ts`
Expected: PASS (5/5)

- [ ] **Step 5: Commit**

```bash
git add src/lib/pipeline/signature.ts src/lib/pipeline/signature.test.ts
git commit -m "feat(pipeline): add appendSignatureBlock

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 4: DB layer — `updateClientSignature`

**Files:**
- Modify: `src/lib/db/clients.ts:171-181` (insert the new function directly after `updateClientDomain`)

**Interfaces:**
- Consumes: existing `ClientRow`, `AppError` (already imported in this file).
- Produces: `export interface ClientSignatureUpdate { phone: string | null; address: string | null; signatureName: string | null; signatureTitle: string | null }` and `export async function updateClientSignature(supabase, id: string, update: ClientSignatureUpdate): Promise<ClientRow>`. Consumed by Task 5 (API route).

- [ ] **Step 1: Write the implementation**

In `src/lib/db/clients.ts`, insert this immediately after the existing `updateClientDomain` function (right before the `updateClientLogoUrl` comment/function):

```ts
export interface ClientSignatureUpdate {
  phone: string | null
  address: string | null
  signatureName: string | null
  signatureTitle: string | null
}

// Single combined update — the operator edits phone/address/signatureName/
// signatureTitle from one dialog in one submit, so there's one write path
// rather than four independent single-field updates like updateClientDomain.
export async function updateClientSignature(
  supabase: SupabaseClient<Database>,
  id: string,
  update: ClientSignatureUpdate,
): Promise<ClientRow> {
  const { data, error } = await supabase
    .from('clients')
    .update({
      phone: update.phone,
      address: update.address,
      signature_name: update.signatureName,
      signature_title: update.signatureTitle,
    })
    .eq('id', id)
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to update client signature', { id, cause: error?.message })
  }
  return data
}
```

- [ ] **Step 2: Verify the project typechecks**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 3: Commit**

```bash
git add src/lib/db/clients.ts
git commit -m "feat(db): add updateClientSignature

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 5: API route — extend `PATCH /api/clients/[clientId]`

**Files:**
- Modify: `src/app/api/clients/[clientId]/route.ts`
- Test: `src/app/api/clients/[clientId]/route.test.ts`

**Interfaces:**
- Consumes: `phoneSchema` (Task 2), `updateClientSignature`/`ClientSignatureUpdate` (Task 4).
- Produces: `PATCH` now accepts `{ phone?, address?, signatureName?, signatureTitle? }` in its JSON body, on top of the existing `name`/`warmupProfile`/`domain`. Logs a `client.signature_changed` event.

- [ ] **Step 1: Write the failing tests**

In `src/app/api/clients/[clientId]/route.test.ts`, add `updateClientSignatureMock` to the mock setup. Replace the top mock block:

```ts
const requireUserMock = vi.fn()
const getClientByIdMock = vi.fn()
const updateClientNameMock = vi.fn()
const updateClientDomainMock = vi.fn()
const updateClientSignatureMock = vi.fn()
const deleteClientCascadeMock = vi.fn()
const listClientRoleAppUsersMock = vi.fn()
const deleteAuthUsersMock = vi.fn()
const logEventMock = vi.fn()

vi.mock('@/lib/auth/require-user', () => ({ requireUser: (...a: unknown[]) => requireUserMock(...a) }))
vi.mock('@/lib/supabase/admin', () => ({ createAdminClient: () => ({}) }))
vi.mock('@/lib/db/clients', () => ({
  getClientById: (...a: unknown[]) => getClientByIdMock(...a),
  updateClientName: (...a: unknown[]) => updateClientNameMock(...a),
  updateClientDomain: (...a: unknown[]) => updateClientDomainMock(...a),
  updateClientSignature: (...a: unknown[]) => updateClientSignatureMock(...a),
  deleteClientCascade: (...a: unknown[]) => deleteClientCascadeMock(...a),
  listClientRoleAppUsers: (...a: unknown[]) => listClientRoleAppUsersMock(...a),
}))
vi.mock('@/lib/supabase/auth-admin', () => ({ deleteAuthUsers: (...a: unknown[]) => deleteAuthUsersMock(...a) }))
vi.mock('@/lib/events/log-event', () => ({
  logEvent: (...a: unknown[]) => logEventMock(...a),
}))
```

Add `updateClientSignatureMock.mockReset()` to the `beforeEach`:

```ts
beforeEach(() => {
  requireUserMock.mockReset().mockResolvedValue({ appUser: { id: 'op1', role: 'operator' } })
  getClientByIdMock.mockReset()
  updateClientNameMock.mockReset()
  updateClientDomainMock.mockReset()
  updateClientSignatureMock.mockReset()
  deleteClientCascadeMock.mockReset()
  listClientRoleAppUsersMock.mockReset()
  deleteAuthUsersMock.mockReset()
  logEventMock.mockReset().mockResolvedValue(undefined)
})
```

Add these `it` blocks inside `describe('PATCH /api/clients/[clientId]', ...)`, after the existing domain tests and before the closing `})`:

```ts
  it('should save phone/address/signature name/title together and log the event', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: null, address: null, signature_name: null, signature_title: null,
    })
    updateClientSignatureMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: '123 Main St',
      signature_name: 'John Smith', signature_title: 'Sales Director',
    })
    const res = await PATCH(
      req({ phone: '+1 555 123 4567', address: '123 Main St', signatureName: 'John Smith', signatureTitle: 'Sales Director' }),
      ctx('c1'),
    )
    const json = await res.json()
    expect(res.status).toBe(200)
    expect(json.client.phone).toBe('+1 555 123 4567')
    expect(updateClientSignatureMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      phone: '+1 555 123 4567', address: '123 Main St', signatureName: 'John Smith', signatureTitle: 'Sales Director',
    })
    expect(logEventMock).toHaveBeenCalledWith(expect.objectContaining({ clientId: 'c1', type: 'client.signature_changed' }))
  })

  it('should keep the existing phone when only address is sent', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: null, signature_name: null, signature_title: null,
    })
    updateClientSignatureMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: '123 Main St', signature_name: null, signature_title: null,
    })
    await PATCH(req({ address: '123 Main St' }), ctx('c1'))
    expect(updateClientSignatureMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      phone: '+1 555 123 4567', address: '123 Main St', signatureName: null, signatureTitle: null,
    })
  })

  it('should clear signature fields when sent empty', async () => {
    getClientByIdMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: '+1 555 123 4567', address: '123 Main St', signature_name: 'John', signature_title: 'CEO',
    })
    updateClientSignatureMock.mockResolvedValue({
      id: 'c1', name: 'Acme', phone: null, address: null, signature_name: null, signature_title: null,
    })
    const res = await PATCH(req({ phone: '', address: '', signatureName: '', signatureTitle: '' }), ctx('c1'))
    expect(res.status).toBe(200)
    expect(updateClientSignatureMock).toHaveBeenCalledWith(expect.anything(), 'c1', {
      phone: null, address: null, signatureName: null, signatureTitle: null,
    })
  })

  it('should return 400 for an invalid phone', async () => {
    getClientByIdMock.mockResolvedValue({ id: 'c1', name: 'Acme', phone: null })
    const res = await PATCH(req({ phone: 'call me maybe' }), ctx('c1'))
    expect(res.status).toBe(400)
    expect(updateClientSignatureMock).not.toHaveBeenCalled()
  })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run src/app/api/clients/\[clientId\]/route.test.ts`
Expected: the 4 new tests FAIL (route doesn't accept these fields yet); all prior tests still PASS.

- [ ] **Step 3: Implement the route changes**

In `src/app/api/clients/[clientId]/route.ts`, update the imports:

```ts
import { NextResponse } from 'next/server'
import { z } from 'zod'
import { requireUser } from '@/lib/auth/require-user'
import { createAdminClient } from '@/lib/supabase/admin'
import {
  getClientById,
  updateClientName,
  updateClientWarmupProfile,
  updateClientDomain,
  updateClientSignature,
  deleteClientCascade,
  listClientRoleAppUsers,
} from '@/lib/db/clients'
import { deleteAuthUsers } from '@/lib/supabase/auth-admin'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'
import { domainSchema } from '@/lib/validation/domain'
import { phoneSchema } from '@/lib/validation/phone'

export const runtime = 'nodejs'
```

Replace `patchSchema` with:

```ts
// Trimmed, length-capped, empty-clears-to-null — same three-step transform
// chain as domainSchema, for the three signature fields that carry no format
// constraint beyond a sane max length.
function nullableTextSchema(maxLength: number) {
  return z
    .string()
    .transform((value) => value.trim())
    .refine((value) => value.length <= maxLength, { message: `must be ${maxLength} characters or fewer` })
    .transform((value) => (value.length === 0 ? null : value))
}

// mailreachEnabled is deliberately NOT a field here — that boolean-flag
// mutation goes through the setClientMailreachEnabled Server Action
// (mailreach-actions.ts) instead of a client-side fetch to this route.
const patchSchema = z
  .object({
    name: z.string().min(1).optional(),
    warmupProfile: z.enum(['standard', 'slow', 'none']).optional(),
    domain: domainSchema.optional(),
    phone: phoneSchema.optional(),
    address: nullableTextSchema(200).optional(),
    signatureName: nullableTextSchema(120).optional(),
    signatureTitle: nullableTextSchema(120).optional(),
  })
  .refine(
    (body) =>
      body.name !== undefined ||
      body.warmupProfile !== undefined ||
      body.domain !== undefined ||
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined,
    { message: 'At least one field must be provided' },
  )
```

In the `PATCH` handler, add this block right after the existing `if (body.domain !== undefined) { ... }` block (before `return NextResponse.json({ ok: true, client: updated })`):

```ts
    if (
      body.phone !== undefined ||
      body.address !== undefined ||
      body.signatureName !== undefined ||
      body.signatureTitle !== undefined
    ) {
      updated = await updateClientSignature(admin, clientId, {
        phone: body.phone !== undefined ? body.phone : client.phone,
        address: body.address !== undefined ? body.address : client.address,
        signatureName: body.signatureName !== undefined ? body.signatureName : client.signature_name,
        signatureTitle: body.signatureTitle !== undefined ? body.signatureTitle : client.signature_title,
      })
      try {
        await logEvent({
          clientId,
          actor: `human:${appUser.id}`,
          type: 'client.signature_changed',
          payload: {
            phone: updated.phone,
            address: updated.address,
            signatureName: updated.signature_name,
            signatureTitle: updated.signature_title,
          },
        })
      } catch {
        // Audit logging is best-effort — the update already succeeded.
      }
    }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/app/api/clients/\[clientId\]/route.test.ts`
Expected: PASS, all tests (existing + 4 new).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/app/api/clients/\[clientId\]/route.ts src/app/api/clients/\[clientId\]/route.test.ts
git commit -m "feat(api): accept phone/address/signature fields on client PATCH

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 6: Wire signature into `write.ts` (first-touch email)

**Files:**
- Modify: `src/lib/pipeline/write.ts`
- Test: `src/lib/pipeline/write.test.ts`

**Interfaces:**
- Consumes: `getClientById`, `type ClientRow` from `@/lib/db/clients`; `appendSignatureBlock` from `./signature` (Task 3).
- Produces: no change to `RunWriteInput`'s public shape or to `/api/pipeline/write/route.ts` — the client fetch is internal to `write.ts`.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pipeline/write.test.ts`, extend the default `getClientByIdMock` fixture in `beforeEach` to include a company name (existing tests don't assert exact body content, so this is safe):

```ts
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null })
```

Add these two `it` blocks at the end of `describe('runWriteForCase', ...)`, before its closing `})`:

```ts
  it('should append the phone signature to the email body when the client has a phone on file', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: 'acme.com',
      phone: '+1 555 123 4567', address: null, signature_name: null, signature_title: null,
    })

    await runWriteForCase({} as never, input)

    const expectedBody = 'Hi Jane...\n\nBest regards,\n\nAcme\n\n+1 555 123 4567\nacme.com'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
    expect(sendViaMailboxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it('should not append a signature when the client has no phone on file', async () => {
    listActiveLeadsMock.mockResolvedValue([lead])
    claimOutboundEmailMock.mockResolvedValue({ id: 'e1' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: 'pm1', threadId: 'thr1' })
    createSequenceMock.mockResolvedValue({ id: 'seq1' })
    publishDelayMock.mockResolvedValue('qmsg1')

    await runWriteForCase({} as never, input)

    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: 'Hi Jane...' }))
  })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run src/lib/pipeline/write.test.ts`
Expected: the "should append the phone signature..." test FAILs (body has no signature yet); all others still PASS.

- [ ] **Step 3: Implement the wiring**

In `src/lib/pipeline/write.ts`, update imports — add these two lines, `getClientById`/`ClientRow` grouped with the other `@/lib/db/*` imports, `appendSignatureBlock` grouped with the other relative imports:

```ts
import { isSuppressed } from '@/lib/db/suppressions'
import { getClientById, type ClientRow } from '@/lib/db/clients'
import { claimOutboundEmail, markEmailSent, markEmailFailed } from '@/lib/db/emails'
```

```ts
import { FIRST_TOUCH_STEP, scheduleFirstFollowup } from './followup'
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { appendSignatureBlock } from './signature'
```

Change `processLead`'s signature and body:

```ts
async function processLead(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
  lead: LeadRow,
  knowledge: KnowledgeRow[],
  clientKnowledge: string,
  client: ClientRow | null,
): Promise<'sent' | 'drafted' | 'skipped'> {
  if (!lead.email) return 'skipped'
  if (await isSuppressed(supabase, input.clientId, lead.email)) return 'skipped'

  const context: LlmCallContext = { clientId: input.clientId, caseId: input.caseId, actor: ACTOR }
  const draft = await generateJson(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildPrompt(input, lead, knowledge, clientKnowledge),
    schema: draftSchema,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // Deterministic — never left to the model's discretion. Appended here,
  // before the claim, so both a sent email and a human_approve draft carry it.
  const signedBody = appendSignatureBlock(draft.body, {
    companyName: client?.name ?? '',
    signatureName: client?.signature_name ?? null,
    signatureTitle: client?.signature_title ?? null,
    phone: client?.phone ?? null,
    address: client?.address ?? null,
    domain: client?.domain ?? null,
  })

  // Claim the (lead, step 0, outbound) slot BEFORE sending — a retry that finds
  // the slot taken returns null and we never double-send.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: input.clientId,
    case_id: input.caseId,
    lead_id: lead.id,
    direction: 'outbound',
    subject: draft.subject,
    body: signedBody,
    status: shouldSendFirstTouch(input.replyMode) ? 'queued' : 'draft',
    sequence_step: FIRST_TOUCH_STEP,
  })
  if (!claimed) return 'skipped'

  if (!shouldSendFirstTouch(input.replyMode)) return 'drafted'

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: input.clientId,
      mailboxIds: input.mailboxIds,
      to: lead.email,
      subject: draft.subject,
      body: signedBody,
      purpose: 'outreach',
    })
  } catch (error) {
```

(everything from the `catch` block onward is unchanged.)

Change `runWriteForCase` to fetch the client once and pass it through:

```ts
export async function runWriteForCase(
  supabase: SupabaseClient<Database>,
  input: RunWriteInput,
): Promise<WriteSummary> {
  const knowledge = await listKnowledgeForCase(supabase, input.caseId)
  const leads = await listActiveLeadsForCase(supabase, input.caseId)
  const client = await getClientById(supabase, input.clientId)

  const dossierText = knowledge.map((k) => k.content).join(' ')
  const clientKnowledge = await retrieveClientKnowledge(supabase, {
    clientId: input.clientId,
    queryText: buildKnowledgeQueryText({ primary: dossierText, secondary: [input.valueProp ?? ''] }),
  })

  let sent = 0
  let drafted = 0
  for (const lead of leads) {
    const outcome = await processLead(supabase, input, lead, knowledge, clientKnowledge, client)
    if (outcome === 'sent') sent += 1
    if (outcome === 'drafted') drafted += 1
  }
```

(rest of `runWriteForCase` is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/pipeline/write.test.ts`
Expected: PASS, all tests (existing + 2 new).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/write.ts src/lib/pipeline/write.test.ts
git commit -m "feat(pipeline): append client signature to first-touch email

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 7: Wire signature into `followup.ts` (nudge sequence)

**Files:**
- Modify: `src/lib/pipeline/followup.ts`
- Test: `src/lib/pipeline/followup.test.ts`

**Interfaces:**
- Consumes: `getClientById` (already imported in this file), `appendSignatureBlock` from `./signature` (Task 3).
- Produces: no change to `RunFollowupInput` or the `/api/pipeline/followup` route.

- [ ] **Step 1: Write the failing tests**

In `src/lib/pipeline/followup.test.ts`, extend the default `getClientByIdMock` fixture in `beforeEach`:

```ts
  getClientByIdMock.mockResolvedValue({ id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: null, phone: null, address: null, signature_name: null, signature_title: null })
```

Add these two `it` blocks at the end of `describe('runFollowupStep', ...)`, before its closing `})`:

```ts
  it('should append the phone signature to the nudge body when the client has a phone on file', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')
    getClientByIdMock.mockResolvedValue({
      id: 'c1', followup_delays_days: [3, 7, 14], name: 'Acme', domain: 'acme.com',
      phone: '+1 555 123 4567', address: null, signature_name: null, signature_title: null,
    })

    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    const expectedBody = 'Just following up, Jane.\n\nBest regards,\n\nAcme\n\n+1 555 123 4567\nacme.com'
    expect(claimOutboundEmailMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
    expect(sendViaMailboxMock).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ body: expectedBody }))
  })

  it('should not append a signature to the nudge when the client has no phone on file', async () => {
    claimOutboundEmailMock.mockResolvedValue({ id: 'e2' })
    sendViaMailboxMock.mockResolvedValue({ mailboxId: 'm1', providerMessageId: '<b@mail>', threadId: 'thr1' })
    publishDelayMock.mockResolvedValue('qmsg2')

    await runFollowupStep({} as never, { sequenceId: 'seq1', step: 1 })

    expect(claimOutboundEmailMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ body: 'Just following up, Jane.' }),
    )
  })
```

- [ ] **Step 2: Run tests to verify the new ones fail**

Run: `pnpm exec vitest run src/lib/pipeline/followup.test.ts`
Expected: the "should append the phone signature..." test FAILs; all others still PASS.

- [ ] **Step 3: Implement the wiring**

In `src/lib/pipeline/followup.ts`, add one import near the other relative imports:

```ts
import { HUMAN_VOICE_INSTRUCTION } from './email-voice'
import { appendSignatureBlock } from './signature'
```

Insert the client fetch and signature append right after the existing `nudgeBody` block (which ends `maxOutputTokens: MAX_OUTPUT_TOKENS, })`) and before the `// Claim the (lead, step, outbound) slot before sending` comment:

```ts
  const nudgeBody = await generateText(context, {
    instructions: SYSTEM_PROMPT,
    prompt: buildNudgePrompt(
      priorSubject,
      firstOutbound?.body ?? '',
      campaign.value_prop,
      campaign.booking_link,
      input.step,
      maxStep,
      clientKnowledge,
    ),
    maxOutputTokens: MAX_OUTPUT_TOKENS,
  })

  // Deterministic — never left to the model's discretion, same as write.ts.
  const client = await getClientById(supabase, sequence.client_id)
  const signedBody = appendSignatureBlock(nudgeBody, {
    companyName: client?.name ?? '',
    signatureName: client?.signature_name ?? null,
    signatureTitle: client?.signature_title ?? null,
    phone: client?.phone ?? null,
    address: client?.address ?? null,
    domain: client?.domain ?? null,
  })

  // Claim the (lead, step, outbound) slot before sending — retry-safe.
  const claimed = await claimOutboundEmail(supabase, {
    client_id: sequence.client_id,
    case_id: sequence.case_id,
    lead_id: sequence.lead_id,
    thread_id: threadId,
    direction: 'outbound',
    subject: replySubject,
    body: signedBody,
    status: 'queued',
    sequence_step: input.step,
  })
  if (!claimed) return { sequenceId: sequence.id, action: 'skipped' }

  let sent: SendViaMailboxResult
  try {
    sent = await sendViaMailbox(supabase, {
      clientId: sequence.client_id,
      mailboxIds: campaign.mailbox_ids,
      to: lead.email,
      subject: replySubject,
      body: signedBody,
      purpose: 'outreach',
      threadId,
      inReplyToMessageId: inReplyTo,
      references: inReplyTo,
    })
```

(everything from the `catch` block onward is unchanged.)

- [ ] **Step 4: Run tests to verify they pass**

Run: `pnpm exec vitest run src/lib/pipeline/followup.test.ts`
Expected: PASS, all tests (existing + 2 new).

- [ ] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/pipeline/followup.ts src/lib/pipeline/followup.test.ts
git commit -m "feat(pipeline): append client signature to follow-up nudges

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

### Task 8: Operator UI — edit-signature dialog

**Files:**
- Create: `src/app/(app)/clients/[id]/edit-signature-dialog.tsx`
- Modify: `src/app/(app)/clients/[id]/page.tsx` (render the new dialog next to `EditDomainDialog`)
- Modify: `src/messages/en.json`, `src/messages/tr.json` (add `clients.editSignatureDialog.*`)

**Interfaces:**
- Consumes: `PATCH /api/clients/[clientId]` (Task 5) with `{ signatureName, signatureTitle, phone, address }`.
- Produces: `export function EditSignatureDialog(props: { clientId: string; currentSignatureName: string | null; currentSignatureTitle: string | null; currentPhone: string | null; currentAddress: string | null }): React.ReactElement`.

- [ ] **Step 1: Add the i18n keys**

In `src/messages/en.json`, find the `"editDomainDialog": { ... }` block under `"clients"` (around line 268) and insert this new block immediately after its closing `},`:

```json
    "editSignatureDialog": {
      "trigger": "Edit signature",
      "title": "Contact signature",
      "toolDescription": "Records the name, title, phone, and address appended as a signature line to outbound email once a phone number is on file. Submitting a field empty clears it.",
      "nameLabel": "Name",
      "nameToolParamDescription": "The signer's name shown in the email signature, e.g. John Smith. Optional; leave blank to clear it.",
      "titleLabel": "Title",
      "titleToolParamDescription": "The signer's job title shown under their name, e.g. Sales Director. Optional; leave blank to clear it.",
      "phoneLabel": "Phone",
      "phoneToolParamDescription": "The phone number appended to outbound email once set — required for a signature to appear at all. Optional; leave blank to clear it.",
      "phoneHint": "No signature is added to outbound email until this is set.",
      "addressLabel": "Address",
      "addressToolParamDescription": "The mailing address shown in the email signature. Optional; leave blank to clear it.",
      "updateFailed": "Could not update the signature.",
      "updateFailedToast": "Update failed",
      "updatedToast": "Signature updated",
      "networkError": "Network request failed. Check your connection and retry."
    },
```

In `src/messages/tr.json`, find the matching `"editDomainDialog": { ... }` block and insert this immediately after its closing `},`:

```json
    "editSignatureDialog": {
      "trigger": "İmzayı düzenle",
      "title": "İletişim imzası",
      "toolDescription": "Telefon numarası girildiğinde giden e-postalara eklenen imza satırındaki ad, unvan, telefon ve adres bilgilerini kaydeder. Bir alan boş gönderilirse temizlenir.",
      "nameLabel": "Ad",
      "nameToolParamDescription": "E-posta imzasında gösterilen imzalayan kişinin adı, örneğin John Smith. İsteğe bağlıdır; temizlemek için boş bırakın.",
      "titleLabel": "Unvan",
      "titleToolParamDescription": "Adın altında gösterilen unvan, örneğin Satış Direktörü. İsteğe bağlıdır; temizlemek için boş bırakın.",
      "phoneLabel": "Telefon",
      "phoneToolParamDescription": "Ayarlandığında giden e-postalara eklenen telefon numarası — bir imzanın görünmesi için gereklidir. İsteğe bağlıdır; temizlemek için boş bırakın.",
      "phoneHint": "Bu ayarlanana kadar giden e-postalara imza eklenmez.",
      "addressLabel": "Adres",
      "addressToolParamDescription": "E-posta imzasında gösterilen posta adresi. İsteğe bağlıdır; temizlemek için boş bırakın.",
      "updateFailed": "İmza güncellenemedi.",
      "updateFailedToast": "Güncelleme başarısız",
      "updatedToast": "İmza güncellendi",
      "networkError": "Ağ isteği başarısız oldu. Bağlantınızı kontrol edip tekrar deneyin."
    },
```

- [ ] **Step 2: Run the message-catalog parity test to verify it passes**

Run: `pnpm exec vitest run src/messages/messages.test.ts`
Expected: PASS — both locales now have identical key structure, no empty values.

- [ ] **Step 3: Create the dialog component**

Create `src/app/(app)/clients/[id]/edit-signature-dialog.tsx`, modeled directly on the existing `edit-domain-dialog.tsx` in the same directory:

```tsx
'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { IdentificationCard } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
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

type EditState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface EditSignatureDialogProps {
  clientId: string
  currentSignatureName: string | null
  currentSignatureTitle: string | null
  currentPhone: string | null
  currentAddress: string | null
}

// All four fields are optional and only used to append a deterministic
// signature line to outbound email once a phone number is on file — see
// appendSignatureBlock in src/lib/pipeline/signature.ts. Submitting a field
// empty clears it, same convention as EditDomainDialog.
export function EditSignatureDialog({
  clientId,
  currentSignatureName,
  currentSignatureTitle,
  currentPhone,
  currentAddress,
}: EditSignatureDialogProps): React.ReactElement {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [signatureName, setSignatureName] = useState(currentSignatureName ?? '')
  const [signatureTitle, setSignatureTitle] = useState(currentSignatureTitle ?? '')
  const [phone, setPhone] = useState(currentPhone ?? '')
  const [address, setAddress] = useState(currentAddress ?? '')
  const [state, setState] = useState<EditState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureName, signatureTitle, phone, address }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('editSignatureDialog.updateFailed')
        setState({ status: 'error', message })
        toast.error(t('editSignatureDialog.updateFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success(t('editSignatureDialog.updatedToast'))
      router.refresh()
    } catch {
      setState({ status: 'error', message: t('editSignatureDialog.networkError') })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setSignatureName(currentSignatureName ?? '')
          setSignatureTitle(currentSignatureTitle ?? '')
          setPhone(currentPhone ?? '')
          setAddress(currentAddress ?? '')
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={t('editSignatureDialog.trigger')}>
          <IdentificationCard size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editSignatureDialog.title')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          // Declarative WebMCP: an agent may fill this in, but the operator
          // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
          toolname="setClientSignature"
          tooldescription={t('editSignatureDialog.toolDescription')}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="signatureName" className="text-xs">
              {t('editSignatureDialog.nameLabel')}
            </Label>
            <Input
              id="signatureName"
              name="signatureName"
              value={signatureName}
              onChange={(event) => setSignatureName(event.target.value)}
              placeholder="John Smith"
              toolparamdescription={t('editSignatureDialog.nameToolParamDescription')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="signatureTitle" className="text-xs">
              {t('editSignatureDialog.titleLabel')}
            </Label>
            <Input
              id="signatureTitle"
              name="signatureTitle"
              value={signatureTitle}
              onChange={(event) => setSignatureTitle(event.target.value)}
              placeholder="Sales Director"
              toolparamdescription={t('editSignatureDialog.titleToolParamDescription')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientPhone" className="text-xs">
              {t('editSignatureDialog.phoneLabel')}
            </Label>
            <Input
              id="clientPhone"
              name="phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 555 123 4567"
              toolparamdescription={t('editSignatureDialog.phoneToolParamDescription')}
            />
            <p className="text-faint text-[11px]">{t('editSignatureDialog.phoneHint')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientAddress" className="text-xs">
              {t('editSignatureDialog.addressLabel')}
            </Label>
            <Input
              id="clientAddress"
              name="address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="123 Main St, Istanbul, Turkey"
              toolparamdescription={t('editSignatureDialog.addressToolParamDescription')}
            />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting'}>
              {state.status === 'submitting' ? tCommon('saving') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 4: Wire it into the client detail page**

In `src/app/(app)/clients/[id]/page.tsx`, add the import next to the other dialog imports:

```ts
import { EditDomainDialog } from './edit-domain-dialog'
import { EditSignatureDialog } from './edit-signature-dialog'
```

Render it next to `EditDomainDialog` in the header:

```tsx
              <RenameClientDialog clientId={client.id} currentName={client.name} />
              <EditDomainDialog clientId={client.id} currentDomain={client.domain} />
              <EditSignatureDialog
                clientId={client.id}
                currentSignatureName={client.signature_name}
                currentSignatureTitle={client.signature_title}
                currentPhone={client.phone}
                currentAddress={client.address}
              />
              <LogoUpload clientId={client.id} hasLogo={Boolean(client.logo_url)} />
```

- [ ] **Step 5: Typecheck and lint**

Run: `pnpm typecheck`
Expected: no errors — `client.signature_name`/`client.signature_title`/`client.phone`/`client.address` all resolve because `getClientById` returns `ClientRow`, updated in Task 1.

Run: `pnpm lint`
Expected: no new errors.

- [ ] **Step 6: Run the full test suite**

Run: `pnpm test`
Expected: PASS — every test from Tasks 2, 3, 5, 6, 7, plus the message-catalog test from this task, plus every pre-existing test untouched by this plan.

- [ ] **Step 7: Commit**

```bash
git add "src/app/(app)/clients/[id]/edit-signature-dialog.tsx" "src/app/(app)/clients/[id]/page.tsx" src/messages/en.json src/messages/tr.json
git commit -m "feat(clients): add contact signature edit dialog to client detail page

Co-Authored-By: Claude Sonnet 5 <noreply@anthropic.com>"
```

---

## Post-plan operator step (not code)

Once merged and deployed: open the Uniforms Fashion client page (`/clients/d99edf8f-b185-47b2-9615-1f6e43853001`), click "Edit signature," fill in phone (and optionally name/title/address). Applies immediately to all 8 existing campaigns — no per-campaign edits needed.
