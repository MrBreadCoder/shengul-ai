-- 0039_reports.sql
-- Weekly + monthly client performance reports. See
-- docs/superpowers/specs/2026-08-12-reports-design.md.

create type report_type as enum ('weekly', 'monthly');
create type report_status as enum ('generating', 'ready', 'send_failed', 'sent');
create type report_delivery_status as enum ('sent', 'failed');

create table reports (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  type          report_type not null,
  period_start  timestamptz not null,
  period_end    timestamptz not null,
  -- Frozen snapshot, computed once at generation time — pages never
  -- re-query analytics_overview/analytics_daily live. See spec §2.
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
