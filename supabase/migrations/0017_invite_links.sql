-- Invite links that stay usable for a short window instead of dying on first
-- open.
--
-- Supabase's own invite token is single-use: the first GET that reaches
-- `/auth/callback` redeems it, and every later open fails. That first GET is
-- very often not the invited human — mail and chat platforms (Safe Links,
-- Gmail, Slack unfurls, antivirus proxies) fetch URLs the moment they are
-- sent, which silently burned invites before the recipient ever clicked.
--
-- This table replaces that token with our own. It carries no secret: the
-- link's raw token is hashed with SHA-256 before it is stored, so a leaked
-- dump of this table cannot be replayed into anyone's account. Redemption
-- mints a fresh Supabase session server-side, which is what makes the link
-- reusable inside its window rather than consumed on first sight.

create table invite_links (
  -- The SHA-256 of the token in the URL, hex-encoded. Primary key because
  -- lookup is always by this value and it is unique by construction.
  token_hash  text primary key,
  user_id     uuid not null references auth.users(id) on delete cascade,
  client_id   uuid not null references clients(id) on delete cascade,
  -- Cascades, unlike most `created_by` columns: without it, removing an
  -- operator would fail outright while any invite they issued was still
  -- outstanding, since a plain reference defaults to NO ACTION. An invite is
  -- short-lived and worthless once its issuer is gone, so following them out
  -- is also the behaviour we want.
  created_by  uuid not null references app_users(id) on delete cascade,
  expires_at  timestamptz not null,
  created_at  timestamptz not null default now()
);

-- Redemption filters on expiry, and the expired-row sweep scans on it.
create index invite_links_expires_at_idx on invite_links (expires_at);

-- Listing a client's outstanding invites, and cascading cleanup by client.
create index invite_links_client_id_idx on invite_links (client_id);

-- RLS on with no policy at all: this table is service-role only. Redemption
-- happens in a route handler using the admin client, before any session
-- exists, and no client-role or operator-role session has any reason to read
-- it. An enabled-but-policy-less table denies every non-service-role caller,
-- which is exactly the intent — unlike the operator-readable pattern used by
-- the knowledge tables in 0014.
alter table invite_links enable row level security;
