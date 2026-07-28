import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { embedTexts } from '@/lib/llm/client'
import { matchClientKnowledgeChunks, type MatchedChunk } from '@/lib/db/client-knowledge'

const DEFAULT_LIMIT = 6
const ACTOR = 'client_knowledge_retrieval'
// Cosine similarity floor below which a matched chunk is considered noise rather
// than signal — without this, a client with a thin knowledge base still gets up
// to DEFAULT_LIMIT chunks injected regardless of relevance (matchClientKnowledgeChunks
// has no threshold of its own, just an ORDER BY + LIMIT).
const MIN_SIMILARITY = 0.5

export interface RetrieveClientKnowledgeArgs {
  clientId: string
  queryText: string
  limit?: number
  /**
   * Resource id → attach-menu ordinal, supplied only by the reply path that
   * offers a menu. A matched chunk from one of those resources is labelled so
   * the model knows the fact came from a file it can send.
   */
  resourceOrdinalById?: ReadonlyMap<string, number>
}

function labelFor(match: MatchedChunk, resourceOrdinalById?: ReadonlyMap<string, number>): string {
  const ordinal = match.resourceId ? resourceOrdinalById?.get(match.resourceId) : undefined
  // Unlabelled is the safe direction: without an ordinal the line reads as
  // ordinary company knowledge, so the model answers from it without claiming
  // an attachment it has no number to make.
  if (ordinal === undefined) return match.sourceTitle
  return `${match.sourceTitle}, attachable #${ordinal}`
}

// Embeds `queryText` (dossier facts + value prop, joined by the caller) and
// pulls the top-K most relevant client-knowledge chunks, formatted as a block
// ready to append to a prompt. Never throws — a retrieval hiccup (embedding
// API error, RPC error) must not block sending an email, so any failure
// degrades to '' instead of propagating.
export async function retrieveClientKnowledge(
  supabase: SupabaseClient<Database>,
  args: RetrieveClientKnowledgeArgs,
): Promise<string> {
  const { clientId, queryText, limit = DEFAULT_LIMIT, resourceOrdinalById } = args
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
    return relevant.map((m) => `- (${labelFor(m, resourceOrdinalById)}) ${m.content}`).join('\n')
  } catch {
    return ''
  }
}
