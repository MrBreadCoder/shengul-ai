import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { AppError } from '@/lib/errors/app-error'
import type { ReportMetricsSnapshot } from '@/types/reports'

export type ReportRow = Database['public']['Tables']['reports']['Row']
export type ReportDeliveryRow = Database['public']['Tables']['report_deliveries']['Row']

export interface UpsertReportInput {
  clientId: string
  type: 'weekly' | 'monthly'
  periodStart: string
  periodEnd: string
  metrics?: ReportMetricsSnapshot
  aiHeadline?: string
  aiSummary?: string
  aiHighlights?: string[]
  status: 'generating' | 'ready' | 'send_failed' | 'sent'
}

// Upserts on (client_id, type, period_start) — the unique constraint from
// 0039_reports.sql. Called multiple times across one generateReport() run
// (generating -> ready -> sent/send_failed); only the fields present in
// `input` are included in the payload, so a later call that omits
// `metrics`/`ai*` leaves those columns untouched rather than blanking them —
// PostgREST's upsert only updates the columns present in the request body.
export async function upsertReport(
  supabase: SupabaseClient<Database>,
  input: UpsertReportInput,
): Promise<ReportRow> {
  const { data, error } = await supabase
    .from('reports')
    .upsert(
      {
        client_id: input.clientId,
        type: input.type,
        period_start: input.periodStart,
        period_end: input.periodEnd,
        ...(input.metrics !== undefined ? { metrics: input.metrics } : {}),
        ...(input.aiHeadline !== undefined ? { ai_headline: input.aiHeadline } : {}),
        ...(input.aiSummary !== undefined ? { ai_summary: input.aiSummary } : {}),
        ...(input.aiHighlights !== undefined ? { ai_highlights: input.aiHighlights } : {}),
        status: input.status,
      },
      { onConflict: 'client_id,type,period_start' },
    )
    .select('*')
    .single()
  if (error || !data) {
    throw new AppError('DB_ERROR', 'Failed to upsert report', {
      clientId: input.clientId,
      type: input.type,
      cause: error?.message,
    })
  }
  return data
}

export async function getReportById(
  supabase: SupabaseClient<Database>,
  id: string,
): Promise<ReportRow | null> {
  const { data, error } = await supabase.from('reports').select('*').eq('id', id).maybeSingle()
  if (error) throw new AppError('DB_ERROR', 'Failed to load report', { id, cause: error.message })
  return data
}

export interface ListReportsForClientInput {
  limit: number
}

// RLS-scoped — only ever called with the caller's own session client, so no
// explicit client_id filter is needed (matches every other listXForClient
// in this codebase). Only 'ready'/'sent' rows are shown — a 'generating' row
// is mid-pipeline (a few seconds) and a 'send_failed' report's underlying
// data is still there but not surfaced as a normal list entry; see spec §7.
export async function listReportsForClient(
  supabase: SupabaseClient<Database>,
  { limit }: ListReportsForClientInput,
): Promise<ReportRow[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .in('status', ['ready', 'sent'])
    .order('period_start', { ascending: false })
    .limit(limit)
  if (error) throw new AppError('DB_ERROR', 'Failed to list reports for client', { cause: error.message })
  return data ?? []
}

export interface ListWeeklyReportsInRangeInput {
  clientId: string
  from: string
  to: string
}

// Admin-client call (cron context, no session) — used only to build a
// monthly report's weekly-recap section (spec §3). Does not filter by
// status: a monthly report recaps whatever weekly reports exist for that
// window, generating or not.
export async function listWeeklyReportsInRange(
  supabase: SupabaseClient<Database>,
  { clientId, from, to }: ListWeeklyReportsInRangeInput,
): Promise<ReportRow[]> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('client_id', clientId)
    .eq('type', 'weekly')
    .gte('period_start', from)
    .lte('period_end', to)
    .order('period_start', { ascending: true })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to list weekly reports in range', { clientId, from, to, cause: error.message })
  }
  return data ?? []
}

export interface GetPreviousReportInput {
  clientId: string
  type: 'weekly' | 'monthly'
  beforePeriodStart: string
}

// The client's most recent report of the same type strictly before
// beforePeriodStart — feeds the AI commentary's period-over-period
// comparison (spec §4). Reads the already-stored snapshot rather than
// recomputing, consistent with the snapshot philosophy (spec §2).
export async function getPreviousReport(
  supabase: SupabaseClient<Database>,
  { clientId, type, beforePeriodStart }: GetPreviousReportInput,
): Promise<ReportRow | null> {
  const { data, error } = await supabase
    .from('reports')
    .select('*')
    .eq('client_id', clientId)
    .eq('type', type)
    .lt('period_start', beforePeriodStart)
    .order('period_start', { ascending: false })
    .limit(1)
    .maybeSingle()
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to load previous report', { clientId, type, cause: error.message })
  }
  return data
}

// Drives the rotating email template pick (priorCount % 7 — spec §6).
export async function countPriorReportsForClient(
  supabase: SupabaseClient<Database>,
  clientId: string,
): Promise<number> {
  const { count, error } = await supabase
    .from('reports')
    .select('*', { count: 'exact', head: true })
    .eq('client_id', clientId)
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to count reports for client', { clientId, cause: error.message })
  }
  return count ?? 0
}

export interface InsertReportDeliveryInput {
  clientId: string
  reportId: string
  appUserId: string | null
  email: string
  status: 'sent' | 'failed'
  error: string | null
  sentAt: string | null
}

export async function insertReportDelivery(
  supabase: SupabaseClient<Database>,
  input: InsertReportDeliveryInput,
): Promise<void> {
  const { error } = await supabase.from('report_deliveries').insert({
    client_id: input.clientId,
    report_id: input.reportId,
    app_user_id: input.appUserId,
    email: input.email,
    status: input.status,
    error: input.error,
    sent_at: input.sentAt,
  })
  if (error) {
    throw new AppError('DB_ERROR', 'Failed to insert report delivery', { reportId: input.reportId, cause: error.message })
  }
}
