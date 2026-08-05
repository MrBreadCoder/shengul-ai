-- Per-user dashboard language, with an operator-set per-client default that
-- unset users inherit. See
-- docs/superpowers/specs/2026-08-05-dashboard-i18n-design.md

create type app_locale as enum ('en', 'tr');

alter table clients add column default_locale app_locale not null default 'en';
alter table app_users add column locale app_locale;
