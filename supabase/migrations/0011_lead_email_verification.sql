-- Emailable deliverability guard (docs/superpowers/specs/2026-07-21-emailable-verification-design.md).
--
-- Emailable's per-lead verdict, kept out of `raw` — that column is documented in
-- architecture.md §5 as the full raw Apollo person object and must stay that.
--
-- Nullable with no backfill on purpose: an existing row reads NULL, meaning
-- "discovered before the guard existed", which is accurate.
--
-- Under the blanket fail-open policy this column is the only durable record of
-- whether a lead was actually guarded. `verified` no longer means one thing: it
-- is either "Emailable confirmed deliverable" or "Emailable was unreachable and
-- this is Apollo's word alone". The events log cannot answer that — the
-- retention cron added in 0010 purges info rows at 30 days and warn/error at 90.
--
-- No index: nothing queries this on a hot path, it is read per-lead for audit.
alter table leads add column email_verification jsonb;

-- `withExternalLogging('emailable', ...)` writes events.source, which is this
-- enum. ALTER TYPE ... ADD VALUE is permitted inside a transaction on PG12+ so
-- long as the new value is not *used* in the same transaction — nothing here
-- references it, so this is safe under `supabase db push`.
alter type log_source add value if not exists 'emailable';
