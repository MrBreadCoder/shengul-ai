-- supabase/migrations/0028_configurable_followup_cadence.sql
-- Client-wide default cadence (edited on /settings) and the per-lead
-- snapshot/override the pipeline actually reads from (edited on a case
-- page). Both default to today's hardcoded 3/7/14-day, 3-step cadence, so
-- every existing row keeps sending on exactly the schedule it does today.
-- See docs/superpowers/specs/2026-08-05-configurable-followup-cadence-design.md

alter table clients add column followup_delays_days integer[] not null default '{3,7,14}';
alter table sequences add column followup_delays_days integer[] not null default '{3,7,14}';
