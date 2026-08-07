-- Per-client default discovery schedule + optional per-campaign overrides,
-- replacing the single global 06:00 UTC discover cron with a per-campaign
-- scheduled instant the scheduler tick (discover-fanout) polls every 5
-- minutes. See docs/superpowers/specs/2026-08-07-campaign-scheduling-design.md

alter table clients
  add column timezone text not null default 'UTC',
  add column default_discover_time text not null default '06:00';

alter table campaigns
  add column discover_time text,
  add column discover_timezone text,
  add column next_discover_at timestamptz not null default now();

-- Backfill: every campaign that existed before this migration was already
-- running on the old global 06:00 UTC cron. Point next_discover_at at the
-- next real occurrence of 06:00 UTC from right now, so nothing changes
-- behavior for an existing campaign until its client/operator touches the
-- new settings.
update campaigns
set next_discover_at = case
  when (date_trunc('day', now() at time zone 'utc') + interval '6 hours') at time zone 'utc' > now()
    then (date_trunc('day', now() at time zone 'utc') + interval '6 hours') at time zone 'utc'
  else (date_trunc('day', now() at time zone 'utc') + interval '1 day 6 hours') at time zone 'utc'
end;

create index idx_campaigns_next_discover_at
  on campaigns (next_discover_at)
  where status = 'active';
