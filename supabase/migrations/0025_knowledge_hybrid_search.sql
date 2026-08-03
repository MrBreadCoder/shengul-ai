-- Hybrid retrieval for the client knowledge base: combines vector-cosine
-- similarity with Postgres full-text search via Reciprocal Rank Fusion, so
-- exact terms (product names, prices, policy names) aren't outranked by a
-- merely semantically-similar chunk. See
-- docs/superpowers/specs/2026-08-04-knowledge-hybrid-search-design.md.
--
-- 'simple' text-search config deliberately used (no stemming) — this table
-- holds mixed-language client content and there is no per-client language
-- config to pick a dictionary from. Accepted recall trade-off, not solved
-- here.

alter table client_knowledge_chunks
  add column content_tsv tsvector generated always as (to_tsvector('simple', content)) stored;

create index client_knowledge_chunks_content_tsv_idx
  on client_knowledge_chunks using gin (content_tsv);

-- Postgres refuses to CREATE OR REPLACE a function whose parameter list
-- changed (42P13) — same reasoning 0019 used when it added resource_id to
-- this function's return shape. Drop-then-create, matching the exact 0019
-- signature so the drop resolves to the right overload.
drop function if exists match_client_knowledge_chunks(uuid, vector(768), integer);

create function match_client_knowledge_chunks(
  p_client_id uuid,
  p_query_embedding vector(768),
  p_query_text text,
  p_limit integer
) returns table (
  source_id uuid,
  source_title text,
  resource_id uuid,
  content text,
  similarity float
) language sql stable security definer set search_path = public as $$
  with vec as (
    select c.id, row_number() over (order by c.embedding <=> p_query_embedding) as rnk
    from client_knowledge_chunks c where c.client_id = p_client_id
  ),
  txt as (
    select c.id, row_number() over (
      order by ts_rank(c.content_tsv, websearch_to_tsquery('simple', p_query_text)) desc
    ) as rnk
    from client_knowledge_chunks c
    where c.client_id = p_client_id
      and c.content_tsv @@ websearch_to_tsquery('simple', p_query_text)
  )
  select c.source_id, s.title as source_title, s.resource_id, c.content,
         1 - (c.embedding <=> p_query_embedding) as similarity
  from client_knowledge_chunks c
  join client_knowledge_sources s on s.id = c.source_id
  join vec on vec.id = c.id
  left join txt on txt.id = c.id
  where c.client_id = p_client_id
  -- Reciprocal Rank Fusion, constant 60 (the standard default from the
  -- original RRF paper). No config surface — trivial to compute at this
  -- corpus size (a few hundred chunks per client).
  order by (1.0 / (60 + vec.rnk)) + coalesce(1.0 / (60 + txt.rnk), 0) desc
  limit p_limit;
$$;
