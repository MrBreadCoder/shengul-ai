# Reports — Design

**Date:** 2026-08-12
**Status:** Approved, pending implementation plan

## Problem

Clients get no periodic recap of what's happening on their account. Everything
today is either live-and-filterable (`/analytics`, `/home`) or requires
knowing to go look. There is no cadence, no historical record of "here's what
happened last week," and no proactive touch from the agency. This adds a
weekly + monthly reporting cadence: real (non-sparkline) charts, an AI-written
performance summary, stored as a durable record, and emailed personally from
the founder to everyone with dashboard access at that client.

## Scope

Client-facing feature. No operator UI in v1 (explicit decision — see
Out of Scope). Two new database tables, three new pipeline routes, two new
QStash schedules, one new client-facing route group, one new outbound mailer
fully independent of the cold-outreach mailbox system.

---

## 1. Scheduling & cadence

Two independent QStash crons, following the existing `discover-fanout` →
per-unit worker pattern (`.claude/architecture.md` §8) exactly:

- **Weekly** — cron `0 8 * * 1` (Monday 08:00 UTC) →
  `/api/pipeline/reports-weekly-fanout` → loads every `clients.status =
  'active'` client → publishes one QStash message per client to
  `/api/pipeline/reports-generate` with `{ clientId, type: 'weekly' }`.
  Period = trailing 7 days, UTC-day-aligned: `period_start` = start of the
  day 7 days before the cron's `now`, `period_end` = start of the day of
  `now` (exclusive). This gives a clean "Aug 4 – Aug 11" label with no
  fractional-day edges.
- **Monthly** — cron `0 8 1 * *` (1st of month, 08:00 UTC) →
  `/api/pipeline/reports-monthly-fanout` → same fan-out shape, `{ clientId,
  type: 'monthly' }`. Period = the just-completed calendar month in full
  (`period_start` = first of previous month 00:00 UTC, `period_end`
  (exclusive) = first of current month 00:00 UTC). Independent of the
  weekly cadence/counter — runs on its own calendar-aligned schedule
  regardless of how many weekly reports fired that month.
- Registered via `scripts/schedule-reports-weekly-cron.ts` and
  `scripts/schedule-reports-monthly-cron.ts`, one-off developer-run scripts
  matching every existing `scripts/schedule-*-cron.ts` — `scheduleCron()` is
  never called from app runtime, only from these scripts, per established
  convention.
- One shared `/api/pipeline/reports-generate` route and one
  `generateReport()` function handle both types, branching internally,
  rather than duplicating the pipeline per type.

**Monthly still recaps the weeks inside it.** It does not assume exactly 4 —
it queries whichever weekly `reports` rows already exist with `period_start
>= period_start AND period_end <= period_end` of the month (ordinarily 4,
occasionally 5 depending on calendar alignment) and includes them as a
"weekly recap" table on the monthly report (§7).

### Idempotency

`reports` carries a unique constraint on `(client_id, type, period_start)`.
`generateReport()` upserts on that key. QStash retries a failed delivery
automatically (architecture.md §8); without the constraint a retry after a
partial failure could create a duplicate report row. This does not guarantee
exactly-once *email* delivery — a retry after the metrics/AI steps succeeded
but the route crashed before returning could resend the notification email
on the retry. Accepted tradeoff: this is a low-frequency job (weekly/monthly
per client), a duplicate would be rare, and the harm of an occasional
duplicate "here's your report" email is low compared to the complexity of
building full exactly-once send semantics.

---

## 2. Data model

New migration `supabase/migrations/0039_reports.sql`. Follows this repo's
established shape exactly: flat denormalized `client_id` for RLS,
service-role-only writes, `is_operator() or client_id = current_client_id()`
read policy (see `0018_client_resources.sql`).

