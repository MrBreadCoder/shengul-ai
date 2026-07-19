import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

const DEMO_CLIENT_NAME = 'Demo Client'

// P0 has no campaign/client UI. The operator demo attaches mailboxes to a single
// stable "Demo Client". Idempotent: returns the existing row's id or creates it.
export async function getOrCreateOperatorClient(
  supabase: SupabaseClient<Database>,
): Promise<string> {
  const { data: existing, error: selErr } = await supabase
    .from('clients').select('id').eq('name', DEMO_CLIENT_NAME).maybeSingle()
  if (selErr) throw new AppError('DB_ERROR', 'Failed to look up demo client', { cause: selErr.message })
  if (existing) return existing.id

  const { data: created, error: insErr } = await supabase
    .from('clients').insert({ name: DEMO_CLIENT_NAME }).select('id').single()
  if (insErr || !created) throw new AppError('DB_ERROR', 'Failed to create demo client', { cause: insErr?.message })
  return created.id
}
