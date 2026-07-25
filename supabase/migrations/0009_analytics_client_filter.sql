-- Adds an optional p_client_id filter to analytics_overview / analytics_daily,
-- so an operator (who bypasses RLS via is_operator()) can scope the dashboard
-- to one client at a time. A client-role caller is already restricted to their
-- own client_id by RLS regardless of this parameter — see the SECURITY INVOKER
-- note at the top of 0008_analytics.sql, which still applies unchanged.
--
-- Every filtered table already carries its own client_id column, so this
-- filters directly on that column rather than joining through campaigns.

drop function if exists public.analytics_overview(timestamptz, timestamptz, uuid);

create function public.analytics_overview(
  p_from         timestamptz,
  p_to           timestamptz,
  p_campaign_id  uuid default null,
  p_client_id    uuid default null
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
        and (p_campaign_id is null or l.campaign_id = p_campaign_id)
        and (p_client_id is null or l.client_id = p_client_id)),
    -- leads_verified
    (select count(*) from public.leads l
      where l.created_at >= p_from and l.created_at < p_to
        and l.email_status = 'verified'
        and (p_campaign_id is null or l.campaign_id = p_campaign_id)
        and (p_client_id is null or l.client_id = p_client_id)),
    -- cases_created
    (select count(*) from public.cases c
      where c.created_at >= p_from and c.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or c.client_id = p_client_id)),
    -- emails_sent
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- first_touch_sent (sequence_step 0 is the cold open)
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.sequence_step = 0
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- followups_sent
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.sequence_step > 0
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- emails_bounced
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status = 'bounced'
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- emails_failed
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status = 'failed'
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- replies_received
    (select count(*) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'inbound'
        and e.created_at >= p_from and e.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- leads_contacted (distinct people we actually emailed in the window)
    (select count(distinct e.lead_id) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
        and e.lead_id is not null
        and coalesce(e.sent_at, e.created_at) >= p_from
        and coalesce(e.sent_at, e.created_at) < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- leads_replied (distinct people who wrote back in the window)
    (select count(distinct e.lead_id) from public.emails e
       left join public.cases c on c.id = e.case_id
      where e.direction = 'inbound'
        and e.lead_id is not null
        and e.created_at >= p_from and e.created_at < p_to
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or e.client_id = p_client_id)),
    -- suppressions_added. Suppressions carry no campaign_id, so this
    -- intentionally ignores p_campaign_id (the UI labels it as such), but it
    -- does honour p_client_id since suppressions do carry client_id.
    (select count(*) from public.suppressions s
      where s.created_at >= p_from and s.created_at < p_to
        and (p_client_id is null or s.client_id = p_client_id)),
    -- active_sequences (SNAPSHOT: follow-up cadences still running)
    (select count(*) from public.sequences q
       left join public.cases c on c.id = q.case_id
      where q.state = 'active'
        and (p_campaign_id is null or c.campaign_id = p_campaign_id)
        and (p_client_id is null or q.client_id = p_client_id));
$$;

drop function if exists public.analytics_daily(timestamptz, timestamptz, uuid);

create function public.analytics_daily(
  p_from        timestamptz,
  p_to          timestamptz,
  p_campaign_id uuid default null,
  p_client_id   uuid default null
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
       and (p_client_id is null or l.client_id = p_client_id)
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
       and (p_client_id is null or e.client_id = p_client_id)
     group by 1
  ),
  replies as (
    select date_trunc('day', e.created_at)::date as day, count(*) as n
      from public.emails e
      left join public.cases c on c.id = e.case_id
     where e.direction = 'inbound'
       and e.created_at >= p_from and e.created_at < p_to
       and (p_campaign_id is null or c.campaign_id = p_campaign_id)
       and (p_client_id is null or e.client_id = p_client_id)
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

grant execute on function public.analytics_overview(timestamptz, timestamptz, uuid, uuid) to authenticated;
grant execute on function public.analytics_daily(timestamptz, timestamptz, uuid, uuid)    to authenticated;
