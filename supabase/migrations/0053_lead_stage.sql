-- Per-contact progress -- the piece that's been missing (see
-- docs/superpowers/specs/2026-08-20-per-contact-case-status-design.md).
-- Deliberately a subset of case_status: 'new'/'researching'/'ready' are
-- pre-outreach, company-level research phases with no per-contact meaning
-- yet (leads.stage stays null until a pipeline stage first has a real
-- per-lead outcome); 'won' is a human decision made on the case itself,
-- never derived from a contact's reply -- see recompute_case_status
-- (0054), which must never touch a case already 'won'.
create type lead_stage as enum (
  'waiting',
  'contacted',
  'in_conversation',
  'hot_handoff',
  'lost',
  'dead'
);

alter table leads add column stage lead_stage;
alter table leads add column wait_reason case_wait_reason;

-- Same cross-column guard as cases_wait_reason_matches_status (0050),
-- adjusted for stage being nullable (a lead that hasn't started outreach
-- yet has both columns null). coalesce(..., false) avoids the
-- three-valued-logic trap of comparing a nullable boolean straight
-- against a NOT NULL check.
alter table leads add constraint leads_wait_reason_matches_stage
  check (coalesce(stage = 'waiting', false) = (wait_reason is not null));
