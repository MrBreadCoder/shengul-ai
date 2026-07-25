-- P3 reply handling: inbound polling cursor + idempotency keys for inbound
-- ingestion, reply sending, and knowledge-request escalation.

-- Opaque per-mailbox polling cursor. Gmail stores a historyId; Outlook stores a
-- Graph delta link. NULL means "not yet baselined" — the first poll captures the
-- current position and ingests nothing, so we never replay the whole mailbox.
alter table public.mailboxes add column if not exists inbound_cursor text;

-- A reply outbound points at the inbound email it answers.
alter table public.emails
  add column if not exists in_reply_to_email_id uuid references public.emails(id);

-- Nullable-column UNIQUE indexes (NOT partial): Postgres treats NULLs as
-- distinct, so the many rows with a NULL key never collide, while non-NULL keys
-- are forced unique. This shape — rather than a partial index — is what
-- supabase-js `upsert({ onConflict })` needs (it emits ON CONFLICT (col) with no
-- predicate, which a partial index would not satisfy).

-- Inbound dedup: the same provider message is ingested at most once, even if two
-- poll cycles overlap.
create unique index if not exists emails_provider_message_id_uniq
  on public.emails (provider_message_id);

-- Reply idempotency: at most one outbound reply per inbound email, so a retried
-- /api/inbound/reply delivery claims the slot exactly once.
create unique index if not exists emails_in_reply_to_uniq
  on public.emails (in_reply_to_email_id);

-- One knowledge request per inbound email — a retried reply run reuses it.
create unique index if not exists knowledge_requests_email_uniq
  on public.knowledge_requests (email_id);
