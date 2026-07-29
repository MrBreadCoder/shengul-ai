-- Mailreach warmup integration: continuous inbox-reputation warmup via the
-- Mailreach API, independent of the existing daily-cap ramp (warmup_profile).
-- A mailbox becomes eligible for campaign sends 14 days after
-- mailreach_started_at, which is stamped once on first enrollment and never
-- cleared by a later disconnect/reconnect cycle (see mailreach-gate.ts).

create type mailreach_status as enum ('disconnected', 'pending', 'connected', 'error');

alter table clients add column mailreach_enabled boolean not null default false;

alter table mailboxes add column mailreach_enabled          boolean not null default false;
alter table mailboxes add column mailreach_started_at       timestamptz;
alter table mailboxes add column mailreach_account_id       text;
alter table mailboxes add column mailreach_status           mailreach_status not null default 'disconnected';
alter table mailboxes add column mailreach_reputation_score numeric;
alter table mailboxes add column mailreach_stats_synced_at  timestamptz;
