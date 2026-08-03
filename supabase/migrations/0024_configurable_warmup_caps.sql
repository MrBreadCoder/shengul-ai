-- Configurable per-mailbox warmup ramp: start cap, increment, and the target
-- cap where ramping stops. Defaults match the ramp's previous hardcoded
-- constants (WARMUP_START_CAP=5, WARMUP_INCREMENT=3); warmup_target_cap
-- backfills from the existing daily_cap so every existing mailbox computes
-- the exact same cap today as it did yesterday. From the moment the ramp
-- value reaches warmup_target_cap, effectiveDailyCap() serves daily_cap
-- instead — the existing "already warm" cap, now independently editable from
-- the Clients page's Warmup tab. See
-- docs/superpowers/specs/2026-08-03-configurable-warmup-caps-design.md.

alter table mailboxes add column warmup_start_cap  integer not null default 5;
alter table mailboxes add column warmup_increment  integer not null default 3;
alter table mailboxes add column warmup_target_cap integer;
update mailboxes set warmup_target_cap = daily_cap where warmup_target_cap is null;
alter table mailboxes alter column warmup_target_cap set not null;
