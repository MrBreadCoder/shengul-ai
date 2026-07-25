import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type CaseWithLeads = Database['public']['Tables']['cases']['Row'] & {
  leads: Database['public']['Tables']['leads']['Row'][]
}

// RLS-scoped read: the caller must pass a session-bound client
// (createServerClient), never the admin client, so a client role only ever
// sees their own client_id's rows (.claude/architecture.md §11).
export async function listCasesWithLeads(
  supabase: SupabaseClient<Database>,
): Promise<CaseWithLeads[]> {
  const { data, error } = await supabase
    .from('cases')
    .select('*, leads(*)')
    .order('created_at', { ascending: false })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list cases with leads', { cause: error.message })
  }
  return (data ?? []) as CaseWithLeads[]
}

export interface CaseCompanyName {
  id: string
  companyName: string
}

// Narrow lookup for building an id → company_name map (e.g. /inbox draft rows)
// without pulling every case's full lead list. RLS-scoped like the query above.
export async function listCaseCompanyNames(
  supabase: SupabaseClient<Database>,
): Promise<CaseCompanyName[]> {
  const { data, error } = await supabase.from('cases').select('id, company_name')
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list case company names', { cause: error.message })
  }
  return (data ?? []).map((c) => ({ id: c.id, companyName: c.company_name }))
}
