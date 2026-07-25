-- Client knowledge base: operator-only per-client website pages + PDFs, chunked
-- and embedded for semantic retrieval, grounding the write/followup/reply/
-- knowledge-answer AI pipelines beyond the freeform campaigns.value_prop string.
-- Deliberately NOT added to the shared client-or-operator RLS loop in
-- 0002_rls_policies.sql — this content must never be visible to client-role
-- sessions, only to the operator who curates it.

create extension if not exists vector;

create type knowledge_source_type as enum ('website_page', 'pdf');
create type knowledge_source_status as enum ('pending', 'ready', 'failed');

create table client_knowledge_sources (
  id            uuid primary key default gen_random_uuid(),
  client_id     uuid not null references clients(id) on delete cascade,
  source_type   knowledge_source_type not null,
  url           text,
  storage_path  text,
  title         text not null,
  content       text,
  char_count    integer,
  status        knowledge_source_status not null default 'pending',
  error_message text,
  created_by    uuid not null references app_users(id),
  created_at    timestamptz not null default now(),
  scraped_at    timestamptz
);

-- Dedup guard for website pages: NULL url (pdf rows) is never subject to this
-- constraint, since a partial unique index ignores rows failing its WHERE.
create unique index client_knowledge_sources_url_uniq
  on client_knowledge_sources (client_id, url) where url is not null;

create index client_knowledge_sources_client_id_idx on client_knowledge_sources (client_id);

create table client_knowledge_chunks (
  id           uuid primary key default gen_random_uuid(),
  client_id    uuid not null references clients(id) on delete cascade,
  source_id    uuid not null references client_knowledge_sources(id) on delete cascade,
  chunk_index  integer not null,
  content      text not null,
  embedding    vector(768) not null,
  created_at   timestamptz not null default now()
);

create index client_knowledge_chunks_source_id_idx on client_knowledge_chunks (source_id);
create index client_knowledge_chunks_embedding_idx
  on client_knowledge_chunks using hnsw (embedding vector_cosine_ops);

alter table client_knowledge_sources enable row level security;
alter table client_knowledge_chunks enable row level security;

create policy client_knowledge_sources_all on client_knowledge_sources
  for all using (is_operator()) with check (is_operator());
create policy client_knowledge_chunks_all on client_knowledge_chunks
  for all using (is_operator()) with check (is_operator());

-- SECURITY DEFINER so it can read across the operator-only RLS from
-- server-side pipeline code (admin client) — always called with a specific
-- client_id, never trusts the caller's session for scoping.
create or replace function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_limit integer
) returns table (
  source_id uuid,
  source_title text,
  content text,
  similarity float
) language sql stable security definer set search_path = public as $$
  select c.source_id, s.title as source_title, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  where c.client_id = p_client_id
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;

-- Private bucket: PDFs may contain sensitive client business content, unlike
-- the public client-logos bucket. Writes are operator-only, enforced at the
-- API route layer via the service-role client (same convention as
-- 0013_client_branding.sql's storage bucket — no storage RLS policies used
-- anywhere in this codebase). Reads go through a signed URL generated
-- server-side, never a public URL.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'client-knowledge-pdfs',
  'client-knowledge-pdfs',
  false,
  10485760, -- 10MB
  array['application/pdf']
)
on conflict (id) do nothing;
