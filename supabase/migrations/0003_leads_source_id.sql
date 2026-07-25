-- Apollo person id for a discovered lead. Used to dedupe against Apollo re-fetches
-- and to skip credit-costing re-enrichment of people we've already seen for a
-- campaign. NULL is fine for any future non-Apollo source: Postgres unique
-- constraints never consider two NULLs equal, so multiple NULL source_ids per
-- campaign do not conflict.
alter table leads add column source_id text;
create unique index idx_leads_campaign_source_id on leads(campaign_id, source_id);
