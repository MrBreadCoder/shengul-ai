-- Extends find_stuck_cases() (0006) to also catch cases stranded in the new
-- 'writing' claim status (0040). 'writing' is purely an in-progress claim —
-- success advances it to 'contacted' — so, like 'researching', age alone is
-- enough to call it stuck; no extra disambiguation needed the way the old
-- 'contacted'-as-claim branch required (see its own comment below).
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
  -- 'writing' (0040) is also a pure in-progress claim (success advances it
  -- to 'contacted') — same reasoning as 'researching' above.
  select c.*
    from public.cases c
   where c.status = 'writing'
     and c.updated_at < p_cutoff
  union all
  -- 'contacted' is the terminal write status. write/route.ts no longer
  -- claims 'contacted' up front as of 0040/this migration — it claims
  -- 'writing' instead — so this branch should only ever match cases
  -- stranded here from before that change shipped. Left in as a harmless
  -- backstop rather than removed. Only treat it as stuck when an active,
  -- verified lead still lacks its first-touch (step 0) outbound email —
  -- i.e. the write loop never finished. (A human_approve draft is a step-0
  -- outbound row, so drafted cases count as complete and are correctly
  -- excluded.)
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
