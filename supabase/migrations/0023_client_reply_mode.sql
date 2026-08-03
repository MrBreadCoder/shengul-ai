-- Client-configurable reply mode. Clients choose Automatic / Manual / Hybrid
-- from /settings; the value is synced onto every campaigns.reply_mode row for
-- that client so the existing pipeline read path (getCampaignForCase) needs
-- no changes. See docs/superpowers/specs/2026-08-03-client-reply-mode-setting-design.md.

alter table clients add column reply_mode reply_mode not null default 'human_approve';
