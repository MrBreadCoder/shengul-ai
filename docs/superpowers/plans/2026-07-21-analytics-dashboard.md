# Analytics Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship an RLS-scoped `/analytics` page that reports the whole outreach funnel — leads discovered, cases created, emails sent, reply/bounce rates, per-campaign and per-mailbox breakdowns, daily trend, and agent activity — recomputed on the server and refreshed live via Supabase Realtime.

**Architecture:** Five `stable`, SECURITY **INVOKER** SQL aggregate functions do all the counting in Postgres, so RLS decides what each viewer can see (operator = all clients, client role = own `client_id`). Thin typed wrappers in `src/lib/db/analytics.ts` call them through the session-bound Supabase client and map `snake_case` → `camelCase`. `/analytics` is a Server Component that renders stat tiles, tables, and an inline-SVG sparkline — no chart library, no client-side data fetching. A single tiny `'use client'` component subscribes to Supabase Realtime `postgres_changes` on `emails` / `leads` / `cases` and calls `router.refresh()` (debounced), so the server recomputes and re-renders the numbers as the pipeline runs.

**Tech Stack:** Next.js 16 App Router (Server Components), Supabase Postgres + RLS + Realtime, `@supabase/ssr`, Zod 4, Vitest, TypeScript strict.

## Global Constraints

- Package manager is **pnpm only**. Never run `npm install` in this repo — it corrupts the tree.
- **No new dependencies.** No chart library. Inline SVG only.
- Data access lives **exclusively** in `src/lib/db/` (`.claude/QUALITY.md`). Pages and components never call `supabase.from(...)` or `supabase.rpc(...)` directly.
- Reads on `/analytics` use the **session-bound** client (`createServerClient()`), never `createAdminClient()` — RLS is the authorization boundary.
- DB columns are `snake_case`; TypeScript is `camelCase`. Map explicitly at the db layer.
- Files: `kebab-case.ts(x)`. Components: `PascalCase`. Constants: `UPPER_SNAKE_CASE`. Named exports everywhere except Next.js `page`/`loading`/`error` default exports.
- No `any`, no `console.log`, no `TODO`/`FIXME`, no commented-out code. Explicit return types on every function.
- Every DB error is mapped to `AppError('DB_ERROR', ...)` — raw Supabase errors never escape the db layer.
- Every new page route ships `loading.tsx` and `error.tsx`, and handles loading / error / empty / success states.
- Tests colocate as `feature.test.ts`; naming is `it('should ... when ...')`; Arrange-Act-Assert. Unit tests mock at the Supabase boundary and never hit a live service. `*.integration.test.ts` is excluded from `pnpm test` and runs via `pnpm test:integration`.
- Update `.claude/roadmap.md` when the work lands (P4 "Operator observability dashboard").
- Verification commands: `pnpm test`, `pnpm typecheck`, `pnpm lint`. `env.test.ts` has one pre-existing eslint warning — that one is expected, anything else is not.

---

## File Structure

**Created:**
- `supabase/migrations/0008_analytics.sql` — five aggregate functions, supporting indexes, Realtime publication membership.
- `src/types/analytics.ts` — camelCase view types shared by the db layer and the UI.
- `src/lib/analytics/range.ts` (+ `.test.ts`) — pure date-range + search-param parsing.
- `src/lib/analytics/rates.ts` (+ `.test.ts`) — pure rate math and display formatting.
- `src/lib/analytics/sparkline.ts` (+ `.test.ts`) — pure SVG bar geometry.
- `src/lib/db/analytics.ts` (+ `.test.ts`) — the five RPC wrappers.
- `src/lib/db/analytics.integration.test.ts` — RLS scoping proof against a live local Supabase.
- `src/app/analytics/page.tsx`, `loading.tsx`, `error.tsx` — the route.
- `src/app/analytics/stat-tile.tsx`, `sparkline-chart.tsx` — presentational Server Components.
- `src/app/analytics/filters.tsx`, `realtime-refresher.tsx` — the only two Client Components.

**Modified:**
- `src/types/database.ts` — add the five functions to the `Functions` block.
- `src/app/crm/page.tsx` — link to `/analytics` (otherwise the page is unreachable; there is no global nav).
- `.claude/roadmap.md` — record P4 progress.

Responsibility split: SQL owns aggregation, `src/lib/analytics/*` owns pure logic (100% unit-tested), `src/lib/db/analytics.ts` owns the RPC boundary + mapping, `src/app/analytics/*` owns rendering only.

---

### Task 1: Analytics SQL functions + generated types

**Files:**
- Create: `supabase/migrations/0008_analytics.sql`
- Modify: `src/types/database.ts:524-545` (the `Functions` block)

**Interfaces:**
- Consumes: existing tables `leads`, `cases`, `emails`, `sequences`, `suppressions`, `mailboxes`, `campaigns`, `events`; RLS policies from `0002_rls_policies.sql`.
- Produces: RPCs `analytics_overview(p_from timestamptz, p_to timestamptz, p_campaign_id uuid)`, `analytics_daily(p_from, p_to, p_campaign_id)`, `analytics_by_campaign(p_from, p_to)`, `analytics_mailboxes()`, `analytics_event_counts(p_from, p_to, p_limit int)`. Every one returns a **set of rows** (PostgREST returns a JSON array). Column names are consumed verbatim by Task 3.

- [x] **Step 1: Write the migration**

Create `supabase/migrations/0008_analytics.sql`:

