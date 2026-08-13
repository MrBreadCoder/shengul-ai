# Design: Surface Mailreach warmup on Home, Analytics, and Reports

**Status:** Approved for planning.

## Problem

Mailreach warmup enrollment already exists (`docs/superpowers/specs/2026-07-29-mailreach-warmup-design.md`) and is visible per-mailbox on `/settings`. Three gaps:

1. **`getAccountStats` reads a field that doesn't exist.** Confirmed against Mailreach's real OpenAPI spec (`https://docs.mailreach.co/api/openapi.json`): `GET /v1/accounts/{id}/stats` has no `reputation_score` field. It returns `total_messages_sent`, `total_messages_received`, `total_spam`, `config_current_conversation_running`, `consolidated_cutoff`. The real reputation number (`score`) lives on `GET /v1/accounts/{id}` instead. This was flagged as a known gap in `docs/superpowers/specs/2026-08-04-mailreach-smtp-connect-404-design.md` ("Explicitly out of scope" §1) and confirmed still true: `mailreach_reputation_score` has been `null` for every mailbox since launch, and none of the messaging-volume fields have ever been fetched.
2. **No client-facing view of warmup progress exists outside `/settings`.** A client has no day-counter on `/home`, and no aggregate warmup numbers on `/analytics`.
3. **Reports lead with "0 leads found" during warmup.** When a client's mailboxes haven't cleared the 14-day gate yet, real outreach numbers are legitimately near zero. Today's fixed email templates (`src/lib/reports/email-templates.ts`) and, to a lesser extent, the LLM commentary (`src/lib/reports/commentary.ts`) present that as a flat, discouraging zero instead of explaining what's actually happening (reputation is being built).

## Scope decisions (from brainstorming)

- Warmup context is shown wherever **any** of a client's mailboxes is still inside the 14-day gate (not only when all of them are) — this drives banner/section/panel *visibility*.
- The report email template swaps to a dedicated warmup template specifically when `emailsSent === 0` for the period **and** at least one mailbox is gated — this is the narrower condition that actually produces the "0 leads found" wording being complained about.
- New Analytics section, not new columns on the existing Mailboxes table (different concern: deliverability health vs. reputation-building).
- Home gets a dedicated banner card, not a 6th stat tile.

## 1. Mailreach client fix (prerequisite)

`src/lib/mailreach/client.ts` — replace the current (broken) `getAccountStats` with two functions matching the real API:

```ts
const accountResponseSchema = z.object({ score: z.number().nullable().optional() }).passthrough()

export async function getAccount(accountId: string, apiKey: string): Promise<{ reputationScore: number | null }> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}`,
    { method: 'GET', headers: authHeaders(apiKey) },
    accountResponseSchema,
  )
  return { reputationScore: res.score ?? null }
}

export interface MailreachAccountStats {
  totalMessagesSent: number | null
  totalMessagesReceived: number | null
  totalSpam: number | null
  currentConversationsRunning: number | null
}

const accountStatsResponseSchema = z
  .object({
    total_messages_sent: z.number().int().nonnegative().nullable().optional(),
    total_messages_received: z.number().int().nonnegative().nullable().optional(),
    total_spam: z.number().int().nonnegative().nullable().optional(),
    config_current_conversation_running: z.number().int().nonnegative().nullable().optional(),
  })
  .passthrough()

