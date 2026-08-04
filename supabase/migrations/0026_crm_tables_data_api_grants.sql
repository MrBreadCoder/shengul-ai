-- Fixes: /cases/[id] and /settings threw "Case unavailable" / failed to load
-- for every real (anon-key + session JWT) request.
--
-- Root cause: migration 0022_crm_integrations.sql was committed to this repo
-- but was never actually applied to this hosted project — crm_connections
-- and case_crm_links do not exist here at all (confirmed via direct SQL:
-- `relation "crm_connections" does not exist`, and independently via a real,
-- non-HEAD PostgREST query against every table in the schema — these two are
-- the only ones missing). Every read of them (getCaseCrmLink,
-- getCrmConnectionForClient) throws, and the case page's Promise.all lets
-- that exception kill the whole page.
--
-- This migration is 0022's body, applied here since it never ran, plus the
-- explicit Data API grant 0022 itself omitted: this project's Data API does
-- not auto-expose newly created tables to `anon`/`authenticated` by default
-- (see supabase/config.toml's `api.auto_expose_new_tables`), so without the
-- grant below the tables would exist but still be invisible to any real user
-- session, only reachable by the service_role admin client.
--
-- SELECT only granted: every insert/update/delete on these two tables already
-- goes through createAdminClient() (src/app/api/crm/[provider]/callback/route.ts,
-- src/app/(app)/settings/crm-actions.ts, src/lib/crm/sync.ts), which uses the
-- service_role key and needs no grant. `anon` is deliberately omitted: every
-- reader of these tables sits behind requireUser(), so there is no
-- unauthenticated code path to serve.

create type crm_provider          as enum ('hubspot', 'pipedrive');
create type crm_connection_status as enum ('connected', 'error');
create type crm_sync_status       as enum ('ok', 'error');

alter type log_source add value if not exists 'crm';

create table crm_connections (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null unique references clients(id) on delete cascade,
  provider       crm_provider not null,
  account_label  text,
  account_ref    text,
  oauth          jsonb not null default '{}'::jsonb,
  pipeline_id      text,
  pipeline_label   text,
  initial_stage_id text,
  won_stage_id   text,
  lost_stage_id  text,
  status         crm_connection_status not null default 'connected',
  status_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table case_crm_links (
  id                   uuid primary key default gen_random_uuid(),
  client_id            uuid not null references clients(id) on delete cascade,
  case_id              uuid not null unique references cases(id) on delete cascade,
  crm_connection_id    uuid not null references crm_connections(id) on delete cascade,
  external_contact_ids text[] not null default '{}',
  external_company_id  text,
  external_deal_id     text,
  external_deal_url    text,
  sync_started_at      timestamptz,
  last_synced_at       timestamptz,
  last_sync_status     crm_sync_status,
  last_sync_error      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);

create index case_crm_links_connection_idx on case_crm_links (crm_connection_id);

alter table crm_connections enable row level security;
alter table case_crm_links  enable row level security;

create policy crm_connections_select on crm_connections for select
  using (is_operator() or client_id = current_client_id());
create policy crm_connections_write on crm_connections for all
  using (is_operator()) with check (is_operator());

create policy case_crm_links_select on case_crm_links for select
  using (is_operator() or client_id = current_client_id());
create policy case_crm_links_write on case_crm_links for all
  using (is_operator()) with check (is_operator());

grant select on crm_connections to authenticated;
grant select on case_crm_links  to authenticated;

notify pgrst, 'reload schema';
