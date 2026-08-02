# CRM Integrations — Design

**Status:** Approved design
**Date:** 2026-08-02
**Scope:** Push qualified cases from our pipeline into a client's own CRM (HubSpot, Pipedrive), and keep the external record's stage and activity in step with the case as it progresses.

---

## 1. Purpose

Clients run their own sales motion in their own CRM. Today the pipeline our agent builds lives only in our `/crm` view, so a client has to watch two places and re-key anything they want to act on.

This feature makes our system a **producer** for the client's CRM: when a case reaches `ready` (grouped company, at least one verified contact), we create a Contact, a Company, and a Deal in the client's CRM, and from then on we push notes and won/lost outcomes as the case moves.

Direction is **one-way, outbound only**. We never read the client's CRM as a lead source and never let CRM-side edits write back into our tables.

---

## 2. Design Principles

- **Never block the pipeline.** A CRM outage must not stall discovery, research, writing, or sending. Every sync is enqueued through QStash and executed by a separate worker.
- **Idempotent by construction.** A QStash retry, a duplicate status transition, or a concurrent worker must never produce a second Deal.
- **Providers are swappable.** HubSpot and Pipedrive sit behind one `CrmProvider` interface, mirroring the existing `MailboxProvider` pattern.
- **Own only what we know.** We move a Deal's stage only for stages we can identify unambiguously (initial, closed-won, closed-lost). Everything else is recorded as a note — we do not guess at a client's intermediate stage semantics.
- **Credentials are encrypted at rest.** RLS grants client-role users SELECT on their own rows, so tokens are AES-256-GCM encrypted exactly as `mailboxes.oauth` is.

---

## 3. Data Model

Migration `supabase/migrations/0022_crm_integrations.sql`.

### 3.1 Enums

```sql
create type crm_provider          as enum ('hubspot', 'pipedrive');
create type crm_connection_status as enum ('connected', 'error');
create type crm_sync_status       as enum ('ok', 'error');
```

### 3.2 `crm_connections`

One connected CRM account per client.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `client_id` | uuid not null, FK `clients(id)` on delete cascade, **unique** | one CRM per client |
| `provider` | `crm_provider` not null | |
| `account_label` | text | provider-side account/portal name, shown in Settings so the client can confirm which account is linked |
| `oauth` | jsonb not null default `'{}'` | AES-256-GCM envelope, same shape as `mailboxes.oauth` |
| `pipeline_id` | text | client-selected target pipeline |
| `pipeline_label` | text | display copy for Settings |
| `initial_stage_id` | text | stage new Deals are created in |
| `won_stage_id` | text null | HubSpot only; null on Pipedrive (see §5.4) |
| `lost_stage_id` | text null | HubSpot only; null on Pipedrive |
| `status` | `crm_connection_status` not null default `'connected'` | |
| `status_reason` | text null | e.g. `token_revoked` — drives the reconnect banner |
| `created_at` / `updated_at` | timestamptz not null default now() | |

`pipeline_id` and `initial_stage_id` are nullable at insert: the row is created by the OAuth callback, then completed by the pipeline-selection step. A connection whose `pipeline_id` is null is **not yet usable** — the sync worker skips it and Settings shows "finish setup".

### 3.3 `case_crm_links`

What a case became on the other side.

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk | |
| `case_id` | uuid not null, FK `cases(id)` on delete cascade, **unique** | |
| `crm_connection_id` | uuid not null, FK `crm_connections(id)` on delete cascade | |
| `external_contact_ids` | text[] not null default `'{}'` | one per synced lead |
| `external_company_id` | text null | |
| `external_deal_id` | text null | |
| `external_deal_url` | text null | deep link rendered on the case page |
| `sync_started_at` | timestamptz null | concurrency claim (§5.6) |
| `last_synced_at` | timestamptz null | |
| `last_sync_status` | `crm_sync_status` null | |
| `last_sync_error` | text null | |
| `created_at` / `updated_at` | timestamptz not null default now() | |

Indexes: `idx_crm_connections_client on crm_connections(client_id)`, `idx_case_crm_links_connection on case_crm_links(crm_connection_id)`. The unique constraints on `crm_connections(client_id)` and `case_crm_links(case_id)` serve the hot-path lookups directly.

