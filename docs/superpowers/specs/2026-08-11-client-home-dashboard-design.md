# Client Home Dashboard — Design

**Date:** 2026-08-11
**Status:** Approved, pending implementation plan

## Problem

There is no home/dashboard page today. Login sends every user straight to
`/crm` (the pipeline board). Clients have no single place to see, at a
glance: how their campaigns are performing, what leads were just found,
what's waiting on their approval, and what mail recently went out. They have
to know to check `/analytics`, `/inbox`, `/mail`, and `/crm` separately.

## Scope

Client-role users only. Operators are unaffected — they keep landing on
`/crm` and never see this page. (Operators aren't scoped to one client, so a
per-client dashboard doesn't apply to them; an operator-facing rollup, if
ever wanted, is a separate future project.)

## 1. Routing & access

- New route: `src/app/(app)/home/` — `page.tsx`, `loading.tsx`, `error.tsx`,
  matching the shape of the existing `/analytics` route.
- `page.tsx` calls `requireUser()` (same as every other page in `(app)`). If
  `appUser.role === 'operator'`, it immediately `redirect('/crm')` — this
  page is client-only.
- `src/app/login/page.tsx`: change the post-sign-in `router.push('/crm')` to
  `router.push('/home')`. No client-side role lookup is needed at login
  because `/home` itself redirects operators server-side.
- `src/components/shell/nav.tsx`: add a `Home` item at the top of
  `PRIMARY_NAV`, above Pipeline. `NavItem` gains a `clientOnly?: boolean`
  flag (mirrors the existing `operatorOnly`) so operators never see a link to
  a page that immediately redirects them away.
