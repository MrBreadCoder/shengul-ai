# Mailreach Warmup Integration — Design

**Date:** 2026-07-29
**Status:** Approved for planning

## Problem

Every mailbox in this system is warmed by an internal ramp (`src/lib/mailbox/warmup.ts`): the daily send cap climbs from 5 toward `daily_cap` over 2-4 weeks, but no actual warmup traffic (real emails exchanged with other real inboxes) happens — it's purely a throttle. Real inbox-reputation warmup requires exchanging mail with a network of other live mailboxes, which is what [Mailreach](https://www.mailreach.co) does as a service.

We want every mailbox, across every client, enrolled in continuous Mailreach warmup. Once a mailbox has been warming for 14 days, it becomes eligible to send campaign (cold outreach) email. Warmup keeps running indefinitely after that — Mailreach warmup is not a program with an end date, it's an ongoing reputation-maintenance service. An operator can enable/disable it per client and per mailbox.

## Relationship to the existing ramp system

Independent and orthogonal — this was a deliberate choice, not an oversight:

- **Mailreach gate** = a yes/no: is this mailbox allowed to send campaign mail *at all* yet (day ≥ 14 since Mailreach enrollment)?
- **`daily_cap` ramp** (existing `effectiveDailyCap`) = *how many* campaign emails it can send today, regardless of Mailreach state.

Both apply simultaneously once a mailbox clears day 14: it's now allowed to send, but still only up to whatever the existing 5→8→11… ramp allows that day. Mailboxes not enrolled in Mailreach at all are ungated (today's behavior, unchanged) — the internal ramp is still the only thing governing them.

## Data model

New migration `0021_mailreach_warmup.sql`:

```sql
create type mailreach_status as enum ('disconnected', 'pending', 'connected', 'error');

alter table clients add column mailreach_enabled boolean not null default false;

alter table mailboxes add column mailreach_enabled          boolean not null default false;
alter table mailboxes add column mailreach_started_at       timestamptz;
alter table mailboxes add column mailreach_account_id       text;
alter table mailboxes add column mailreach_status           mailreach_status not null default 'disconnected';
alter table mailboxes add column mailreach_reputation_score numeric;
alter table mailboxes add column mailreach_stats_synced_at  timestamptz;
```

- `clients.mailreach_enabled` — operator-facing master switch per client (the checkbox originally requested, on `/clients/[id]`). A kill switch: off means no mailbox under this client may be connected to Mailreach, regardless of the mailbox's own flag.
- `mailboxes.mailreach_enabled` — per-mailbox operator intent (the checkbox on `/settings`). Effective enrollment = `client.mailreach_enabled AND mailbox.mailreach_enabled`.
- `mailboxes.mailreach_started_at` — set exactly once, the first time the mailbox is ever enrolled. **Never cleared** by disconnect, including bulk-disconnect from the client master switch. This is what lets the 14-day gate resume from the original date instead of restarting after a pause.
- `mailboxes.mailreach_account_id` — Mailreach's external account id; null when not currently connected. Needed to call their disconnect/stats endpoints.
- `mailboxes.mailreach_status` — `disconnected` (never connected, or explicitly disconnected) / `pending` (OAuth redirect in flight) / `connected` / `error` (Mailreach reported a connection failure, e.g. revoked credentials — surfaced to the operator like `health_reason` already is).
- `mailboxes.mailreach_reputation_score` + `mailreach_stats_synced_at` — cached from the periodic stats sync, shown in the UI. Null until the first sync completes.

## Mailreach API client