```sql
create type report_type as enum ('weekly', 'monthly');
create type report_status as enum ('generating', 'ready', 'send_failed', 'sent');
create type report_delivery_status as enum ('sent', 'failed');

create table reports (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  type          report_type not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  -- Frozen snapshot — see "Snapshot, not live-recompute" below.
  metrics       jsonb not null default '{}'::jsonb,
  ai_headline   text not null default '',
  ai_summary    text not null default '',
  ai_highlights text[] not null default '{}',
  status        report_status not null default 'generating',
  created_at    timestamptz not null default now(),
  unique (client_id, type, period_start)
);

create index reports_client_list_idx
  on reports (client_id, status, period_start desc);

create table report_deliveries (
  id           uuid primary key default gen_random_uuid(),
  -- Denormalized for RLS shape, matching email_attachments' convention (0018).
  client_id    uuid not null references clients(id) on delete cascade,
  report_id    uuid not null references reports(id) on delete cascade,
  app_user_id  uuid references app_users(id) on delete set null,
  email        text not null,
  status       report_delivery_status not null,
  error        text,
  sent_at      timestamptz,
  created_at   timestamptz not null default now()
);

create index report_deliveries_report_idx on report_deliveries (report_id);

alter table reports enable row level security;
alter table report_deliveries enable row level security;

create policy reports_select on reports for select
  using (is_operator() or client_id = current_client_id());
create policy reports_write on reports for all
  using (is_operator()) with check (is_operator());

create policy report_deliveries_select on report_deliveries for select
  using (is_operator() or client_id = current_client_id());
create policy report_deliveries_write on report_deliveries for all
  using (is_operator()) with check (is_operator());
```

### Snapshot, not live-recompute

