-- Configurable "how many verified contacts to aim for per company" knob for
-- discovery. Defaults to 2 rather than 1: the discover.ts depth-search phase
-- already existed specifically to find a second contact per company before
-- this column existed — that was always the intended behavior, just never
-- guaranteed within a single discovery run (see
-- docs/superpowers/specs/2026-08-10-contacts-per-company-design.md). Setting
-- the default to 2 here makes every existing campaign's next discovery run
-- match that pre-existing intent instead of silently reverting to 1.
alter table campaigns
  add column contacts_per_company integer not null default 2;

alter table campaigns
  add constraint campaigns_contacts_per_company_check
  check (contacts_per_company >= 1 and contacts_per_company <= 10);