// past_days=180 (the endpoint's max) rather than the 14-day default: the field
// names read like lifetime totals but are actually windowed by past_days. 180
// days safely covers a mailbox's whole history for the "since connecting"
// numbers this feature shows — see docs.mailreach.co/usage/account-stats.
export async function getAccountStats(accountId: string, apiKey: string): Promise<MailreachAccountStats> {
  const res = await fetchJson(
    `${BASE_URL}/accounts/${accountId}/stats?past_days=180`,
    { method: 'GET', headers: authHeaders(apiKey) },
    accountStatsResponseSchema,
  )
  return {
    totalMessagesSent: res.total_messages_sent ?? null,
    totalMessagesReceived: res.total_messages_received ?? null,
    totalSpam: res.total_spam ?? null,
    currentConversationsRunning: res.config_current_conversation_running ?? null,
  }
}
```

`getAccountStats`'s old signature/return shape (`{ reputationScore }`) is fully removed — every caller is updated in this same change, so there is no lingering wrong-shaped path.

## 2. DB schema

New migration `supabase/migrations/0042_mailreach_stats_fields.sql`:

```sql
-- Adds the messaging-volume fields from Mailreach's real GET /v1/accounts/{id}/stats
-- response. mailreach_reputation_score (0021) is unchanged in shape — it was always
-- the right column, just fed from the wrong endpoint until this change (see
-- docs/superpowers/specs/2026-08-13-mailreach-warmup-surfacing-design.md §1).
alter table mailboxes add column mailreach_total_messages_sent     integer;
alter table mailboxes add column mailreach_total_messages_received integer;
alter table mailboxes add column mailreach_total_spam               integer;
alter table mailboxes add column mailreach_current_conversations    integer;
```

`src/types/database.ts` (hand-authored) gains the four columns on `mailboxes`' `Row`/`Insert`/`Update`, nullable, matching the existing `mailreach_reputation_score: number | null` style exactly.

## 3. Sync pipeline

`src/lib/db/mailboxes.ts`:

```ts
export async function updateMailboxMailreachStats(
  supabase: SupabaseClient<Database>,
  id: string,
  fields: {
    reputationScore: number | null
    totalMessagesSent: number | null
    totalMessagesReceived: number | null
    totalSpam: number | null
    currentConversations: number | null
    syncedAt: string
  },
): Promise<void> {
  const { error } = await supabase
    .from('mailboxes')
    .update({
      mailreach_reputation_score: fields.reputationScore,
      mailreach_total_messages_sent: fields.totalMessagesSent,
      mailreach_total_messages_received: fields.totalMessagesReceived,
      mailreach_total_spam: fields.totalSpam,
      mailreach_current_conversations: fields.currentConversations,
      mailreach_stats_synced_at: fields.syncedAt,
    })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to update mailbox mailreach stats', { id, cause: error.message })
}
```

`listMailreachConnectedMailboxes` gains an optional `clientId` filter (used by Analytics/Home; the sync sweep keeps calling it with no argument for "every client"):

```ts
export async function listMailreachConnectedMailboxes(
  supabase: SupabaseClient<Database>,
  clientId?: string,
): Promise<MailboxRow[]> {
  let query = supabase.from('mailboxes').select('*').eq('mailreach_status', 'connected')
  if (clientId) query = query.eq('client_id', clientId)
  const { data, error } = await query.order('email_address')
  if (error) throw new AppError('DB_ERROR', 'Failed to list mailreach-connected mailboxes', { clientId, cause: error.message })
  return data ?? []
}
```

`src/lib/pipeline/mailreach-sync.ts` — `runMailreachStatsSync` now makes both calls per mailbox, still inside the same per-mailbox `try/catch` (a failure in either call skips that mailbox entirely for this run — no partially-written stats):

```ts
try {
  const [account, stats] = await Promise.all([
    getAccount(mailbox.mailreach_account_id, resolveMailreachApiKey(mailbox.client_id)),
    getAccountStats(mailbox.mailreach_account_id, resolveMailreachApiKey(mailbox.client_id)),
  ])
  await updateMailboxMailreachStats(supabase, mailbox.id, {
    reputationScore: account.reputationScore,
    totalMessagesSent: stats.totalMessagesSent,
    totalMessagesReceived: stats.totalMessagesReceived,
    totalSpam: stats.totalSpam,
    currentConversations: stats.currentConversationsRunning,
    syncedAt: now.toISOString(),
  })
  return true
} catch (error) {
  // ...unchanged logEventSafe + return false
}
```

## 4. Shared warmup summarizer (`src/lib/mailbox/mailreach-gate.ts`)

One pure module, three consumers (Home, Analytics, Reports) — no duplicated gating math. Domain type lives here, not in `/types`, matching the existing precedent of `WarmupProfile`/`WarmthStatus` living in `src/lib/mailbox/warmup.ts` rather than a shared types file.

```ts
export interface MailboxWarmupInfo {
  mailboxId: string
  emailAddress: string
  elapsedDays: number
  gateDays: number
  isGated: boolean
  reputationScore: number | null
  totalMessagesSent: number | null
  totalMessagesReceived: number | null
  totalSpam: number | null
  currentConversations: number | null
}