```sql
-- Analytics dashboard (roadmap P4 "operator observability dashboard").
--
-- Every function here is SECURITY INVOKER (the default for `language sql`
-- without `security definer`) and `stable`. That is deliberate and load
-- bearing: aggregation runs as the calling role, so the RLS policies from
-- 0002_rls_policies.sql decide the row set — an operator aggregates every
-- client, a client role aggregates only its own client_id. Never add
-- `security definer` to these; it would leak cross-client counts.
--
-- Window semantics, applied consistently:
--   * leads / cases / suppressions / events -> counted by created_at.
--   * outbound emails                       -> counted by coalesce(sent_at, created_at),
--                                              because a failed send never sets sent_at.
--   * inbound emails                        -> counted by created_at (ingest time).
--   * "sent" means status in ('sent','delivered','bounced') — a bounced email
--     was still delivered to the provider, so rates are computed over it.
--   * Columns documented as SNAPSHOT ignore the window entirely: they answer
--     "right now" (active sequences, current case statuses).
-- Ranges are half-open: p_from <= t < p_to.
--
-- p_campaign_id is null => no campaign filter. Emails carry no campaign_id, so
-- they are filtered through their case; the LEFT JOIN keeps case-less emails
-- visible in the unfiltered view and excludes them from a filtered one.

-- ---------- Indexes for the time-window scans ----------
create index if not exists idx_leads_created_at        on public.leads (created_at desc);
create index if not exists idx_cases_created_at        on public.cases (created_at desc);
create index if not exists idx_cases_campaign_status   on public.cases (campaign_id, status);
create index if not exists idx_emails_sent_at          on public.emails (sent_at desc);
create index if not exists idx_emails_created_at       on public.emails (created_at desc);
create index if not exists idx_emails_direction_status on public.emails (direction, status);
create index if not exists idx_emails_mailbox          on public.emails (mailbox_id);
create index if not exists idx_events_type_created     on public.events (type, created_at desc);
create index if not exists idx_suppressions_created_at on public.suppressions (created_at desc);
create index if not exists idx_sequences_case_state    on public.sequences (case_id, state);

-- ---------- 1. Overview counters ----------
create or replace function public.analytics_overview(
  p_from         timestamptz,
  p_to           timestamptz,
  p_campaign_id  uuid default null
)
returns table (
  leads_discovered        bigint,
  leads_verified          bigint,
  cases_created           bigint,
  emails_sent             bigint,
  first_touch_sent        bigint,
  followups_sent          bigint,
  emails_bounced          bigint,
  emails_failed           bigint,
  replies_received        bigint,
  leads_contacted         bigint,
  leads_replied           bigint,
  suppressions_added      bigint,
  active_sequences        bigint
)
language sql
stable
as $$
  select
    -- leads_discovered
    (select count(*) from public.leads l
      where l.created_at >= p_from and l.created_at < p_to
        and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    -- leads_verified
    (select count(*) from public.leads l
      where l.created_at >= p_from and l.created_at < p_to
        and l.email_status = 'verified'
        and (p_campaign_id is null or l.campaign_id = p_campaign_id)),
    -- cases_created
    (select count(*) from public.cases c
      where c.created_at >= p_from and c.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- emails_sent
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- first_touch_sent (sequence_step 0 is the cold open)
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.sequence_step = 0
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- followups_sent
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.sequence_step > 0
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- emails_bounced
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status = 'bounced'
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- emails_failed
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status = 'failed'
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- replies_received
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'inbound'
        and e.created_at >= p_from and e.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- leads_contacted (distinct people we actually emailed in the window)
    (select count(distinct e.lead_id) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.lead_id is not null
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- leads_replied (distinct people who wrote back in the window)
    (select count(distinct e.lead_id) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'inbound'
        and e.lead_id is not null
        and e.created_at >= p_from and e.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)),
    -- suppressions_added. Suppressions are client-wide (no campaign_id), so
    -- this column intentionally ignores p_campaign_id; the UI labels it as such.
    (select count(*) from public.suppressions s
      where s.created_at >= p_from and s.created_at < p_to),
    -- active_sequences (SNAPSHOT: follow-up cadences still running)
    (select count(*) from public.sequences q
       left join public.cases c on c.id = q.case_id
      where q.state = 'active'
        and (p_campaign_id is null or c.campaign_id = p_campaign_id));
$$;

-- ---------- 2. Daily trend ----------
-- One row per UTC day across the whole window, zero-filled so the sparkline has
-- no gaps. date_trunc runs in the database timezone (UTC on Supabase).
create or replace function public.analytics_daily(
  p_from        timestamptz,
  p_to          timestamptz,
  p_campaign_id uuid default null
)
returns table (
  day              date,
  leads_discovered bigint,
  emails_sent      bigint,
  replies_received bigint
)
language sql
stable
as $$
  with days as (
    select generate_series(
             date_trunc('day', p_from),
             date_trunc('day', p_to - interval '1 microsecond'),
             interval '1 day'
           )::date as day
  ),
  discovered as (
    select date_trunc('day', l.created_at)::date as day, count(*) as n
      from public.leads l
     where l.created_at >= p_from and l.created_at < p_to
       and (p_campaign_id is null or l.campaign_id = p_campaign_id)
     group by 1
  ),
  sent as (
    select date_trunc('day', coalesce(e.sent_at, e.created_at))::date as day, count(*) as n
      from public.emails e
      left join public.cases c on c.id = e.case_id
     where e.direction = 'outbound'
       and e.status in ('sent', 'delivered', 'bounced')
       and coalesce(e.sent_at, e.created_at) >= p_from
       and coalesce(e.sent_at, e.created_at) < p_to
       and (p_campaign_id is null or c.campaign_id = p_campaign_id)
     group by 1
  ),
  replies as (
    select date_trunc('day', e.created_at)::date as day, count(*) as n
      from public.emails e
      left join public.cases c on c.id = e.case_id
     where e.direction = 'inbound'
       and e.created_at >= p_from and e.created_at < p_to
       and (p_campaign_id is null or c.campaign_id = p_campaign_id)
     group by 1
  )
  select d.day,
         coalesce(discovered.n, 0),
         coalesce(sent.n, 0),
         coalesce(replies.n, 0)
    from days d
    left join discovered on discovered.day = d.day
    left join sent       on sent.day = d.day
    left join replies    on replies.day = d.day
   order by d.day;
$$;

-- ---------- 3. Per-campaign breakdown ----------
-- Windowed activity columns + a SNAPSHOT of the current case-status board.
create or replace function public.analytics_by_campaign(
  p_from timestamptz,
  p_to   timestamptz
)
returns table (
  campaign_id          uuid,
  campaign_name        text,
  client_id            uuid,
  campaign_status      public.campaign_status,
  leads_discovered     bigint,
  leads_verified       bigint,
  cases_created        bigint,
  emails_sent          bigint,
  leads_contacted      bigint,
  leads_replied        bigint,
  cases_new            bigint,
  cases_researching    bigint,
  cases_ready          bigint,
  cases_contacted      bigint,
  cases_in_conversation bigint,
  cases_hot_handoff    bigint,
  cases_won            bigint,
  cases_lost           bigint,
  cases_dead           bigint
)
language sql
stable
as $$
  select
    cp.id,
    cp.name,
    cp.client_id,
    cp.status,
    (select count(*) from public.leads l
      where l.campaign_id = cp.id
        and l.created_at >= p_from and l.created_at < p_to),
    (select count(*) from public.leads l
      where l.campaign_id = cp.id and l.email_status = 'verified'
        and l.created_at >= p_from and l.created_at < p_to),
    (select count(*) from public.cases c
      where c.campaign_id = cp.id
        and c.created_at >= p_from and c.created_at < p_to),
    (select count(*) from public.emails e
       join public.cases c on c.id = e.case_id
      where c.campaign_id = cp.id
        and e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to),
    (select count(distinct e.lead_id) from public.emails e
       join public.cases c on c.id = e.case_id
      where c.campaign_id = cp.id
        and e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.lead_id is not null
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to),
    (select count(distinct e.lead_id) from public.emails e
       join public.cases c on c.id = e.case_id
      where c.campaign_id = cp.id
        and e.direction = 'inbound'
        and e.lead_id is not null
        and e.created_at >= p_from and e.created_at < p_to),
    st.c_new, st.c_researching, st.c_ready, st.c_contacted,
    st.c_in_conversation, st.c_hot_handoff, st.c_won, st.c_lost, st.c_dead
  from public.campaigns cp
  left join lateral (
    select
      count(*) filter (where c.status = 'new')             as c_new,
      count(*) filter (where c.status = 'researching')     as c_researching,
      count(*) filter (where c.status = 'ready')           as c_ready,
      count(*) filter (where c.status = 'contacted')       as c_contacted,
      count(*) filter (where c.status = 'in_conversation') as c_in_conversation,
      count(*) filter (where c.status = 'hot_handoff')     as c_hot_handoff,
      count(*) filter (where c.status = 'won')             as c_won,
      count(*) filter (where c.status = 'lost')            as c_lost,
      count(*) filter (where c.status = 'dead')            as c_dead
    from public.cases c
    where c.campaign_id = cp.id
  ) st on true
  order by cp.name;
$$;

-- ---------- 4. Mailbox health / utilisation (SNAPSHOT + lifetime totals) ----------
create or replace function public.analytics_mailboxes()
returns table (
  mailbox_id    uuid,
  client_id     uuid,
  email_address text,
  provider      public.mailbox_provider,
  health        public.mailbox_health,
  daily_cap     integer,
  sent_today    integer,
  sent_total    bigint,
  bounced_total bigint,
  failed_total  bigint,
  last_sent_at  timestamptz
)
language sql
stable
as $$
  select
    m.id, m.client_id, m.email_address, m.provider, m.health, m.daily_cap, m.sent_today,
    coalesce(agg.sent_total, 0),
    coalesce(agg.bounced_total, 0),
    coalesce(agg.failed_total, 0),
    agg.last_sent_at
  from public.mailboxes m
  left join lateral (
    select
      count(*) filter (where e.status in ('sent', 'delivered', 'bounced')) as sent_total,
      count(*) filter (where e.status = 'bounced')                        as bounced_total,
      count(*) filter (where e.status = 'failed')                         as failed_total,
      max(e.sent_at)                                                      as last_sent_at
    from public.emails e
    where e.mailbox_id = m.id and e.direction = 'outbound'
  ) agg on true
  order by m.email_address;
$$;

-- ---------- 5. Agent activity from the audit log ----------
create or replace function public.analytics_event_counts(
  p_from  timestamptz,
  p_to    timestamptz,
  p_limit integer
)
returns table (
  event_type  text,
  event_count bigint
)
language sql
stable
as $$
  select e.type, count(*)
    from public.events e
   where e.created_at >= p_from and e.created_at < p_to
   group by e.type
   order by count(*) desc, e.type asc
   limit p_limit;
$$;

grant execute on function public.analytics_overview(timestamptz, timestamptz, uuid)     to authenticated;
grant execute on function public.analytics_daily(timestamptz, timestamptz, uuid)        to authenticated;
grant execute on function public.analytics_by_campaign(timestamptz, timestamptz)        to authenticated;
grant execute on function public.analytics_mailboxes()                                  to authenticated;
grant execute on function public.analytics_event_counts(timestamptz, timestamptz, integer) to authenticated;

-- ---------- Realtime ----------
-- The dashboard does not stream rows; it listens for "something changed" and
-- re-runs the server-side aggregation. Only INSERT/UPDATE on these three tables
-- can move a number on the page. RLS is enforced by Realtime against the new
-- record, and we never read the `old` record, so REPLICA IDENTITY stays default
-- (FULL would double WAL volume on the hottest table for no benefit).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'emails'
    ) then
      execute 'alter publication supabase_realtime add table public.emails';
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'leads'
    ) then
      execute 'alter publication supabase_realtime add table public.leads';
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'cases'
    ) then
      execute 'alter publication supabase_realtime add table public.cases';
    end if;
  end if;
end $$;
```

- [ ] **Step 2: Apply the migration locally and verify it loads**

Run:

```bash
pnpm supabase start
pnpm supabase db reset
```

Expected: `supabase db reset` replays `0001` … `0008` and finishes with `Finished supabase db reset.` — no `ERROR:` lines.

If Docker/`supabase start` is unavailable in this environment, stop and report that the migration could not be applied; do not fake the verification.

- [ ] **Step 3: Smoke-test each function against the local database**

Run:

```bash
pnpm supabase db reset >/dev/null 2>&1 && psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c "
  select * from public.analytics_overview(now() - interval '30 days', now(), null);
  select count(*) from public.analytics_daily(now() - interval '7 days', now(), null);
  select count(*) from public.analytics_by_campaign(now() - interval '30 days', now());
  select count(*) from public.analytics_mailboxes();
  select count(*) from public.analytics_event_counts(now() - interval '30 days', now(), 10);
"
```

Expected: five result sets, all zeros/empty on a fresh database, and `analytics_daily` returns exactly `7` rows (the zero-filled day series). No errors.

- [x] **Step 4: Add the function types to `src/types/database.ts`**

In the `Functions: {` block (after the `find_stuck_cases` entry, before the closing `}`), add:

```ts
      analytics_overview: {
        Args: { p_from: string; p_to: string; p_campaign_id?: string | null }
        Returns: {
          leads_discovered: number
          leads_verified: number
          cases_created: number
          emails_sent: number
          first_touch_sent: number
          followups_sent: number
          emails_bounced: number
          emails_failed: number
          replies_received: number
          leads_contacted: number
          leads_replied: number
          suppressions_added: number
          active_sequences: number
        }[]
      }
      analytics_daily: {
        Args: { p_from: string; p_to: string; p_campaign_id?: string | null }
        Returns: {
          day: string
          leads_discovered: number
          emails_sent: number
          replies_received: number
        }[]
      }
      analytics_by_campaign: {
        Args: { p_from: string; p_to: string }
        Returns: {
          campaign_id: string
          campaign_name: string
          client_id: string
          campaign_status: Database['public']['Enums']['campaign_status']
          leads_discovered: number
          leads_verified: number
          cases_created: number
          emails_sent: number
          leads_contacted: number
          leads_replied: number
          cases_new: number
          cases_researching: number
          cases_ready: number
          cases_contacted: number
          cases_in_conversation: number
          cases_hot_handoff: number
          cases_won: number
          cases_lost: number
          cases_dead: number
        }[]
      }
      analytics_mailboxes: {
        Args: Record<string, never>
        Returns: {
          mailbox_id: string
          client_id: string
          email_address: string
          provider: Database['public']['Enums']['mailbox_provider']
          health: Database['public']['Enums']['mailbox_health']
          daily_cap: number
          sent_today: number
          sent_total: number
          bounced_total: number
          failed_total: number
          last_sent_at: string | null
        }[]
      }
      analytics_event_counts: {
        Args: { p_from: string; p_to: string; p_limit: number }
        Returns: { event_type: string; event_count: number }[]
      }
```