**Disconnect deletes the `crm_connections` row**, cascading its `case_crm_links`. This is deliberate: an external id is only meaningful relative to one connected account, so keeping links across a disconnect would let a reconnect to a *different* CRM write to ids that do not exist there. Because sync only ever fires on a status transition and there is no backfill (§8), a disconnect/reconnect of the same account does not re-create Deals for cases already past their transitions.

### 3.4 RLS

Both tables follow the existing per-`client_id` isolation pattern from `0002_rls_policies.sql`:

- **SELECT:** a client-role user sees rows where `client_id` matches their `app_users.client_id`; an operator sees all. `case_crm_links` derives `client_id` through its `case_id` join, consistent with how other case-scoped tables are policed.
- **INSERT/UPDATE/DELETE:** no policy — all writes go through `createAdminClient()` from server routes and Server Actions that have already checked the session and role.

`oauth` is readable under the SELECT policy, which is exactly why it is encrypted: a direct PostgREST read yields ciphertext, not a live refresh token.

---

## 4. Provider Abstraction

### 4.1 Interface — `src/lib/crm/provider.ts`

```ts
export interface CrmOAuthCredentials {
  kind: 'oauth'
  accessToken: string
  refreshToken: string
  expiresAt: string // ISO
}

export interface CrmPipelineStage {
  id: string
  label: string
  /** Providers that model closure as a stage flag it here; null when unknown. */
  closedOutcome: 'won' | 'lost' | null
}

export interface CrmPipeline {
  id: string
  label: string
  stages: CrmPipelineStage[]
}

export interface CrmContactInput {
  email: string
  firstName: string | null
  lastName: string | null
  title: string | null
  linkedinUrl: string | null
  companyName: string | null
}

export interface CrmCompanyInput {
  name: string
  domain: string | null
}

export interface CrmDealInput {
  title: string
  pipelineId: string
  stageId: string
  companyExternalId: string | null
  contactExternalIds: readonly string[]
}

/** Where a Deal should end up. A discriminated union, not a boolean — the two
 *  providers model closure differently and the caller should not care. */
export type CrmDealTarget =
  | { kind: 'stage'; stageId: string }
  | { kind: 'closed'; outcome: 'won' | 'lost' }

export interface CrmProvider {
  readonly provider: 'hubspot' | 'pipedrive'

  buildAuthUrl(state: string): string
  exchangeCode(code: string): Promise<{ tokens: CrmOAuthCredentials; accountLabel: string | null }>

  listPipelines(c: CrmOAuthCredentials): Promise<{ pipelines: CrmPipeline[]; tokens: CrmOAuthCredentials }>

  upsertCompany(c: CrmOAuthCredentials, input: CrmCompanyInput):
    Promise<{ externalId: string; tokens: CrmOAuthCredentials }>
  upsertContact(c: CrmOAuthCredentials, input: CrmContactInput):
    Promise<{ externalId: string; tokens: CrmOAuthCredentials }>
  createDeal(c: CrmOAuthCredentials, input: CrmDealInput):
    Promise<{ externalId: string; url: string; tokens: CrmOAuthCredentials }>
  moveDeal(c: CrmOAuthCredentials, dealId: string, target: CrmDealTarget):
    Promise<{ tokens: CrmOAuthCredentials }>
  addDealNote(c: CrmOAuthCredentials, dealId: string, note: string):
    Promise<{ tokens: CrmOAuthCredentials }>
}
```

Every method returns possibly-refreshed `tokens` alongside its result — the same contract as `MailboxProvider.sendEmail`. The caller persists them when `accessToken` changed, so a refresh is never silently dropped and an unchanged token costs no write.

`upsertCompany` / `upsertContact` lean on each provider's own dedupe (HubSpot upsert-by-email / by-domain; Pipedrive search-then-create by email / by name+domain) so a prospect already in the client's CRM is enriched rather than duplicated.

### 4.2 Implementations

- `src/lib/crm/hubspot-provider.ts` — HubSpot CRM v3 objects + associations API.
- `src/lib/crm/pipedrive-provider.ts` — Pipedrive Persons / Organizations / Deals / Notes API.
- `src/lib/crm/registry.ts` — `getCrmProvider(provider)` with an exhaustive `switch` and a `never` default, matching `mailbox/registry.ts`.