export type MailboxWarmupSource = Pick<
  MailboxRow,
  | 'id' | 'email_address' | 'mailreach_enabled' | 'mailreach_started_at' | 'mailreach_status'
  | 'mailreach_reputation_score' | 'mailreach_total_messages_sent' | 'mailreach_total_messages_received'
  | 'mailreach_total_spam' | 'mailreach_current_conversations'
>

/**
 * Every currently-connected, enrolled mailbox in `mailboxes`, gated or not.
 * Callers filter to `.isGated` themselves for "still warming" surfaces (home
 * banner, report trigger) — Analytics wants the full list including mailboxes
 * that already cleared the gate ("Warm").
 */
export function summarizeMailboxWarmup(
  mailboxes: MailboxWarmupSource[],
  clientMailreachEnabled: boolean,
  now: Date,
): MailboxWarmupInfo[] {
  const summaries: MailboxWarmupInfo[] = []
  for (const mailbox of mailboxes) {
    if (!mailbox.mailreach_enabled || !clientMailreachEnabled) continue
    if (mailbox.mailreach_status !== 'connected') continue
    if (mailbox.mailreach_started_at === null) continue
    // Narrowed to non-null by the guard above.
    const elapsedDays = mailreachElapsedDays(mailbox.mailreach_started_at, now)
    summaries.push({
      mailboxId: mailbox.id,
      emailAddress: mailbox.email_address,
      elapsedDays,
      gateDays: MAILREACH_CAMPAIGN_GATE_DAYS,
      isGated: elapsedDays < MAILREACH_CAMPAIGN_GATE_DAYS,
      reputationScore: mailbox.mailreach_reputation_score,
      totalMessagesSent: mailbox.mailreach_total_messages_sent,
      totalMessagesReceived: mailbox.mailreach_total_messages_received,
      totalSpam: mailbox.mailreach_total_spam,
      currentConversations: mailbox.mailreach_current_conversations,
    })
  }
  return summaries
}

/** The mailbox nearest to clearing the gate — null when none are gated. */
export function closestToReady(gated: MailboxWarmupInfo[]): MailboxWarmupInfo | null {
  if (gated.length === 0) return null
  return gated.reduce((closest, current) => (current.elapsedDays > closest.elapsedDays ? current : closest))
}