- [x] **Step 5: Typecheck**

Run: `pnpm typecheck`
Expected: exits 0, no output.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/0008_analytics.sql src/types/database.ts
git commit -m "feat(analytics): add RLS-scoped aggregate SQL functions and realtime publication"
```

---

### Task 2: Pure analytics helpers (range, rates, sparkline geometry)

**Files:**
- Create: `src/lib/analytics/range.ts`, `src/lib/analytics/range.test.ts`
- Create: `src/lib/analytics/rates.ts`, `src/lib/analytics/rates.test.ts`
- Create: `src/lib/analytics/sparkline.ts`, `src/lib/analytics/sparkline.test.ts`

**Interfaces:**
- Consumes: nothing from earlier tasks (Zod only).
- Produces:
  - `RANGE_OPTIONS: readonly [7, 30, 90]`, `type RangeDays = 7 | 30 | 90`, `DEFAULT_RANGE_DAYS: RangeDays`
  - `parseRangeDays(raw: number | undefined): RangeDays`
  - `interface DateRange { from: string; to: string }`
  - `rangeFromDays(days: RangeDays, now: Date): DateRange`
  - `analyticsSearchParamsSchema` (Zod) with `{ days?: number; campaign?: string }`
  - `rate(numerator: number, denominator: number): number | null`
  - `formatPercent(value: number | null): string`
  - `formatCount(value: number): string`
  - `formatDateTime(iso: string | null): string`
  - `interface SparkBar { x, y, width, height }`, `interface SparklineGeometry { width, height, max, bars }`, `buildSparkline(values: readonly number[]): SparklineGeometry`

- [x] **Step 1: Write the failing tests for `range.ts`**

Create `src/lib/analytics/range.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import {
  parseRangeDays,
  rangeFromDays,
  analyticsSearchParamsSchema,
  DEFAULT_RANGE_DAYS,
} from './range'

describe('parseRangeDays', () => {
  it('should return the value when it is a supported range', () => {
    expect(parseRangeDays(7)).toBe(7)
    expect(parseRangeDays(90)).toBe(90)
  })

  it('should fall back to the default when the value is unsupported', () => {
    expect(parseRangeDays(13)).toBe(DEFAULT_RANGE_DAYS)
  })

  it('should fall back to the default when the value is undefined', () => {
    expect(parseRangeDays(undefined)).toBe(DEFAULT_RANGE_DAYS)
  })
})

describe('rangeFromDays', () => {
  it('should end at the start of the next UTC day so today is included', () => {
    const now = new Date('2026-07-21T13:45:00.000Z')
    expect(rangeFromDays(7, now).to).toBe('2026-07-22T00:00:00.000Z')
  })

  it('should start N days before the end boundary', () => {
    const now = new Date('2026-07-21T13:45:00.000Z')
    expect(rangeFromDays(7, now).from).toBe('2026-07-15T00:00:00.000Z')
  })

  it('should span 30 UTC days for the 30-day range', () => {
    const now = new Date('2026-01-05T00:00:01.000Z')
    const { from, to } = rangeFromDays(30, now)
    const spanDays = (Date.parse(to) - Date.parse(from)) / 86_400_000
    expect(spanDays).toBe(30)
  })
})

describe('analyticsSearchParamsSchema', () => {
  it('should coerce a numeric days string', () => {
    const parsed = analyticsSearchParamsSchema.safeParse({ days: '30' })
    expect(parsed.success && parsed.data.days).toBe(30)
  })

  it('should accept a uuid campaign filter', () => {
    const id = '11111111-1111-4111-8111-111111111111'
    const parsed = analyticsSearchParamsSchema.safeParse({ campaign: id })
    expect(parsed.success && parsed.data.campaign).toBe(id)
  })

  it('should reject a non-uuid campaign filter', () => {
    expect(analyticsSearchParamsSchema.safeParse({ campaign: 'nope' }).success).toBe(false)
  })

  it('should accept an empty object', () => {
    const parsed = analyticsSearchParamsSchema.safeParse({})
    expect(parsed.success && parsed.data.days).toBeUndefined()
  })
})
```

- [x] **Step 2: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/analytics/range.test.ts`
Expected: FAIL — `Failed to resolve import "./range"`.

- [x] **Step 3: Implement `range.ts`**

Create `src/lib/analytics/range.ts`:

```ts
import { z } from 'zod'

const MS_PER_DAY = 86_400_000

// The ranges the dashboard offers. Anything else in the URL is rejected — the
// value reaches SQL, so it is never taken on trust.
export const RANGE_OPTIONS = [7, 30, 90] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]
export const DEFAULT_RANGE_DAYS: RangeDays = 30

export function parseRangeDays(raw: number | undefined): RangeDays {
  return RANGE_OPTIONS.find((option) => option === raw) ?? DEFAULT_RANGE_DAYS
}

export const analyticsSearchParamsSchema = z.object({
  days: z.coerce.number().int().optional(),
  campaign: z.string().uuid().optional(),
})

export interface DateRange {
  from: string
  to: string
}

// Half-open UTC window [from, to). `to` is the start of tomorrow so today's rows
// count; a 7-day range therefore covers today plus the previous six days, which
// is what `analytics_daily`'s generate_series expands into exactly 7 buckets.
export function rangeFromDays(days: RangeDays, now: Date): DateRange {
  const startOfTomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return {
    from: new Date(startOfTomorrow - days * MS_PER_DAY).toISOString(),
    to: new Date(startOfTomorrow).toISOString(),
  }
}
```

- [x] **Step 4: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/analytics/range.test.ts`
Expected: PASS — 9 tests.

- [x] **Step 5: Write the failing tests for `rates.ts`**

Create `src/lib/analytics/rates.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { rate, formatPercent, formatCount, formatDateTime } from './rates'

describe('rate', () => {
  it('should divide the numerator by the denominator', () => {
    expect(rate(3, 12)).toBe(0.25)
  })

  it('should return null when the denominator is zero', () => {
    expect(rate(5, 0)).toBeNull()
  })

  it('should return null when the denominator is negative', () => {
    expect(rate(5, -1)).toBeNull()
  })
})

describe('formatPercent', () => {
  it('should render one decimal place', () => {
    expect(formatPercent(0.1234)).toBe('12.3%')
  })

  it('should render an em dash when the rate is undefined', () => {
    expect(formatPercent(null)).toBe('—')
  })

  it('should render zero as 0.0%', () => {
    expect(formatPercent(0)).toBe('0.0%')
  })
})

describe('formatCount', () => {
  it('should group thousands', () => {
    expect(formatCount(12345)).toBe('12,345')
  })
})

describe('formatDateTime', () => {
  it('should render an ISO timestamp as a UTC date and time', () => {
    expect(formatDateTime('2026-07-21T13:45:00.000Z')).toBe('2026-07-21 13:45 UTC')
  })

  it('should render an em dash when the timestamp is null', () => {
    expect(formatDateTime(null)).toBe('—')
  })
})
```

- [x] **Step 6: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/analytics/rates.test.ts`
Expected: FAIL — `Failed to resolve import "./rates"`.

- [x] **Step 7: Implement `rates.ts`**

Create `src/lib/analytics/rates.ts`:

```ts
// `null` means "no denominator, so no rate exists" — distinct from 0%, which
// means "we tried and nothing converted". The UI renders them differently.
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return numerator / denominator
}

const EMPTY_VALUE = '—'

export function formatPercent(value: number | null): string {
  if (value === null) return EMPTY_VALUE
  return `${(value * 100).toFixed(1)}%`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

// Server- and client-rendered on the same page, so the timezone must be pinned;
// letting it default would produce a hydration mismatch.
export function formatDateTime(iso: string | null): string {
  if (!iso) return EMPTY_VALUE
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  )
}
```

- [x] **Step 8: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/analytics/rates.test.ts`
Expected: PASS — 9 tests.

- [x] **Step 9: Write the failing tests for `sparkline.ts`**

Create `src/lib/analytics/sparkline.test.ts`:

```ts
import { describe, it, expect } from 'vitest'
import { buildSparkline, SPARKLINE_HEIGHT } from './sparkline'

