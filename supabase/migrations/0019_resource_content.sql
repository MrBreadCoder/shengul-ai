-- Resource content: the agent can now read what is inside a resource file.
--
-- This REVERSES the rule stated at the top of 0018_client_resources.sql, that a
-- resource is "never chunked, embedded, or retrieved by retrieveClientKnowledge()".
-- A resource's content is now derived at upload time (text extraction where it
-- works, Gemini vision for images and text-thin PDFs) and embedded into the
-- existing knowledge index through a companion client_knowledge_sources row.
-- See docs/superpowers/specs/2026-07-27-resource-content-design.md.

create type resource_content_status as enum ('pending', 'ready', 'failed', 'unsupported');

alter table client_resources
  -- The agent now derives what a file contains from the file itself. This column
  -- narrows to an optional steering hint ("only on a direct pricing request") —
  -- the one thing the content cannot express.
  alter column description drop not null,
  add column content_status  resource_content_status not null default 'pending',
  -- Full derived content: the extracted text, or the vision model's description.
  add column content         text,
  -- One line, capped at RESOURCE_SUMMARY_MAX_CHARS, for the AI's attach menu.
  add column content_summary text,
  add column content_error   text,
  add column read_at         timestamptz;

-- PG12+ allows ADD VALUE inside a transaction as long as the new value is not
-- USED in the same transaction — it is not; runtime code writes 'resource' rows
-- only after this migration commits. Same reasoning as 0018's 'file' value.
alter type knowledge_source_type add value if not exists 'resource';

alter table client_knowledge_sources
  add column resource_id uuid references client_resources(id) on delete cascade;

-- At most one companion source per resource. This is what makes the worker's
-- select-then-insert-or-update idempotent under a QStash retry.
create unique index client_knowledge_sources_resource_id_key
  on client_knowledge_sources (resource_id) where resource_id is not null;

-- Retrieval must be able to trace a matched chunk back to an attachable file, so
-- the reply prompt can label the line and the model knows it may send the source.
--
-- Dropped first, not CREATE OR REPLACEd: adding resource_id changes the row type
-- defined by the OUT parameters, and Postgres refuses to replace a function whose
-- return type changed (42P13). No CASCADE — nothing else depends on this function,
-- and a plain drop fails loudly if that ever stops being true. The original in
-- 0014 granted nothing explicitly, so the recreate below restores the same
-- default privileges.
drop function if exists match_client_knowledge_chunks(uuid, vector(768), integer);

create function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_limit integer
) returns table (
  source_id uuid,
  source_title text,
  resource_id uuid,
  content text,
  similarity float
) language sql stable security definer set search_path = public as $$
  select c.source_id, s.title as source_title, s.resource_id, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  where c.client_id = p_client_id
  order by c.embedding <=> p_query_embedding
  limit p_limit;
$$;