/** Sum of sent + received across the given mailboxes, treating null as 0. */
export function totalMessagesExchanged(mailboxes: MailboxWarmupInfo[]): number {
  return mailboxes.reduce((sum, m) => sum + (m.totalMessagesSent ?? 0) + (m.totalMessagesReceived ?? 0), 0)
}
```

`MailboxRow` is imported as a type only from `@/lib/db/mailboxes` — zero runtime coupling, and it keeps the Pick in sync with the real DB row shape at compile time.

## 5. Home page — warmup banner

`src/app/(app)/home/page.tsx`: fetches the client row (for `mailreach_enabled`) and the client's connected+enrolled mailboxes, computes the summary, and renders the banner between `PageHeader` and the stat-tile grid **only when at least one mailbox is gated**:

```ts
const [client, mailreachMailboxes /* ...existing Promise.all entries... */] = await Promise.all([
  getClientById(supabase, clientId),
  listMailreachConnectedMailboxes(supabase, clientId),
  // ...existing
])
const warmup = summarizeMailboxWarmup(mailreachMailboxes, client?.mailreach_enabled ?? false, now)
const gatedWarmup = warmup.filter((w) => w.isGated)
```

```tsx
{gatedWarmup.length > 0 ? <WarmupBanner mailboxes={warmup} gated={gatedWarmup} /> : null}
```

New `src/app/(app)/home/warmup-banner.tsx` (server component, `getTranslations('home')`):

```tsx
export async function WarmupBanner({
  mailboxes,
  gated,
}: {
  mailboxes: MailboxWarmupInfo[]
  gated: MailboxWarmupInfo[]
}): Promise<React.ReactElement | null> {
  const t = await getTranslations('home')
  // Only null when gated is empty, which the caller in page.tsx already
  // guarantees never happens before rendering this component — this guard is
  // what makes the rest of the function assertion-free, not dead code.
  const closest = closestToReady(gated)
  if (!closest) return null
  const exchanged = totalMessagesExchanged(gated)
  return (
    <div className="border-hairline bg-surface animate-rise rounded-lg border p-5">
      <p className="text-sm font-medium">{t('warmupBanner.title')}</p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupBanner.progress', { gated: gated.length, total: mailboxes.length })}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">
        {t('warmupBanner.closest', { elapsed: closest.elapsedDays, gate: closest.gateDays })}
        {closest.reputationScore !== null ? ' · ' + t('warmupBanner.reputation', { score: closest.reputationScore }) : null}
      </p>
      <p className="text-muted-foreground mt-1 text-sm">{t('warmupBanner.messagesExchanged', { count: exchanged })}</p>
      <Link href="/settings" className="text-primary mt-3 inline-block text-xs underline underline-offset-2">
        {t('warmupBanner.viewDetails')}
      </Link>
    </div>
  )
}
```

## 6. Analytics — "Mailbox Warmup" section

No new SQL function needed — this is a plain RLS-scoped select (`listMailreachConnectedMailboxes`), not an aggregate, unlike `analytics_mailboxes` which joins against `emails`.

`src/app/(app)/analytics/analytics-view.tsx`: alongside the existing `getMailboxMetrics` call, fetch:

```ts
const [client, warmupMailboxes] = await Promise.all([
  clientId ? getClientById(supabase, clientId) : Promise.resolve(null),
  listMailreachConnectedMailboxes(supabase, clientId ?? undefined),
])
const warmup = summarizeMailboxWarmup(warmupMailboxes, client?.mailreach_enabled ?? true, now)
```

(`?? true` for the no-client-filter/global-operator case: the client-level switch doesn't apply when aggregating across every client, and `mailreach_enabled` is already checked per-mailbox by `listMailreachConnectedMailboxes`'s `mailreach_status = 'connected'` filter — a mailbox can't be `connected` while its owning client has the master switch off, since disabling the switch disconnects it. This mirrors how the existing Mailboxes table already has no client-level gating in global scope.)

New section, rendered only when `warmup.length > 0`, placed after the existing "Mailboxes" section:

```tsx
{warmup.length > 0 ? (
  <Section title={t('sectionMailboxWarmup')}>
    <div className="border-hairline overflow-x-auto rounded-lg border">
      <Table className="min-w-[760px]">
        <TableHeader>
          <TableRow>
            <TableHead scope="col">{t('mailboxWarmupTable.mailbox')}</TableHead>
            <TableHead scope="col">{t('mailboxWarmupTable.status')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.reputation')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.sent')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.received')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.spam')}</TableHead>
            <TableHead scope="col" className="text-right">{t('mailboxWarmupTable.activeConversations')}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {warmup.map((m) => (
            <TableRow key={m.mailboxId}>
              <TableCell className="font-medium">{m.emailAddress}</TableCell>
              <TableCell>
                {m.isGated ? t('mailboxWarmupTable.statusWarming', { elapsed: m.elapsedDays, gate: m.gateDays }) : t('mailboxWarmupTable.statusWarm')}
              </TableCell>
              <TableCell className="tnum text-right">{m.reputationScore ?? '—'}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.totalMessagesSent ?? 0)}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.totalMessagesReceived ?? 0)}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.totalSpam ?? 0)}</TableCell>
              <TableCell className="tnum text-right">{formatCount(m.currentConversations ?? 0)}</TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  </Section>
) : null}
```

No empty state needed (section hidden entirely, consistent with "only show what's real").

## 7. Reports

### 7a. Frozen snapshot

`src/types/reports.ts` — `reportMetricsSnapshotSchema` gains an optional `warmup` array, mirroring `MailboxWarmupInfo` exactly:

```ts
const mailboxWarmupSchema = z.object({
  mailboxId: z.string().uuid(),
  emailAddress: z.string(),
  elapsedDays: z.number().int().nonnegative(),
  gateDays: z.number().int().positive(),
  isGated: z.boolean(),
  reputationScore: z.number().nullable(),
  totalMessagesSent: z.number().int().nonnegative().nullable(),
  totalMessagesReceived: z.number().int().nonnegative().nullable(),
  totalSpam: z.number().int().nonnegative().nullable(),
  currentConversations: z.number().int().nonnegative().nullable(),
}) satisfies z.ZodType<MailboxWarmupInfo>

