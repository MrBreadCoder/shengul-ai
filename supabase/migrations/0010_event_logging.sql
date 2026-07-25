
-- Client-scoped logging.
--
-- `events` already carries client_id / case_id / actor / type / payload and is
-- written by ~35 call sites. This adds the two dimensions an operator needs to
-- answer "is this client's agent healthy?" without reading every payload:
--   severity - info | warn | error
--   source   - which subsystem or vendor emitted the row
--
-- Both columns are NOT NULL WITH DEFAULT, so every existing insert keeps
-- working unchanged while the call sites are migrated task by task.

create type log_severity as enum ('info', 'warn', 'error');

create type log_source as enum (
  'app',        -- operator/user actions in the web app
  'pipeline',   -- our own orchestration steps
  'gemini',     -- Google Gemini via the AI SDK
  'apollo',     -- Apollo.io lead search + enrichment
  'brightdata', -- BrightData SERP + Web Unlocker
  'mailbox',    -- Gmail / Outlook send + read
  'qstash',     -- Upstash QStash scheduling and delivery
  'db'          -- Supabase / Postgres
);

alter table events
  add column severity log_severity not null default 'info',
  add column source   log_source   not null default 'app';

-- Backfill historic rows so the Logs tab has real content the moment it ships.
-- Ordered narrowest-last: the source rules do not overlap, but the severity
-- rule runs first so a failed row keeps its correct source below.
update events set severity = 'error'
 where type like '%.failed' or type like '%_failed' or type like '%.agent_failed';

update events set source = 'gemini'     where type like 'llm.%';
update events set source = 'apollo'     where type like 'apollo.%';
update events set source = 'brightdata' where type like 'brightdata.%';
update events set source = 'mailbox'    where type like 'mailbox.%';
update events set source = 'pipeline'
 where type like 'pipeline.%' or type like 'reply.%' or type like 'inbound.%' or type like 'cron.%';

-- Hot paths. The Logs tab filters by (client, severity) newest-first; the
-- clients list groups by client over a 24h window; the retention purge scans
-- by (severity, age) across every client.
create index idx_events_client_severity_created on events (client_id, severity, created_at desc);
create index idx_events_client_created          on events (client_id, created_at desc);
create index idx_events_severity_created        on events (severity, created_at);

-- One grouped query for the clients-list health dots. Without it the list would
-- issue one count per client (N+1) on a page that renders every client at once.
--
-- SECURITY INVOKER (the default): a client-role caller is already restricted to
-- its own client_id by the events RLS policy from 0002_rls_policies.sql, exactly
-- as in 0008_analytics.sql. Every reference to the events table is qualified
-- with the `e` alias so it can never collide with an OUT column name.
create function public.events_error_counts(p_since timestamptz)
returns table (
  client_id   uuid,
  error_count bigint,
  warn_count  bigint
)
language sql
stable
as $$
  select e.client_id,
         count(*) filter (where e.severity = 'error') as error_count,
         count(*) filter (where e.severity = 'warn')  as warn_count
    from public.events e
   where e.client_id is not null
     and e.created_at >= p_since
     and e.severity in ('error', 'warn')
   group by e.client_id;
$$;

grant execute on function public.events_error_counts(timestamptz) to authenticated;
