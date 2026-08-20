-- One-time best-guess backfill: no history exists to derive real
-- per-contact stages from, so every lead on a case whose outreach has
-- already begun gets its case's CURRENT status as a starting point.
-- 'new'/'researching'/'ready'/'writing' are excluded -- the first three
-- have no lead_stage counterpart (pre-outreach, case-level only), and
-- 'writing' is claimCaseForWriting's dispatch lock, not a committed
-- per-lead outcome, so casting it directly would either fail (no
-- 'writing' label in lead_stage) or misrepresent a lead that may not
-- have been touched yet. 'won' has no lead_stage counterpart either --
-- backfills to 'hot_handoff', the closest available proxy (the deal
-- reached serious conversation before closing). From this migration
-- forward, every contact's stage is tracked for real via
-- recompute_case_status (0054), not backfilled again.
update leads l
set stage = case c.status
  when 'won' then 'hot_handoff'
  else c.status::text::lead_stage
end,
wait_reason = case when c.status = 'waiting' then c.wait_reason else null end
from cases c
where l.case_id = c.id
  and c.status not in ('new', 'researching', 'ready', 'writing')
  and l.stage is null;