describe('buildSparkline', () => {
  it('should produce no bars and zero width when there are no values', () => {
    const geometry = buildSparkline([])
    expect(geometry.bars).toEqual([])
    expect(geometry.width).toBe(0)
    expect(geometry.max).toBe(0)
  })

  it('should scale the tallest bar to the full chart height', () => {
    const geometry = buildSparkline([0, 5, 10])
    expect(geometry.max).toBe(10)
    expect(geometry.bars[2]?.height).toBe(SPARKLINE_HEIGHT)
    expect(geometry.bars[2]?.y).toBe(0)
  })

  it('should scale intermediate bars proportionally', () => {
    const geometry = buildSparkline([0, 5, 10])
    expect(geometry.bars[1]?.height).toBe(SPARKLINE_HEIGHT / 2)
  })

  it('should give zero values a minimum-height baseline bar', () => {
    const geometry = buildSparkline([0, 10])
    expect(geometry.bars[0]?.height).toBe(1)
    expect(geometry.bars[0]?.y).toBe(SPARKLINE_HEIGHT - 1)
  })

  it('should render flat baseline bars when every value is zero', () => {
    const geometry = buildSparkline([0, 0, 0])
    expect(geometry.max).toBe(0)
    expect(geometry.bars.map((bar) => bar.height)).toEqual([1, 1, 1])
  })

  it('should lay bars out left to right without overlap', () => {
    const geometry = buildSparkline([1, 2, 3])
    const xs = geometry.bars.map((bar) => bar.x)
    expect(xs[0]).toBe(0)
    expect(xs[1]).toBeGreaterThan(xs[0]! + geometry.bars[0]!.width - 1)
    expect(geometry.width).toBeGreaterThanOrEqual(xs[2]! + geometry.bars[2]!.width)
  })

  it('should clamp negative values to zero', () => {
    const geometry = buildSparkline([-4, 8])
    expect(geometry.max).toBe(8)
    expect(geometry.bars[0]?.height).toBe(1)
  })
})
```

- [x] **Step 10: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/analytics/sparkline.test.ts`
Expected: FAIL — `Failed to resolve import "./sparkline"`.

- [x] **Step 11: Implement `sparkline.ts`**

Create `src/lib/analytics/sparkline.ts`:

```ts
// Geometry for the inline-SVG bar chart. Kept as pure math so it is unit
// testable without a DOM — the component in src/app/analytics is a thin
// <rect> renderer over this output.
export const SPARKLINE_HEIGHT = 48
const BAR_WIDTH = 8
const BAR_GAP = 2
// A zero day still draws a 1px baseline so gaps in the series stay visible.
const MIN_BAR_HEIGHT = 1

export interface SparkBar {
  x: number
  y: number
  width: number
  height: number
}

export interface SparklineGeometry {
  width: number
  height: number
  max: number
  bars: SparkBar[]
}

export function buildSparkline(values: readonly number[]): SparklineGeometry {
  const safeValues = values.map((value) => (value > 0 ? value : 0))
  const max = safeValues.reduce((highest, value) => (value > highest ? value : highest), 0)
  const width =
    safeValues.length === 0 ? 0 : safeValues.length * BAR_WIDTH + (safeValues.length - 1) * BAR_GAP

  const bars = safeValues.map((value, index) => {
    const scaled = max === 0 ? 0 : Math.round((value / max) * SPARKLINE_HEIGHT)
    const height = Math.max(MIN_BAR_HEIGHT, scaled)
    return {
      x: index * (BAR_WIDTH + BAR_GAP),
      y: SPARKLINE_HEIGHT - height,
      width: BAR_WIDTH,
      height,
    }
  })

  return { width, height: SPARKLINE_HEIGHT, max, bars }
}
```

- [x] **Step 12: Run the full suite, typecheck, and lint**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: all suites pass (the three new files add 25 tests), `typecheck` silent, `lint` clean apart from the known pre-existing `env.test.ts` warning.

- [ ] **Step 13: Commit**

```bash
git add src/lib/analytics
git commit -m "feat(analytics): add pure range, rate, and sparkline helpers"
```

---

### Task 3: Analytics db layer

**Files:**
- Create: `src/types/analytics.ts`
- Create: `src/lib/db/analytics.ts`, `src/lib/db/analytics.test.ts`

**Interfaces:**
- Consumes: RPC names and column names from Task 1; `DateRange` is *not* consumed here — this module takes a plain `{ from, to, campaignId }` input.
- Produces:
  - Types (from `@/types/analytics`): `OverviewMetrics`, `DailyMetric`, `CampaignMetrics`, `MailboxMetrics`, `EventCount`, `ZERO_OVERVIEW`.
  - Functions (from `@/lib/db/analytics`):
    - `getOverviewMetrics(supabase, { from, to, campaignId }): Promise<OverviewMetrics>`
    - `getDailyMetrics(supabase, { from, to, campaignId }): Promise<DailyMetric[]>`
    - `getCampaignMetrics(supabase, { from, to }): Promise<CampaignMetrics[]>`
    - `getMailboxMetrics(supabase): Promise<MailboxMetrics[]>`
    - `getEventCounts(supabase, { from, to, limit }): Promise<EventCount[]>`
  - Shared input types `MetricsRange { from: string; to: string; campaignId: string | null }` and `EventCountsInput { from: string; to: string; limit: number }`.

- [x] **Step 1: Write the view types**

Create `src/types/analytics.ts`:

```ts
import type { Database } from '@/types/database'

export interface OverviewMetrics {
  leadsDiscovered: number
  leadsVerified: number
  casesCreated: number
  emailsSent: number
  firstTouchSent: number
  followupsSent: number
  emailsBounced: number
  emailsFailed: number
  repliesReceived: number
  leadsContacted: number
  leadsReplied: number
  suppressionsAdded: number
  activeSequences: number
}

// Returned when the window contains no rows at all, so the page always has a
// complete object to render instead of a partially-undefined one.
export const ZERO_OVERVIEW: OverviewMetrics = {
  leadsDiscovered: 0,
  leadsVerified: 0,
  casesCreated: 0,
  emailsSent: 0,
  firstTouchSent: 0,
  followupsSent: 0,
  emailsBounced: 0,
  emailsFailed: 0,
  repliesReceived: 0,
  leadsContacted: 0,
  leadsReplied: 0,
  suppressionsAdded: 0,
  activeSequences: 0,
}

export interface DailyMetric {
  day: string
  leadsDiscovered: number
  emailsSent: number
  repliesReceived: number
}

export interface CampaignMetrics {
  campaignId: string
  campaignName: string
  clientId: string
  campaignStatus: Database['public']['Enums']['campaign_status']
  leadsDiscovered: number
  leadsVerified: number
  casesCreated: number
  emailsSent: number
  leadsContacted: number
  leadsReplied: number
  casesNew: number
  casesResearching: number
  casesReady: number
  casesContacted: number
  casesInConversation: number
  casesHotHandoff: number
  casesWon: number
  casesLost: number
  casesDead: number
}

export interface MailboxMetrics {
  mailboxId: string
  clientId: string
  emailAddress: string
  provider: Database['public']['Enums']['mailbox_provider']
  health: Database['public']['Enums']['mailbox_health']
  dailyCap: number
  sentToday: number
  sentTotal: number
  bouncedTotal: number
  failedTotal: number
  lastSentAt: string | null
}

export interface EventCount {
  type: string
  count: number
}
```

- [x] **Step 2: Write the failing tests**

Create `src/lib/db/analytics.test.ts`:

```ts
import { describe, it, expect, vi } from 'vitest'
import {
  getOverviewMetrics,
  getDailyMetrics,
  getCampaignMetrics,
  getMailboxMetrics,
  getEventCounts,
} from './analytics'
import { AppError } from '@/lib/errors/app-error'
import { ZERO_OVERVIEW } from '@/types/analytics'

function mockRpc(result: { data: unknown; error: unknown }) {
  const rpc = vi.fn(() => Promise.resolve(result))
  return { supabase: { rpc } as never, rpc }
}

const RANGE = { from: '2026-07-01T00:00:00.000Z', to: '2026-07-21T00:00:00.000Z', campaignId: null }

const overviewRow = {
  leads_discovered: 120,
  leads_verified: 80,
  cases_created: 40,
  emails_sent: 200,
  first_touch_sent: 60,
  followups_sent: 140,
  emails_bounced: 4,
  emails_failed: 2,
  replies_received: 15,
  leads_contacted: 55,
  leads_replied: 11,
  suppressions_added: 7,
  active_sequences: 22,
}

describe('getOverviewMetrics', () => {
  it('should map the row to camelCase when the rpc succeeds', async () => {
    const { supabase } = mockRpc({ data: [overviewRow], error: null })
    const result = await getOverviewMetrics(supabase, RANGE)
    expect(result.leadsDiscovered).toBe(120)
    expect(result.activeSequences).toBe(22)
    expect(result.leadsReplied).toBe(11)
  })

  it('should pass the window and campaign filter to the rpc', async () => {
    const { supabase, rpc } = mockRpc({ data: [overviewRow], error: null })
    await getOverviewMetrics(supabase, { ...RANGE, campaignId: 'camp-1' })
    expect(rpc).toHaveBeenCalledWith('analytics_overview', {
      p_from: RANGE.from,
      p_to: RANGE.to,
      p_campaign_id: 'camp-1',
    })
  })

  it('should return zeroed metrics when the rpc returns no rows', async () => {
    const { supabase } = mockRpc({ data: [], error: null })
    expect(await getOverviewMetrics(supabase, RANGE)).toEqual(ZERO_OVERVIEW)
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(getOverviewMetrics(supabase, RANGE)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getDailyMetrics', () => {
  it('should map each day row to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [{ day: '2026-07-20', leads_discovered: 5, emails_sent: 9, replies_received: 1 }],
      error: null,
    })
    const result = await getDailyMetrics(supabase, RANGE)
    expect(result).toEqual([
      { day: '2026-07-20', leadsDiscovered: 5, emailsSent: 9, repliesReceived: 1 },
    ])
  })

  it('should return an empty array when the rpc returns null data', async () => {
    const { supabase } = mockRpc({ data: null, error: null })
    expect(await getDailyMetrics(supabase, RANGE)).toEqual([])
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(getDailyMetrics(supabase, RANGE)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getCampaignMetrics', () => {
  it('should map campaign rows to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [
        {
          campaign_id: 'camp-1',
          campaign_name: 'Q3 SaaS',
          client_id: 'client-1',
          campaign_status: 'active',
          leads_discovered: 10,
          leads_verified: 6,
          cases_created: 3,
          emails_sent: 12,
          leads_contacted: 5,
          leads_replied: 2,
          cases_new: 1,
          cases_researching: 0,
          cases_ready: 1,
          cases_contacted: 2,
          cases_in_conversation: 1,
          cases_hot_handoff: 0,
          cases_won: 0,
          cases_lost: 0,
          cases_dead: 1,
        },
      ],
      error: null,
    })
    const [row] = await getCampaignMetrics(supabase, { from: RANGE.from, to: RANGE.to })
    expect(row?.campaignName).toBe('Q3 SaaS')
    expect(row?.casesInConversation).toBe(1)
    expect(row?.leadsReplied).toBe(2)
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(
      getCampaignMetrics(supabase, { from: RANGE.from, to: RANGE.to }),
    ).rejects.toBeInstanceOf(AppError)
  })
})

describe('getMailboxMetrics', () => {
  it('should map mailbox rows to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [
        {
          mailbox_id: 'mb-1',
          client_id: 'client-1',
          email_address: 'sales@acme.com',
          provider: 'gmail',
          health: 'ok',
          daily_cap: 20,
          sent_today: 8,
          sent_total: 340,
          bounced_total: 3,
          failed_total: 1,
          last_sent_at: '2026-07-21T09:00:00.000Z',
        },
      ],
      error: null,
    })
    const [row] = await getMailboxMetrics(supabase)
    expect(row?.emailAddress).toBe('sales@acme.com')
    expect(row?.sentTotal).toBe(340)
    expect(row?.lastSentAt).toBe('2026-07-21T09:00:00.000Z')
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(getMailboxMetrics(supabase)).rejects.toBeInstanceOf(AppError)
  })
})

describe('getEventCounts', () => {
  it('should map event rows to camelCase', async () => {
    const { supabase } = mockRpc({
      data: [{ event_type: 'pipeline.research.completed', event_count: 9 }],
      error: null,
    })
    expect(await getEventCounts(supabase, { from: RANGE.from, to: RANGE.to, limit: 12 })).toEqual([
      { type: 'pipeline.research.completed', count: 9 },
    ])
  })

  it('should pass the limit to the rpc', async () => {
    const { supabase, rpc } = mockRpc({ data: [], error: null })
    await getEventCounts(supabase, { from: RANGE.from, to: RANGE.to, limit: 5 })
    expect(rpc).toHaveBeenCalledWith('analytics_event_counts', {
      p_from: RANGE.from,
      p_to: RANGE.to,
      p_limit: 5,
    })
  })

  it('should throw DB_ERROR when the rpc errors', async () => {
    const { supabase } = mockRpc({ data: null, error: { message: 'boom' } })
    await expect(
      getEventCounts(supabase, { from: RANGE.from, to: RANGE.to, limit: 12 }),
    ).rejects.toBeInstanceOf(AppError)
  })
})
```

