-- New case_wait_reason value: this case has at least one lead whose
-- first-touch content already exists and is parked at the email level in
-- 'waiting' (see 0051). It clears when the drain sweep sends it, never by
-- regenerating — deliberately excluded from AUTO_RETRY_WAIT_REASONS
-- (src/lib/db/cases.ts) so write-fanout's cron never reclaims a case for
-- fresh writing over this.
--
-- Separate file/transaction from 0051 for the same ADD VALUE restriction.
alter type case_wait_reason add value if not exists 'awaiting_resend';
