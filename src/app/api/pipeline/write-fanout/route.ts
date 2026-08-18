import { NextResponse } from 'next/server'
import type { SupabaseClient } from '@supabase/supabase-js'
import type { Database } from '@/types/database'
import { verifyQstashSignature } from '@/lib/qstash/verify'
import { createAdminClient } from '@/lib/supabase/admin'
import { listCasesByStatus, AUTO_RETRY_WAIT_REASONS, type CaseRow, type CaseListCursor } from '@/lib/db/cases'
import { publishJson } from '@/lib/qstash/client'
import { logEvent } from '@/lib/events/log-event'
import { isAppError } from '@/lib/errors/app-error'

export const runtime = 'nodejs'

const FANOUT_LIMIT = 200
// Bounds how many pages a single run will fetch while chasing FANOUT_LIMIT
// dispatchable cases — protects against an unbounded scan if the queue is
// dominated by non-dispatchable 'waiting' cases (stuck on manual approval or
// no viable leads) many pages deep.
const MAX_PAGES = 10

// A 'waiting' case with a non-time-based reason (awaiting a human's approval
// click, or no viable leads) doesn't belong in this sweep — only the three
// mailbox-availability reasons resolve by waiting.
function isDispatchable(c: CaseRow): boolean {
  return c.status === 'ready' || (c.wait_reason !== null && AUTO_RETRY_WAIT_REASONS.includes(c.wait_reason))
}

// Applies the dispatchability criteria before FANOUT_LIMIT, not after: a
// page entirely made up of non-retryable 'waiting' cases must not be able to
// consume the whole fetch and starve a genuinely dispatchable case sitting
// further back in the queue. Pages with a keyset cursor (created_at of the
// last row seen) until `limit` dispatchable cases are collected, the table
// is exhausted, or MAX_PAGES is hit.
async function collectDispatchableCases(
  admin: SupabaseClient<Database>,
  limit: number,
): Promise<CaseRow[]> {
  const dispatchable: CaseRow[] = []
  let cursor: CaseListCursor | undefined
  for (let page = 0; page < MAX_PAGES && dispatchable.length < limit; page++) {
    const rows = await listCasesByStatus(admin, ['ready', 'waiting'], FANOUT_LIMIT, cursor)
    if (rows.length === 0) break
    for (const c of rows) {
      if (isDispatchable(c)) dispatchable.push(c)
    }
    const lastRow = rows[rows.length - 1]!
    cursor = { createdAt: lastRow.created_at, id: lastRow.id }
    if (rows.length < FANOUT_LIMIT) break // no more rows exist past this page
  }
  return dispatchable.slice(0, limit)
}

export async function POST(request: Request) {
  try {
    await verifyQstashSignature(request)
    const admin = createAdminClient()
    const dispatchable = await collectDispatchableCases(admin, FANOUT_LIMIT)
    const failedCaseIds: string[] = []
    for (const c of dispatchable) {
      try {
        await publishJson('/api/pipeline/write', { caseId: c.id })
      } catch {
        failedCaseIds.push(c.id)
      }
    }
    try {
      await logEvent({
        clientId: null,
        actor: 'system',
        type: 'pipeline.write_fanout.completed',
        payload: { caseCount: dispatchable.length, failedCaseIds },
      })
    } catch {
      // best-effort audit
    }
    return NextResponse.json({ ok: true, caseCount: dispatchable.length, failedCaseIds })
  } catch (error) {
    if (isAppError(error) && error.code === 'UNAUTHORIZED') {
      return NextResponse.json({ error: 'unauthorized' }, { status: 401 })
    }
    return NextResponse.json({ error: 'internal' }, { status: 500 })
  }
}
