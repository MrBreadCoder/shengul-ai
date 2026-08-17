'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

const REFRESH_DEBOUNCE_MS = 1500

interface KnowledgeSourcesRealtimeRefresherProps {
  /** Scope to one client's sources (clients/[id]). Omit to watch every source
   *  visible to the viewer (knowledge/sources) — RLS still applies server-side,
   *  so an unfiltered subscription only ever delivers rows the viewer can read. */
  clientId?: string
}

// Same pattern as components/realtime-refresher.tsx: listens for a source row
// flipping pending -> ready/failed and asks the server to re-render, so the
// operator sees scrape progress without a manual refresh.
export function KnowledgeSourcesRealtimeRefresher({
  clientId,
}: KnowledgeSourcesRealtimeRefresherProps): null {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const filter = clientId ? { filter: `client_id=eq.${clientId}` } : {}
    const channel = supabase
      .channel(`knowledge-sources-${clientId ?? 'all'}`)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'client_knowledge_sources', ...filter },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'client_knowledge_sources', ...filter },
        scheduleRefresh,
      )
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(channel)
    }
  }, [router, clientId])

  return null
}
