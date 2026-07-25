-- Deterministic dedup key for Stage 2 grouping (architecture.md §6): the
-- company_domain (lowercased) when known, else the normalized company_name.
-- Always populated by the grouping code path (src/lib/pipeline/group-lead.ts),
-- so NOT NULL with no default is safe — there are no pre-existing case rows yet.
alter table cases add column company_key text not null;
create unique index idx_cases_campaign_company_key on cases(campaign_id, company_key);

