-- Extensions
create extension if not exists "pgcrypto";

-- ---------- Enums ----------
create type user_role            as enum ('operator', 'client');
create type client_status        as enum ('active', 'paused', 'archived');
create type campaign_status      as enum ('active', 'paused', 'archived');
create type reply_mode           as enum ('auto_send', 'human_approve', 'hybrid');
create type price_handoff_mode   as enum ('book_call_and_notify', 'notify_only', 'configurable');
create type lead_email_status    as enum ('unverified', 'verified', 'invalid', 'risky', 'not_found');
create type lead_status          as enum ('new', 'parked', 'active');
create type case_status          as enum ('new', 'researching', 'ready', 'contacted', 'in_conversation', 'hot_handoff', 'won', 'lost', 'dead');
create type knowledge_kind       as enum ('company', 'person', 'news', 'pain_point', 'answer');
create type email_direction      as enum ('outbound', 'inbound');
create type email_status         as enum ('draft', 'queued', 'sent', 'delivered', 'bounced', 'failed');
create type sequence_state       as enum ('active', 'paused', 'stopped', 'completed');
create type knowledge_req_status as enum ('open', 'answered', 'dismissed');
create type mailbox_provider     as enum ('gmail', 'outlook');
create type mailbox_health       as enum ('ok', 'warning', 'blocked');
create type suppression_reason   as enum ('replied', 'bounced', 'manual', 'price_handoff');
create type author_kind          as enum ('agent', 'human');

-- ---------- clients ----------
create table clients (
  id         uuid primary key default gen_random_uuid(),
  name       text not null,
  status     client_status not null default 'active',
  settings   jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- app_users (NOT in architecture §5; added for RLS user->client mapping) ----------
-- operators: role='operator', client_id null  -> span all clients
-- clients:   role='client',   client_id set   -> scoped to one client
create table app_users (
  id         uuid primary key references auth.users(id) on delete cascade,
  role       user_role not null default 'client',
  client_id  uuid references clients(id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint app_users_client_role_ck
    check ((role = 'operator' and client_id is null) or (role = 'client' and client_id is not null))
);

-- ---------- campaigns ----------
create table campaigns (
  id                 uuid primary key default gen_random_uuid(),
  client_id          uuid not null references clients(id) on delete cascade,
  name               text not null,
  status             campaign_status not null default 'active',
  icp                jsonb not null default '{}'::jsonb,
  value_prop         text,
  booking_link       text,
  reply_mode         reply_mode not null default 'human_approve',
  price_handoff_mode price_handoff_mode not null default 'book_call_and_notify',
  mailbox_ids        uuid[] not null default '{}',
  daily_target       integer not null default 0,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);

-- ---------- cases ----------
create table cases (
  id             uuid primary key default gen_random_uuid(),
  client_id      uuid not null references clients(id) on delete cascade,
  campaign_id    uuid not null references campaigns(id) on delete cascade,
  company_name   text not null,
  company_domain text,
  status         case_status not null default 'new',
  summary        text,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

-- ---------- leads ----------
create table leads (
  id                uuid primary key default gen_random_uuid(),
  client_id         uuid not null references clients(id) on delete cascade,
  campaign_id       uuid not null references campaigns(id) on delete cascade,
  case_id           uuid references cases(id) on delete set null,
  full_name         text not null,
  title             text,
  company_name      text,
  company_domain    text,
  linkedin_url      text,
  source            text,
  raw               jsonb not null default '{}'::jsonb,
  email             text,
  email_status      lead_email_status not null default 'unverified',
  email_verified_at timestamptz,
  status            lead_status not null default 'new',
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

-- ---------- case_knowledge (append-only) ----------
create table case_knowledge (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  case_id    uuid not null references cases(id) on delete cascade,
  kind       knowledge_kind not null,
  content    text not null,
  source_url text,
  citation   text,
  created_by author_kind not null default 'agent',
  created_at timestamptz not null default now()
);

-- ---------- emails ----------
create table emails (
  id                  uuid primary key default gen_random_uuid(),
  client_id           uuid not null references clients(id) on delete cascade,
  case_id             uuid references cases(id) on delete set null,
  lead_id             uuid references leads(id) on delete set null,
  thread_id           text,
  provider_message_id text,
  direction           email_direction not null,
  subject             text,
  body                text,
  status              email_status not null default 'draft',
  sequence_step       integer,
  mailbox_id          uuid,
  sent_at             timestamptz,
  created_at          timestamptz not null default now()
);

-- ---------- sequences ----------
create table sequences (
  id               uuid primary key default gen_random_uuid(),
  client_id        uuid not null references clients(id) on delete cascade,
  case_id          uuid not null references cases(id) on delete cascade,
  lead_id          uuid not null references leads(id) on delete cascade,
  state            sequence_state not null default 'active',
  current_step     integer not null default 0,
  next_action_at   timestamptz,
  qstash_message_id text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now()
);

-- ---------- knowledge_requests ----------
create table knowledge_requests (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  case_id      uuid not null references cases(id) on delete cascade,
  lead_id      uuid references leads(id) on delete set null,
  email_id     uuid references emails(id) on delete set null,
  question     text not null,
  status       knowledge_req_status not null default 'open',
  human_answer text,
  answered_by  uuid references auth.users(id) on delete set null,
  answered_at  timestamptz,
  created_at   timestamptz not null default now()
);

-- ---------- mailboxes ----------
create table mailboxes (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  provider      mailbox_provider not null,
  email_address text not null,
  display_name  text,
  oauth         jsonb not null default '{}'::jsonb,
  daily_cap     integer not null default 20,
  sent_today    integer not null default 0,
  warmup_state  jsonb not null default '{}'::jsonb,
  health        mailbox_health not null default 'ok',
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (client_id, email_address)
);

-- ---------- suppressions ----------
create table suppressions (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  email      text not null,
  reason     suppression_reason not null,
  created_at timestamptz not null default now(),
  unique (client_id, email)
);

-- ---------- events (audit log) ----------
create table events (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid references clients(id) on delete cascade,
  case_id    uuid references cases(id) on delete set null,
  actor      text not null,
  type       text not null,
  payload    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

-- ---------- Indexes on WHERE-hot columns (QUALITY: index every hot-path filter) ----------
create index idx_campaigns_client         on campaigns(client_id);
create index idx_cases_client             on cases(client_id);
create index idx_cases_campaign           on cases(campaign_id);
create index idx_leads_client             on leads(client_id);
create index idx_leads_campaign           on leads(campaign_id);
create index idx_leads_case               on leads(case_id);
create index idx_case_knowledge_case      on case_knowledge(case_id);
create index idx_emails_client            on emails(client_id);
create index idx_emails_case              on emails(case_id);
create index idx_emails_thread            on emails(thread_id);
create index idx_sequences_client         on sequences(client_id);
create index idx_knowledge_requests_case  on knowledge_requests(case_id);
create index idx_mailboxes_client         on mailboxes(client_id);
create index idx_suppressions_client      on suppressions(client_id);
create index idx_events_client            on events(client_id);
create index idx_app_users_client         on app_users(client_id);
