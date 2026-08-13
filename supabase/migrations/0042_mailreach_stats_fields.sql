-- Adds the messaging-volume fields from Mailreach's real GET /v1/accounts/{id}/stats
-- response. mailreach_reputation_score (0021) is unchanged in shape — it was always
-- the right column, just fed from the wrong endpoint until this change (see
-- docs/superpowers/specs/2026-08-13-mailreach-warmup-surfacing-design.md §1).
alter table mailboxes add column mailreach_total_messages_sent     integer;
alter table mailboxes add column mailreach_total_messages_received integer;
alter table mailboxes add column mailreach_total_spam               integer;
alter table mailboxes add column mailreach_current_conversations    integer;
