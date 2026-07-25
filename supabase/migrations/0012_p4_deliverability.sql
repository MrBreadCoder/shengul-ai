-- P4 deliverability hardening: warmup ramp, mailbox health attribution,
-- bounce-rate stats, and a cap check that accounts for the ramp.

-- ---------- warmup profiles ----------
-- 'standard' raises the cap every day, 'slow' every 2 days (for a domain that
-- needs a gentler ramp), 'none' skips the ramp for an already-warm mailbox.
create type warmup_profile as enum ('standard', 'slow', 'none');

alter table clients add column warmup_profile warmup_profile not null default 'standard';

alter table mailboxes add column warmup_profile   warmup_profile not null default 'standard';
alter table mailboxes add column warmup_started_at timestamptz;
-- Machine-readable reason the current health was set (see src/lib/mailbox/health.ts
-- HEALTH_REASON) plus when it changed, so the operator can tell an auto-pause
-- from a manual one without digging through events.
alter table mailboxes add column health_reason     text;
alter table mailboxes add column health_changed_at timestamptz;

-- Mailboxes connected before this migration are already in service; retro-ramping
-- them would cut their throughput for no deliverability benefit.
update mailboxes set warmup_profile = 'none';

-- Superseded by the three typed columns above. It was never read by application
-- code — only written by the seed generator.
alter table mailboxes drop column warmup_state;

-- ---------- bounce-rate stats ----------
-- Hot path for mailbox_send_stats and the /settings screen.
create index idx_emails_mailbox_sent on emails (mailbox_id, sent_at) where mailbox_id is not null;

-- Per-mailbox outbound volume and hard-bounce count over a window.
-- SECURITY INVOKER so RLS decides the row set: /settings sees only the viewer's
-- mailboxes, the health sweep (admin client) sees every one. Every column is
-- qualified with `e.` because the OUT parameter names shadow the table columns.
create or replace function public.mailbox_send_stats(p_since timestamptz)
returns table (
  mailbox_id    uuid,
  sent_count    bigint,
  bounced_count bigint
)
language sql
stable
security invoker
set search_path = public
as $$
  select e.mailbox_id,
         count(*) filter (where e.status in ('sent', 'delivered', 'bounced')) as sent_count,
         count(*) filter (where e.status = 'bounced')                          as bounced_count
    from public.emails e
   where e.direction = 'outbound'
     and e.mailbox_id is not null
     and e.sent_at >= p_since
   group by e.mailbox_id;
$$;

-- ---------- cap claim, warmup-aware ----------
-- Adding a parameter creates an overload rather than replacing, so drop first.
drop function if exists public.claim_mailbox_send(uuid);

-- p_effective_cap is the ramp-adjusted cap computed by the caller
-- (src/lib/mailbox/warmup.ts effectiveDailyCap). The ramp math lives in
-- TypeScript so it is unit-testable without a database; the *comparison* stays
-- here so the claim is still atomic. least(daily_cap, ...) means a caller can
-- only ever lower the ceiling, never raise it above the configured cap.
--
-- health <> 'blocked' (not health = 'ok'): 'warning' is a soft flag that still
-- sends, so the bounce-rate warning threshold is meaningful.
create or replace function public.claim_mailbox_send(p_mailbox_id uuid, p_effective_cap integer)
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
     and sent_today < least(daily_cap, greatest(p_effective_cap, 0))
  returning *;
$$;
