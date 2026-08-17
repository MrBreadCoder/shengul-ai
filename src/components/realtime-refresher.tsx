'use client'

import { useEffect, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'

// The pipeline writes in bursts (a discovery run inserts dozens of leads), so
// coalesce a burst into one server round-trip instead of one per row.
const REFRESH_DEBOUNCE_MS = 1500

interface RealtimeRefresherProps {
  /** Unique per page so concurrent subscriptions are distinguishable in
   *  Supabase's realtime logs. The tables watched are the same everywhere. */
  channel: string
}

// Renders nothing. It listens for "a row that feeds a metric changed" and asks
// the server to recompute — the aggregation itself stays server-side and
// RLS-scoped. Realtime applies the same RLS policies to the subscription, so a
// client-role viewer is only woken by its own client's rows.
export function RealtimeRefresher({ channel }: RealtimeRefresherProps) {
  const router = useRouter()
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    const supabase = createBrowserClient()

    const scheduleRefresh = (): void => {
      if (timerRef.current) clearTimeout(timerRef.current)
      timerRef.current = setTimeout(() => {
        router.refresh()
      }, REFRESH_DEBOUNCE_MS)
    }

    const realtimeChannel = supabase
      .channel(channel)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'emails' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'emails' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'leads' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'cases' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'cases' }, scheduleRefresh)
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'knowledge_requests' }, scheduleRefresh)
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'knowledge_requests' }, scheduleRefresh)
      .subscribe()

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
      void supabase.removeChannel(realtimeChannel)
    }
  }, [router, channel])

  return null
}
