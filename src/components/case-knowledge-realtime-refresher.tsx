'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

const REFRESH_DEBOUNCE_MS = 1500

// Same pattern as components/realtime-refresher.tsx: listens for the research
// agent (or an operator) adding a fact and asks the server to re-render.
// Unfiltered — RLS scopes delivery to the viewer's own client's rows, and
// /knowledge already shows every case for that client, so no extra filter is
// needed. Facts are append-only (no edit/delete surface), so INSERT is enough.
export function CaseKnowledgeRealtimeRefresher(): null {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel('case-knowledge')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'case_knowledge' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(channel)
    }
  }, [router])

  return null
}
