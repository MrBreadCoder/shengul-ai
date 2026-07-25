# Runbook — Deliverability & Pipeline Operations

Covers the P4 controls: mailbox warmup, health, kill switches, bounces, and
recovering a stuck pipeline. Every threshold named here is defined in
`src/lib/mailbox/health.ts` or `src/lib/mailbox/warmup.ts` — change it there,
not in prose.

## Cron schedules

Each is registered once per environment with a `tsx scripts/schedule-*.ts` run.
QStash schedules do not expire, but they are per-project: **a new Vercel project
or a rotated `QSTASH_TOKEN` means re-running every one of these.**

| Schedule | Default cron | Script |
|---|---|---|
| Apollo discovery fan-out | daily | `scripts/schedule-discover-cron.ts` |
| Case research fan-out | `0 7 * * *` | `scripts/schedule-research-cron.ts` |
| Email write fan-out | `0 8 * * *` | `scripts/schedule-write-cron.ts` |
| Mailbox daily-counter reset | `0 0 * * *` | `scripts/schedule-mailbox-reset-cron.ts` |
| Inbound poll fan-out | `*/5 * * * *` | `scripts/schedule-inbound-poll-cron.ts` |
| Stuck-case sweep | `*/15 * * * *` | `scripts/schedule-stuck-sweep-cron.ts` |
| Mailbox health sweep | `0 */6 * * *` | `scripts/schedule-mailbox-health-cron.ts` |
| Log retention purge | daily | `scripts/schedule-log-retention-cron.ts` |

Verify what is actually registered in the Upstash console. A silent pipeline is
almost always a missing schedule, not broken code.

## Warmup

A newly connected mailbox starts at **5 sends/day** and gains **3/day**, capped
by its configured `daily_cap`. The profile decides the cadence:

| Profile | Cadence | Day 0 → 5 |
|---|---|---|
| `standard` | every day | 5, 8, 11, 14, 17, 20 |
| `slow` | every 2 days | 5, 5, 8, 8, 11, 11 |
| `none` | no ramp | the configured cap from day one |

The profile is chosen per client on `/clients/[id]` and inherited by mailboxes at
connect time. Override one mailbox on `/settings`. **Switching a mailbox to a
ramping profile restarts the ramp at day one** — do that after reconnecting a
mailbox or recovering a blocked one.

Today's allowance is shown on `/settings` as `sent/cap today`.

## Mailbox health

Health is re-evaluated every 6 hours from the **hard-bounce rate over the last 7
days**, ignoring any mailbox with fewer than 20 sends in that window.

| Rate | Result | Sends? |
|---|---|---|
| < 3% | `ok` | yes |
| ≥ 3% | `warning` | yes — a flag, not a stop |
| ≥ 5% | `blocked` | no |

`health_reason` records why: `bounce_rate_high`, `bounce_rate_elevated`,
`bounce_rate_normal`, `operator_paused`, `auth_failure`.

**A blocked mailbox never un-blocks itself.** That is deliberate — bad sends age
out of the window on their own, and an automatic un-block would resume sending
from a mailbox nobody has looked at.

### A mailbox went to `blocked`

1. Open `/settings` and read `health_reason`.
2. `auth_failure` → the OAuth grant was revoked. Reconnect the mailbox from
   `/settings` → *Connect a mailbox* using the same address. Then set its warmup
   profile back to `standard` so it re-ramps.
3. `bounce_rate_high` → find the bounces on `/analytics` (mailbox table) and in
   the client's Logs tab (`bounce.hard` events). If they cluster on one campaign's
   ICP, pause that campaign before resuming the mailbox. Emailable is a fail-open
   guard (see `architecture.md §12`) — a run of Emailable failures means leads
   were activated on Apollo's word alone and bounce risk is elevated.
4. When the cause is fixed, click **Resume** on `/settings`. Consider setting the
   profile to `slow` for a re-warm.

### Spam complaints

Not observable. Neither the Gmail API nor Microsoft Graph exposes a per-mailbox
complaint rate to a third-party app, and Google Postmaster Tools needs domain
ownership plus 5,000 messages/day to that domain — far above what this system
sends. Bounce rate and reply rate are the only automated signals we have. If a
client reports landing in spam, reduce `daily_cap`, re-warm, and check SPF/DKIM/
DMARC on the sending domain by hand.

## Kill switches, weakest to strongest

| Scope | Where | Effect |
|---|---|---|
| One person | `/cases/[id]` → Stop on a contact | Suppresses the address, stops the sequence, parks the lead. Available to client-role users. |
| One mailbox | `/settings` → Pause | `health = blocked`. Drops out of rotation on the next send. |
| One campaign | `/campaigns` → status `paused` | Discovery, research, write and follow-up all skip it. Follow-ups reschedule themselves a day out instead of dying. |
| One client | `/clients/[id]` → Pause | Pauses every campaign. Archive also bans the client's logins. |

## Bounces

Inbound polling classifies every message before it reaches the Reply Agent:

- **Hard (5.x.x)** → mark the outbound email `bounced`, suppress the address
  (`reason: 'bounced'`), stop the sequence, park the lead. Logged as `bounce.hard`.
- **Soft (4.x.x) or unparseable** → logged as `bounce.soft`, nothing changes. We
  never suppress on a guess.
- **Auto-reply / out-of-office** → logged as `inbound.auto_reply_ignored` and
  dropped. It is deliberately *not* stored as an inbound email: that would make
  `hasInboundReply()` true and end the follow-up sequence as if a human answered.

A `bounce.unmatched` event means a DSN arrived that we could not tie to a lead —
usually mail sent outside the pipeline from the same mailbox. Safe to ignore
unless it is frequent.

Suppression is enforced in one place: `sendViaMailbox`. An outreach send is
blocked by any suppression; a reply is blocked only by a `bounced` suppression.

## Rotating OAuth tokens

Access tokens refresh themselves on every send and poll. Only the **refresh
token** needs human action, and only when it is revoked (`auth_failure`):
reconnect the mailbox from `/settings`. Tokens are encrypted at rest
(`src/lib/mailbox/tokens.ts`); rotating `MAILBOX_TOKEN_KEY` invalidates every
stored token and requires reconnecting every mailbox.

## Recovering stuck sequences

- **Cases stuck in `researching` or `contacted`** — the stuck-sweep cron
  (`*/15`) resets them automatically. Force a run by POSTing to
  `/api/pipeline/stuck-sweep` with a valid QStash signature. Claims and unique
  slots make it safe to re-run; it cannot double-send.
- **A follow-up that never fired** — `sequences.qstash_message_id` is the
  delivery to look up in Upstash. A sequence for a paused campaign reschedules
  itself one day out, so it will look "late" but is not lost.
- **A draft stuck in `queued`** — the send threw after the claim. It is not
  retried automatically; check the client's Logs tab for `mailbox.send.failed`,
  fix the cause, and re-approve from `/inbox` after resetting the row to `draft`.
- **Nothing at all is happening** — check the QStash schedule list first (above),
  then the client's Logs tab for `error`-severity rows.
