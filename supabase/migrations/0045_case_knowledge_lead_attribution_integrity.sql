-- Closes two gaps left by 0044_case_knowledge_attribution.sql (already
-- applied — not edited here, this migration only alters what it added):
--
-- 1. lead_id only FK'd to leads(id), with nothing tying the referenced lead
--    back to the same case/client as the case_knowledge row itself. Nothing
--    stopped attributing a fact to a lead from a different case, or even a
--    different client — silently reopening the exact company-vs-person
--    misattribution class 0044 was written to close, one hop removed.
--    write.ts's `k.lead_id === lead.id` filter (src/lib/pipeline/write.ts)
--    would just never match a mis-attributed row, silently dropping the
--    fact from every lead's dossier instead of failing loudly at write time.
-- 2. `on delete set null` on lead_id: deleting a lead nulled the
--    attribution instead of removing or blocking it. write.ts treats a null
--    lead_id as "company-wide fact" (see the `?? null` comment at
--    src/lib/pipeline/write.ts around the leadKnowledge filter), so a
--    deleted lead's person-specific fact would silently resurface as a
--    company-wide fact shown to every lead in the case — the same bug class
--    again. Replaced with `on delete cascade`: a lead-attributed fact has no
--    independent meaning once that lead is gone, so it goes with it.

alter table case_knowledge drop constraint case_knowledge_lead_id_fkey;
alter table case_knowledge
  add constraint case_knowledge_lead_id_fkey
  foreign key (lead_id) references leads(id) on delete cascade;

-- Trigger, not a check constraint: the check depends on another table's
-- row (leads.case_id / leads.client_id), which plain check constraints
-- cannot reference. `is distinct from` (not `<>`) so a lead that doesn't
-- exist under this trigger's read (case_id/client_id come back null) fails
-- the check instead of silently passing — `<>` with a null operand
-- evaluates to null, which plpgsql's `if` treats as false and would let a
-- bad row through.
create or replace function public.case_knowledge_validate_lead_attribution()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lead_case_id   uuid;
  v_lead_client_id uuid;
begin
  if new.lead_id is null then
    return new;
  end if;

  select case_id, client_id into v_lead_case_id, v_lead_client_id
  from leads
  where id = new.lead_id;

  if v_lead_case_id is distinct from new.case_id or v_lead_client_id is distinct from new.client_id then
    raise exception
      'case_knowledge.lead_id % must belong to case % / client % (found case % / client %)',
      new.lead_id, new.case_id, new.client_id, v_lead_case_id, v_lead_client_id
      using errcode = '23514';
  end if;

  return new;
end;
$$;

drop trigger if exists case_knowledge_lead_attribution_trigger on case_knowledge;
create trigger case_knowledge_lead_attribution_trigger
  before insert or update of lead_id, case_id, client_id on case_knowledge
  for each row
  execute function public.case_knowledge_validate_lead_attribution();