`metrics`/`ai_*` are computed once at generation time and frozen into the
row. The report pages (§7) only ever render the stored snapshot — they never
re-query `analytics_overview`/`analytics_daily` live. A report is a
historical record of what was actually emailed; if it silently changed later
(e.g. a lead's status gets corrected after the fact), the AI commentary
("replies up 32%") would drift out of sync with a live-recomputed chart,
which is a worse problem than a frozen number. `/analytics` and `/home`
remain the live views — this is deliberately not a third one.

### Types

`ReportRow`/`ReportInsert`/`ReportDeliveryRow` types are colocated in
`src/lib/db/reports.ts` (`Database['public']['Tables']['reports']['Row']`
etc.), matching how `ClientRow` lives in `lib/db/clients.ts` — not `/types`.

`ReportMetricsSnapshot` (the shape inside the `metrics` jsonb column) goes in
`src/types/reports.ts`, matching `types/analytics.ts` — it composes
`OverviewMetrics`/`DailyMetric` from that file and is read by both the
writer (`lib/reports/`) and the reader (`(app)/reports/` pages), the same
cross-feature relationship `OverviewMetrics` has to `/analytics` and
`/home`:

```ts
// src/types/reports.ts
import { z } from 'zod'
import type { OverviewMetrics, DailyMetric } from './analytics'

const overviewMetricsSchema = z.object({
  leadsDiscovered: z.number().int().nonnegative(),
  leadsVerified: z.number().int().nonnegative(),
  casesCreated: z.number().int().nonnegative(),
  emailsSent: z.number().int().nonnegative(),
  firstTouchSent: z.number().int().nonnegative(),
  followupsSent: z.number().int().nonnegative(),
  emailsBounced: z.number().int().nonnegative(),
  emailsFailed: z.number().int().nonnegative(),
  repliesReceived: z.number().int().nonnegative(),
  leadsContacted: z.number().int().nonnegative(),
  leadsReplied: z.number().int().nonnegative(),
  suppressionsAdded: z.number().int().nonnegative(),
  activeSequences: z.number().int().nonnegative(),
}) satisfies z.ZodType<OverviewMetrics>

const dailyMetricSchema = z.object({
  day: z.string(),
  leadsDiscovered: z.number().int().nonnegative(),
  emailsSent: z.number().int().nonnegative(),
  repliesReceived: z.number().int().nonnegative(),
}) satisfies z.ZodType<DailyMetric>

export const reportMetricsSnapshotSchema = z.object({
  overview: overviewMetricsSchema,
  daily: z.array(dailyMetricSchema),
  // Present only when the parent report's type is 'monthly'.
  weeklyBreakdown: z
    .array(
      z.object({
        reportId: z.string().uuid(),
        periodStart: z.string(),
        periodEnd: z.string(),
        overview: overviewMetricsSchema,
      }),
    )
    .optional(),
})

export type ReportMetricsSnapshot = z.infer<typeof reportMetricsSnapshotSchema>
```

Validated with this schema both when written (defensive — catches a bug in
the builder before it lands in the DB) and when read back out of the jsonb
column (per QUALITY.md: never trust an external boundary, and a jsonb column
read back counts as one).

### Generation flow

`generateReport(admin, { clientId, type, now })` — the single function both
`/api/pipeline/reports-generate` calls and every unit test in §9 targets —
runs these steps in order, so the status column always reflects reality even
if a later step fails:

1. Compute `period_start`/`period_end` for `type` (§1).
2. Upsert the `reports` row on `(client_id, type, period_start)`,
   `status = 'generating'`.
3. Compute the metrics snapshot (§3) — `getOverviewMetrics` +
   `getDailyMetrics`, plus `weeklyBreakdown` if `type = 'monthly'`.
4. Generate AI commentary (§4), falling back to the templated summary on
   failure — this step never throws.
5. Update the row: `metrics`, `ai_headline`/`ai_summary`/`ai_highlights`,
   `status = 'ready'`. From this point the report is visible on `/reports`
   (§7) even if every step below fails.
6. Resolve recipients (§6). Empty → log `reports.no_recipients`, done;
   `status` stays `'ready'`.
7. For each recipient, independently: pick the template, render it, send it,
   insert its own `report_deliveries` row — wrapped in its own try/catch, so
   one recipient's failure never stops the remaining sends.
8. `status = 'sent'` if at least one send succeeded, `'send_failed'` if
   recipients existed but every send failed.
9. Log the summary event (§8).

---

## 3. Report content & metrics

Aggregate across the client's **whole account** — no per-campaign breakdown.
`/analytics` already owns that drill-down; duplicating it here is scope the
feature doesn't need (YAGNI). Reuses the existing RPCs exactly as `/home`
and `/analytics` do, called with the admin client and an explicit
`clientId` (cron context has no session):

- `getOverviewMetrics(admin, { from: period_start, to: period_end,
  campaignId: null, clientId })` → the period's totals.
- `getDailyMetrics(admin, { from, to, campaignId: null, clientId })` → the
  day-by-day series that drives the real chart (§5).

For a monthly report, additionally: `listWeeklyReportsInRange(admin, {
clientId, from: period_start, to: period_end })` — a new `lib/db/reports.ts`
query for `reports` rows where `type = 'weekly' AND period_start >= from AND
period_end <= to`, ordered by `period_start`. Their already-stored
`metrics.overview` snapshots populate `weeklyBreakdown` directly — this is
**not** recomputed from raw data, it's copied from what was already frozen
into each weekly report, so a monthly report always agrees exactly with the
weekly reports it recaps.

---

## 4. AI commentary

New `src/lib/reports/commentary.ts`, built on the existing
`generateJson()` (`lib/llm/client.ts` — timeouts, token ceiling, and usage
logging already handled there):

```ts
const reportCommentarySchema = z.object({
  headline: z.string().min(1).max(80),
  summary: z.string().min(1).max(600),
  highlights: z.array(z.string().min(1).max(140)).min(2).max(4),
})

export async function generateReportCommentary(
  context: LlmCallContext,
  input: { clientName: string; type: 'weekly' | 'monthly'; periodLabel: string; current: OverviewMetrics; previous: OverviewMetrics | null },
): Promise<{ headline: string; summary: string; highlights: string[] }>
```

Prompt gives the model the real current-period numbers plus the prior
period's (previous week, or previous month) for comparison so it can ground
claims like "replies up 12%" in an actual delta rather than inventing a
trend. Consistent with the snapshot philosophy (§2), `previous` is **not** a
fresh RPC call for a shifted date range — it's the `metrics.overview` already
stored on that client's immediately-prior `reports` row of the same `type`
(via a new `getPreviousReport(admin, { clientId, type, beforePeriodStart })`
in `lib/db/reports.ts`), or `null` when this is the client's first report of
that type, in which case the prompt omits the comparison and the model
describes the period on its own terms rather than inventing a delta from
nothing. `thinkingLevel: 'low'` — this is grounded numeric summarization, not
the judgment-heavy research/reply-triage work that earns `'medium'`/`'high'`
elsewhere in this codebase. Not routed through `EMAIL_WRITER_MODEL_ID` — that
model override is reserved for outbound cold-email copy specifically (see
its doc comment in `client.ts`); this is a different consumer.

**Fallback on failure**: if `generateReportCommentary` throws (timeout, rate
limit, malformed output), `generateReport()` catches it, logs via
`logError`, and substitutes a deterministic templated summary instead of
failing the whole report:

```
headline:  "{periodLabel} performance summary"
summary:   "{leadsDiscovered} leads found, {emailsSent} emails sent, {repliesReceived} replies received."
highlights: []
```

A Gemini hiccup must never block a report — and by extension its email —
from going out (QUALITY.md: graceful degradation).

---

## 5. Charts — the actual ask

New `src/components/report-chart.tsx`: a real, hand-built SVG chart —
axes, gridlines, date labels on the x-axis, a legend when plotting multiple
series — genuinely distinct from `SparklineChart` (which is untouched and
stays exactly as-is on `/home`). No new dependency; this repo has none of
the chart libraries (`recharts`, `d3`, `chart.js`, etc.) and none are added.

- **Weekly report page**: one chart, the 7-day `daily` series (`emailsSent`,
  `repliesReceived`, `leadsDiscovered` as up to three plotted series with a
  legend).
- **Monthly report page**: the same chart shape across the full month's
  `daily` series (more data points), **plus** a "Weekly recap" — a plain
  table, one row per entry in `weeklyBreakdown`, each row showing that
  week's `period_start`–`period_end` label and its key totals, linking to
  that individual weekly report's own `/reports/[id]` page. A table over a
  second chart type here: it's simpler to build correctly than a grouped bar
  chart and it's the only place in the feature where drilling from a monthly
  report into one specific week's own report actually matters.

Exact mark choice (line vs. bar), color, and spacing are implementation-time
decisions — `report-chart.tsx` is built following the `dataviz` skill's form
heuristic and color formula (invoked when that file is written, per that
skill's own trigger — not during this design).

---

## 6. Recipient email — sent from Shengul, personally

### Sender identity & config

New env vars (extends `src/lib/env.ts` + `.env.example`, `nonEmpty`/coerced
via the existing `parseEnv/envSchema` pattern):

```
REPORTS_SMTP_HOST=
REPORTS_SMTP_PORT=
REPORTS_SMTP_SECURE=        # 'true' | 'false' — true = implicit TLS (465), false = STARTTLS (587)
REPORTS_SMTP_USERNAME=
REPORTS_SMTP_PASSWORD=
REPORTS_FROM_EMAIL=         # shengul@shengulai.com
REPORTS_FROM_NAME=          # "Shengul Yavuz" — the From display name
```

New `src/lib/reports/mailer.ts`. **Not** routed through the cold-outreach
`sendSmtpEmail` (`lib/mailbox/smtp-send.ts`) — that function is plain-text
only and carries Message-ID thread-chaining semantics built for the
follow-up sequence pipeline, neither of which applies here. Instead it:

- Defines its own minimal `ReportsSmtpConfig`
  (host/port/secure/username/password/fromEmail/fromName) sourced from the
  env vars above — deliberately
  **not** the mailbox module's `SmtpCredentials`, which also requires
  `imapHost`/`imapPort`/`imapSecure` for a reader this feature has no use
  for.
- Calls `nodemailer.createTransport(...)` directly with that config.
- Reuses the generic, provider-agnostic pieces from the mailbox module:
  `toMailAppError`/`withMailDeadline`/`MAIL_DEADLINE_MS`
  (`lib/mailbox/smtp-errors.ts`) and `assertNoHeaderInjection`
  (`lib/mailbox/headers.ts`) — these are pure utilities with no coupling to
  mailbox rotation/health/warmup, legitimate shared reuse.
- Sends HTML + plain-text multipart, **minimal styling** — no logo header,
  no button graphic, no card/box chrome. Just paragraphs and plain inline
  links, so it reads as an actual personal email, not a marketing template.
- **BCC's `REPORTS_FROM_EMAIL` on every send** — since there's no operator
  UI (§ Out of scope), this is how the sender gets visibility into what went
  out, at zero extra complexity. Easy to remove later if unwanted.

### Recipient resolution

"People in that client's dashboard access" = every `app_users` row with
`role = 'client'` and that `client_id`. `app_users` itself has **no email
column** (confirmed while building this) — email lives on Supabase Auth's
`auth.users`, referenced by `app_users.id`. Two small additions:

```ts
// src/lib/db/clients.ts
export async function listClientRoleAppUsersForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<AppUserRow[]>  // .eq('role', 'client').eq('client_id', clientId)

export async function listActiveClients(
  supabase: SupabaseClient<Database>,
): Promise<ClientOption[]>  // .eq('status', 'active').select('id, name').order('name')
```

```ts
// src/lib/supabase/auth-admin.ts — new batch function alongside the
// existing single-user getAuthUserEmail
export async function getAuthUserEmails(
  admin: SupabaseClient<Database>,
  userIds: string[],
): Promise<{ userId: string; email: string }[]>
```

`getAuthUserEmails` uses `Promise.allSettled` over `admin.auth.admin.getUserById`,
silently dropping any id that fails or has no email (logged via
`logEventSafe`, not thrown) — deliberately best-effort, unlike
`deleteAuthUsers`'s all-or-nothing semantics. One broken auth record must not
block the report from reaching every other valid recipient.

If the resolved recipient list is empty (no one's been invited to that
client's dashboard yet), `generateReport()` still finishes successfully —
`status = 'ready'`, viewable in-app whenever someone eventually gets access —
it just skips sending and logs `reports.no_recipients`. This is intentionally
different from `send_failed`, which means a send was attempted and failed.

### Templates

Seven templates in `src/lib/reports/email-templates.ts`, picked
deterministically by `(count of this client's prior reports) % 7` — via a
new `countPriorReportsForClient(admin, clientId)` in `lib/db/reports.ts` — so
wording never repeats back-to-back. `{client}` = `clients.name`. `{period}` =
`"this week"` (weekly) / `"this month"` (monthly). Greeting addresses the
client by company name, not a person's name — the invite flow only ever
captures an email address, there is no name field anywhere to greet a person
by (confirmed while building this; adding one was considered and explicitly
declined in favor of this). `{feedbackUrl}` is the named constant
`FEEDBACK_CALL_URL = 'https://cal.com/shengul-yavuz/feedback-call'` — not a
secret, so not env. `{reportUrl}` = `${APP_URL}/reports/{id}`.

Every template closes with the same two-line signature block below the
casual sign-off — the sign-off varies per template (personal, in-the-body
voice), the signature block underneath is static (who this actually is):

```
Shengul Yavuz
Founder of Shengul AI
```

1. **Subject:** `Shengul AI: your {period} numbers are in`
   ```
   Hey {client} team,

   {leads} new leads this {period}, {emails} emails out the door. Full report here: {reportUrl}

   Something look off? Reply to this email or grab 15 minutes on my calendar: {feedbackUrl}

   — Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

2. **Subject:** `Shengul AI — {leads} new leads for {client}`
   ```
   Hi {client},

   {period}'s numbers: {leads} leads found, {replies} replies back. Report's here: {reportUrl}

   If anything doesn't add up, tell me — reply here or book time: {feedbackUrl}

   Talk soon,
   Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

3. **Subject:** `{client}'s {period} report is ready (Shengul AI)`
   ```
   Hey {client} team,

   Report's in: {leads} new leads, {emails} emails sent {period}. Take a look: {reportUrl}

   Anything look wrong, or want to talk it through? Book a call: {feedbackUrl}

   Best,
   Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

4. **Subject:** `Shengul AI report: {client}, {period}`
   ```
   Hi {client},

   Wrapped up {period}: {leads} leads, {replies} replies so far. Details here: {reportUrl}

   Flag anything that seems off, or just grab time on my calendar: {feedbackUrl}

   — Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

5. **Subject:** `{leads} new leads for {client} — Shengul AI`
   ```
   Hey {client} team,

   {leads} leads found {period}, {emails} emails sent. Everything's in the report: {reportUrl}

   Questions or something's wrong — write back anytime, or book 15 minutes: {feedbackUrl}

   Thanks,
   Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

6. **Subject:** `Your {period} update from Shengul AI`
   ```
   Hi {client},

   Here's {period}: {leads} leads, {emails} emails out, {replies} replies. Full breakdown: {reportUrl}

   Doesn't look right, or want to dig in together? Grab time here: {feedbackUrl}

   — Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

7. **Subject:** `Shengul AI — checking in on {client}'s {period}`
   ```
   Hey {client} team,

   {period} report's ready — {leads} leads, {replies} replies so far. See everything here: {reportUrl}

   Something off? Reply to this email, or book a call and we'll sort it: {feedbackUrl}

   Talk soon,
   Shengul

   Shengul Yavuz
   Founder of Shengul AI
   ```

Every interpolated value that lands in the subject or a header runs through
`assertNoHeaderInjection` before send (a client name is operator-entered
today, but this costs nothing and matches how every other send path in this
codebase treats header values).

### Delivery

One individual email per recipient (never one message with multiple `To:`
addresses) — keeps it reading as personal mail, and means one recipient's
bounced/invalid address doesn't affect delivery to the client's other
dashboard users. Each attempt gets its own `report_deliveries` row
(`status: 'sent' | 'failed'`, `error` populated on failure). After all
attempts: `reports.status` = `'sent'` if at least one succeeded,
`'send_failed'` if recipients existed but every send failed.

---

## 7. In-app report pages

Client-only, no operator UI (§ Out of scope) — same `requireUser()` +
operator-redirect-to-`/crm` pattern as `/home`.

- `src/app/(app)/reports/page.tsx` — list. Queries only `status IN ('ready',
  'sent')`, newest first — a `'generating'` row (mid-pipeline, a few
  seconds) or a `'send_failed'` row's underlying report is simply not shown
  until it's actually ready, so there's no in-progress/error state to design
  for on this page. Each row: type badge (Weekly/Monthly), period label,
  generated date → links to `/reports/[id]`. `EmptyState` for a brand-new
  client with no reports yet.
- `src/app/(app)/reports/[id]/page.tsx` — detail. `getReportById` (RLS-scoped
  — a report belonging to another client 404s via `notFound()`, same as
  every other `[id]` detail route). Renders: period label + generated date,
  stat tiles (reusing `StatTile`) for the period's `overview`, the real
  trend chart (§5), the AI commentary block (headline as a callout, summary
  paragraph, highlights as a bullet list), and — monthly only — the weekly
  recap table (§5).
- Both get `loading.tsx`/`error.tsx` matching every other route's shape.
- **No realtime subscription** (unlike `/home`/`/analytics`) — reports
  change on a weekly/monthly cadence, not from live pipeline events, so a
  `RealtimeRefresher` subscription here would just be idle overhead.
- Nav: new item in `src/components/shell/nav.tsx`'s `PRIMARY_NAV`, after
  Analytics, `clientOnly: true`.
- i18n: new `reports` namespace in `src/messages/en.json` +
  `src/messages/tr.json` — this is client-facing, so per this repo's rule
  (translate client-facing pages, not operator-only ones) it is fully
  translated, unlike an operator-only surface.

---

## 8. Error handling & edge cases

No new `AppErrorCode` values — every failure mode here (DB write, SMTP send,
LLM call, missing report) is already covered by the existing generic codes
(`DB_ERROR`, `EXTERNAL_ERROR`, `EXTERNAL_TIMEOUT`, `NOT_FOUND`,
`VALIDATION_ERROR`, `CONFIG_ERROR`) — none of this feature's failures are a
business-rule branch the UI needs to distinguish by a bespoke code the way
`EMAIL_STYLE_NAME_TAKEN` is.

| Case | Behavior |
|---|---|
| LLM commentary call fails | Fall back to deterministic templated summary (§4). Report still generates and sends. |
| Zero dashboard users for a client | Report generates (`status: 'ready'`), sending is skipped and logged (`reports.no_recipients`), not treated as a failure. |
| One recipient's send fails, others succeed | `report_deliveries` row per recipient records it individually; `reports.status = 'sent'` (at least one succeeded). |
| Every recipient's send fails | `reports.status = 'send_failed'`. Report itself is still viewable in-app. |
| One auth user record unresolvable (banned/deleted) | Dropped from the recipient list (logged), doesn't block the rest. |
| QStash retries a report that partially completed | `(client_id, type, period_start)` unique constraint + upsert prevents a duplicate *row*; a duplicate *email* on that narrow retry window is possible and accepted (§1). |
| Client has multiple active campaigns | Metrics aggregate across all of them — no per-campaign split in v1. |

Observability: one summary event per fanout
(`reports.weekly_fanout.completed`/`reports.monthly_fanout.completed`,
payload mirrors `discover-fanout`'s: client counts, fired/failed ids), one
event per generation (`reports.generated`, payload: reportId, type,
clientId, recipientCount) via `logEventSafe`, failures via `logError`.
Per-recipient delivery status lives in `report_deliveries`, not duplicated
into the `events` audit log — one source of truth, matching how
`discover-fanout` logs one fanout-level summary rather than one event per
campaign.

---

## 9. Testing

Colocated Vitest, matching this repo's coverage targets (100% for pure
`lib/reports/period.ts` and `lib/reports/email-templates.ts`, 80%+ for
`lib/db/reports.ts`, mocked-collaborator tests for everything that calls an
external service):

- `lib/reports/period.ts` — weekly/monthly boundary math: UTC day
  truncation, calendar month wraparound (Dec→Jan), 28/29/30/31-day months,
  leap year February.
- `lib/reports/email-templates.ts` — all 7 render with no leftover
  `{placeholder}` tokens, `pickTemplate` covers every modulo index 0–6,
  header-injection guard rejects a newline in any interpolated field.
- `lib/reports/commentary.ts` — mocked `generateJson`: schema/prompt shape,
  the fallback-on-failure path.
- `lib/reports/mailer.ts` — mocked `nodemailer.createTransport`:
  to/from/subject/text/html assembled correctly, BCC present,
  timeout/SMTP-error mapping to `AppError`.
- `lib/reports/metrics.ts` — mocked Supabase RPC calls: snapshot shape,
  weekly-breakdown assembly from prior `reports` rows.
- `lib/reports/generate.ts` — the orchestrator, every collaborator mocked:
  happy path, zero-recipients path, partial-send-failure path,
  all-sends-failed path, LLM-failure-fallback path, idempotent-retry path.
- `lib/db/reports.ts`, `lib/db/clients.ts` additions, and
  `lib/supabase/auth-admin.ts` additions — happy path + error path mapped
  to `AppError`, matching every other file in `lib/db/`.
- Route tests for `reports-weekly-fanout`, `reports-monthly-fanout`,
  `reports-generate` mirroring `discover-fanout/route.test.ts` — signature
  verification, per-client failure isolation in the fanout routes.
- No component tests for the report pages — thin Server Components
  composing already-tested `lib` functions, matching this repo's established
  precedent (see `2026-08-11-client-home-dashboard-design.md` §5). Manual
  verification before considering this done: a weekly report generates and
  is visible at `/reports`; a monthly report's weekly recap table links to
  the correct individual weekly reports; the notification email arrives
  from `Shengul Yavuz <shengul@shengulai.com>`, BCC'd to the same address;
  an operator hitting `/reports` directly still redirects to `/crm`.

---

## Out of scope (explicit)

- **Operator-facing reports UI** — explicitly declined. Visibility for the
  sender comes from the BCC (§6), not a dashboard.
- **Per-campaign breakdown** within a report — `/analytics` already owns
  that; account-level aggregate only here.
- **PDF export / attachment** — considered and declined in favor of the
  hosted report page.
- **Charts embedded directly in the email** — considered and declined; would
  require a new server-side chart-rendering dependency with no precedent in
  this codebase.
- **DB-editable / admin-manageable templates** — the 7 templates are code
  for v1, not editable through the product.
- **Per-person name greetings** ("Hey Jane") — no name field exists for
  dashboard users; considered adding one and explicitly declined in favor of
  a company-name greeting.
- **Resend/retry UI** for a failed delivery — visible in `report_deliveries`
  for future tooling, no resend button in v1.
- **Per-recipient unsubscribe/preferences** — every client-role user for a
  client always receives every report, matching "everyone with dashboard
  access" as literally requested.
