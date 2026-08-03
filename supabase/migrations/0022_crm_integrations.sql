-- Outbound CRM integrations. We PUSH qualified cases into a client's own CRM
-- (HubSpot / Pipedrive) as Contact + Company + Deal, then keep the Deal's notes
-- and won/lost outcome in step with the case. One-way: we never read the
-- client's CRM as a lead source.
-- See docs/superpowers/specs/2026-08-02-crm-integrations-design.md.

create type crm_provider          as enum ('hubspot', 'pipedrive');
create type crm_connection_status as enum ('connected', 'error');
create type crm_sync_status       as enum ('ok', 'error');

-- New vendor for the Logs tab's source filter. Permitted inside a transaction
-- on PG12+ because nothing in this migration *uses* the new value.
alter type log_source add value if not exists 'crm';

create table crm_connections (
  id             uuid primary key default gen_random_uuid(),
  -- UNIQUE: one CRM per client. Connecting a second one is not supported, and
  -- the constraint is what makes getCrmConnectionForClient a single-row read.
  client_id      uuid not null unique references clients(id) on delete cascade,
  provider       crm_provider not null,
  -- Provider-side portal/company name, shown in Settings so the client can
  -- confirm WHICH account is linked. Nullable: not every provider returns one.
  account_label  text,
  -- Provider-side account identifier needed to build record deep links:
  -- HubSpot portal (hub) id, Pipedrive api_domain. Captured at code exchange so
  -- createDeal can return a URL without a second round trip.
  account_ref    text,
  -- AES-256-GCM envelope, identical shape to mailboxes.oauth. Encrypted because
  -- the SELECT policy below lets a client-role session read its own row via
  -- PostgREST — plaintext here would hand out a live refresh token.
  oauth          jsonb not null default '{}'::jsonb,
  -- Null until the client finishes the pipeline-selection step. A connection
  -- with a null pipeline_id is NOT usable; the sync worker skips it.
  pipeline_id      text,
  pipeline_label   text,
  initial_stage_id text,
  -- HubSpot models closure as pipeline stages, so these carry stage ids there.
  -- Pipedrive models it as a separate deal status field, so they stay null.
  won_stage_id   text,
  lost_stage_id  text,
  status         crm_connection_status not null default 'connected',
  -- e.g. 'token_revoked'. Drives the reconnect banner in /settings/crm.
  status_reason  text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create table case_crm_links (
  id                   uuid primary key default gen_random_uuid(),
  -- Denormalized so this table fits the flat RLS shape every other table in
  -- 0002_rls_policies.sql uses, exactly as email_attachments.client_id does.
  client_id            uuid not null references clients(id) on delete cascade,
  -- UNIQUE: one external Deal per case. This constraint plus the claim below is
  -- what makes a retried or concurrent sync unable to create a second Deal.
  case_id              uuid not null unique references cases(id) on delete cascade,
  -- CASCADE: an external id is only meaningful relative to one connected
  -- account, so disconnecting must not leave links pointing at ids that do not
  -- exist in whatever CRM is connected next.
  crm_connection_id    uuid not null references crm_connections(id) on delete cascade,
  external_contact_ids text[] not null default '{}',
  external_company_id  text,
  external_deal_id     text,
  external_deal_url    text,
  -- Single-flight claim. Set when a worker starts, cleared when it finishes;
  -- a stale value past the cutoff is reclaimable so a crashed worker cannot
  -- deadlock the case permanently.
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

-- Flat per-client isolation, same shape as the loop in 0002_rls_policies.sql.
-- SELECT only: every write goes through createAdminClient() from a route or
-- Server Action that has already checked session, role, and ownership.
create policy crm_connections_select on crm_connections for select
  using (is_operator() or client_id = current_client_id());
create policy crm_connections_write on crm_connections for all
  using (is_operator()) with check (is_operator());

create policy case_crm_links_select on case_crm_links for select
  using (is_operator() or client_id = current_client_id());
create policy case_crm_links_write on case_crm_links for all
  using (is_operator()) with check (is_operator());