`src/lib/mailreach/client.ts` — a thin, Zod-validated wrapper, one shared platform-level credential (`MAILREACH_API_KEY` added to `src/lib/env.ts`'s schema), base URL `https://api.mailreach.co/api/v1`, `X-Api-Key` header auth. Every call wrapped in a timeout and mapped to `AppError` at the boundary, per `QUALITY.md`.

- `connectSmtpAccount(credentials: SmtpCredentials): Promise<{ accountId: string }>`
- `getOAuthAuthorizeUrl(params: { provider: 'gmail' | 'outlook'; state: string }): string`
- `completeOAuthConnect(params: { provider: 'gmail' | 'outlook'; code: string }): Promise<{ accountId: string }>`
- `disconnectAccount(accountId: string): Promise<void>`
- `getAccountStats(accountId: string): Promise<{ reputationScore: number | null }>`

**Open item to resolve at implementation start:** Mailreach's exact request/response field names for `connect-account`, `account-stats`, and the OAuth authorize step were not fully confirmable from public docs during design (docs.mailreach.co renders a quickstart page but sub-pages 404'd on automated fetch). Before writing this client, pull the live schema using a real API key (their dashboard/docs are authenticated per-account) and validate every response with Zod regardless of what's confirmed up front.

## Connect / disconnect flows

**Enable, SMTP mailbox** — `POST /api/mailboxes/[id]/mailreach/connect` (operator-only), synchronous:
1. Load the mailbox, decrypt its stored `SmtpCredentials` (same credentials already used by `verifySmtpConnection`).
2. Call `connectSmtpAccount`.
3. Store `mailreach_account_id`, `mailreach_status = 'connected'`, `mailreach_enabled = true`; stamp `mailreach_started_at = now()` only if it is currently null.
4. `logEvent('mailbox.mailreach_connected', ...)`.

**Enable, Gmail/Outlook mailbox** — requires Mailreach's own OAuth consent (our stored OAuth tokens are scoped to our app registration and unusable by a third party):
1. `POST /api/mailboxes/[id]/mailreach/connect` sets `mailreach_status = 'pending'`, mints a nonce, stores `{ nonce, mailboxId }` in an httpOnly cookie (same shape as `GMAIL_OAUTH_STATE_COOKIE`), and returns a redirect to `getOAuthAuthorizeUrl(...)`.
2. New callback route `GET /api/mailboxes/mailreach/callback` validates the nonce (`timingSafeEqualString`, same pattern as `google/callback/route.ts`), calls `completeOAuthConnect`, and performs the same persistence as step 3 above using the `mailboxId` from the cookie.
3. On `/settings`, checking this box for a Gmail/Outlook mailbox is a real navigation (redirect), not a fire-and-forget POST — same UX shape as the existing "Connect Gmail" flow, not the existing async toggle pattern.

**Disable** — `POST /api/mailboxes/[id]/mailreach/disconnect` (operator-only): calls `disconnectAccount(mailreach_account_id)`, then clears `mailreach_account_id`, sets `mailreach_status = 'disconnected'`, `mailreach_enabled = false`. `mailreach_started_at` is left untouched.

**Client master switch** — `PATCH /api/clients/[clientId]` gains a `mailreachEnabled` field (same shape as the existing `warmupProfile` PATCH):
- **Off:** bulk-disconnects every currently-connected mailbox under the client. Best-effort — one mailbox's failure is logged and does not block the others. Each mailbox's own `mailreach_enabled` intent flag is left as-is, so the set of "should be enrolled" mailboxes is remembered.
- **On:** for every mailbox with `mailreach_enabled = true` and `provider = 'smtp'`, silently reconnects (we hold the credentials). For `gmail`/`outlook` mailboxes in that state, silent reconnect is impossible (OAuth needs interactive consent) — they surface a "needs reconnect" affordance on `/settings` (visibly `enabled = true` but `status = 'disconnected'`) until the operator clicks through consent again. This is a hard constraint of Mailreach's OAuth model, not a design choice.

## Campaign-send gate

New pure module `src/lib/mailbox/mailreach-gate.ts`, same style as `warmup.ts`:

