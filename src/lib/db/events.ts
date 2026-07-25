import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import type { ClientErrorCount, LogSeverity, LogSource } from '@/types/logs'
import { AppError } from '@/lib/errors/app-error'

export type EventInsert = Database['public']['Tables']['events']['Insert']
export type EventRow = Database['public']['Tables']['events']['Row']

const DAY_MS = 24 * 60 * 60 * 1000

export async function insertEvent(
  supabase: SupabaseClient<Database>,
  row: EventInsert,
): Promise<void> {
  const { error } = await supabase.from('events').insert(row)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert event', { type: row.type, cause: error.message })
  }
}

// Agent audit trail for one case, newest first. Bounded because a long-running
// case can accumulate hundreds of pipeline events.
export async function listEventsForCase(
  supabase: SupabaseClient<Database>,
  caseId: string,
  limit: number,
): Promise<EventRow[]> {
  const { data, error } = await supabase
    .from('events')
    .select('*')
    .eq('case_id', caseId)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list events for case', { caseId, cause: error.message })
  }
  return data ?? []
}

export interface ListEventsForClientInput {
  clientId: string
  /** Severities to include. Never empty — an empty list would return nothing. */
  severities: LogSeverity[]
  source: LogSource | null
  limit: number
  /** Keyset cursor: return only rows strictly older than this ISO timestamp. */
  before: string | null
}

/**
 * One page of a client's log feed, newest first. Paginated by `created_at`
 * cursor rather than offset: the pipeline inserts at the head of this list
 * continuously, and offset paging would silently skip or repeat rows.
 */
export async function listEventsForClient(
  supabase: SupabaseClient<Database>,
  { clientId, severities, source, limit, before }: ListEventsForClientInput,
): Promise<EventRow[]> {
  let query = supabase
    .from('events')
    .select('*')
    .eq('client_id', clientId)
    .in('severity', severities)
    .order('created_at', { ascending: false })
    .limit(limit)
  if (source) query = query.eq('source', source)
  if (before) query = query.lt('created_at', before)

  const { data, error } = await query
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list events for client', { clientId, cause: error.message })
  }
  return data ?? []
}

/**
 * Warn/error tallies per client since `since`, as one grouped query. The
 * clients list renders every client at once, so a per-client count would be an
 * N+1 on that page.
 */
export async function countRecentErrorsByClient(
  supabase: SupabaseClient<Database>,
  since: string,
): Promise<Map<string, ClientErrorCount>> {
  const { data, error } = await supabase.rpc('events_error_counts', { p_since: since })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count client errors', { since, cause: error.message })
  }
  const counts = new Map<string, ClientErrorCount>()
  for (const row of data ?? []) {
    counts.set(row.client_id, {
      clientId: row.client_id,
      errorCount: row.error_count,
      warnCount: row.warn_count,
    })
  }
  return counts
}

export interface EventRetention {
  /** Days to keep `info` rows — high volume, low long-term value. */
  infoDays: number
  /** Days to keep `warn` and `error` rows — the ones worth investigating later. */
  problemDays: number
}

export interface PurgeSummary {
  infoDeleted: number
  problemDeleted: number
}

function cutoffFor(now: Date, days: number): string {
  return new Date(now.getTime() - days * DAY_MS).toISOString()
}

/**
 * Deletes log rows past their retention window. `now` is an explicit parameter
 * so the caller stays testable and the two cutoffs are computed from a single
 * instant rather than drifting between the two statements.
 */
export async function deleteExpiredEvents(
  supabase: SupabaseClient<Database>,
  now: Date,
  retention: EventRetention,
): Promise<PurgeSummary> {
  const { count: infoDeleted, error: infoError } = await supabase
    .from('events')
    .delete({ count: 'exact' })
    .eq('severity', 'info')
    .lt('created_at', cutoffFor(now, retention.infoDays))
  if (infoError) {
    throw new AppError('DB_ERROR', 'Failed to purge info events', { cause: infoError.message })
  }

  const { count: problemDeleted, error: problemError } = await supabase
    .from('events')
    .delete({ count: 'exact' })
    .in('severity', ['warn', 'error'])
    .lt('created_at', cutoffFor(now, retention.problemDays))
  if (problemError) {
    throw new AppError('DB_ERROR', 'Failed to purge warn/error events', { cause: problemError.message })
  }

  return { infoDeleted: infoDeleted ?? 0, problemDeleted: problemDeleted ?? 0 }
}
