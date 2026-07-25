# Code review fixes — 2026-07-22

Addresses the first 7 findings from the deep code review (severity-ranked). Per
instructions, no `.sql` file was modified — two of the seven can only be fully
closed with a migration, so those are implemented as the best available
app-layer mitigation plus the exact SQL to run separately (see "Not fixed"
below).

All 649 existing + new unit tests pass (`pnpm vitest run`). `tsc --noEmit` and
`eslint` are clean.

---

## 1. Cross-tenant RPC exposure via un-REVOKEd SQL functions — **NOT FIXED (SQL-only)**

`claim_mailbox_send`, `reset_mailbox_daily_counters` (`0005_p2_pipeline.sql`)
and `find_stuck_cases` (`0006_stuck_case_sweep.sql`) are `SECURITY DEFINER`
with no `REVOKE EXECUTE FROM PUBLIC`. Postgres grants `EXECUTE` to `PUBLIC` by
default and Supabase auto-exposes every `public`-schema function as a
PostgREST RPC, so any authenticated tenant can currently call these directly
and read other tenants' cases, or manipulate another tenant's mailbox send
quota.

This has no code-only fix — it requires a migration. Run this against every
environment (dev, staging, prod) as soon as possible:

```sql
revoke execute on function claim_mailbox_send(uuid) from public, anon, authenticated;
revoke execute on function reset_mailbox_daily_counters() from public, anon, authenticated;
revoke execute on function find_stuck_cases() from public, anon, authenticated;
```

Recommend adding this as `supabase/migrations/0012_revoke_public_execute.sql`
(function argument types above are best guesses from the call sites in
`src/lib/db/mailboxes.ts`/`src/lib/db/cases.ts` — confirm exact signatures
with `\df claim_mailbox_send` etc. before running).

## 2. Plaintext OAuth tokens + RLS exposure — **partially fixed (encryption at rest)**

The RLS policy still grants client-role SELECT on the full `mailboxes` row
(that part needs a migration — same "not fixed" caveat as #1). What's fixed
here is the actual secret: Gmail/Outlook OAuth tokens are now encrypted
(AES-256-GCM) before they're ever written to the `oauth` jsonb column, so
even a row leaked via RLS/PostgREST or a DB dump no longer hands out a usable
refresh token — only the app, holding `MAILBOX_ENCRYPTION_KEY`, can decrypt.

- `src/lib/mailbox/tokens.ts` — added `encryptMailboxTokens` /
  `decryptMailboxTokens`. `parseMailboxTokens` now accepts both the new
  encrypted envelope (`{ v, iv, tag, data }`) and legacy plaintext tokens, so
  already-connected mailboxes keep working; every refresh/reconnect
  re-persists them encrypted, so plaintext rows self-heal over time with no
  backfill script needed.
- `src/lib/env.ts` — new required `MAILBOX_ENCRYPTION_KEY` (64-char hex / 32
  bytes). **Action needed:** generate one per environment with
  `openssl rand -hex 32` and set it before deploying — the app will fail to
  boot without it (fail-fast, per the existing env-validation pattern).
- `.env.example` — documents the new var.
- Write sites now encrypt before persisting: `src/app/api/mailboxes/google/callback/route.ts`,
  `src/app/api/mailboxes/outlook/callback/route.ts` (initial connect),
  `src/lib/mailbox/sender.ts`, `src/lib/mailbox/reader.ts` (token refresh),
  `src/app/api/mailboxes/[id]/test-email/route.ts` (also switched off its own
  ad-hoc plaintext-only zod schema onto the shared `parseMailboxTokens`).
- New tests: `src/lib/mailbox/tokens.test.ts` (encrypt/decrypt round-trip,
  tamper detection, legacy-plaintext backward compatibility).
- `vitest.config.ts`, `src/lib/env.test.ts` — stub/test the new env var.

**Still needed** (SQL, not applied): tighten `mailboxes_select` so client-role
users can't read the `oauth` column at all — e.g. move tokens to a
service-role-only table, or a Postgres view that excludes `oauth` and point
RLS at the view instead of the base table.

## 3. Open redirect in the auth callback — **fixed**

`src/app/auth/callback/route.ts` — added `sanitizeNextPath()`: rejects any
`next` value that isn't a same-origin relative path (no leading `//`, no
`://`), falling back to `/set-password`. Previously `new URL(next, url)`
would happily resolve `next=https://evil.com` to an off-origin redirect.

Tests added to the existing `route.test.ts`: absolute URL, protocol-relative
URL, and no-leading-slash all fall back to the default path.

## 4. Failed sends permanently stuck, invisible to stuck-sweep — **fixed (retry path); SQL half not touched**

`src/lib/db/emails.ts` — `claimOutboundEmail` previously used
`upsert(..., { ignoreDuplicates: true })` unconditionally, so a row left at
`status: 'failed'` (a transient send error) permanently occupied the
`(lead_id, sequence_step, direction)` unique slot — no retry could ever claim
it again. It now falls through to a new `reclaimFailedOutboundEmail()` when
the slot is taken: an atomic `UPDATE ... WHERE status = 'failed'` that only
succeeds if the existing row is genuinely retryable, letting `write.ts` /
`followup.ts` resend without any change to their own code.

