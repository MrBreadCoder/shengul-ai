-- supabase/migrations/0027_mailbox_contact_name.sql
-- Mailreach's POST /v1/imap_auth requires first_name/last_name, which nothing in
-- the app collected before now (only the optional display_name). Nullable here —
-- existing rows stay null; "required" is enforced at the connect form/route layer
-- for new connects only, not backfilled. See
-- docs/superpowers/specs/2026-08-04-mailreach-smtp-connect-404-design.md section 2.

alter table mailboxes add column first_name text;
alter table mailboxes add column last_name  text;
