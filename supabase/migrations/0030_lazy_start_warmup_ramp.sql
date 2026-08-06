-- Lazy-start warmup ramp: the ramp clock now starts on a mailbox's first
-- actual send, not at connect time. Previously warmup_started_at was
-- stamped the moment a mailbox was connected (see warmupInsertFields,
-- src/lib/mailbox/warmup.ts), so the daily-cap ramp climbed every day even
-- while a mailbox sat idle through the whole 14-day Mailreach gate
-- (mailreach_started_at / MAILREACH_CAMPAIGN_GATE_DAYS,
-- src/lib/mailbox/mailreach-gate.ts — a separate, unrelated clock). See
-- docs/superpowers/specs/2026-08-06-lazy-start-warmup-ramp-design.md.

-- ---------- claim RPCs stamp warmup_started_at on first send ----------
-- coalesce() inside the single atomic UPDATE means only the first send ever
-- sets it; a later send is a no-op on this column, and two concurrent first
-- sends can't double-stamp since only one UPDATE commits first. Guarded to
-- warmup_profile <> 'none' so an already-warm mailbox (which never ramps,
-- see WARMUP_STEP_DAYS.none === 0) never gets a meaningless timestamp
-- written to it.
create or replace function public.claim_mailbox_send(p_mailbox_id uuid, p_effective_cap integer)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         warmup_started_at = case
           when warmup_profile <> 'none' then coalesce(warmup_started_at, now())
           else warmup_started_at
         end,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
     and sent_today < least(daily_cap, greatest(p_effective_cap, 0))
  returning *;
$$;

create or replace function public.claim_mailbox_send_uncapped(p_mailbox_id uuid)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         warmup_started_at = case
           when warmup_profile <> 'none' then coalesce(warmup_started_at, now())
           else warmup_started_at
         end,
         updated_at = now()
   where id = p_mailbox_id
     and health <> 'blocked'
  returning *;
$$;

-- ---------- backfill: reset mailboxes that are ramping but never sent ----------
-- Mailboxes connected before this migration already have warmup_started_at
-- stamped from connect time even though most have never sent anything —
-- exactly the reported bug. Reset those (and only those) back to null so
-- they pick up lazy-start on their next send. Uses the same "has this
-- mailbox ever sent" filter mailbox_send_stats (migration 0012) already
-- uses, so "never sent" means the same thing everywhere in the codebase.
-- Mailboxes that have already sent something are left untouched — resetting
-- their clock would cut their ramp progress, not fix anything.
update mailboxes m
   set warmup_started_at = null
 where m.warmup_profile <> 'none'
   and m.warmup_started_at is not null
   and not exists (
     select 1 from emails e
      where e.mailbox_id = m.id
        and e.direction = 'outbound'
        and e.status in ('sent', 'delivered', 'bounced')
   );
