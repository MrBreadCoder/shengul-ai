import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type KnowledgeRow = Database['public']['Tables']['case_knowledge']['Row']
export type KnowledgeInsert = Database['public']['Tables']['case_knowledge']['Insert']

export async function insertKnowledge(
  supabase: SupabaseClient<Database>,
  rows: KnowledgeInsert[],
): Promise<KnowledgeRow[]> {
  if (rows.length === 0) return []
  const { data, error } = await supabase.from('case_knowledge').insert(rows).select('*')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert case knowledge', {
      count: rows.length, cause: error.message,
    })
  }
  return data ?? []
}

export interface InsertCompanyKnowledgeInput {
  clientId: string
  caseId: string
  content: string
  sourceUrl: string | null
}

// Check-before-insert: a case gets at most one kind:'company' row. Two
// groupVerifiedLead calls for the same brand-new case within one discovery
// run can't race here — discover.ts calls it sequentially — but concurrent
// discovery runs across campaigns could theoretically both pass this check;
// accepted per the design doc (no DB-level constraint for this row).
export async function insertCompanyKnowledgeIfMissing(
  supabase: SupabaseClient<Database>,
  input: InsertCompanyKnowledgeInput,
): Promise<KnowledgeRow | null> {
  const { data: existing, error: selectError } = await supabase
    .from('case_knowledge')
    .select('id')
    .eq('case_id', input.caseId)
    .eq('kind', 'company')
    .limit(1)
  if (selectError) {
    throw new AppError('DB_ERROR', 'Failed to check for existing company knowledge', {
      caseId: input.caseId, cause: selectError.message,
    })
  }
  if (existing && existing.length > 0) return null

  const { data: inserted, error: insertError } = await supabase
    .from('case_knowledge')
    .insert({
      client_id: input.clientId,
      case_id: input.caseId,
      kind: 'company',
      content: input.content,
      source_url: input.sourceUrl,
      citation: 'Apollo',
      created_by: 'agent',
    })
    .select('*')
  if (insertError) {
    throw new AppError('DB_ERROR', 'Failed to insert company knowledge', {
      caseId: input.caseId, cause: insertError.message,
    })
  }
  return inserted && inserted.length > 0 ? inserted[0]! : null
}

export async function listKnowledgeForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
): Promise<KnowledgeRow[]> {
  const { data, error } = await supabase
    .from('case_knowledge')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list case knowledge', { caseId, cause: error.message })
  }
  return data ?? []
}

export interface KnowledgeFilter {
  kind?: Database['public']['Enums']['knowledge_kind']
  createdBy?: Database['public']['Enums']['author_kind']
  limit: number
}

// Client-wide knowledge browser, newest first. RLS scopes the rows.
export async function listKnowledgeForClient(
  supabase: SupabaseClient<Database>,
  filter: KnowledgeFilter,
): Promise<KnowledgeRow[]> {
  let query = supabase.from('case_knowledge').select('*')
  if (filter.kind) query = query.eq('kind', filter.kind)
  if (filter.createdBy) query = query.eq('created_by', filter.createdBy)

  const { data, error } = await query
    .order('created_at', { ascending: false })
    .limit(filter.limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list knowledge for client', { cause: error.message })
  }
  return data ?? []
}
