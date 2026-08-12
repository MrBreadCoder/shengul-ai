# Uniforms Fashion Per-Client Mailreach API Key — Design

**Goal:** Uniforms Fashion (the client) wants to use their own Mailreach account/API key instead of the shared platform-level one. Every other client keeps using the existing global `MAILREACH_API_KEY`.

**Context:** Today `src/lib/mailreach/client.ts` reads a single `env.MAILREACH_API_KEY` for every vendor call (SMTP connect, OAuth connect, disconnect, stats). There is no per-client credential concept anywhere in the Mailreach integration.

## Approach

Env-var-based override, not a database column. The operator explicitly chose this over a DB-backed encrypted field + UI — the key is set directly in deployment env vars, same trust tier as the existing `MAILREACH_API_KEY`.

- `src/lib/env.ts`: add `MAILREACH_API_KEY_UNIFORMS_FASHION: z.string().min(1).optional()`. Optional because only production needs it set; local/CI stay unaffected.
- `src/lib/mailreach/client-api-keys.ts` (new): `resolveMailreachApiKey(clientId: string): string`. Hardcodes the Uniforms Fashion client UUID (`d99edf8f-b185-47b2-9615-1f6e43853001`) as a constant. Returns `env.MAILREACH_API_KEY_UNIFORMS_FASHION` when `clientId` matches AND that env var is set; falls back to `env.MAILREACH_API_KEY` in every other case (including: different client, or Uniforms Fashion but the override var isn't configured yet). Deliberately a simple if/else for exactly one override — a comment notes that a second per-client override should prompt moving this to a real per-client DB column instead of stacking more env vars / branches.
- `src/lib/mailreach/client.ts`: every function that currently reads `env.MAILREACH_API_KEY` (`authHeaders`, `connectSmtpAccount`, `completeOAuthConnect`, `disconnectAccount`, `getAccountStats`) instead takes an explicit `apiKey: string` parameter and uses that. `buildOAuthAuthorizeUrl` is unchanged — it doesn't send an API key today; the browser navigates straight to Mailreach's OAuth consent screen, and the key is only used later at the callback exchange (`completeOAuthConnect`).
- `src/lib/mailreach/enrollment.ts`: internals resolve the key via `resolveMailreachApiKey(mailbox.client_id)` (or the already-in-scope `clientId` for the two bulk functions) and pass it into the updated `client.ts` calls. Exported function signatures are unchanged, so every caller (connect/disconnect/callback routes, `mailreach-actions.ts`) needs no changes.
- `src/lib/pipeline/mailreach-sync.ts`: the reputation-stats cron sweep currently calls `getAccountStats(mailbox.mailreach_account_id)` directly (bypassing enrollment.ts). Update this call site to resolve the key from `mailbox.client_id` before calling `getAccountStats`, so Uniforms Fashion's connected mailboxes get their stats pulled against their own Mailreach account.

## Out of scope

- No DB migration, no new `clients` column, no operator UI, no encryption. The key never touches the database.
- No generalized "any client can have a key" mechanism — this hardcodes one client. A second client needing its own key should trigger a redesign (real per-client storage), not a second copy-pasted branch.

## Testing

- `src/lib/mailreach/client-api-keys.test.ts` (new): returns the override for the Uniforms Fashion client ID when the env var is set; falls back to the global key for any other client ID, and for Uniforms Fashion when the override env var is unset.
- `src/lib/mailreach/client.test.ts`: update every call site to pass an explicit `apiKey` and assert it lands in the `X-Api-Key` header (covers both the existing global-key path and a distinct client-key value).
- `src/lib/mailreach/enrollment.test.ts`: assert `resolveMailreachApiKey` is invoked with the mailbox's/client's id and its result is threaded into the mocked `client.ts` calls.
- `src/lib/pipeline/mailreach-sync.test.ts`: assert `getAccountStats` is called with the resolved per-mailbox key, not a hardcoded one.

## Rollout

1. Ship this code (no env var set yet) — behavior is 100% unchanged, everyone still resolves to the global key.
2. Operator adds `MAILREACH_API_KEY_UNIFORMS_FASHION` to the deployment env (and `.env.local` for local testing) once the friend provides their Mailreach API key.
3. No redeploy-triggering code change needed for step 2 — it's a pure env var addition.
