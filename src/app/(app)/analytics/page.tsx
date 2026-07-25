import type { Metadata } from 'next'
import { PageHeader } from '@/components/page-header'
import { AnalyticsView } from './analytics-view'
import { RealtimeRefresher } from './realtime-refresher'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Analytics' }

interface AnalyticsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps): Promise<React.ReactElement> {
  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresher />
      <PageHeader
        title="Analytics"
        description="Numbers recompute live as the pipeline runs."
        actions={
          <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden className="bg-primary size-1.5 animate-pulse rounded-full" style={{ animationDuration: '2.4s' }} />
            Live
          </span>
        }
      />
      <AnalyticsView searchParams={searchParams} scope={{ kind: 'global' }} />
    </div>
  )
}