Tests added to `emails.test.ts` covering: reclaim succeeds when the existing
row is `failed`, no-op when it's any other status, and the reclaim's own
`DB_ERROR` path.

**Not fixed:** `find_stuck_cases` (SQL) still only checks *existence* of the
step-0 outbound row, not its status, so a lead sitting at `failed` still
won't be picked up by the stuck-sweep safety net on its own — it now *can*
be retried (e.g. by a manual re-run of `/api/pipeline/write` for that case),
but nothing automatically triggers that retry yet. Fixing that fully means
teaching `find_stuck_cases` to treat `status = 'failed'` the same as "no row
at all" — a SQL change, out of scope here.

## 5. No 429 backoff on Apollo; a rate limit loses the whole discovery run — **fixed**

- New `src/lib/http/with-retry.ts` — generic exponential-backoff-with-jitter
  retry for any `fetchJson`-backed call, keyed off `AppError.context.status`
  (429 or 5xx only; validation/timeout/4xx-other errors are never retried).
  Tested in `with-retry.test.ts`.
- `src/lib/pipeline/discover.ts` — `searchPeople` and `bulkMatchPeople` calls
  are now wrapped in `withRetry(...)`.
- Also fixed the data-loss half of this finding: `runDiscoveryForCampaign`
  now calls `insertLeads` once after pass 1 and again after pass 2, instead
  of batching both into a single insert at the very end. If pass 2 (or its
  Apollo/Emailable calls) still fails after retries are exhausted, pass-1
  leads are already durable — a retried run picks them up via
  `getKnownSourceIds` instead of losing and re-discovering them.
- New test in `discover.test.ts`: pass-1 leads are persisted even when pass 2
  throws.

## 6. OAuth `state` param is the static user id, not a nonce — **fixed**

`src/app/api/mailboxes/google/{connect,callback}/route.ts` and the Outlook
equivalents: `/connect` now mints a random `crypto.randomUUID()` state,
stores it in a short-lived (10 min) httpOnly, `sameSite=lax` cookie scoped to
that provider's routes, and `/callback` validates the `state` query param
against the cookie (not against `appUser.id`) before exchanging the code —
matching OAuth2 Security BCP's single-use-nonce requirement. Both routes
clear the cookie on every exit path (success, oauth error, exchange failure).

New shared constants: `src/app/api/mailboxes/google/state-cookie.ts`,
`src/app/api/mailboxes/outlook/state-cookie.ts`.

No dedicated route tests existed for these handlers before or after this
change (none of the four route files had a `.test.ts`); behavior was verified
via `tsc`/manual trace of both the happy path and the state-mismatch path.

## 7. Outlook delta-link expiry (410) unhandled, polling stalls — **fixed**

`src/lib/mailbox/outlook-provider.ts` — `fetchInbound` now catches a 410
(`resyncRequired`) from Microsoft Graph and re-baselines to a fresh delta
link, mirroring the existing Gmail 404/`startHistoryId`-expired handling.
Extracted the pagination walk into a standalone `walkDelta()` so the
re-baseline call reuses the exact same logic instead of duplicating it.

Tests added to `outlook-provider.test.ts`: re-baseline on 410, rethrow on any
other status. (Also fixed a latent gap in the test file while adding these:
the `describe('outlookProvider.fetchInbound', ...)` block had no
`mockFetchJson.mockReset()` of its own — it was silently relying on a
sibling `describe` block's `beforeEach`, which never actually ran for its
tests. Harmless while no test asserted call counts; would have made the new
410 tests flaky/order-dependent.)

---

## Files touched

```
.env.example
vitest.config.ts
src/lib/env.ts
src/lib/env.test.ts
src/lib/mailbox/tokens.ts
src/lib/mailbox/tokens.test.ts        (new)
src/lib/mailbox/sender.ts
src/lib/mailbox/reader.ts
src/lib/mailbox/reader.test.ts
src/lib/mailbox/outlook-provider.ts
src/lib/mailbox/outlook-provider.test.ts
src/app/auth/callback/route.ts
src/app/auth/callback/route.test.ts
src/app/api/mailboxes/google/connect/route.ts
src/app/api/mailboxes/google/callback/route.ts
src/app/api/mailboxes/google/state-cookie.ts     (new)
src/app/api/mailboxes/outlook/connect/route.ts
src/app/api/mailboxes/outlook/callback/route.ts
src/app/api/mailboxes/outlook/state-cookie.ts    (new)
src/app/api/mailboxes/[id]/test-email/route.ts
src/lib/db/emails.ts
src/lib/db/emails.test.ts
src/lib/http/with-retry.ts            (new)
src/lib/http/with-retry.test.ts       (new)
src/lib/pipeline/discover.ts
src/lib/pipeline/discover.test.ts
```

## Before deploying

1. Generate `MAILBOX_ENCRYPTION_KEY` per environment: `openssl rand -hex 32`.
2. Run the `REVOKE EXECUTE` statements in section 1 against every environment
   (or land them as a proper migration).
3. Decide on the RLS/column-exposure fix for `mailboxes.oauth` noted in
   section 2 — encryption limits the blast radius but the row is still
   readable by client-role users today.