export const reportMetricsSnapshotSchema = z.object({
  overview: overviewMetricsSchema,
  daily: z.array(dailyMetricSchema),
  weeklyBreakdown: z.array(/* unchanged */).optional(),
  // Present only when the client has ≥1 Mailreach-enrolled, connected mailbox
  // at generation time. Frozen like weeklyBreakdown — the report stays
  // historically accurate even after the gate later clears.
  warmup: z.array(mailboxWarmupSchema).optional(),
})
```

`src/lib/reports/metrics.ts` — `buildReportMetrics` (called with the **admin** client from `generate.ts`, so no RLS scoping concern) additionally fetches and summarizes:

```ts
const [overview, daily, client, mailreachMailboxes] = await Promise.all([
  getOverviewMetrics(supabase, range),
  getDailyMetrics(supabase, range),
  getClientById(supabase, input.clientId),
  listMailreachConnectedMailboxes(supabase, input.clientId),
])
const warmup = summarizeMailboxWarmup(mailreachMailboxes, client?.mailreach_enabled ?? false, input.now)
// ...spread into the returned object as `warmup: warmup.length > 0 ? warmup : undefined`
```

(`buildReportMetrics` needs a `now: Date` added to its `BuildReportMetricsInput` — `generate.ts` already has `input.now` available to pass through.)

### 7b. LLM commentary

`src/lib/reports/commentary.ts` — `GenerateReportCommentaryInput` gains `warmup: MailboxWarmupInfo[]` (empty array when none, not `null` — simpler for the prompt builder). `buildPrompt` appends a block when non-empty:

```ts
function formatWarmupBlock(warmup: MailboxWarmupInfo[]): string {
  const gated = warmup.filter((w) => w.isGated)
  if (gated.length === 0) return ''
  const scores = gated.map((w) => w.reputationScore).filter((s): s is number => s !== null)
  return (
    `\n\nMailbox warmup in progress:\n` +
    `- ${gated.length} of ${warmup.length} connected mailboxes still building sending reputation\n` +
    gated.map((w) => `  - Day ${w.elapsedDays} of ${w.gateDays}`).join('\n') +
    (scores.length > 0 ? `\n- Reputation scores so far: ${scores.join(', ')}` : '') +
    `\n- Messages exchanged as part of warmup: ${totalMessagesExchanged(gated)}`
  )
}
```

`INSTRUCTIONS` gains one sentence: *"If the client has mailboxes still in Mailreach warmup and outreach numbers are low as a result, prioritize describing the warmup progress (days remaining, reputation trend) over dwelling on low lead/email counts — this is expected and positive, not a shortfall. If outreach numbers are healthy, mention warmup progress only briefly, as a secondary note."*

`buildFallbackCommentary` (the deterministic no-LLM fallback) gains a warmup-aware branch, checked first:

```ts
export function buildFallbackCommentary(
  periodLabel: 'this week' | 'this month',
  overview: OverviewMetrics,
  warmup: MailboxWarmupInfo[],
): ReportCommentary {
  const gated = warmup.filter((w) => w.isGated)
  if (overview.emailsSent === 0 && gated.length > 0) {
    const closest = closestToReady(gated)
    if (closest) {
      return {
        headline: 'Building your sending reputation',
        summary:
          `${gated.length} mailbox${gated.length === 1 ? '' : 'es'} still warming up with Mailreach — ` +
          `the closest is on day ${closest.elapsedDays} of ${closest.gateDays}. ` +
          `Outreach begins automatically once warmup clears.`,
        highlights: [
          `Day ${closest.elapsedDays} of ${closest.gateDays} for the closest mailbox`,
          closest.reputationScore !== null
            ? `Reputation score: ${closest.reputationScore}`
            : `${gated.length} mailbox${gated.length === 1 ? '' : 'es'} warming up`,
        ],
      }
    }
  }
  return {
    // ...existing body, unchanged
  }
}
```

### 7c. Fixed email templates

`src/lib/reports/email-templates.ts` — `ReportEmailTemplateInput` gains `warmup: WarmupTemplateContext | null`:

```ts
export interface WarmupTemplateContext {
  gatedCount: number
  totalEnrolled: number
  closestElapsedDays: number
  closestGateDays: number
  closestReputationScore: number | null
  messagesExchanged: number
}