- [x] **Step 3: Run the tests to verify they fail**

Run: `pnpm vitest run src/lib/db/analytics.test.ts`
Expected: FAIL — `Failed to resolve import "./analytics"`.

- [x] **Step 4: Implement the db layer**

Create `src/lib/db/analytics.ts`:

```ts
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import {
  ZERO_OVERVIEW,
  type OverviewMetrics,
  type DailyMetric,
  type CampaignMetrics,
  type MailboxMetrics,
  type EventCount,
} from '@/types/analytics'

export interface MetricsRange {
  from: string
  to: string
  campaignId: string | null
}

export interface CampaignMetricsRange {
  from: string
  to: string
}

export interface EventCountsInput {
  from: string
  to: string
  limit: number
}

// Every read below is RLS-scoped: the caller must pass a session-bound client
// (createServerClient), never the admin client. The SQL functions are SECURITY
// INVOKER precisely so a client-role viewer aggregates only its own client_id
// (.claude/architecture.md §11).

export async function getOverviewMetrics(
  supabase: SupabaseClient<Database>,
  { from, to, campaignId }: MetricsRange,
): Promise<OverviewMetrics> {
  const { data, error } = await supabase.rpc('analytics_overview', {
    p_from: from,
    p_to: to,
    p_campaign_id: campaignId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load analytics overview', {
      from, to, campaignId, cause: error.message,
    })
  }
  // length check guarantees index 0 exists.
  const row = data && data.length > 0 ? data[0]! : null
  if (!row) return ZERO_OVERVIEW
  return {
    leadsDiscovered: row.leads_discovered,
    leadsVerified: row.leads_verified,
    casesCreated: row.cases_created,
    emailsSent: row.emails_sent,
    firstTouchSent: row.first_touch_sent,
    followupsSent: row.followups_sent,
    emailsBounced: row.emails_bounced,
    emailsFailed: row.emails_failed,
    repliesReceived: row.replies_received,
    leadsContacted: row.leads_contacted,
    leadsReplied: row.leads_replied,
    suppressionsAdded: row.suppressions_added,
    activeSequences: row.active_sequences,
  }
}

export async function getDailyMetrics(
  supabase: SupabaseClient<Database>,
  { from, to, campaignId }: MetricsRange,
): Promise<DailyMetric[]> {
  const { data, error } = await supabase.rpc('analytics_daily', {
    p_from: from,
    p_to: to,
    p_campaign_id: campaignId,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load daily analytics', {
      from, to, campaignId, cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({
    day: row.day,
    leadsDiscovered: row.leads_discovered,
    emailsSent: row.emails_sent,
    repliesReceived: row.replies_received,
  }))
}

export async function getCampaignMetrics(
  supabase: SupabaseClient<Database>,
  { from, to }: CampaignMetricsRange,
): Promise<CampaignMetrics[]> {
  const { data, error } = await supabase.rpc('analytics_by_campaign', { p_from: from, p_to: to })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load campaign analytics', {
      from, to, cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    clientId: row.client_id,
    campaignStatus: row.campaign_status,
    leadsDiscovered: row.leads_discovered,
    leadsVerified: row.leads_verified,
    casesCreated: row.cases_created,
    emailsSent: row.emails_sent,
    leadsContacted: row.leads_contacted,
    leadsReplied: row.leads_replied,
    casesNew: row.cases_new,
    casesResearching: row.cases_researching,
    casesReady: row.cases_ready,
    casesContacted: row.cases_contacted,
    casesInConversation: row.cases_in_conversation,
    casesHotHandoff: row.cases_hot_handoff,
    casesWon: row.cases_won,
    casesLost: row.cases_lost,
    casesDead: row.cases_dead,
  }))
}

export async function getMailboxMetrics(
  supabase: SupabaseClient<Database>,
): Promise<MailboxMetrics[]> {
  const { data, error } = await supabase.rpc('analytics_mailboxes')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load mailbox analytics', { cause: error.message })
  }
  return (data ?? []).map((row) => ({
    mailboxId: row.mailbox_id,
    clientId: row.client_id,
    emailAddress: row.email_address,
    provider: row.provider,
    health: row.health,
    dailyCap: row.daily_cap,
    sentToday: row.sent_today,
    sentTotal: row.sent_total,
    bouncedTotal: row.bounced_total,
    failedTotal: row.failed_total,
    lastSentAt: row.last_sent_at,
  }))
}

export async function getEventCounts(
  supabase: SupabaseClient<Database>,
  { from, to, limit }: EventCountsInput,
): Promise<EventCount[]> {
  const { data, error } = await supabase.rpc('analytics_event_counts', {
    p_from: from,
    p_to: to,
    p_limit: limit,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load event counts', {
      from, to, limit, cause: error.message,
    })
  }
  return (data ?? []).map((row) => ({ type: row.event_type, count: row.event_count }))
}
```

- [x] **Step 5: Run the tests to verify they pass**

Run: `pnpm vitest run src/lib/db/analytics.test.ts`
Expected: PASS — 14 tests.

- [x] **Step 6: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: `typecheck` silent, `lint` clean apart from the known `env.test.ts` warning.

- [ ] **Step 7: Commit**

```bash
git add src/types/analytics.ts src/lib/db/analytics.ts src/lib/db/analytics.test.ts
git commit -m "feat(analytics): add RPC wrappers and view types for dashboard metrics"
```

---

### Task 4: RLS integration test for the analytics RPCs

**Files:**
- Create: `src/lib/db/analytics.integration.test.ts`
- Read for reference: `src/lib/supabase/rls.integration.test.ts` (setup pattern this test mirrors)

**Interfaces:**
- Consumes: `getOverviewMetrics`, `getCampaignMetrics` from Task 3; the SQL functions from Task 1.
- Produces: nothing consumed by later tasks.

This is the only place the SECURITY INVOKER assumption is actually proven. Unit tests mock the RPC, so without this a `security definer` regression would leak one client's counts to another and no test would notice.

- [x] **Step 1: Read the existing integration test setup**

Run: `sed -n '1,60p' src/lib/supabase/rls.integration.test.ts`
Expected: the `makeUser` / admin-client bootstrap this test copies.

- [x] **Step 2: Write the integration test**

Create `src/lib/db/analytics.integration.test.ts`:

