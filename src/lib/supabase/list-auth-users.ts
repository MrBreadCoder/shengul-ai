import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export interface AuthUserSummary {
  id: string
  email: string
}

// Supabase Admin API caps a page at 1000; 200 keeps each round-trip fast
// without materially risking missed rows at this product's expected client count.
const PAGE_SIZE = 200

export async function listAllAuthUsers(admin: SupabaseClient<Database>): Promise<AuthUserSummary[]> {
  const summaries: AuthUserSummary[] = []
  let page = 1
  for (;;) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: PAGE_SIZE })
    if (error) {
      throw new AppError('EXTERNAL_ERROR', 'Failed to list auth users', { cause: error.message })
    }
    for (const user of data.users) {
      if (user.email) summaries.push({ id: user.id, email: user.email })
    }
    if (data.users.length < PAGE_SIZE) break
    page += 1
  }
  return summaries
}
