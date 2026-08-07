# Client Contact Signature — Design

**Date:** 2026-08-07
**Trigger:** Uniforms Fashion (client) asked that their phone number be included in the first outbound email. Address was added to the same request during design.

## Problem

`write.ts` (first-touch AI email) and `followup.ts` (nudge sequence) generate email copy from an LLM. Neither ever includes the client's phone number or physical address — there's no field for either anywhere in the schema. The client wants their phone number reliably present starting with email #1, and now also wants their address available the same way.

## Scope

- One new **per-client** contact/signature identity: company name (existing `clients.name`), an optional signer name, an optional signer title, phone, address, and reuse of the existing `clients.domain` as a website line.
- Applies to **first-touch and every follow-up** in the sequence (confirmed with the client — not first-touch only).
- Per-client, not per-campaign: a phone number/address is a property of the company, not of an individual campaign's targeting. Uniforms Fashion has 8 campaigns; the field must not need setting 8 times.
- Deterministic — appended to the AI-generated body in code, never left to the model's discretion. `bookingLink` already demonstrates the risk: the model is told it's "optional" and can (and does) omit it. A phone number the client explicitly asked for must not be subject to that same discretion.
- Out of scope: per-campaign override of the signature, multi-line address, editing the signature's wording/closing salutation, and `redesign.ts` (the `/inbox` AI-rewrite-this-draft action) — see Known Limitation below.

## Data model

New migration `supabase/migrations/0031_client_contact_signature.sql`, four nullable columns on `clients`:

```sql
alter table clients
  add column phone text,
  add column address text,
  add column signature_name text,
  add column signature_title text;
```

All nullable, all default to unset — existing clients (and the Uniforms Fashion campaigns already live) are unaffected until an operator fills them in.

`src/types/database.ts`: add `phone`, `address`, `signature_name`, `signature_title` (`string | null`) to the `clients` table's `Row`/`Insert`/`Update` shapes.

## Signature block — `src/lib/pipeline/signature.ts` (new)

```ts
export interface ClientSignatureContext {
  companyName: string
  signatureName: string | null
  signatureTitle: string | null
  phone: string | null
  address: string | null
  domain: string | null
}
```

`appendSignatureBlock(body: string, signature: ClientSignatureContext): string`

- Returns `body` unchanged if `signature.phone` is null. This is the sole gate: an address, name, or title set without a phone still produces no signature. (Confirmed with client — phone stays the trigger even after address was added.)
- Otherwise appends two blank-line-separated groups after a fixed English closing line (`"Best regards,"` — English regardless of `client.default_locale`, matching every other system-prompt instruction in `write.ts`/`followup.ts` that forces English output):
  - **Identity group:** `signatureName`, `signatureTitle`, `companyName` — each its own line, blank ones dropped. `companyName` always present (non-null column).
  - **Contact group:** `phone`, `address`, `domain` — each its own line, blank ones dropped (`domain` is `clients.domain`, already-existing, reused as-is — no new column).

Example, all fields set:
```
Best regards,

John Smith
Sales Director
Uniforms Fashion

+1 (505) 555-1234
123 Main St, Istanbul, Turkey
uniformsfashion.com
```

Pure function, no I/O — colocated `signature.test.ts` covers: no-phone no-op, phone-only (minimal block), every field present, each optional field individually absent.

## Validation

`src/lib/validation/phone.ts` (new), mirroring the existing `src/lib/validation/domain.ts` pattern:

```ts
export const phoneSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length === 0 || (PHONE_PATTERN.test(value) && digitCount(value) >= 7), {
    message: 'must be a valid phone number, e.g. +1 555 123 4567',
  })
  .transform((value) => (value.length === 0 ? null : value))
```

`PHONE_PATTERN = /^\+?[0-9()\-.\s]{7,25}$/` — lenient international format (digits, spaces, `()`, `-`, `.`, optional leading `+`), not a strict E.164 validator; this is a signature line, not a dialable-number check. Empty input clears the field to `null`, matching `domainSchema`'s "field sent empty vs field not sent" convention. Colocated `phone.test.ts` covers valid formats, garbage rejection, and empty-clears.

`signatureName`, `signatureTitle`, and `address` are plain optional text: trimmed, empty clears to `null`, capped at a sane max length (120 chars for name/title, 200 for address) via inline `z.string().max(...)` in the API route's schema — no dedicated file needed, they carry no format constraint beyond length.

## DB layer — `src/lib/db/clients.ts`

```ts
export interface ClientSignatureUpdate {
  phone: string | null
  address: string | null
  signatureName: string | null
  signatureTitle: string | null
}

export async function updateClientSignature(
  supabase: SupabaseClient<Database>,
  id: string,
  update: ClientSignatureUpdate,
): Promise<ClientRow>
```