```ts
import { describe, it, expect, beforeAll } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { getOverviewMetrics, getCampaignMetrics } from './analytics'

// Integration test: runs against local `supabase start`.
// Run with: set -a; . ./.env.local; set +a; pnpm test:integration
const url = process.env.NEXT_PUBLIC_SUPABASE_URL ?? ''
const anon = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? ''
const service = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const admin = createClient<Database>(url, service, { auth: { persistSession: false } })

const stamp = Date.now()
const password = 'test-password-123'
const clientAEmail = `analytics-a-${stamp}@test.local`
const clientBEmail = `analytics-b-${stamp}@test.local`

const RANGE = { from: '2000-01-01T00:00:00.000Z', to: '2100-01-01T00:00:00.000Z' }

let clientAId = ''
let clientBId = ''
let campaignAId = ''

async function makeUser(email: string, clientId: string | null, role: 'operator' | 'client') {
  const { data, error } = await admin.auth.admin.createUser({ email, password, email_confirm: true })
  if (error || !data.user) throw new Error(`createUser failed: ${error?.message}`)
  const { error: insErr } = await admin
    .from('app_users')
    .insert({ id: data.user.id, role, client_id: clientId })
  if (insErr) throw new Error(`app_users insert failed: ${insErr.message}`)
}

async function signedInClient(email: string) {
  const supabase = createClient<Database>(url, anon, { auth: { persistSession: false } })
  const { error } = await supabase.auth.signInWithPassword({ email, password })
  if (error) throw new Error(`signIn failed: ${error.message}`)
  return supabase
}

beforeAll(async () => {
  const { data: clientA, error: aErr } = await admin
    .from('clients').insert({ name: `Analytics A ${stamp}` }).select('id').single()
  if (aErr || !clientA) throw new Error(`client A insert failed: ${aErr?.message}`)
  clientAId = clientA.id

  const { data: clientB, error: bErr } = await admin
    .from('clients').insert({ name: `Analytics B ${stamp}` }).select('id').single()
  if (bErr || !clientB) throw new Error(`client B insert failed: ${bErr?.message}`)
  clientBId = clientB.id

  const { data: campaignA, error: caErr } = await admin
    .from('campaigns').insert({ client_id: clientAId, name: `Campaign A ${stamp}` })
    .select('id').single()
  if (caErr || !campaignA) throw new Error(`campaign A insert failed: ${caErr?.message}`)
  campaignAId = campaignA.id

  const { data: campaignB, error: cbErr } = await admin
    .from('campaigns').insert({ client_id: clientBId, name: `Campaign B ${stamp}` })
    .select('id').single()
  if (cbErr || !campaignB) throw new Error(`campaign B insert failed: ${cbErr?.message}`)

  // 3 leads for client A, 1 for client B.
  const { error: leadErr } = await admin.from('leads').insert([
    { client_id: clientAId, campaign_id: campaignAId, full_name: 'A One', email_status: 'verified' },
    { client_id: clientAId, campaign_id: campaignAId, full_name: 'A Two', email_status: 'verified' },
    { client_id: clientAId, campaign_id: campaignAId, full_name: 'A Three', email_status: 'unverified' },
    { client_id: clientBId, campaign_id: campaignB.id, full_name: 'B One', email_status: 'verified' },
  ])
  if (leadErr) throw new Error(`leads insert failed: ${leadErr.message}`)

  await makeUser(clientAEmail, clientAId, 'client')
  await makeUser(clientBEmail, null, 'operator')
})

describe('analytics_overview RLS scoping', () => {
  it('should count only the caller\'s own client rows for a client-role user', async () => {
    const supabase = await signedInClient(clientAEmail)
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: null })
    expect(overview.leadsDiscovered).toBe(3)
    expect(overview.leadsVerified).toBe(2)
  })

  it('should count across every client for an operator', async () => {
    const supabase = await signedInClient(clientBEmail)
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: null })
    expect(overview.leadsDiscovered).toBeGreaterThanOrEqual(4)
  })

  it('should honour a campaign filter within the caller\'s own client', async () => {
    const supabase = await signedInClient(clientAEmail)
    const overview = await getOverviewMetrics(supabase, { ...RANGE, campaignId: campaignAId })
    expect(overview.leadsDiscovered).toBe(3)
  })
})

describe('analytics_by_campaign RLS scoping', () => {
  it('should list only the caller\'s own campaigns for a client-role user', async () => {
    const supabase = await signedInClient(clientAEmail)
    const rows = await getCampaignMetrics(supabase, RANGE)
    expect(rows.every((row) => row.clientId === clientAId)).toBe(true)
    expect(rows.find((row) => row.campaignId === campaignAId)?.leadsDiscovered).toBe(3)
  })

  it('should list campaigns from multiple clients for an operator', async () => {
    const supabase = await signedInClient(clientBEmail)
    const rows = await getCampaignMetrics(supabase, RANGE)
    const clientIds = new Set(rows.map((row) => row.clientId))
    expect(clientIds.size).toBeGreaterThanOrEqual(2)
  })
})
```

- [ ] **Step 3: Run the integration test**

Run:

```bash
set -a; . ./.env.local; set +a; pnpm test:integration
```

Expected: PASS — the new file's 5 tests plus the existing `rls.integration.test.ts` tests.

If `.env.local` does not point at a running local Supabase, run `pnpm supabase start` first and use the printed anon/service keys. Do not skip this step — it is the only proof the RPCs are RLS-scoped.

- [x] **Step 4: Confirm the unit suite still excludes it**

Run: `pnpm test`
Expected: PASS, and the summary does **not** list `analytics.integration.test.ts` (excluded by `vitest.config.ts`).

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/analytics.integration.test.ts
git commit -m "test(analytics): prove RPC aggregates are RLS-scoped per client"
```

---

### Task 5: Presentational components (stat tile + sparkline chart)

**Files:**
- Create: `src/app/analytics/stat-tile.tsx`
- Create: `src/app/analytics/sparkline-chart.tsx`

**Interfaces:**
- Consumes: `buildSparkline`, `SPARKLINE_HEIGHT` from `@/lib/analytics/sparkline` (Task 2).
- Produces:
  - `<StatTile label={string} value={string} hint?={string} />`
  - `<SparklineChart title={string} values={number[]} color={string} total={string} />`

Both are Server Components (no `'use client'`) so they add zero client JS.

- [x] **Step 1: Write the stat tile**

Create `src/app/analytics/stat-tile.tsx`:

```tsx
interface StatTileProps {
  label: string
  value: string
  hint?: string
}

export function StatTile({ label, value, hint }: StatTileProps) {
  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14, minWidth: 0 }}>
      <div style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: 0.4 }}>
        {label}
      </div>
      <div style={{ fontSize: 26, fontWeight: 600, margin: '6px 0 2px' }}>{value}</div>
      {hint && <div style={{ fontSize: 12, color: '#888' }}>{hint}</div>}
    </div>
  )
}
```

- [x] **Step 2: Write the sparkline chart**

Create `src/app/analytics/sparkline-chart.tsx`:

```tsx
import { buildSparkline } from '@/lib/analytics/sparkline'

interface SparklineChartProps {
  title: string
  values: number[]
  color: string
  total: string
}

export function SparklineChart({ title, values, color, total }: SparklineChartProps) {
  const { width, height, max, bars } = buildSparkline(values)

  return (
    <div style={{ border: '1px solid #ddd', borderRadius: 8, padding: 14 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
        <span style={{ fontSize: 12, color: '#666', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          {title}
        </span>
        <span style={{ fontSize: 18, fontWeight: 600 }}>{total}</span>
      </div>
      {bars.length === 0 ? (
        <p style={{ fontSize: 13, color: '#888', margin: '10px 0 0' }}>No days in this range.</p>
      ) : (
        <svg
          role="img"
          aria-label={`${title}: ${total} over ${bars.length} days, peak ${max} per day`}
          width={width}
          height={height}
          viewBox={`0 0 ${width} ${height}`}
          style={{ display: 'block', marginTop: 10, maxWidth: '100%' }}
        >
          {bars.map((bar, index) => (
            <rect
              key={`${title}-${index}`}
              x={bar.x}
              y={bar.y}
              width={bar.width}
              height={bar.height}
              rx={1}
              fill={color}
            />
          ))}
        </svg>
      )}
      <div style={{ fontSize: 11, color: '#999', marginTop: 6 }}>
        Peak {max} / day · {bars.length} days · UTC
      </div>
    </div>
  )
}
```

The chart reads `height` off the geometry object, so `SPARKLINE_HEIGHT` is deliberately not imported here — only `sparkline.test.ts` needs that constant.

- [x] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: `typecheck` silent; `lint` clean apart from the known `env.test.ts` warning.

- [ ] **Step 4: Commit**

```bash
git add src/app/analytics/stat-tile.tsx src/app/analytics/sparkline-chart.tsx
git commit -m "feat(analytics): add stat tile and inline-SVG sparkline components"
```

---

### Task 6: Client components — range/campaign filters and the realtime refresher

**Files:**
- Create: `src/app/analytics/filters.tsx`
- Create: `src/app/analytics/realtime-refresher.tsx`

**Interfaces:**
- Consumes: `RANGE_OPTIONS`, `RangeDays` from `@/lib/analytics/range` (Task 2); `createBrowserClient` from `@/lib/supabase/client`.
- Produces:
  - `<AnalyticsFilters days={RangeDays} campaignId={string | null} campaigns={CampaignOption[]} />` where `CampaignOption = { id: string; name: string }`
  - `<RealtimeRefresher />` (renders nothing)

- [x] **Step 1: Write the filter bar**

Create `src/app/analytics/filters.tsx`:

```tsx
'use client'

import { useRouter } from 'next/navigation'
import { useTransition, type ChangeEvent } from 'react'
import { RANGE_OPTIONS, type RangeDays } from '@/lib/analytics/range'

export interface CampaignOption {
  id: string
  name: string
}

interface AnalyticsFiltersProps {
  days: RangeDays
  campaignId: string | null
  campaigns: CampaignOption[]
}

// The current filter state arrives as props from the server, so this component
// never reads useSearchParams — it just rebuilds the URL from what it was given.
function buildHref(days: RangeDays, campaignId: string | null): string {
  const params = new URLSearchParams()
  params.set('days', String(days))
  if (campaignId) params.set('campaign', campaignId)
  return `/analytics?${params.toString()}`
}

export function AnalyticsFilters({ days, campaignId, campaigns }: AnalyticsFiltersProps) {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  const onRangeClick = (nextDays: RangeDays): void => {
    startTransition(() => {
      router.push(buildHref(nextDays, campaignId))
    })
  }

  const onCampaignChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const nextCampaign = event.target.value === '' ? null : event.target.value
    startTransition(() => {
      router.push(buildHref(days, nextCampaign))
    })
  }

  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', flexWrap: 'wrap', margin: '12px 0 24px' }}>
      <div role="group" aria-label="Date range" style={{ display: 'flex', gap: 6 }}>
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onRangeClick(option)}
            disabled={isPending}
            aria-pressed={option === days}
            style={{
              padding: '6px 12px',
              borderRadius: 6,
              border: '1px solid #ccc',
              background: option === days ? '#111' : '#fff',
              color: option === days ? '#fff' : '#111',
              cursor: isPending ? 'wait' : 'pointer',
            }}
          >
            {option}d
          </button>
        ))}
      </div>

      <label style={{ fontSize: 13, color: '#444' }}>
        Campaign{' '}
        <select
          value={campaignId ?? ''}
          onChange={onCampaignChange}
          disabled={isPending || campaigns.length === 0}
          style={{ padding: '6px 8px', borderRadius: 6, border: '1px solid #ccc' }}
        >
          <option value="">All campaigns</option>
          {campaigns.map((campaign) => (
            <option key={campaign.id} value={campaign.id}>
              {campaign.name}
            </option>
          ))}
        </select>
      </label>

      {isPending && <span style={{ fontSize: 12, color: '#888' }}>Updating…</span>}
    </div>
  )
}
```

- [x] **Step 2: Write the realtime refresher**

Create `src/app/analytics/realtime-refresher.tsx`:

```tsx
'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

