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