All HTTP goes through the existing `fetchJson` (`src/lib/http/fetch-json.ts`), which supplies the AbortController timeout and Zod-validates every response. No unbounded waits, no untrusted shapes.

### 4.3 Token storage — `src/lib/crm/tokens.ts`

`encryptCrmTokens` / `parseCrmTokens`, the same AES-256-GCM envelope (`{ v: 1, iv, tag, data }`) as `src/lib/mailbox/tokens.ts`, keyed off the existing `MAILBOX_ENCRYPTION_KEY`. No new secret. There is no legacy plaintext shape to accept — these tables are new, so `parseCrmTokens` validates the encrypted envelope only and throws `INVARIANT_VIOLATION` on anything else.

### 4.4 New environment variables

Added to `envSchema` in `src/lib/env.ts` as `nonEmpty`, validated at startup like every other secret:

```
HUBSPOT_OAUTH_CLIENT_ID
HUBSPOT_OAUTH_CLIENT_SECRET
PIPEDRIVE_OAUTH_CLIENT_ID
PIPEDRIVE_OAUTH_CLIENT_SECRET
```

---

## 5. Connect Flow and Sync

### 5.1 Who connects

The **client** authorizes their own CRM account. `GET /api/crm/[provider]/connect` requires `appUser.role === 'client'` and binds the connection to `appUser.client_id`. This is deliberately the inverse of the mailbox flow, which is operator-only: mailboxes are agency infrastructure, a CRM account is the client's own property.

Operators get read-only visibility of connection health (§7) so the agency can see whether a client is set up, but cannot initiate or revoke the OAuth grant.

### 5.2 Routes

| Route | Auth | Behavior |
|---|---|---|
| `GET /api/crm/[provider]/connect` | client role | Mints a single-use random state nonce into an httpOnly, `sameSite: 'lax'` cookie (secure when `APP_URL` is https), redirects to `buildAuthUrl(state)`. Identical pattern to `/api/mailboxes/google/connect`. |
| `GET /api/crm/[provider]/callback` | client role | Reads `code` + `state`, compares state to the cookie with `timingSafeEqualString`, exchanges the code, upserts `crm_connections` (encrypted tokens, `status = 'connected'`), clears the cookie, redirects to `/settings/crm?connect=<provider>`. On failure redirects to `/settings/crm?error=<AppError code>`. |
| `POST /api/crm/sync` | QStash signature | The worker (§5.5). |

`provider` is validated against a `z.enum(['hubspot','pipedrive'])` at the top of both handlers; anything else 404s.

Pipeline selection and disconnect are **Server Actions** on `/settings/crm`, not routes — they are form submissions from an authenticated page, which is what the codebase uses Server Actions for. Each validates the session, asserts `role === 'client'`, asserts the target connection's `client_id` matches, then writes through `createAdminClient()`.

### 5.3 Pipeline selection

Immediately after the callback, `/settings/crm` calls `listPipelines` and presents the client's pipelines and stages. On submit we persist `pipeline_id`, `pipeline_label`, `initial_stage_id`, and — where the provider reports them — `won_stage_id` / `lost_stage_id` from the stages whose `closedOutcome` is `'won'` / `'lost'`.

Defaults offered in the form: the first pipeline, its first stage as initial. The client can change both.

### 5.4 How the two providers close a Deal

HubSpot models closure as pipeline stages, so `moveDeal(..., { kind: 'closed', outcome })` resolves to `won_stage_id` / `lost_stage_id`. Pipedrive models it as a Deal `status` field independent of stage, so the same call sets `status: 'won' | 'lost'` and leaves the stage alone — which is why `won_stage_id` / `lost_stage_id` stay null for Pipedrive connections. The `CrmDealTarget` union exists precisely so `sync.ts` never has to know this.

If a HubSpot pipeline reports no closed-won/closed-lost stage, `moveDeal` on a `closed` target records a note ("Case marked won" / "Case marked lost") instead of moving the stage, and returns normally. Losing a stage move is not worth failing a sync over.

### 5.5 Trigger points and the worker

`src/lib/crm/sync.ts` exports:

```ts
export type CrmSyncReason =
  | 'qualified'        // case -> ready
  | 'contacted'        // case -> contacted
  | 'in_conversation'  // case -> in_conversation
  | 'hot_handoff'      // case -> hot_handoff
  | 'won'              // case -> won
  | 'lost'             // case -> lost
  | 'dead'             // case -> dead

export async function enqueueCrmSync(caseId: string, reason: CrmSyncReason): Promise<void>
```

`enqueueCrmSync` looks up the case's client connection; if there is none, or `pipeline_id` is null, or `status = 'error'`, it returns without publishing — so clients who never connect a CRM pay one indexed read. Otherwise it publishes `{ caseId, reason }` to `/api/crm/sync`. The whole body is wrapped best-effort (the `logEventSafe` pattern): a QStash failure is logged, never rethrown, so it cannot fail a case transition that already succeeded.

Call sites — one line appended after each existing `updateCaseStatus`:

| File | Transition | Reason |
|---|---|---|
| `src/lib/pipeline/research.ts:111` | `→ ready` | `qualified` |
| `src/lib/pipeline/write.ts:175` | `→ contacted` | `contacted` |
| `src/lib/pipeline/reply.ts:273` | `→ in_conversation` | `in_conversation` |
| `src/lib/pipeline/reply.ts:286` | `→ hot_handoff` | `hot_handoff` |
| `src/lib/pipeline/reply.ts:297` | `→ lost` | `lost` |
| `src/lib/pipeline/followup.ts:285` | `→ dead` | `dead` |

**`won` has no call site today.** Nothing in the codebase currently sets `case_status = 'won'` — the enum value exists but is unreachable. The `'won'` reason and its `{ kind: 'closed', outcome: 'won' }` mapping are implemented and tested, so that whenever a "mark won" action is added it needs no CRM work. This is a known dormant path, not an oversight.

**Worker behavior** (`POST /api/crm/sync`), in order:

1. `verifyQstashSignature`, parse `{ caseId: uuid, reason: enum }` with Zod.
2. Load case → connection. Missing case → 404. No connection / incomplete setup / `status = 'error'` → `200 { ok: true, skipped }`.
3. Claim the sync (§5.6). Not claimed → `500` so QStash retries; the event is not lost.
4. Ensure a `case_crm_links` row exists for the case.
5. **Create-or-update, regardless of reason.** If `external_deal_id` is null, run the create path: `upsertCompany` → `upsertContact` per active/verified lead → `createDeal` at `initial_stage_id` → note carrying the dossier summary and a link back to our case page. Each external id is persisted to the link row **as soon as it is obtained**, so a retry after a partial failure resumes rather than restarting and cannot orphan a created object.
6. Apply the reason (§5.7).
7. Persist refreshed tokens if `accessToken` changed; set `last_synced_at`, `last_sync_status = 'ok'`, clear `last_sync_error`, release the claim; `logEventSafe('crm.synced')`.

Step 5 running on *any* reason is what lets a client who connects their CRM mid-campaign pick up existing cases: the next transition on such a case finds no link row and creates the Deal then. There is still no historical backfill (§8).

### 5.6 Concurrency

Two transitions on the same case close together would otherwise produce two workers and two Deals. `claimCrmSync(caseId)` performs a conditional update on the link row — set `sync_started_at = now()` where `sync_started_at is null or sync_started_at < now() - interval '5 minutes'` — and returns whether a row was affected, the same atomic-claim shape as `claimCollisionNotice` in `src/lib/db/cases.ts`. A loser returns 500 and QStash retries it after the winner has released. The five-minute staleness cutoff means a crashed worker cannot deadlock a case permanently.

### 5.7 Reason → action

Creation itself happens in worker step 5. This table describes what is applied to the Deal *after* it exists, so a mid-campaign connect that creates and immediately closes a Deal is expressed by the same code path.

| Reason | Deal action | Note added |
|---|---|---|
| `qualified` | none beyond creation at `initial_stage_id` | dossier summary + case link |
| `contacted` | none | "First outreach sent" |
| `in_conversation` | none | "Prospect replied — conversation in progress" |
| `hot_handoff` | none | "Hot handoff — ready for your team" + reason |
| `won` | `{ kind: 'closed', outcome: 'won' }` | "Marked won" |
| `lost` | `{ kind: 'closed', outcome: 'lost' }` | "Marked lost" + reason |
| `dead` | `{ kind: 'closed', outcome: 'lost' }` | "No reply after the full follow-up sequence" |

