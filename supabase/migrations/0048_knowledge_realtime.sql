-- ---------- Realtime: case_knowledge, client_knowledge_sources, client_resources ----------
-- Closes two gaps found while auditing the realtime rollout (see roadmap):
--
-- 1. client_knowledge_sources was referenced by a postgres_changes subscription
--    (clients/[id]'s knowledge refresher) that has existed since that page
--    shipped, but the table was never added to the publication — Supabase
--    silently drops subscriptions on tables outside it, so that "live" scrape
--    status indicator has never actually fired. This migration is the fix.
-- 2. case_knowledge and client_resources feed /knowledge, /knowledge/resources
--    and /cases/[id], none of which have ever been wired for realtime.
--
-- Same idempotent pattern as migrations 0008 and 0047. RLS is enforced by
-- Realtime against the new record, and we never read the `old` record, so
-- REPLICA IDENTITY stays default on all three.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'case_knowledge'
    ) then
      execute 'alter publication supabase_realtime add table public.case_knowledge';
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_knowledge_sources'
    ) then
      execute 'alter publication supabase_realtime add table public.client_knowledge_sources';
    end if;
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'client_resources'
    ) then
      execute 'alter publication supabase_realtime add table public.client_resources';
    end if;
  end if;
end $$;
