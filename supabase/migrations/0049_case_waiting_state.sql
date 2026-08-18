-- New case-status value for "write was attempted this tick and did not reach
-- a terminal outcome, but will (or may) be retried" — distinct from 'ready'
-- (never attempted) and 'writing' (actively running this instant). Fixes two
-- bugs sharing one root cause (runWriteForCase's unconditional end-of-loop
-- `contacted` write): a gate-blocked first touch silently losing the lead
-- (nothing retried a 'contacted' case with a failed step-0 email), and a
-- human_approve case with only drafts falsely CRM-syncing "First outreach
-- sent" before anyone approved. See
-- docs/superpowers/specs/2026-08-17-outreach-send-waiting-system-design.md.
--
-- ALTER TYPE ... ADD VALUE is permitted inside a transaction on PG12+ so long
-- as the new value is not *used* in the same transaction (0011, 0040) —
-- nothing below references 'waiting' as a case_status literal, so this is
-- safe under `supabase db push`.
alter type case_status add value if not exists 'waiting' after 'writing';

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
