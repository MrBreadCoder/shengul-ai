import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'

export type SuppressionReason = Database['public']['Enums']['suppression_reason']

export interface SuppressionMatch {
  email: string
  reason: SuppressionReason
}

// Suppression lookups/inserts must be case-insensitive: bounce-driven suppressions and
// lead emails (Apollo's raw casing) are never guaranteed to match byte-for-byte otherwise.
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase()
}

// The reason matters at send time: an outreach send is blocked by any
// suppression, while a reply is blocked only by 'bounced' (see sendViaMailbox).
export async function getSuppression(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
): Promise<SuppressionMatch | null> {
  const { data, error } = await supabase
    .from('suppressions')
    .select('email, reason')
    .eq('client_id', clientId)
    .eq('email', normalizeEmail(email))
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to check suppression', { clientId, cause: error.message })
  }
  return data
}

// Bulk variant of getSuppression, used by discovery (src/lib/pipeline/discover.ts)
// to check every revealed email in one enrich batch with a single round trip
// instead of one query per candidate. Same case-insensitive normalization,
// same client scope. Returns the normalized emails that ARE suppressed —
// callers compare against their own normalized email to decide membership.
export async function getSuppressions(
  supabase: SupabaseClient<Database>,
  clientId: string,
  emails: string[],
): Promise<Set<string>> {
  const normalized = emails.map(normalizeEmail)
  const { data, error } = await supabase
    .from('suppressions')
    .select('email')
    .eq('client_id', clientId)
    .in('email', normalized)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to bulk-check suppressions', {
      clientId, count: emails.length, cause: error.message,
    })
  }
  return new Set((data ?? []).map((r) => r.email))
}

export async function isSuppressed(
  supabase: SupabaseClient<Database>,
  clientId: string,
  email: string,
): Promise<boolean> {
  return (await getSuppression(supabase, clientId, email)) !== null
}

export async function addSuppression(
  supabase: SupabaseClient<Database>,
  input: { clientId: string; email: string; reason: SuppressionReason },
): Promise<void> {
  const { error } = await supabase
    .from('suppressions')
    .upsert(
      { client_id: input.clientId, email: normalizeEmail(input.email), reason: input.reason },
      { onConflict: 'client_id,email', ignoreDuplicates: true },
    )
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to add suppression', {
      clientId: input.clientId, reason: input.reason, cause: error.message,
    })
  }
}