Intermediate reasons add a note but do not move the stage. We know a client's initial, won, and lost stages because they told us or the provider flagged them; we do not know what their middle stages mean, and guessing would corrupt their forecast.

### 5.8 Field mapping

| Ours | HubSpot | Pipedrive |
|---|---|---|
| `leads.email` | Contact `email` | Person `email` |
| `leads.full_name` | `firstname` / `lastname` (split on first space) | Person `name` |
| `leads.title` | `jobtitle` | creation note line |
| `leads.linkedin_url` | `linkedin_bio` | creation note line |
| `cases.company_name` | Company `name` | Organization `name` |
| `cases.company_domain` | Company `domain` | creation note line |
| `cases.company_name` + campaign name | Deal `dealname` | Deal `title` |
| dossier summary + case URL | note on the Deal | note on the Deal |

Pipedrive has no standard field for job title, LinkedIn URL, or organization domain, and custom fields must be created by the account owner before they can be written. We do not create custom fields in a client's CRM — those three values go into the creation note instead, which is always available.

Mapping lives in `src/lib/crm/mapping.ts` as pure functions (`toContactInput`, `toCompanyInput`, `toDealInput`, `toNote`) — trivially unit-testable, no I/O.

Only leads that are **active and email-verified** are synced. Unverified or stopped leads are not the client's problem and would pollute their CRM.

---

## 6. Error Handling

`fetchJson` throws `AppError('EXTERNAL_ERROR')` with the HTTP status in `error.context.status` for any non-2xx (and `EXTERNAL_TIMEOUT` on abort). The worker branches on that status:

| Condition | Handling |
|---|---|
| **401 / 403** — token revoked, app uninstalled | Set `crm_connections.status = 'error'`, `status_reason = 'token_revoked'`. Return `200` — retrying cannot help. `logError('crm.connection_error')`. Settings shows a reconnect banner; `enqueueCrmSync` then short-circuits for this client until they reconnect. |
| **429** — rate limited | Return `500` so QStash retries with its configured backoff. We do not hand-roll a sleep inside a serverless handler. |
| **5xx / `EXTERNAL_TIMEOUT`** | Return `500`; QStash retries. |
| **Other 4xx** — validation, bad field, missing required property | Record `last_sync_status = 'error'` + `last_sync_error` (the AppError message, truncated) on the link row, release the claim, return `200`. Retrying an invalid payload just burns quota; the operator can read the exact failure. |
| **`DB_ERROR` / `INVARIANT_VIOLATION`** | Programming errors — rethrow, return `500`, logged via the existing `logError` path. |

Every provider SDK-level failure is mapped to `AppError` at the provider module boundary; no raw error escapes `src/lib/crm/`.

Audit events written through the existing `logEvent` / `logEventSafe` helpers: `crm.connected`, `crm.disconnected`, `crm.connection_error`, `crm.synced`, `crm.sync_failed`.

---

## 7. UI

### 7.1 `/settings/crm`

New route under `src/app/(app)/settings/crm/` with `page.tsx`, `loading.tsx`, `error.tsx`, following the existing `/settings` composition (`PageHeader`, `Section`, `EmptyState`).

Four states, all handled:

- **Empty** — no connection. `EmptyState` plus Connect buttons for HubSpot and Pipedrive.
- **Setup incomplete** — connected but `pipeline_id` is null. Pipeline/stage picker, submitted through a Server Action wrapped in `useTransition` for pending state.
- **Connected** — account label, target pipeline, last sync time and outcome, Disconnect (with a confirmation dialog naming the blast radius: sync stops, existing CRM records are left untouched).
- **Error** — `status = 'error'`. A reconnect banner explaining that syncing is paused, plus the Connect button.

Client-role users see the interactive version. Operators see the same page read-only — connection presence, provider, target pipeline, status, last sync — with no connect/disconnect controls.

### 7.2 Case detail

