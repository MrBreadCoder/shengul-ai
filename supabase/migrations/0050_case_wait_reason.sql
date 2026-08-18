-- Second half of the outreach send waiting system (0049 added the enum
-- value in its own transaction; this one is safe to use it now that it's
-- committed). See 0049 and
-- docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md.

-- Why each case is waiting. The first three are mailbox-availability
-- conditions the 5-minute write-fanout cron re-checks automatically
-- (AUTO_RETRY_WAIT_REASONS, src/lib/db/cases.ts); 'awaiting_manual_approval'
-- clears when a human approves a draft in /inbox; 'no_viable_leads' clears
-- only if a later discovery pass adds a new lead to the case.
create type case_wait_reason as enum (
  'mailreach_gate',
  'daily_cap',
  'no_healthy_mailbox',
  'awaiting_manual_approval',
  'no_viable_leads'
);

alter table cases add column wait_reason case_wait_reason;

-- Keeps the two columns from ever disagreeing: a reason with no 'waiting'
-- status, or 'waiting' with no reason, are both invalid states. Same
-- cross-column guard pattern as app_users' role/client_id check (0001).
alter table cases add constraint cases_wait_reason_matches_status
  check ((status = 'waiting') = (wait_reason is not null));