Single combined update (mirrors `updateClientDomain`'s shape) since the UI edits all four fields from one dialog in one submit.

## API route — `src/app/api/clients/[clientId]/route.ts`

`patchSchema` gains four more optional fields: `phone: phoneSchema.optional()`, `address`, `signatureName`, `signatureTitle` (each a trimmed/length-capped optional string, empty-clears). The `.refine` requiring at least one field grows to include these. Handling block follows the existing `domain` block's shape exactly:

```ts
if (body.phone !== undefined || body.address !== undefined ||
    body.signatureName !== undefined || body.signatureTitle !== undefined) {
  updated = await updateClientSignature(admin, clientId, {
    phone: body.phone ?? client.phone,
    address: body.address ?? client.address,
    signatureName: body.signatureName ?? client.signature_name,
    signatureTitle: body.signatureTitle ?? client.signature_title,
  })
  await logEvent({ clientId, actor: `human:${appUser.id}`, type: 'client.signature_changed', payload: { ... } })
}
```

(`??` here is safe because `body.field ?? client.field` only matters when `body.field === undefined`, at which point we want the current DB value — not because `null` is being treated as "absent".)

## Wiring into the pipeline

**`write.ts`:** `runWriteForCase` currently fetches leads/knowledge but not the client row. Add one `getClientById(supabase, input.clientId)` call alongside those (client doesn't vary per lead — fetched once, not per-lead). Pass the resulting `ClientSignatureContext` into `processLead`, which calls `appendSignatureBlock(draft.body, ...)` immediately after `generateJson` returns and before `claimOutboundEmail` — so the signature lands in both sent emails and `human_approve`-mode drafts, consistent with how every other injected value (`valueProp`, `bookingLink`) already flows to both. No change to `RunWriteInput`'s public shape or to `/api/pipeline/write/route.ts` — the fetch is internal to `write.ts`.

**`followup.ts`:** `runFollowupStep` doesn't currently fetch the client row (only `scheduleFirstFollowup` does, for `followup_delays_days`). Add a `getClientById(supabase, sequence.client_id)` call in `runFollowupStep` and apply `appendSignatureBlock` to `nudgeBody` before `claimOutboundEmail`/`sendViaMailbox`, same insertion point pattern as `write.ts`.

Both files already import from `@/lib/db/clients` (directly or via `scheduleFirstFollowup`), and both test suites already mock that module — the addition needs new test cases for the phone-present path, not a rewrite of existing mocks.

## Known limitation (not solved by this change)

`redesign.ts` (the `/inbox` "regenerate this draft per instruction" AI action) passes the *current* draft body — including any appended signature — to the model as free text and asks it to "return the full revised subject and body." A signature already appended by `write.ts` could be reworded or dropped if an operator triggers a redesign on that draft. This is a pre-existing characteristic of how `redesign.ts` treats draft bodies (same risk exists for any other structured content appended to a body today) and is out of scope for this change, which targets automated sends and initial drafts, not manual AI-assisted rewrites.

## UI — client detail page

New `src/app/(app)/clients/[id]/edit-signature-dialog.tsx`, modeled directly on the existing `edit-domain-dialog.tsx`: four inputs (Name, Title, Phone, Address), one `PATCH /api/clients/${clientId}` submission carrying all four, same submitting/error/success state machine, same declarative-WebMCP `toolname` pattern. Rendered next to `EditDomainDialog` in `src/app/(app)/clients/[id]/page.tsx`'s header, passed the client's current `signature_name`/`signature_title`/`phone`/`address`.

New i18n keys under `clients.editSignatureDialog.*` in both `src/messages/en.json` and `src/messages/tr.json` (trigger, title, four field labels/hints, error/success toasts) — same key shape as the existing `editDomainDialog` block.

## Test plan

- `signature.test.ts` (new, 100% branch coverage): no-op without phone; minimal block (phone + company name only); full block; each optional field independently absent.
- `phone.test.ts` (new): valid formats (`+1 555 123 4567`, `(505) 555-1234`, etc.), garbage rejected (too few digits, letters), empty string clears to `null`.
- `write.test.ts`: extend the existing `getClientByIdMock` default fixture with `name`, `domain`; add a case asserting the sent/drafted body contains the signature when `phone` is set on the mocked client, and a case confirming no signature when it's `null` (today's default fixture already has no `phone`, so existing assertions on body content keep passing unchanged).
- `followup.test.ts`: same shape — extend the fixture, add phone-present/phone-absent cases for `runFollowupStep`.
- `src/app/api/clients/[clientId]/route.test.ts`: add cases for the new PATCH fields — validation rejection (bad phone), empty-clears-to-null, and the combined-update path.
- Manual/operator step (not code): once shipped, fill in phone (and optionally name/title/address) once on the Uniforms Fashion client page — applies to all 8 existing campaigns immediately, no per-campaign changes needed.
