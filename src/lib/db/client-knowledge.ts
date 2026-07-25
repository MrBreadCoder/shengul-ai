import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import { chunkText } from '@/lib/knowledge/chunk-text'
import { embedTexts } from '@/lib/llm/client'

export type KnowledgeSourceRow = Database['public']['Tables']['client_knowledge_sources']['Row']
export type KnowledgeChunkRow = Database['public']['Tables']['client_knowledge_chunks']['Row']
export interface MatchedChunk {
  sourceId: string
  sourceTitle: string
  content: string
  similarity: number
}

export interface PendingWebsitePage {
  url: string
  title: string
}

// Check-before-insert on (client_id, url): cheap for a batch of <=50 urls, and
// avoids relying on supabase-js's upsert+ignoreDuplicates ON CONFLICT inference
// against the partial unique index (Postgres arbiter inference for a partial
// index needs the WHERE clause restated, which PostgREST's onConflict option
// does not do). A rare concurrent double-submit still can't create a true
// duplicate row: the partial unique index rejects it at the DB level.
export async function insertPendingWebsiteSources(
  supabase: SupabaseClient<Database>,
  clientId: string,
  createdBy: string,
  pages: PendingWebsitePage[],
): Promise<KnowledgeSourceRow[]> {
  if (pages.length === 0) return []

  const { data: existing, error: selectError } = await supabase
    .from('client_knowledge_sources')
    .select('url')
    .eq('client_id', clientId)
    .in('url', pages.map((p) => p.url))
  if (selectError) {
    throw new AppError('DB_ERROR', 'Failed to check for existing knowledge sources', {
      clientId, cause: selectError.message,
    })
  }
  const existingUrls = new Set((existing ?? []).map((row) => row.url))
  const toInsert = pages.filter((p) => !existingUrls.has(p.url))
  if (toInsert.length === 0) return []

  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .insert(toInsert.map((p) => ({
      client_id: clientId,
      source_type: 'website_page' as const,
      url: p.url,
      title: p.title,
      status: 'pending' as const,
      created_by: createdBy,
    })))
    .select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert knowledge sources', { clientId, cause: error.message })
  }
  return data ?? []
}

export async function listSourcesForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<KnowledgeSourceRow[]> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .select('*')
    .eq('client_id', clientId)
    .order('created_at', { ascending: false })
  if (error) throw new AppError('DB_ERROR', 'Failed to list knowledge sources', { clientId, cause: error.message })
  return data ?? []
}

export async function getSourceById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<KnowledgeSourceRow | null> {
  const { data, error } = await supabase.from('client_knowledge_sources').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load knowledge source', { id, cause: error.message })
  return data
}

export async function markSourceReady(
  supabase: SupabaseClient<Database>,
  id: string,
  content: string,
  charCount: number,
): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .update({ status: 'ready', content, char_count: charCount, error_message: null, scraped_at: new Date().toISOString() })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to mark knowledge source ready', { id, cause: error.message })
}

export async function markSourceFailed(
  supabase: SupabaseClient<Database>,
  id: string,
  errorMessage: string,
): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .update({ status: 'failed', error_message: errorMessage })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to mark knowledge source failed', { id, cause: error.message })
}

export async function resetSourceToPending(supabase: SupabaseClient<Database>, id: string): Promise<void> {
  const { error } = await supabase
    .from('client_knowledge_sources')
    .update({ status: 'pending', content: null, char_count: null, error_message: null, scraped_at: null })
    .eq('id', id)
  if (error) throw new AppError('DB_ERROR', 'Failed to reset knowledge source', { id, cause: error.message })
}

// Returns the deleted row (needed by the caller to clean up a pdf's storage
// object) or null if it was already gone. Chunks cascade via the FK.
export async function deleteSource(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<KnowledgeSourceRow | null> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .delete()
    .eq('id', id)
    .select('*')
    .maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to delete knowledge source', { id, cause: error.message })
  return data
}

export interface InsertPdfSourceInput {
  clientId: string
  createdBy: string
  title: string
  storagePath: string
  content: string
  charCount: number
}

// PDFs are extracted inline (no network dependency, unlike a website scrape),
// so the row is created already 'ready' — there's no pending window to show.
export async function insertPdfSourceReady(
  supabase: SupabaseClient<Database>,
  input: InsertPdfSourceInput,
): Promise<KnowledgeSourceRow> {
  const { data, error } = await supabase
    .from('client_knowledge_sources')
    .insert({
      client_id: input.clientId,
      source_type: 'pdf',
      title: input.title,
      storage_path: input.storagePath,
      content: input.content,
      char_count: input.charCount,
      status: 'ready',
      created_by: input.createdBy,
      scraped_at: new Date().toISOString(),
    })
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to insert PDF knowledge source', { clientId: input.clientId, cause: error?.message })
  }
  return data
}

export interface EmbedAndStoreChunksInput {
  clientId: string
  sourceId: string
  content: string
  actor: string
}

// Chunks content, embeds every chunk in one batched call, inserts one row per
// chunk. Callers are responsible for deleting any prior chunks for this
// source first (see deleteChunksForSource) — this function only ever appends.
export async function embedAndStoreChunks(
  supabase: SupabaseClient<Database>,
  input: EmbedAndStoreChunksInput,
): Promise<void> {
  const chunks = chunkText(input.content)
  if (chunks.length === 0) return

  const embeddings = await embedTexts(
    { clientId: input.clientId, actor: input.actor },
    { values: chunks.map((c) => c.content), taskType: 'RETRIEVAL_DOCUMENT' },
  )

  const { error } = await supabase.from('client_knowledge_chunks').insert(
    chunks.map((chunk, i) => ({
      client_id: input.clientId,
      source_id: input.sourceId,
      chunk_index: chunk.index,
      content: chunk.content,
      embedding: embeddings[i]!,
    })),
  )
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to store knowledge chunks', { sourceId: input.sourceId, cause: error.message })
  }
}

export async function deleteChunksForSource(supabase: SupabaseClient<Database>, sourceId: string): Promise<void> {
  const { error } = await supabase.from('client_knowledge_chunks').delete().eq('source_id', sourceId)
  if (error) throw new AppError('DB_ERROR', 'Failed to delete knowledge chunks', { sourceId, cause: error.message })
}

export async function matchClientKnowledgeChunks(
  supabase: SupabaseClient<Database>,
  clientId: string,
  queryEmbedding: number[],
  limit: number,
): Promise<MatchedChunk[]> {
  const { data, error } = await supabase.rpc('match_client_knowledge_chunks', {
    p_client_id: clientId,
    p_query_embedding: queryEmbedding,
    p_limit: limit,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to match knowledge chunks', { clientId, cause: error.message })
  }
  return (data ?? []).map((row) => ({
    sourceId: row.source_id, sourceTitle: row.source_title, content: row.content, similarity: row.similarity,
  }))
}
