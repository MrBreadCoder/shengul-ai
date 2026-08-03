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

// A chunk whose content overlaps an already-kept chunk by more than this
// fraction of tokens is dropped — targets exact/near-duplicate boilerplate
// (e.g. the same footer surviving in two sources) occupying two of the
// limited top-K slots.
const DUPLICATE_TOKEN_OVERLAP = 0.9

function tokenize(text: string): Set<string> {
  return new Set(text.toLowerCase().trim().split(/\s+/).filter((token) => token.length > 0))
}

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1
  let intersection = 0
  for (const token of a) {
    if (b.has(token)) intersection += 1
  }
  const union = a.size + b.size - intersection
  return union === 0 ? 0 : intersection / union
}

function dedupeNearDuplicates(matches: MatchedChunk[]): MatchedChunk[] {
  const kept: MatchedChunk[] = []
  const keptTokenSets: Set<string>[] = []
  for (const match of matches) {
    const tokens = tokenize(match.content)
    const isDuplicate = keptTokenSets.some(
      (existing) => jaccardSimilarity(existing, tokens) > DUPLICATE_TOKEN_OVERLAP,
    )
    if (!isDuplicate) {
      kept.push(match)
      keptTokenSets.push(tokens)
    }
  }
  return kept
}

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
    const matches = await matchClientKnowledgeChunks(supabase, clientId, queryEmbedding, queryText, limit)
    const relevant = matches.filter((m) => m.similarity >= MIN_SIMILARITY)
    const deduped = dedupeNearDuplicates(relevant)
    if (deduped.length === 0) return ''
    return deduped.map((m) => `- (${labelFor(m, resourceOrdinalById)}) ${m.content}`).join('\n')
  } catch {
    return ''
  }
}
