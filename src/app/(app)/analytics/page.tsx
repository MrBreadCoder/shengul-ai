import type { Metadata } from 'next'
import { getTranslations } from 'next-intl/server'
import { PageHeader } from '@/components/page-header'
import { RealtimeRefresher } from '@/components/realtime-refresher'
import { AnalyticsView } from './analytics-view'

export const dynamic = 'force-dynamic'

export const metadata: Metadata = { title: 'Analytics' }

interface AnalyticsPageProps {
  searchParams: Promise<Record<string, string | string[] | undefined>>
}

export default async function AnalyticsPage({ searchParams }: AnalyticsPageProps): Promise<React.ReactElement> {
  const t = await getTranslations('analytics')
  return (
    <div className="flex flex-col gap-8">
      <RealtimeRefresher channel="analytics-metrics" />
      <PageHeader
        title={t('title')}
        description={t('description')}
        actions={
          <span className="text-primary inline-flex items-center gap-1.5 text-xs font-medium">
            <span aria-hidden className="bg-primary size-1.5 animate-pulse rounded-full" style={{ animationDuration: '2.4s' }} />
            {t('live')}
          </span>
        }
      />
      <AnalyticsView searchParams={searchParams} scope={{ kind: 'global' }} />
    </div>
  )
}
