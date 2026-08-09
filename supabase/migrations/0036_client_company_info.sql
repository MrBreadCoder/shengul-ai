-- Operator-authored company description, injected verbatim as "About our
-- company" into every outbound email prompt (first-touch, follow-up,
-- redesign, reply, knowledge-answer). Replaces the website-crawled RAG
-- client-knowledge retrieval as the source of that section — see
-- docs/superpowers/specs/2026-08-09-manual-company-info-design.md.
alter table clients add column company_info text;
