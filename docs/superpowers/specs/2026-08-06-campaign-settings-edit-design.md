# Campaign settings: edit (operator) + read-only view (client)

**Date:** 2026-08-06
**Status:** Approved, ready for implementation plan

## Problem

`campaigns` currently only accepts settings (name, value prop, booking link, daily
target, all Apollo ICP filters) at creation time via `POST /api/campaigns` +
`new-campaign-form.tsx`. There is no way to change any of it afterward — only
status (`stop`/`resume`/`delete`) is editable post-creation, via
`campaign-row-actions.tsx`.

Separately, `/campaigns` currently `redirect('/crm')`s any non-operator, so
clients have **no visibility into their own campaigns at all** — not even
read-only.

## Scope

In scope:
- Operator-only editing of: name, value prop, booking link, daily target, and
  all ICP filters (`personTitles`, `organizationLocations`,
  `excludeOrganizationLocations`, `employeeRangeMin/Max`, `keywords`,
  `excludeKeywords`, `personSeniorities`, `contactEmailStatuses`).
- Client-facing read-only view of their own campaigns on `/campaigns` (instead
  of being redirected away).
- Editing allowed at any campaign status (active/paused/archived) — changing
  an active campaign's ICP just changes what tomorrow's discovery run targets.

Out of scope (explicitly deferred):
- `client_id` is immutable — not editable via this feature.
- `status` — already has dedicated stop/resume/delete actions; unchanged.
- `mailbox_ids` assignment UI — real gap (every real campaign is created with
  `mailbox_ids: []` and nothing in the app sets it), but a separate feature.
- Per-campaign `reply_mode` / `price_handoff_mode` override — currently
  inherited from the client at creation time only; unchanged.
- WebMCP tool for editing (`updateCampaign`) — the edit form stays human-only.
  `listCampaigns` (existing, read-only) stays mounted for both roles.

## Architecture

### Shared validation

`src/lib/apollo/campaign-settings-schema.ts` — new file exporting
`campaignSettingsSchema`, the field-validation portion of the existing
`createCampaignSchema` in `src/app/api/campaigns/route.ts` (name, valueProp,
bookingLink, dailyTarget, and the 8 ICP fields) **minus** `clientId`. Both
`POST /api/campaigns` (create) and the new `PATCH /api/campaigns/[campaignId]`
(edit) import this schema instead of each declaring their own copy of the same
10 fields.

### Edit (operator)

- `PATCH /api/campaigns/[campaignId]` — added to the existing
  `src/app/api/campaigns/[campaignId]/route.ts` alongside `DELETE`. Same
  `requireUser()` + `appUser.role !== 'operator' → 403 forbidden` guard.
  Validates the body with `campaignSettingsSchema`, builds the `icp` object
  via `apolloIcpSchema.parse(...)` (same as `POST`), calls
  `updateCampaignSettings`, logs `campaign.updated` (best-effort, matching
  `campaign.created`/`campaign.deleted`).
- `updateCampaignSettings(supabase, id, patch)` — new function in
  `src/lib/db/campaigns.ts`, same shape as the existing `updateCampaignStatus`:
  one `.update(...).eq('id', id).select('*').single()`, `AppError('DB_ERROR', ...)`
  on failure/missing row.
- `src/app/(app)/campaigns/[campaignId]/edit/page.tsx` — new Server Component
  route. `requireUser()`; redirect non-operators to `/crm` (edit stays
  operator-only, unaffected by the new client read-only view). Fetches the
  campaign via `getCampaignById` (admin client, same as the rest of
  `/campaigns`); `notFound()` if missing. Parses the row's `icp` Json column
  back through `apolloIcpSchema.parse(...)` to recover typed ICP fields (every
  row was written by this same schema, so this should never fail in
  practice). Renders `EditCampaignForm` prefilled with the row's current
  values plus the parsed ICP fields, with the client name shown read-only
  (not editable).
- `CampaignSettingsFields` — new presentational component, extracted from the
  value-prop/booking-link/daily-target/ICP-fieldset JSX currently inline in
  `new-campaign-form.tsx`. Takes `defaultValues` for every field. Reused by
  both `NewCampaignForm` (defaults empty/50/verified-only) and the new
  `EditCampaignForm` (defaults from the existing row).
- `EditCampaignForm` — new client component, same structural shape as
  `NewCampaignForm` (form state, submit handler, error/toast handling) but:
  no client selector, submits `PATCH` instead of `POST`, on success
  `router.push('/campaigns')` + `router.refresh()` + success toast.
