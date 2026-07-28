-- Resources: files the agent may ATTACH to a reply (portfolio PDFs, mockups,
-- one-pagers). Deliberately NOT knowledge — a resource is never chunked,
-- embedded, or retrieved by retrieveClientKnowledge(). The AI only ever sees a
-- resource's title + description, offered as a numbered menu it picks from.
-- See docs/superpowers/specs/2026-07-26-ai-resources-design.md.

create table client_resources (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  title        text not null,
  -- NOT NULL on purpose: an undescribed resource is invisible to the AI's menu,
  -- so the schema forces the uploader to state what it is for.
  description  text not null,
  -- Already sanitized to a wire-safe ASCII subset at upload time, because this
  -- lands verbatim in a MIME Content-Disposition header.
  file_name    text not null,
  mime_type    text not null,
  byte_size    integer not null,
  storage_path text not null,
  -- Soft delete. A sent email references the resource it carried; hard-deleting
  -- would gut that audit trail. Deactivated rows drop out of the AI menu and
  -- every picker immediately.
  is_active    boolean not null default true,
  -- No ON DELETE action, matching client_knowledge_sources.created_by in 0014:
  -- removing an app_user must not silently destroy the collateral they uploaded
  -- (design spec §5.1), and CASCADE here would fight the ON DELETE RESTRICT on
  -- email_attachments.resource_id below anyway.
  created_by   uuid not null references app_users(id),
  created_at   timestamptz not null default now()
);

create index client_resources_client_active_idx
  on client_resources (client_id, created_at desc) where is_active;

create table email_attachments (
  -- client_id is denormalized so this table fits the flat RLS shape every other
  -- table in 0002_rls_policies.sql uses.
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references clients(id) on delete cascade,
  email_id    uuid not null references emails(id) on delete cascade,
  -- RESTRICT + the soft delete above is what keeps history intact.
  resource_id uuid not null references client_resources(id) on delete restrict,
  created_at  timestamptz not null default now(),
  -- Makes attaching idempotent under a retried QStash delivery.
  unique (email_id, resource_id)
);

create index email_attachments_email_id_idx on email_attachments (email_id);

alter table client_resources enable row level security;
alter table email_attachments enable row level security;

-- Clients manage their OWN uploads; operators manage everything. This is the
-- first table in the codebase a client-role session can write to.
-- created_by alone would be enough today, but it is not the whole rule: it
-- keeps matching after a user is reassigned to another client, which would let
-- them keep editing rows in the tenant they left. Both halves, on every policy.
create policy client_resources_select on client_resources for select
  using (is_operator() or client_id = current_client_id());
create policy client_resources_insert on client_resources for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy client_resources_update on client_resources for update
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()))
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy client_resources_delete on client_resources for delete
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));

-- Only the service-role pipeline writes attachments; clients read their own.
create policy email_attachments_select on email_attachments for select
  using (is_operator() or client_id = current_client_id());
create policy email_attachments_write on email_attachments for all
  using (is_operator()) with check (is_operator());

-- 0014 said this content "must never be visible to client-role sessions". That
-- decision is reversed: clients now curate their own knowledge alongside the
-- operator's. Chunks stay operator-write because only the pipeline writes them.
drop policy client_knowledge_sources_all on client_knowledge_sources;
drop policy client_knowledge_chunks_all on client_knowledge_chunks;

create policy client_knowledge_sources_select on client_knowledge_sources for select
  using (is_operator() or client_id = current_client_id());
create policy client_knowledge_sources_insert on client_knowledge_sources for insert
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy client_knowledge_sources_update on client_knowledge_sources for update
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()))
  with check (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));
create policy client_knowledge_sources_delete on client_knowledge_sources for delete
  using (is_operator() or (client_id = current_client_id() and created_by = auth.uid()));

create policy client_knowledge_chunks_select on client_knowledge_chunks for select
  using (is_operator() or client_id = current_client_id());
create policy client_knowledge_chunks_write on client_knowledge_chunks for all
  using (is_operator()) with check (is_operator());

-- Knowledge uploads widen from PDF-only to pdf/txt/md. Postgres allows ADD VALUE
-- inside a transaction (PG12+) as long as the new value is not USED in the same
-- transaction — it is not; runtime code starts writing 'file' rows after this
-- migration commits. Existing 'pdf' rows are left alone.
alter type knowledge_source_type add value if not exists 'file';

update storage.buckets
  set allowed_mime_types = array['application/pdf', 'text/plain', 'text/markdown']
  where id = 'client-knowledge-pdfs';

-- Private, same convention as client-knowledge-pdfs: no storage RLS policies,
-- writes go through the service-role client at the route layer, UI reads go
-- through a server-generated signed URL. 3145728 = 3MB, the per-email ceiling
-- that keeps Gmail, Graph and SMTP all on their simple send paths.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-resources',
  'client-resources',
  false,
  3145728,
  array[
    'application/pdf', 'image/png', 'image/jpeg', 'image/gif',
    'image/webp', 'image/svg+xml', 'text/plain', 'text/markdown'
  ]
)
on conflict (id) do nothing;
