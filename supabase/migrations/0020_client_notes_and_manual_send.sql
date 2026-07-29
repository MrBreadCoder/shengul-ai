-- 0020 — client notes + client-written email.
--
-- Four additive changes. No backfill, no deploy ordering constraint: nothing
-- here needs a route to exist first (unlike 0019).
--   1. notes                       — human annotations on a case, optionally pinned to a lead
--   2. emails.sent_by              — who typed a message; null means the agent wrote it
--   3. sequences.skip_next_step    — consumed at fire time to skip exactly one follow-up
--   4. claim_mailbox_send_uncapped — cap-free mailbox claim, human-written mail only

-- ---------- notes ----------
create table notes (
  id         uuid primary key default gen_random_uuid(),
  client_id  uuid not null references clients(id) on delete cascade,
  -- Always set, even for a note about one person: leads.case_id is nullable
  -- (on delete set null, 0001), so anchoring a note on the lead alone would
  -- leave notes attached to no visible surface.
  case_id    uuid not null references cases(id) on delete cascade,
  -- Null = the note is about the company. Set = about that person.
  lead_id    uuid references leads(id) on delete cascade,
  body       text not null,
  created_by uuid not null references app_users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index notes_case_idx on notes (case_id, created_at desc);

alter table notes enable row level security;

-- Mirrors client_resources (0018): the whole client reads, only the author
-- writes. Unlike emails, notes are written through the session-scoped client,
-- so these policies are the authorization boundary rather than a second wall.
create policy notes_select on notes for select
  using (is_operator() or client_id = current_client_id());
create policy notes_insert on notes for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy notes_update on notes for update
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()))
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy notes_delete on notes for delete
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));

-- ---------- provenance ----------
-- Null means the agent wrote it. No default and no backfill: every existing row
-- is agent-written, which is exactly what null already says.
alter table emails add column sent_by uuid references app_users(id);

-- ---------- follow-up skip ----------
-- Set when a human interjects into an active cadence. Consumed by the next
-- runFollowupStep firing, which sends nothing and schedules the step after it.
alter table sequences add column skip_next_step boolean not null default false;

-- ---------- cap-free mailbox claim ----------
-- claim_mailbox_send (0012) clamps with least(daily_cap, ...), so no argument
-- value can lift a human-written email over the cap. A separate function rather
-- than a flag on that one, so the agent's path cannot accidentally become
-- uncapped. sent_today still increments, keeping real volume visible to the
-- health monitor; health <> 'blocked' still applies, because a blocked mailbox
-- has nothing safe to send from.
create or replace function public.claim_mailbox_send_uncapped(p_mailbox_id uuid)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
  returning *;
$$;
