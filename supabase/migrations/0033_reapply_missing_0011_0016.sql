-- Re-apply migrations that were committed to this repo but never actually
-- applied to the hosted project — same failure mode as
-- 0026_crm_tables_data_api_grants.sql (see that file's comment for the prior
-- occurrence). Confirmed via a full audit of every ADD COLUMN / CREATE TABLE
-- / ALTER TYPE ... ADD VALUE across all 32 migrations against a real,
-- non-HEAD PostgREST query on production: these are the only two gaps.
--
-- 0011_lead_email_verification.sql never landed: leads.email_verification
-- does not exist in production, so every insertLeads() call (i.e. every
-- discovery run, for every campaign) has been failing with
-- "Could not find the 'email_verification' column of 'leads' in the schema
-- cache" since that column was first written to. Confirmed by directly
-- reproducing pipeline.discover.failed against production and reading the
-- AppError's underlying Postgres error.
alter table leads add column if not exists email_verification jsonb;

-- Same migration's enum value — withExternalLogging('emailable', ...) writes
-- events.source = 'emailable' on every Emailable vendor-call failure, and
-- that write has been silently swallowing itself (log_event.ts's
-- logEventSafe never throws) since Emailable verification shipped.
alter type log_source add value if not exists 'emailable';

-- 0016_collision_notice.sql never landed: cases.collision_notified_at does
-- not exist in production, so the meeting-collision-notice gate
-- (docs/superpowers/specs — pause + notify any other untouched contact once
-- one reaches hot_handoff) has had no column to read or write since it
-- shipped.
alter table cases add column if not exists collision_notified_at timestamptz;
