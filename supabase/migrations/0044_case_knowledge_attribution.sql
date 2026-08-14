-- Fixes the root cause behind the 2026-08-11 person-research attribution bug
-- (.claude/roadmap.md same date): case_knowledge had no way to record *whose*
-- a person-kind fact was, so write.ts handed every case's full knowledge set
-- to every lead's prompt unfiltered. lead_id is null for company-level facts,
-- set for person-level facts. event_date supports a hard recency cutoff for
-- dated facts (e.g. scraped social posts) — null for evergreen firmographics.
-- See docs/superpowers/specs/2026-08-14-social-scraping-design.md.
alter table case_knowledge add column lead_id    uuid references leads(id) on delete set null;
alter table case_knowledge add column event_date timestamptz;

create index case_knowledge_lead_id_idx on case_knowledge(lead_id) where lead_id is not null;
