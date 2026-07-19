import { createAdminClient } from '@/lib/supabase/admin'
import { insertEvent } from '@/lib/db/events'
import type { Json } from '@/types/database'

export interface LogEventInput {
  clientId: string | null
  caseId?: string | null
  actor: string
  type: string
  payload?: Record<string, Json>
}

// The single audit entry point. Uses the service-role client so audit writes
// are never blocked by RLS. Call after the core action succeeds.
export async function logEvent(input: LogEventInput): Promise<void> {
  const supabase = createAdminClient()
  await insertEvent(supabase, {
    client_id: input.clientId,
    case_id: input.caseId ?? null,
    actor: input.actor,
    type: input.type,
    payload: input.payload ?? {},
  })
}
