-- Per-client first-touch email voice. 'concise' (default) is today's
-- existing dossier-led, low-friction style — every current client keeps it
-- unchanged. 'formal_intro' is a structured self-introduction voice, opt-in
-- per client via the /clients/[id] toggle. See
-- docs/superpowers/specs/2026-08-08-uniforms-fashion-formal-intro-email-style-design.md

create type email_style as enum ('concise', 'formal_intro');
alter table clients add column email_style email_style not null default 'concise';
