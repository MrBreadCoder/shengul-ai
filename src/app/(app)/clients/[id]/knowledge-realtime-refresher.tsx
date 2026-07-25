'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

const REFRESH_DEBOUNCE_MS = 1500

interface KnowledgeRealtimeRefresherProps {
  clientId: string
}

// Same pattern as analytics/realtime-refresher.tsx: listens for a source row
// flipping pending -> ready/failed and asks the server to re-render, so the
// operator sees scrape progress without a manual refresh. Filtered to this
// client's rows only — a QStash fan-out can touch many clients' sources
// concurrently.
export function KnowledgeRealtimeRefresher({ clientId }: KnowledgeRealtimeRefresherProps): null {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel(`knowledge-sources-${clientId}`)
      .on(
        'postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'client_knowledge_sources', filter: `client_id=eq.${clientId}` },
        scheduleRefresh,
      )
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'client_knowledge_sources', filter: `client_id=eq.${clientId}` },
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
