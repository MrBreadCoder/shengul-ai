'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

// This page is the one an operator has open while a reply comes in, so it
// gets a shorter debounce than the dashboard-style refreshers — a mail thread
// feels laggy at 1.5s in a way a metrics tile does not.
const REFRESH_DEBOUNCE_MS = 800

interface CaseRealtimeRefresherProps {
  caseId: string
}

// Renders nothing. Scoped to a single case: a new/updated email, a lead
// status change, the case row itself (status/summary), a new research fact,
// or a knowledge request being raised or answered — anything the tabs on this
// page render — triggers a re-render. RLS still applies underneath the
// filter, so this can never surface another client's case.
export function CaseRealtimeRefresher({ caseId }: CaseRealtimeRefresherProps): null {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const caseIdFilter = { filter: `case_id=eq.${caseId}` }
    const channel = supabase
      .channel(`case-${caseId}`)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'emails', ...caseIdFilter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'emails', ...caseIdFilter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads', ...caseIdFilter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'leads', ...caseIdFilter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cases', filter: `id=eq.${caseId}` }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'case_knowledge', ...caseIdFilter }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'knowledge_requests', ...caseIdFilter }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'knowledge_requests', ...caseIdFilter }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(channel)
    }
  }, [router, caseId])

  return null
}