- No change to `src/lib/auth/public-paths.ts` — `/home` is protected the same
  way every other `(app)` route already is (via the layout's `requireUser()`
  plus the page's own `requireUser()` call).

## 2. Data layer

Reuses existing `lib/db` functions directly, all RLS-scoped via the
session-bound `createServerClient()`:

- `getOverviewMetrics` + `getDailyMetrics` (`src/lib/db/analytics.ts`),
  scoped `{ clientId: appUser.client_id, campaignId: null }`, fixed 14-day
  range. No filter UI on Home — `/analytics` remains the place for that.
- `listCampaignsForClient` (`src/lib/db/campaigns.ts`), filtered in-memory to
  `status === 'active'`, for "Running Campaigns" and the active-campaign
  count stat tile.
- `listEmailsForClient` (`src/lib/db/emails.ts`) with
  `{ direction: 'outbound', limit: 5 }` for "Recent Mail."
- `listDraftEmailsForClient` + `listOpenKnowledgeRequestsForClient`
  (`src/lib/db/emails.ts`, `src/lib/db/knowledge-requests.ts`) — the same
  two lists the layout already fetches for the nav badge, reused here for
  the pending-actions card.

One new function, since no "recent leads for a client" query exists yet:

```ts
// src/lib/db/leads.ts
export interface RecentLeadForClient {
  id: string
  fullName: string
  title: string | null
  companyName: string | null
  status: Database['public']['Enums']['lead_status']
  emailStatus: Database['public']['Enums']['lead_email_status']
  caseId: string | null
  createdAt: string
}

export async function listRecentLeadsForClient(
  supabase: SupabaseClient<Database>,
  { limit }: { limit: number },
): Promise<RecentLeadForClient[]>
```

`select('id, full_name, title, company_name, status, email_status, case_id, created_at')`,
`.order('created_at', { ascending: false })`, `.limit(limit)`, mapped
snake_case → camelCase per project convention. RLS scopes it to the caller's
client automatically — no explicit `client_id` filter needed (matches the
pattern of every other `listXForClient` function in this codebase).

All five queries (`getOverviewMetrics`, `getDailyMetrics`,
`listCampaignsForClient`, `listEmailsForClient`, `listRecentLeadsForClient`)
plus the two pending-action lists run in one `Promise.all` in `page.tsx`.

## 3. Page composition

`PageHeader` (title only, no filter controls), then:

```
PageHeader — "Home"
────────────────────────────────────────────────
Stat tile grid (4 tiles, same grid classes as /analytics):
  Leads found (14d) · Emails sent (14d) · Replies (14d) · Active campaigns
────────────────────────────────────────────────
Two-column row (stacks to 1 col below md):
  ┌─ Needs your action ──────┐  ┌─ Activity trend (14d) ───────┐
  │ drafts + knowledge count │  │ SparklineChart, same series  │
  │ or "all caught up"       │  │ as /analytics                │
  └───────────────────────────┘  └───────────────────────────────┘
────────────────────────────────────────────────
Two-column row (stacks to 1 col below md):
  ┌─ Running campaigns ──────┐  ┌─ Latest leads found ─────────┐
  │ up to 5 active campaigns │  │ up to 5 most recent leads    │
  └───────────────────────────┘  └───────────────────────────────┘
────────────────────────────────────────────────
Recent mail — full-width list, up to 5 most recent outbound emails
```

### Stat tiles
Reuse `StatTile` unmodified. Values: `leadsDiscovered` and `emailsSent` from
`getOverviewMetrics`, `repliesReceived` from the same, and active-campaign
count from the filtered `listCampaignsForClient` result (not from
`getOverviewMetrics`, which has no campaign-count field).

### Needs your action
A `Section` wrapping one card. If `drafts.length + knowledgeRequests.length
=== 0`: calm "You're all caught up" message, not a dashed empty-state box
(this is a good state, not a missing-data state). Otherwise: the count plus
a one-line breakdown ("2 drafts, 1 question waiting"), linking to `/inbox`.

### Activity trend
Reuse `SparklineChart` exactly as `/analytics` renders it — same props
shape, fed by the 14-day `getDailyMetrics` call. No campaign/client picker.

### Running campaigns
Up to 5 active campaigns. Each row: name, daily target, `StatusPill` for
status. Row links to `/analytics?campaign=<id>` — clients have no
`/campaigns` route (operator-only), so a campaign-filtered analytics view is
the closest read-only drill-down that already exists. Empty state (no active
campaigns) via the existing `EmptyState` component.

### Latest leads found
Up to 5 most recent leads. Each row: full name, "title @ company", an
email-status `StatusPill`, relative created-at time. Row links to
`/cases/[id]` when `caseId` is set, otherwise unlinked (a lead can exist
before grouping into a case). Empty state via `EmptyState`.

### Recent mail
Up to 5 most recent outbound emails: subject/preview, recipient, relative
sent time, status pill (sent / bounced / failed / draft). Row links into
`/mail`. Empty state via `EmptyState`.

## 4. Real-time, loading, error, i18n

- **Real-time**: same `RealtimeRefresher` pattern as `/analytics` — a client
  component subscribed to `leads`, `cases`, `emails` insert/update events,
  debounced `router.refresh()`. RLS scopes the subscription to the viewer's
  own client, same as the existing implementation.
- **Loading**: `loading.tsx` mirrors the stat-tile-grid + card skeleton
  shapes used by `/analytics/loading.tsx`.
- **Error**: standard `error.tsx` boundary, consistent with every other
  route.
- **Empty states**: each list widget (campaigns, leads, mail) gets its own
  `EmptyState`. The trend chart's zero-data case (a brand-new client) reuses
  whatever `SparklineChart` already renders for an all-zero series.
- **i18n**: this page is client-facing, so every string is translated per
  the project's translation policy. New `home` namespace added to
  `src/messages/en.json` and `src/messages/tr.json`: `pageTitle`,
  `welcomeBack` (if used), stat tile labels, section titles
  (`needsYourAction`, `activityTrend`, `runningCampaigns`, `latestLeads`,
  `recentMail`), empty-state copy per widget, `allCaughtUp`. Plus one new
  `nav.home` key.

## 5. Testing

- `listRecentLeadsForClient`: new tests colocated in
  `src/lib/db/leads.test.ts` — happy path (rows returned, mapped
  correctly), empty result, error path (mapped to `AppError`).
- No page-level component tests exist anywhere in this codebase today —
  every route under `(app)` is a thin Server Component composing already-
  tested `lib/db` functions, and `/home` follows that same pattern. It is
  not tested in isolation; its only new logic (the operator-redirect branch
  and the `Promise.all` composition) is straightforward composition, not
  business logic.
- Manual verification before considering this done: sign in as a client
  user and confirm landing on `/home`; confirm an operator still lands on
  `/crm`; confirm all five empty states render correctly for a client with
  no data yet; confirm every widget's link target resolves.

## Out of scope (explicitly)

- Any operator-facing rollup/dashboard.
- Filter controls on Home (date range, campaign picker) — `/analytics`
  already owns that.
- New visual design system, motion, or typography — this page matches the
  existing app's Inter/Geist Mono, shadcn-style component set exactly, per
  explicit user decision during brainstorming.
