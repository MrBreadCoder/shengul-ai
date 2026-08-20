-- The one place the case-level rollup rule lives. Every pipeline stage
-- that used to write cases.status directly off one contact's event now
-- writes that contact's leads.stage and calls this instead. Row-locks the
-- case first so two concurrent callers for the same case (e.g. a reply
-- landing for lead A while write.ts is still finishing lead B) serialize
-- their read-compute-write instead of interleaving it -- the same class
-- of race this whole redesign exists to close.
create type case_recompute_result as (
  status case_status,
  did_change boolean
);

create or replace function recompute_case_status(p_case_id uuid)
returns case_recompute_result
language plpgsql
as $$
declare
  v_current_status  case_status;
  v_total_leads     int;
  v_terminal_leads  int;
  v_has_lost        boolean;
  v_primary         lead_stage;
  v_new_status      case_status;
  v_new_wait_reason case_wait_reason;
  v_result          case_recompute_result;
begin
  select status into v_current_status from cases where id = p_case_id for update;
  if v_current_status is null then
    v_result.did_change := false;
    return v_result; -- case not found -- caller's own FK guarantees this shouldn't happen
  end if;

  -- 'won' is a human decision, made on the case, never derived from a
  -- contact's stage. Recompute must never walk it back.
  if v_current_status = 'won' then
    v_result.status := v_current_status;
    v_result.did_change := false;
    return v_result;
  end if;

  select count(*), count(*) filter (where stage in ('lost', 'dead'))
    into v_total_leads, v_terminal_leads
  from leads
  where case_id = p_case_id;

  if v_total_leads = 0 then
    v_result.status := v_current_status;
    v_result.did_change := false;
    return v_result;
  end if;

  if v_terminal_leads = v_total_leads then
    -- Every contact on the case is lost or dead. 'lost' (an explicit "no")
    -- is more informative than 'dead' (cadence exhausted, no reply either
    -- way), so it wins the tie when both are present.
    select exists(select 1 from leads where case_id = p_case_id and stage = 'lost') into v_has_lost;
    v_new_status := case when v_has_lost then 'lost' else 'dead' end::case_status;
    update cases set status = v_new_status, wait_reason = null, updated_at = now() where id = p_case_id;
    v_result.status := v_new_status;
    v_result.did_change := v_new_status is distinct from v_current_status;
    return v_result;
  end if;

  -- Not every contact is terminal. Pick whichever active contact has
  -- progressed furthest. Order mirrors ACTIVE_STAGE_RANK in
  -- src/lib/ui/lead-stage-badges.ts -- keep both in sync.
  select stage into v_primary
  from leads
  where case_id = p_case_id
    and stage in ('hot_handoff', 'in_conversation', 'contacted', 'waiting')
  order by array_position(
    array['hot_handoff', 'in_conversation', 'contacted', 'waiting']::lead_stage[],
    stage
  )
  limit 1;

  if v_primary is null then
    -- No contact has started outreach yet (all null), or the only
    -- contacts with a stage are a terminal minority alongside
    -- not-yet-started siblings. Leave the case's current pre-outreach
    -- status (new/researching/ready) exactly as the discovery pipeline
    -- set it -- there's nothing new to report yet.
    v_result.status := v_current_status;
    v_result.did_change := false;
    return v_result;
  end if;

  -- lead_stage and case_status are separate enum types even though these
  -- labels are spelled the same in both -- Postgres has no implicit
  -- cross-enum cast, so this has to go through text.
  v_new_status := v_primary::text::case_status;
  v_new_wait_reason := case when v_primary = 'waiting' then (
    select wait_reason from leads
    where case_id = p_case_id and stage = 'waiting' and wait_reason is not null
    -- Most-actionable-for-a-human first: an approval sitting in /inbox
    -- beats a resend that clears itself, which beats a cap that clears
    -- itself tomorrow.
    order by array_position(
      array['awaiting_manual_approval', 'awaiting_resend', 'daily_cap']::case_wait_reason[],
      wait_reason
    )
    limit 1
  ) else null end;

  update cases
  set status = v_new_status, wait_reason = v_new_wait_reason, updated_at = now()
  where id = p_case_id;

  v_result.status := v_new_status;
  v_result.did_change := v_new_status is distinct from v_current_status;
  return v_result;
end;
$$;
