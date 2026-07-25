-- P2 pipeline: idempotency + atomic mailbox cap enforcement.

-- One outbound email per (lead, sequence_step). Inbound rows have a null
-- sequence_step; Postgres treats nulls as distinct, so many inbound rows per
-- lead remain allowed. This index is the claim slot that makes send idempotent.
create unique index emails_outbound_step_uniq
  on public.emails (lead_id, sequence_step, direction);

-- Exactly one follow-up sequence per lead.
create unique index sequences_lead_uniq
  on public.sequences (lead_id);

-- One suppression per (client, email); makes addSuppression idempotent.
create unique index suppressions_client_email_uniq
  on public.suppressions (client_id, email);

-- Atomically claim one send against a mailbox's daily cap. Returns the updated
-- row when the send is allowed (healthy + under cap), or no rows when the cap
-- is reached or the mailbox is unhealthy. SECURITY DEFINER so the service role
-- executes it; callers use the admin client only.
create or replace function public.claim_mailbox_send(p_mailbox_id uuid)
returns setof public.mailboxes
language sql
security definer
set search_path = public
as $$
  update public.mailboxes
     set sent_today = sent_today + 1,
         updated_at = now()
   where id = p_mailbox_id
     and health = 'ok'
     and sent_today < daily_cap
  returning *;
$$;

-- Reset every mailbox's daily counter. Called by the daily reset cron.
create or replace function public.reset_mailbox_daily_counters()
returns void
language sql
security definer
set search_path = public
as $$
  update public.mailboxes set sent_today = 0, updated_at = now() where sent_today <> 0;
$$;
