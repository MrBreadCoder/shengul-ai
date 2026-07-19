-- Helper functions (security definer so they can read app_users under RLS)
create or replace function public.is_operator()
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from app_users where id = auth.uid() and role = 'operator');
$$;

create or replace function public.current_client_id()
returns uuid language sql stable security definer set search_path = public as $$
  select client_id from app_users where id = auth.uid();
$$;

-- Generic pattern:
--   SELECT: operator OR own client
--   WRITE (insert/update/delete): operator only (clients are read-only per architecture §11;
--   pipeline writes use the service-role key which bypasses RLS entirely)

-- clients (keyed by id, not client_id)
alter table clients enable row level security;
create policy clients_select on clients for select using (is_operator() or id = current_client_id());
create policy clients_write  on clients for all using (is_operator()) with check (is_operator());

-- app_users: a user may read their own row; operators read all; only operators write
alter table app_users enable row level security;
create policy app_users_select_self on app_users for select using (is_operator() or id = auth.uid());
create policy app_users_write on app_users for all using (is_operator()) with check (is_operator());

-- Tables carrying client_id — identical shape
do $$
declare t text;
begin
  foreach t in array array[
    'campaigns','cases','leads','case_knowledge','emails',
    'sequences','knowledge_requests','mailboxes','suppressions','events'
  ] loop
    execute format('alter table %I enable row level security;', t);
    execute format(
      'create policy %I on %I for select using (is_operator() or client_id = current_client_id());',
      t || '_select', t);
    execute format(
      'create policy %I on %I for all using (is_operator()) with check (is_operator());',
      t || '_write', t);
  end loop;
end $$;
