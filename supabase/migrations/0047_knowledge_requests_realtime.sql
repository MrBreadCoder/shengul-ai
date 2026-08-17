-- ---------- Realtime: knowledge_requests ----------
-- /inbox lists open knowledge requests and needs to react to two events: a new
-- one raised (INSERT) and an open one answered elsewhere, e.g. by another
-- operator (UPDATE, status open -> answered). RLS is enforced by Realtime
-- against the new record, and we never read the `old` record, so REPLICA
-- IDENTITY stays default. Same idempotent pattern as migration 0008.
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    if not exists (
      select 1 from pg_publication_tables
       where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = 'knowledge_requests'
    ) then
      execute 'alter publication supabase_realtime add table public.knowledge_requests';
    end if;
  end if;
end $$;