- `CampaignRowActions` — gains an "Edit" `<Link>` to
  `/campaigns/[campaignId]/edit`, alongside the existing Stop/Resume/Delete
  buttons. Operator-only surface (this component is only ever rendered on the
  operator branch of `/campaigns`, see below).

### Client read-only view

- `src/app/(app)/campaigns/page.tsx` — no longer redirects non-operators.
  Branches on `appUser.role`:
  - **Operator:** unchanged current behavior — `createAdminClient()`, new
    campaign form section, full list with `CampaignRowActions` (now including
    Edit).
  - **Client:** uses the **session-scoped** `createServerClient()` (not the
    admin client) so Postgres RLS
    (`campaigns_select: is_operator() or client_id = current_client_id()`)
    does the filtering — same pattern as `reply_mode`/mailboxes on
    `/settings`. Calls the existing `listCampaignsForClient(supabase, null)`
    (no new DB helper — RLS narrows the result set for free). Renders the
    same visual cards, but omits the new-campaign section entirely and passes
    no `actions` to each card — a client cannot create, edit, stop, resume,
    or delete a campaign from this page.
- `CampaignCard` — new presentational component extracted from the `<li>...`
  block currently inline in `page.tsx`'s `.map()`. Props: `campaign: CampaignRow`,
  `now: Date`, `actions?: React.ReactNode`. Operator branch passes
  `<CampaignRowActions ... />` as `actions`; client branch passes nothing (the
  actions border/row is only rendered when `actions` is present, so the
  client's card doesn't show an empty bordered strip).
- `CampaignsWebMcpTools` (`listCampaigns` directory tool) stays mounted on
  both branches — it's read-only, and each branch's own RLS-scoped fetch
  already determines what it can see, so a client's agent legitimately only
  ever sees that client's campaigns.

## Data flow

**Edit:** operator opens `/campaigns/[id]/edit` → form prefilled from the
current row → submit → `PATCH` validates body → `updateCampaignSettings`
writes the row → best-effort `campaign.updated` event → redirect to
`/campaigns` → toast confirms. An in-flight campaign is unaffected
retroactively — changing `dailyTarget`/ICP only changes what the *next*
discovery run (`/api/pipeline/discover`) picks up; already-created
leads/cases are untouched.

**View:** client opens `/campaigns` → RLS-scoped `listCampaignsForClient`
returns only their own rows → read-only cards render. Even a hand-crafted
`PATCH`/`DELETE` request from a client session is still rejected server-side
by the existing `role !== 'operator'` check in both route handlers —
unchanged by this feature.

## Error handling

Matches existing route conventions throughout:
- Zod validation failure → `400 { error: 'validation_error', issues }`.
- Campaign not found → `404` (edit page: Next.js `notFound()`; PATCH route:
  `404 { error: 'not_found' }`, same as `DELETE` already does).
- Non-operator on the edit page → redirect to `/crm`; non-operator hitting
  `PATCH`/`DELETE` directly → `403 { error: 'forbidden' }`.
- DB failure → `AppError('DB_ERROR', ...)` → `500 { error: 'unknown' }` via
  the existing `isAppError` mapping, same as every other route in this file.
- Audit log write (`campaign.updated`) is wrapped in its own try/catch and
  never fails the request — matches `campaign.created`/`campaign.deleted`.

## Testing

- `src/lib/db/campaigns.test.ts`: add `updateCampaignSettings` — success
  (returns updated row) and DB-error mapping (throws `AppError`).
- `src/app/api/campaigns/[campaignId]/route.test.ts`: add `PATCH` cases —
  403 non-operator, 400 validation error, 404 not-found, 200 success (asserts
  the returned row and that `campaign.updated` was logged).
- No new component tests: this codebase has none for `new-campaign-form.tsx`
  either, and QUALITY.md scopes React component coverage to "critical paths
  only" — these are plain CRUD forms/read views, not one.
- Manual verification: `tsc --noEmit` and `eslint` clean, full existing suite
  still green (per this repo's standard completion bar).

## i18n

New keys needed under the existing `campaigns` namespace in both
`src/messages/en.json` and `src/messages/tr.json`:
- `rowActions.editTrigger` (the new Edit link/button label).
- An `editCampaignForm` group mirroring `newCampaignForm`'s keys (title,
  field labels/hints/tool-param-descriptions can reuse the same strings where
  identical — only the ones that differ, e.g. submit button label
  `"Save changes"` vs `"Create campaign"`, need new keys).
- Client-branch page copy: a description string for the read-only view
  (e.g. `clientPageDescription`), used instead of `pageDescription` when
  `appUser.role !== 'operator'`.
