-- Stuck-case recovery (code-review Important #6).
-- The research/write routes claim a case by advancing its status BEFORE looping
-- over its leads, so a concurrent or retried fan-out can't re-enter. The trade
-- off: if the loop dies mid-way, the case is stranded — a plain QStash retry
-- no-ops because the status guard already advanced past the entry condition.
-- This function surfaces genuinely-stuck cases so a sweeper cron can reset and
-- re-queue them. SECURITY DEFINER so the service role executes it; callers use
-- the admin client only.
create or replace function public.find_stuck_cases(p_cutoff timestamptz, p_limit int)
returns setof public.cases
language sql
stable
security definer
set search_path = public
as $$
  -- 'researching' is purely an in-progress claim (success advances it to
  -- 'ready'), so any such case older than the cutoff is unambiguously stuck.
  select c.*
    from public.cases c
   where c.status = 'researching'
     and c.updated_at < p_cutoff
  union all
  -- 'contacted' is ALSO the terminal write status, so age alone is ambiguous.
  -- Only treat it as stuck when an active, verified lead still lacks its
  -- first-touch (step 0) outbound email — i.e. the write loop never finished.
  -- (A human_approve draft is a step-0 outbound row, so drafted cases count as
  -- complete and are correctly excluded.)
  select c.*
    from public.cases c
   where c.status = 'contacted'
     and c.updated_at < p_cutoff
     and exists (
       select 1
         from public.leads l
        where l.case_id = c.id
          and l.status = 'active'
          and l.email_status = 'verified'
          and not exists (
            select 1
              from public.emails e
             where e.lead_id = l.id
               and e.direction = 'outbound'
               and e.sequence_step = 0
          )
     )
   order by updated_at asc
   limit p_limit;
$$;