// The pipeline writes in bursts (a discovery run inserts dozens of leads), so
// coalesce a burst into one server round-trip instead of one per row.
const REFRESH_DEBOUNCE_MS = 1500

// Renders nothing. It listens for "a row that feeds a metric changed" and asks
// the server to recompute — the aggregation itself stays server-side and
// RLS-scoped. Realtime applies the same RLS policies to the subscription, so a
// client-role viewer is only woken by its own client's rows.
export function RealtimeRefresher() {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        router.refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel('analytics-metrics')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'emails' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'emails' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cases' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cases' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(channel)
    }
  }, [router])

  return null
}
```

- [x] **Step 3: Typecheck and lint**

Run: `pnpm typecheck && pnpm lint`
Expected: `typecheck` silent, `lint` clean apart from the known `env.test.ts` warning.

- [ ] **Step 4: Commit**

```bash
git add src/app/analytics/filters.tsx src/app/analytics/realtime-refresher.tsx
git commit -m "feat(analytics): add range/campaign filters and realtime refresh listener"
```

---

### Task 7: The `/analytics` page

**Files:**
- Create: `src/app/analytics/page.tsx`
- Create: `src/app/analytics/loading.tsx`
- Create: `src/app/analytics/error.tsx`

**Interfaces:**
- Consumes: `requireUser` (`@/lib/auth/require-user`), `createServerClient` (`@/lib/supabase/server`), `listCampaignsForClient` (`@/lib/db/campaigns`), the five getters from `@/lib/db/analytics` (Task 3), the helpers from `@/lib/analytics/*` (Task 2), `StatTile` / `SparklineChart` (Task 5), `AnalyticsFilters` / `RealtimeRefresher` (Task 6).
- Produces: the `/analytics` route.

- [x] **Step 1: Write the loading state**

Create `src/app/analytics/loading.tsx`:

```tsx
export default function Loading() {
  return (
    <main style={{ padding: 24 }}>
      <h1>Analytics</h1>
      <p>Loading metrics…</p>
    </main>
  )
}
```

- [x] **Step 2: Write the error state**

Create `src/app/analytics/error.tsx`:

```tsx
'use client'

export default function Error({ reset }: { error: Error; reset: () => void }) {
  return (
    <main style={{ padding: 24 }}>
      <h1>Analytics</h1>
      <p>Something went wrong loading your metrics.</p>
      <button type="button" onClick={reset}>Try again</button>
    </main>
  )
}
```

- [x] **Step 3: Write the page**

Create `src/app/analytics/page.tsx`:

```tsx
import Link from 'next/link'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listCampaignsForClient } from '@/lib/db/campaigns'
import {
  getOverviewMetrics,
  getDailyMetrics,
  getCampaignMetrics,
  getMailboxMetrics,
  getEventCounts,
} from '@/lib/db/analytics'
import {
  analyticsSearchParamsSchema,
  parseRangeDays,
  rangeFromDays,
} from '@/lib/analytics/range'
import { rate, formatPercent, formatCount, formatDateTime } from '@/lib/analytics/rates'
import { StatTile } from './stat-tile'
import { SparklineChart } from './sparkline-chart'
import { AnalyticsFilters } from './filters'
import { RealtimeRefresher } from './realtime-refresher'

export const dynamic = 'force-dynamic'

const EVENT_TYPE_LIMIT = 12
const TREND_TABLE_DAYS = 14

interface AnalyticsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

const cellStyle = { padding: '6px 10px', borderBottom: '1px solid #eee', fontSize: 13 } as const
const headStyle = { ...cellStyle, textAlign: 'left', color: '#666', fontWeight: 600 } as const
const numStyle = { ...cellStyle, textAlign: 'right' } as const
const sectionStyle = { margin: '32px 0 0' } as const

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps) {
  const { appUser } = await requireUser()
  const supabase = await createServerClient()

  // URL params are untrusted input that reaches SQL — validate, then whitelist.
  const parsed = analyticsSearchParamsSchema.safeParse(await searchParams)
  const days = parseRangeDays(parsed.success ? parsed.data.days : undefined)
  const requestedCampaignId = parsed.success ? parsed.data.campaign ?? null : null

  const campaigns = await listCampaignsForClient(supabase, appUser.client_id)
  // Only honour a campaign the viewer can actually see in their RLS-scoped list.
  const campaignId = campaigns.some((campaign) => campaign.id === requestedCampaignId)
    ? requestedCampaignId
    : null

  const { from, to } = rangeFromDays(days, new Date())
  const [overview, daily, byCampaign, mailboxes, eventCounts] = await Promise.all([
    getOverviewMetrics(supabase, { from, to, campaignId }),
    getDailyMetrics(supabase, { from, to, campaignId }),
    getCampaignMetrics(supabase, { from, to }),
    getMailboxMetrics(supabase),
    getEventCounts(supabase, { from, to, limit: EVENT_TYPE_LIMIT }),
  ])

  const replyRate = rate(overview.leadsReplied, overview.leadsContacted)
  const bounceRate = rate(overview.emailsBounced, overview.emailsSent)
  const failureRate = rate(overview.emailsFailed, overview.emailsSent + overview.emailsFailed)
  const verifiedRate = rate(overview.leadsVerified, overview.leadsDiscovered)
  const trendRows = daily.slice(-TREND_TABLE_DAYS).reverse()
  const scopedCampaigns = campaignId
    ? byCampaign.filter((row) => row.campaignId === campaignId)
    : byCampaign
  const hasAnyData =
    overview.leadsDiscovered + overview.emailsSent + overview.repliesReceived > 0

  return (
    <main style={{ maxWidth: 1100, margin: '48px auto', padding: '0 16px', fontFamily: 'system-ui' }}>
      <RealtimeRefresher />

      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0 }}>Analytics</h1>
        <Link href="/crm" style={{ fontSize: 13 }}>Back to CRM</Link>
      </div>
      <p style={{ fontSize: 13, color: '#666', margin: '6px 0 0' }}>
        Last {days} days (UTC) · live — numbers refresh as the pipeline runs.
      </p>

      <AnalyticsFilters days={days} campaignId={campaignId} campaigns={campaigns} />

      {!hasAnyData && (
        <p style={{ fontSize: 14, color: '#666', border: '1px dashed #ccc', borderRadius: 8, padding: 16 }}>
          No pipeline activity in this range yet. Run discovery or widen the date range.
        </p>
      )}

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16 }}>Outreach</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
          <StatTile label="Emails sent" value={formatCount(overview.emailsSent)}
            hint={`${formatCount(overview.firstTouchSent)} first touch · ${formatCount(overview.followupsSent)} follow-ups`} />
          <StatTile label="Replies" value={formatCount(overview.repliesReceived)}
            hint={`${formatCount(overview.leadsReplied)} people replied`} />
          <StatTile label="Reply rate" value={formatPercent(replyRate)}
            hint={`of ${formatCount(overview.leadsContacted)} people contacted`} />
          <StatTile label="Bounce rate" value={formatPercent(bounceRate)}
            hint={`${formatCount(overview.emailsBounced)} bounced`} />
          <StatTile label="Send failures" value={formatCount(overview.emailsFailed)}
            hint={`${formatPercent(failureRate)} of send attempts`} />
          <StatTile label="Active sequences" value={formatCount(overview.activeSequences)}
            hint="follow-ups still running (now)" />
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16 }}>Pipeline</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(190px, 1fr))', gap: 12 }}>
          <StatTile label="Leads discovered" value={formatCount(overview.leadsDiscovered)} />
          <StatTile label="Verified emails" value={formatCount(overview.leadsVerified)}
            hint={`${formatPercent(verifiedRate)} of discovered`} />
          <StatTile label="Cases created" value={formatCount(overview.casesCreated)} />
          <StatTile label="Suppressions added" value={formatCount(overview.suppressionsAdded)}
            hint="client-wide, ignores campaign filter" />
        </div>
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16 }}>Daily trend</h2>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: 12 }}>
          <SparklineChart title="Emails sent" color="#2563eb" total={formatCount(overview.emailsSent)}
            values={daily.map((day) => day.emailsSent)} />
          <SparklineChart title="Replies" color="#16a34a" total={formatCount(overview.repliesReceived)}
            values={daily.map((day) => day.repliesReceived)} />
          <SparklineChart title="Leads discovered" color="#9333ea" total={formatCount(overview.leadsDiscovered)}
            values={daily.map((day) => day.leadsDiscovered)} />
        </div>

        {trendRows.length > 0 && (
          <table style={{ width: '100%', borderCollapse: 'collapse', marginTop: 16 }}>
            <caption style={{ captionSide: 'top', textAlign: 'left', fontSize: 12, color: '#666', paddingBottom: 6 }}>
              Last {Math.min(TREND_TABLE_DAYS, daily.length)} days, most recent first
            </caption>
            <thead>
              <tr>
                <th style={headStyle} scope="col">Day (UTC)</th>
                <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Discovered</th>
                <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Sent</th>
                <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Replies</th>
              </tr>
            </thead>
            <tbody>
              {trendRows.map((day) => (
                <tr key={day.day}>
                  <td style={cellStyle}>{day.day}</td>
                  <td style={numStyle}>{formatCount(day.leadsDiscovered)}</td>
                  <td style={numStyle}>{formatCount(day.emailsSent)}</td>
                  <td style={numStyle}>{formatCount(day.repliesReceived)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16 }}>Campaigns</h2>
        {scopedCampaigns.length === 0 ? (
          <p style={{ fontSize: 13, color: '#666' }}>
            No campaigns yet. <Link href="/campaigns">Create one</Link>.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900 }}>
              <thead>
                <tr>
                  <th style={headStyle} scope="col">Campaign</th>
                  <th style={headStyle} scope="col">Status</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Discovered</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Verified</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Sent</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Contacted</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Replied</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Reply rate</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">In conv.</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Hot</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Won</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Dead</th>
                </tr>
              </thead>
              <tbody>
                {scopedCampaigns.map((row) => (
                  <tr key={row.campaignId}>
                    <td style={cellStyle}>{row.campaignName}</td>
                    <td style={cellStyle}>{row.campaignStatus}</td>
                    <td style={numStyle}>{formatCount(row.leadsDiscovered)}</td>
                    <td style={numStyle}>{formatCount(row.leadsVerified)}</td>
                    <td style={numStyle}>{formatCount(row.emailsSent)}</td>
                    <td style={numStyle}>{formatCount(row.leadsContacted)}</td>
                    <td style={numStyle}>{formatCount(row.leadsReplied)}</td>
                    <td style={numStyle}>{formatPercent(rate(row.leadsReplied, row.leadsContacted))}</td>
                    <td style={numStyle}>{formatCount(row.casesInConversation)}</td>
                    <td style={numStyle}>{formatCount(row.casesHotHandoff)}</td>
                    <td style={numStyle}>{formatCount(row.casesWon)}</td>
                    <td style={numStyle}>{formatCount(row.casesDead)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={sectionStyle}>
        <h2 style={{ fontSize: 16 }}>Mailboxes</h2>
        {mailboxes.length === 0 ? (
          <p style={{ fontSize: 13, color: '#666' }}>
            No mailboxes connected. <Link href="/settings">Connect one</Link>.
          </p>
        ) : (
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760 }}>
              <thead>
                <tr>
                  <th style={headStyle} scope="col">Mailbox</th>
                  <th style={headStyle} scope="col">Provider</th>
                  <th style={headStyle} scope="col">Health</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Today</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Cap used</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Sent all-time</th>
                  <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Bounce rate</th>
                  <th style={headStyle} scope="col">Last send</th>
                </tr>
              </thead>
              <tbody>
                {mailboxes.map((mailbox) => (
                  <tr key={mailbox.mailboxId}>
                    <td style={cellStyle}>{mailbox.emailAddress}</td>
                    <td style={cellStyle}>{mailbox.provider}</td>
                    <td style={{ ...cellStyle, color: mailbox.health === 'ok' ? '#166534' : '#b91c1c' }}>
                      {mailbox.health}
                    </td>
                    <td style={numStyle}>{formatCount(mailbox.sentToday)} / {formatCount(mailbox.dailyCap)}</td>
                    <td style={numStyle}>{formatPercent(rate(mailbox.sentToday, mailbox.dailyCap))}</td>
                    <td style={numStyle}>{formatCount(mailbox.sentTotal)}</td>
                    <td style={numStyle}>{formatPercent(rate(mailbox.bouncedTotal, mailbox.sentTotal))}</td>
                    <td style={cellStyle}>{formatDateTime(mailbox.lastSentAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section style={{ ...sectionStyle, marginBottom: 48 }}>
        <h2 style={{ fontSize: 16 }}>Agent activity</h2>
        {eventCounts.length === 0 ? (
          <p style={{ fontSize: 13, color: '#666' }}>No agent events logged in this range.</p>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={headStyle} scope="col">Event</th>
                <th style={{ ...headStyle, textAlign: 'right' }} scope="col">Count</th>
              </tr>
            </thead>
            <tbody>
              {eventCounts.map((event) => (
                <tr key={event.type}>
                  <td style={cellStyle}>{event.type}</td>
                  <td style={numStyle}>{formatCount(event.count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    </main>
  )
}
```

- [x] **Step 4: Typecheck, lint, and build**

Run: `pnpm typecheck && pnpm lint && pnpm build`
Expected: `typecheck` silent; `lint` clean apart from the known `env.test.ts` warning; `build` succeeds and lists `/analytics` as a dynamic (`ƒ`) route.

- [ ] **Step 5: Commit**

```bash
git add src/app/analytics/page.tsx src/app/analytics/loading.tsx src/app/analytics/error.tsx
git commit -m "feat(analytics): add RLS-scoped /analytics dashboard page"
```

---

### Task 8: Wire up navigation, verify end to end, update the roadmap

**Files:**
- Modify: `src/app/crm/page.tsx` (add the `/analytics` link — there is no global nav, so without this the page is unreachable)
- Modify: `.claude/roadmap.md`

**Interfaces:**
- Consumes: the `/analytics` route from Task 7.
- Produces: nothing consumed downstream.

- [x] **Step 1: Add the link to the CRM header**

In `src/app/crm/page.tsx`, add the import at the top of the import block:

```tsx
import Link from 'next/link'
```

and replace the `<h1>CRM</h1>` line with:

```tsx
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', gap: 12 }}>
        <h1 style={{ margin: 0 }}>CRM</h1>
        <Link href="/analytics" style={{ fontSize: 13 }}>Analytics</Link>
      </div>
```

- [x] **Step 2: Run the full verification suite**

Run: `pnpm test && pnpm typecheck && pnpm lint && pnpm build`
Expected: all unit tests pass (Tasks 2 and 3 add 39 tests across 4 new files); `typecheck` silent; `lint` clean apart from the known `env.test.ts` warning; `build` succeeds.

- [ ] **Step 3: Verify the page in a browser against local Supabase**

Run: `pnpm dev` and open `http://localhost:3000/analytics`.

Check, in order:
1. Signed out → redirected to `/login`.
2. Signed in as an operator → tiles render (zeros are fine), the campaign dropdown lists campaigns, `7d`/`30d`/`90d` change the URL and the numbers.
3. Insert a row and confirm the page updates itself within ~2 seconds without a manual reload:
   ```bash
   psql "postgresql://postgres:postgres@127.0.0.1:54322/postgres" -c \
     "insert into leads (client_id, campaign_id, full_name, email_status)
      select client_id, id, 'Realtime Probe', 'verified' from campaigns limit 1;"
   ```
   Expected: "Leads discovered" increments on its own. If it does not, check that `0008`'s publication block ran (`select tablename from pg_publication_tables where pubname = 'supabase_realtime';` must list `leads`, `emails`, `cases`) and that Realtime is enabled for the local project.
4. Sign in as a client-role user → only that client's campaigns and mailboxes appear.

- [x] **Step 4: Update the roadmap**

In `.claude/roadmap.md`, under `## P4 — Deliverability Hardening + Observability`, replace the line
`- [ ] Operator observability dashboard from `events`: per-campaign funnel (discovered → verified → cased → sent → replied → handoff), mailbox health, error rates.`
with:

```markdown
- [x] **Analytics dashboard (`/analytics`)** — plan: `docs/superpowers/plans/2026-07-21-analytics-dashboard.md`. Migration `0008_analytics.sql` adds five `stable` **SECURITY INVOKER** aggregate functions (`analytics_overview`, `analytics_daily`, `analytics_by_campaign`, `analytics_mailboxes`, `analytics_event_counts`) so RLS decides each viewer's row set — operators aggregate every client, client-role users only their own; proven by `src/lib/db/analytics.integration.test.ts`. `src/lib/db/analytics.ts` wraps the RPCs, `src/lib/analytics/{range,rates,sparkline}.ts` hold the pure logic, and `/analytics` is a Server Component rendering stat tiles, per-campaign and per-mailbox tables, an agent-activity breakdown, and inline-SVG sparklines (no chart library, no new dependencies). `realtime-refresher.tsx` subscribes to Supabase Realtime `postgres_changes` on `emails`/`leads`/`cases` and debounces a `router.refresh()`, so the server recomputes the metrics live. Window semantics: leads/cases/events by `created_at`, outbound email by `coalesce(sent_at, created_at)`, "sent" includes `bounced`; columns marked SNAPSHOT (active sequences, case-status board) ignore the date range by design.
```

- [ ] **Step 5: Commit**

```bash
git add src/app/crm/page.tsx .claude/roadmap.md
git commit -m "feat(analytics): link dashboard from CRM and record P4 progress"
```

---

## Verification Summary

After Task 8 the following must all be true — check each before calling the feature done:

| Check | Command | Expected |
|---|---|---|
| Unit tests | `pnpm test` | all pass; 4 new files, 39 new tests |
| Types | `pnpm typecheck` | exits 0, silent |
| Lint | `pnpm lint` | clean except the pre-existing `env.test.ts` warning |
| Build | `pnpm build` | succeeds, `/analytics` listed as dynamic |
| RLS | `pnpm test:integration` | `analytics.integration.test.ts` passes |
| Realtime | manual (Task 8 Step 3) | inserting a lead updates the page with no reload |
