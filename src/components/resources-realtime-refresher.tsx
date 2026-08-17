'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

const REFRESH_DEBOUNCE_MS = 1500

// Same pattern as components/realtime-refresher.tsx: listens for a resource's
// content_status flipping pending -> ready/failed after upload, or a new
// resource being added, and asks the server to re-render. Unfiltered — RLS
// scopes delivery to the viewer's own client's rows, and /knowledge/resources
// already shows every resource visible to the viewer.
export function ResourcesRealtimeRefresher(): null {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => router.refresh(), REFRESH_DEBOUNCE_MS)
    }

    const channel = supabase
      .channel('client-resources')
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'client_resources' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'client_resources' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(channel)
    }
  }, [router])

  return null
}