`src/app/(app)/cases/[id]/page.tsx` gains one line: when a link row exists with an `external_deal_url`, a "Synced to HubSpot ↗" / "Synced to Pipedrive ↗" link; when `last_sync_status = 'error'`, the truncated `last_sync_error` instead. Nothing when there is no connection.

### 7.3 Data access

New DB modules, one function per operation, per `QUALITY.md`:

- `src/lib/db/crm-connections.ts` — `getCrmConnectionForClient`, `insertCrmConnection`, `updateCrmConnectionPipeline`, `updateCrmConnectionTokens`, `markCrmConnectionError`, `deleteCrmConnection`.
- `src/lib/db/case-crm-links.ts` — `getCaseCrmLink`, `ensureCaseCrmLink`, `claimCrmSync`, `updateCaseCrmLinkIds`, `markCrmSyncResult`.

Page reads use the RLS-scoped `createServerClient`; every write uses `createAdminClient()` behind an explicit session + role + ownership check.

---

## 8. Out of Scope

Deliberately excluded from this iteration:

- Pulling contacts or companies **from** the CRM as a lead source.
- Two-way sync, and suppressing our outreach based on records already in the client's CRM.
- Backfilling cases that reached `ready` before the CRM was connected. Such cases join at their next status transition (§5.5); there is no historical import.
- A custom field-mapping UI. The §5.8 mapping is fixed.
- Salesforce and any third CRM. The `CrmProvider` interface is the extension point.
- Webhook subscriptions for CRM-side changes.
- Multiple CRM connections per client (`crm_connections.client_id` is unique).

---

## 9. Testing

Per the `QUALITY.md` coverage targets.

**Provider clients** (`hubspot-provider.test.ts`, `pipedrive-provider.test.ts`) — mocked `fetch`, per method: success, 401, 429, 5xx, and a malformed response body that must fail Zod validation. Plus `buildAuthUrl` shape and `exchangeCode` token parsing.

**Mapping** (`mapping.test.ts`) — 100% of the pure functions: name splitting including single-word and empty names, null domain, null title, note composition.

**Tokens** (`tokens.test.ts`) — encrypt/parse round-trip; tampered ciphertext and tampered auth tag both throw `INVARIANT_VIOLATION`; a plaintext payload is rejected.

**Sync** (`sync.test.ts`) —
- no connection / incomplete setup / errored connection → no publish;
- first sync creates company, contacts, and deal, and persists each id as obtained;
- a link row with an existing `external_deal_id` updates and never calls `createDeal`;
- partial-failure resume: a link row with a company id but no deal id skips `upsertCompany`;
- each `CrmSyncReason` maps to the right `CrmDealTarget` and note;
- only active + verified leads are synced;
- 401 marks the connection errored and returns without retry; 429 and 5xx surface as retryable.

**Concurrency** (`case-crm-links.test.ts`) — `claimCrmSync` returns true for a null `sync_started_at`, false for a fresh one, true past the staleness cutoff.

**Routes** — connect: wrong role → 403, cookie is set, redirect target correct. Callback: missing code, state mismatch, provider failure → error redirect; success → row inserted. Sync: missing signature → 401, malformed body → 400, unknown case → 404, success → 200.

**DB modules** — `{ data, error }` both handled and mapped to `AppError` for every function.

**Server Actions** — pipeline selection and disconnect: unauthenticated, wrong role, and cross-client connection id are all rejected before any write.

**RLS** — an integration test asserting a client-role session cannot read another client's `crm_connections` row, alongside the existing RLS suite.

---

## 10. Implementation Order

1. Migration `0022_crm_integrations.sql` + regenerate `src/types/database.ts`.
2. `src/lib/crm/tokens.ts` + env vars.
3. `src/lib/crm/provider.ts`, `mapping.ts`, `registry.ts`.
4. `src/lib/db/crm-connections.ts`, `src/lib/db/case-crm-links.ts`.
5. `hubspot-provider.ts`.
6. `pipedrive-provider.ts`.
7. `src/lib/crm/sync.ts` + `POST /api/crm/sync`.
8. Connect/callback routes.
9. `/settings/crm` page and Server Actions.
10. Case-detail sync indicator.
11. Wire the six `enqueueCrmSync` call sites.

Steps 5 and 6 are independent of each other; everything else is sequential. The call sites land last on purpose — nothing fires until the worker and both providers are proven.
