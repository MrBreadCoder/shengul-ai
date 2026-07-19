import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type EventInsert = Database['public']['Tables']['events']['Insert']

export async function insertEvent(
  supabase: SupabaseClient<Database>,
  row: EventInsert,
): Promise<void> {
  const { error } = await supabase.from('events').insert(row)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert event', { type: row.type, cause: error.message })
  }
}