export function buildWarmupTemplateContext(warmup: MailboxWarmupInfo[]): WarmupTemplateContext | null {
  const gated = warmup.filter((w) => w.isGated)
  const closest = closestToReady(gated)
  if (!closest) return null
  return {
    gatedCount: gated.length,
    totalEnrolled: warmup.length,
    closestElapsedDays: closest.elapsedDays,
    closestGateDays: closest.gateDays,
    closestReputationScore: closest.reputationScore,
    messagesExchanged: totalMessagesExchanged(gated),
  }
}
```

A dedicated template, deliberately **not** part of the rotating `TEMPLATES` pool (YAGNI — this is a narrower, temporary state, not something that needs 7 variants):

```ts
const WARMUP_TEMPLATE: ReportEmailTemplate = {
  subject: ({ clientName }) => `Shengul AI — building ${clientName}'s sending reputation`,
  body: ({ clientName, periodLabel, warmup, reportUrl }) => {
    if (!warmup) {
      throw new AppError('INVARIANT_VIOLATION', 'Warmup template rendered without warmup context', {})
    }
    const scoreLine = warmup.closestReputationScore !== null ? `, reputation score ${warmup.closestReputationScore}` : ''
    return (
      `Hey ${clientName} team,\n\n` +
      `No outreach numbers to report ${periodLabel} yet — ${warmup.gatedCount} of ${warmup.totalEnrolled} mailboxes ` +
      `are still building sending reputation with Mailreach. The closest is on day ${warmup.closestElapsedDays} of ` +
      `${warmup.closestGateDays}${scoreLine}. ${warmup.messagesExchanged} messages exchanged so far as part of warmup.\n\n` +
      `Once warmup clears, outreach starts automatically — full detail here: ${reportUrl}\n\n` +
      `Questions? Reply to this email, or grab 15 minutes: ${FEEDBACK_CALL_URL}\n\n` +
      `— Shengul\n\n${SIGNATURE}`
    )
  },
}

