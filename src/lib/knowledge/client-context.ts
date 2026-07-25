import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { embedTexts } from '@/lib/llm/client'
import { matchClientKnowledgeChunks } from '@/lib/db/client-knowledge'

const DEFAULT_LIMIT = 6
const ACTOR = 'client_knowledge_retrieval'
// Cosine similarity floor below which a matched chunk is considered noise rather
// than signal — without this, a client with a thin knowledge base still gets up
// to DEFAULT_LIMIT chunks injected regardless of relevance (matchClientKnowledgeChunks
// has no threshold of its own, just an ORDER BY + LIMIT).
const MIN_SIMILARITY = 0.5

// Embeds `queryText` (dossier facts + value prop, joined by the caller) and
// pulls the top-K most relevant client-knowledge chunks, formatted as a block
// ready to append to a prompt. Never throws — a retrieval hiccup (embedding
// API error, RPC error) must not block sending an email, so any failure
// degrades to '' instead of propagating.
export async function retrieveClientKnowledge(
  supabase: SupabaseClient<Database>,
  clientId: string,
  queryText: string,
  limit: number = DEFAULT_LIMIT,
): Promise<string> {
  if (queryText.trim().length === 0) return ''
  try {
    const [queryEmbedding] = await embedTexts(
      { clientId, actor: ACTOR },
      { values: [queryText], taskType: 'RETRIEVAL_QUERY' },
    )
    if (!queryEmbedding) return ''
    const matches = await matchClientKnowledgeChunks(supabase, clientId, queryEmbedding, limit)
    const relevant = matches.filter((m) => m.similarity >= MIN_SIMILARITY)
    if (relevant.length === 0) return ''
    return relevant.map((m) => `- (${m.sourceTitle}) ${m.content}`).join('\n')
  } catch {
    return ''
  }
}