```ts
export const MAILREACH_CAMPAIGN_GATE_DAYS = 14

export interface CampaignSendEligibilityInput {
  mailreachEnabled: boolean
  mailreachStartedAt: string | null
  now: Date
}

export function isEligibleForCampaignSend(input: CampaignSendEligibilityInput): boolean {
  if (!input.mailreachEnabled || input.mailreachStartedAt === null) return true // never enrolled -> ungated
  const startedAt = Date.parse(input.mailreachStartedAt)
  if (Number.isNaN(startedAt)) {
    throw new AppError('INVARIANT_VIOLATION', 'Mailbox mailreach_started_at is not a valid timestamp', {
      mailreachStartedAt: input.mailreachStartedAt,
    })
  }
  const elapsedDays = Math.floor((input.now.getTime() - startedAt) / MS_PER_DAY)
  return elapsedDays >= MAILREACH_CAMPAIGN_GATE_DAYS
}
```

Wired into `src/lib/mailbox/sender.ts`'s `rotationOrder`, which already filters `health !== 'blocked'`. It gains a `purpose: SendPurpose` parameter and an additional filter, applied only when `purpose === 'outreach'`: a mailbox failing `isEligibleForCampaignSend` is excluded from that call's candidate list. Replies (`purpose: 'reply'`) bypass the gate entirely — answering a prospect who already wrote in is not gated by warmup state, consistent with how replies already bypass most suppression rules.

If every candidate is gated out, the existing `RATE_LIMITED` / "no healthy mailbox" path in `sendViaMailbox` fires unchanged — no new error code. The `mailbox.none_healthy` warn log gains a `warmupGated` count in its payload for observability.

## UI

**`/clients/[id]`** (operator-only page, unchanged gating): a `MailreachToggle` checkbox in the header controls row, next to the existing `WarmupProfileSelect`, calling the client `PATCH` route.

**`/settings` mailbox rows** (`mailbox-row.tsx`, visible to both roles today):
- A read-only status fragment visible to **both** operator and client, alongside the existing `sentToday/capToday` text: `Mailreach: day 6/14 · warming` before the gate clears, `Mailreach: warm · reputation 94` after a score has synced, nothing if not enrolled.
- Operator-only (`mailbox-controls.tsx`): a checkbox next to the existing warmup-profile `<select>`. SMTP mailboxes toggle async (POST, `useTransition`, mirrors the existing pause/resume button). Gmail/Outlook mailboxes navigate on enable (redirect into the Mailreach OAuth flow) and POST async on disable.

## Stats sync

`src/lib/pipeline/mailreach-sync.ts` + `/api/pipeline/mailreach-sync` (QStash cron, same cadence as the existing 6-hourly mailbox-health sweep): iterates every mailbox with `mailreach_status = 'connected'`, calls `getAccountStats`, writes `mailreach_reputation_score` + `mailreach_stats_synced_at`. Per-mailbox failures are logged (`logEventSafe`) and skipped, not fatal to the sweep — same best-effort pattern used elsewhere in the pipeline. No webhook receiver in v1; polling only, consistent with how bounce-rate health is already computed.

## Testing

- `mailreach-gate.ts`: 100% unit coverage — not enrolled → eligible; day 0–13 → ineligible; day 14+ → eligible; invalid timestamp → throws `AppError`.
- `src/lib/mailreach/client.ts`: mocked at the boundary in every consumer test; never hits the real API in unit tests.
- Connect/disconnect routes: auth-rejection, validation-rejection, success, external-failure — same shape as `src/app/api/mailboxes/[id]/warmup/route.test.ts`.
- `sender.test.ts`: a gated mailbox is excluded from rotation for `purpose: 'outreach'` but still used for `purpose: 'reply'`.
- Client `PATCH` bulk enable/disable: partial-failure case (one mailbox's disconnect fails, others still succeed) is explicitly tested.

## Out of scope (this iteration)

- Webhook receiver for real-time Mailreach events (polling covers the stats requirement).
- Per-client Mailreach API keys (one shared platform account, per your answer).
- Spam-test / deliverability-test endpoints Mailreach also exposes — unrelated to warmup enrollment.