export function pickTemplate(priorReportCount: number, useWarmupTemplate: boolean): ReportEmailTemplate {
  if (useWarmupTemplate) return WARMUP_TEMPLATE
  return TEMPLATES[priorReportCount % TEMPLATES.length]!
}
```

`email-templates.ts` does not currently import `AppError` — this change adds `import { AppError } from '@/lib/errors/app-error'` alongside the existing `assertNoHeaderInjection` import. The 7 existing templates ignore the new `warmup` field on their input (they never reference it) — no change to their bodies.

### 7d. Wiring in `generate.ts`

```ts
const gatedMailboxes = (validatedMetrics.warmup ?? []).filter((w) => w.isGated)
const useWarmupTemplate = validatedMetrics.overview.emailsSent === 0 && gatedMailboxes.length > 0
const template = pickTemplate(priorCount, useWarmupTemplate)
const templateInput: ReportEmailTemplateInput = {
  clientName: client.name,
  periodLabel: period.periodLabel,
  leadsFound: validatedMetrics.overview.leadsDiscovered,
  emailsSent: validatedMetrics.overview.emailsSent,
  repliesReceived: validatedMetrics.overview.repliesReceived,
  reportUrl: reportUrlFor(report.id),
  warmup: useWarmupTemplate ? buildWarmupTemplateContext(validatedMetrics.warmup ?? []) : null,
}
```

And the commentary call passes `warmup: validatedMetrics.warmup ?? []` / `buildFallbackCommentary(period.periodLabel, validatedMetrics.overview, validatedMetrics.warmup ?? [])`.

### 7e. Report detail page

`src/app/(app)/reports/[id]/page.tsx` — new `src/app/(app)/reports/[id]/warmup-panel.tsx`, rendered from the frozen snapshot (so it reflects what was true at generation time, not current live state), positioned right after `PageHeader` and before the three stat tiles:

```tsx
{metrics.warmup && metrics.warmup.length > 0 ? <WarmupPanel mailboxes={metrics.warmup} /> : null}
```

Panel content: a one-line summary (`{gated} of {total} mailboxes were still building sending reputation during this period`) plus a compact per-mailbox list (email · day X/14 or "Warm" · reputation).

## 8. i18n

Both `/home` and `/reports` are client-facing (translations required). `/analytics` is reachable directly by client-role users too (RLS-scoped `SECURITY INVOKER` functions, no route guard restricting it to operators — confirmed by reading `analytics-view.tsx`), so it also gets real translations, consistent with its existing fully-translated state. `/settings` (operator-only controls) and internal pipeline code are untouched.

**`src/messages/en.json`** additions:

```json
"home": {
  "warmupBanner": {
    "title": "Building your sending reputation",
    "progress": "{gated} of {total} mailboxes still warming up",
    "closest": "Closest to ready: day {elapsed} of {gate}",
    "reputation": "Reputation score: {score}",
    "messagesExchanged": "{count} messages exchanged so far",
    "viewDetails": "View mailbox details"
  }
}
```

```json
"analytics": {
  "sectionMailboxWarmup": "Mailbox warmup",
  "mailboxWarmupTable": {
    "mailbox": "Mailbox",
    "status": "Status",
    "statusWarming": "Day {elapsed} of {gate}",
    "statusWarm": "Warm",
    "reputation": "Reputation",
    "sent": "Messages sent",
    "received": "Messages received",
    "spam": "Landed in spam",
    "activeConversations": "Active conversations"
  }
}
```

```json
"reports": {
  "warmupPanel": {
    "title": "Warming up your mailboxes",
    "description": "{gated} of {total} mailboxes were still building sending reputation during this period.",
    "mailbox": "Mailbox",
    "status": "Status",
    "statusWarming": "Day {elapsed} of {gate}",
    "statusWarm": "Warm",
    "reputation": "Reputation"
  }
}
```

**`src/messages/tr.json`** — real translations, not English fallbacks:

```json
"home": {
  "warmupBanner": {
    "title": "E-posta itibarınız oluşturuluyor",
    "progress": "{total} kutudan {gated} tanesi hâlâ ısınma sürecinde",
    "closest": "Hazıra en yakın: {gate} günün {elapsed}. günü",
    "reputation": "İtibar puanı: {score}",
    "messagesExchanged": "Şu ana kadar {count} e-posta alışverişi yapıldı",
    "viewDetails": "Kutu detaylarını görüntüle"
  }
}
```

```json
"analytics": {
  "sectionMailboxWarmup": "Kutu ısınması",
  "mailboxWarmupTable": {
    "mailbox": "Kutu",
    "status": "Durum",
    "statusWarming": "{gate} günün {elapsed}. günü",
    "statusWarm": "Isındı",
    "reputation": "İtibar",
    "sent": "Gönderilen mesaj",
    "received": "Alınan mesaj",
    "spam": "Spam'e düşen",
    "activeConversations": "Aktif konuşmalar"
  }
}
```

```json
"reports": {
  "warmupPanel": {
    "title": "Kutularınız ısınıyor",
    "description": "Bu dönemde {total} kutudan {gated} tanesi hâlâ gönderim itibarı oluşturuyordu.",
    "mailbox": "Kutu",
    "status": "Durum",
    "statusWarming": "{gate} günün {elapsed}. günü",
    "statusWarm": "Isındı",
    "reputation": "İtibar"
  }
}
```

## 9. Explicitly out of scope

- Adding `mailboxes` to the Supabase Realtime publication so the banner/section live-update without a page refresh. Warmup numbers change on a 6-hourly sync cadence or once per calendar day (the day counter) — not event-driven — and `mailboxes` is deliberately excluded from realtime today (see `0008_analytics.sql`'s comment). Both pages are `force-dynamic`, so any navigation/reload already shows current data.
- Per-provider reputation breakdown (`score_gmail`/`score_outlook`/`score_custom` from the real `Account` object) — only the aggregate `score` is pulled, matching exactly what was asked for.
- A reputation-score trend/sparkline on the home banner — no historical time series is stored (only the latest synced value), and building one is a separate feature.
- Any change to `isEligibleForCampaignSend`'s gating logic itself — this work only adds visibility into the existing gate, it doesn't change when sending actually unlocks.

## 10. Testing

- **`src/lib/mailreach/client.test.ts`**: `getAccount` (score present → mapped; `null`/missing → `null`); `getAccountStats` (all four fields present → mapped; missing/null → nulls); assert the `past_days=180` query param is sent.
- **`src/lib/pipeline/mailreach-sync.test.ts`**: both calls succeed → all 5 fields passed to `updateMailboxMailreachStats`; either call rejects → mailbox counted as failed, `updateMailboxMailreachStats` not called for it, sweep continues (existing "one failure doesn't stop the sweep" test extended, not replaced).
- **`src/lib/db/mailboxes.test.ts`**: `listMailreachConnectedMailboxes` with a `clientId` argument adds the extra `.eq('client_id', ...)` filter; without it, behaves exactly as today (existing test kept). `updateMailboxMailreachStats` test extended to assert all 5 fields in the update payload.
- **`src/lib/mailbox/mailreach-gate.test.ts`**: new `describe('summarizeMailboxWarmup')` — empty input → `[]`; `mailreach_enabled: false` → excluded; `clientMailreachEnabled: false` → excluded; `mailreach_status !== 'connected'` → excluded; `mailreach_started_at: null` → excluded (defensive; must not throw); day 0/13 → `isGated: true`; day 14+ → `isGated: false`; null reputation/stats fields pass through as `null`. New `describe('closestToReady')` — empty → `null`; picks max `elapsedDays`; ties keep the first encountered. New `describe('totalMessagesExchanged')` — sums sent+received, treats null as 0, empty array → 0.
- **`src/lib/reports/metrics.ts` test**: `buildReportMetrics` includes `warmup` (non-empty) when the client has enrolled+connected mailboxes; omits it (`undefined`) when none.
- **`src/lib/reports/commentary.test.ts`**: prompt includes the warmup block only when `warmup` is non-empty and has ≥1 gated mailbox; `buildFallbackCommentary` — `emailsSent: 0` + gated mailboxes → warmup headline/summary/highlights; `emailsSent > 0` → normal fallback even with warmup data present; no gated mailboxes → normal fallback.
- **`src/lib/reports/email-templates.test.ts`**: `buildWarmupTemplateContext` — no gated mailboxes → `null`; gated mailboxes → correct aggregate. `pickTemplate(n, true)` always returns the warmup template regardless of `n`; `pickTemplate(n, false)` unchanged rotation (existing tests kept). Rendered warmup body contains no "0" lead/email count wording and includes the day counter.
- **`src/lib/reports/generate.test.ts`**: `emailsSent === 0` + gated mailbox → warmup template used, commentary called with non-empty `warmup`; `emailsSent > 0` (even with one mailbox still gated) → normal rotating template, per the narrower template-trigger condition in §7d.
- **No new component tests** for `warmup-banner.tsx`, the Analytics section, or `warmup-panel.tsx` — consistent with this repo's existing convention (no `.test.tsx` files for page-level components anywhere in `(app)/home`, `(app)/analytics`, or `(app)/reports`; QUALITY.md's "React components: critical paths only" is satisfied here by the pure logic underneath being fully covered).
- `pnpm typecheck && pnpm lint && pnpm test` all clean before calling this done.
