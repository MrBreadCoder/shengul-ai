import type { Metadata } from 'next'
import { redirect } from 'next/navigation'
import Link from 'next/link'
import { ClipboardText } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { requireUser } from '@/lib/auth/require-user'
import { createServerClient } from '@/lib/supabase/server'
import { listReportsForClient } from '@/lib/db/reports'
import { PageHeader } from '@/components/page-header'
import { EmptyState } from '@/components/empty-state'
import { Badge } from '@/components/ui/badge'

export const dynamic = 'force-dynamic'
export const metadata: Metadata = { title: 'Reports' }

const LIST_LIMIT = 50

function formatPeriodDate(iso: string): string {
  // period_start/period_end are always UTC-midnight ISO strings (see
  // lib/reports/period.ts), so slicing the date part needs no timezone math.
  return iso.slice(0, 10)
}

export default async function ReportsPage(): Promise<React.ReactElement> {
  const { appUser } = await requireUser()
  if (appUser.role !== 'client' || appUser.client_id === null) {
    redirect('/crm')
  }

  const supabase = await createServerClient()
  const t = await getTranslations('reports')
  const reports = await listReportsForClient(supabase, { limit: LIST_LIMIT })

  return (
    <div className="flex flex-col gap-6">
      <PageHeader title={t('pageTitle')} description={t('description')} />
      {reports.length === 0 ? (
        <EmptyState icon={ClipboardText} title={t('emptyTitle')} description={t('emptyDescription')} />
      ) : (
        <div className="border-hairline bg-surface divide-hairline animate-rise flex flex-col divide-y rounded-lg border">
          {reports.map((report) => (
            <Link
              key={report.id}
              href={`/reports/${report.id}`}
              className="hover:bg-accent/40 flex items-center justify-between gap-3 px-4 py-3 text-sm transition-colors duration-200"
            >
              <div className="flex items-center gap-3">
                <Badge variant={report.type === 'monthly' ? 'default' : 'secondary'}>
                  {report.type === 'monthly' ? t('typeMonthly') : t('typeWeekly')}
                </Badge>
                <span className="tnum text-muted-foreground">
                  {formatPeriodDate(report.period_start)} – {formatPeriodDate(report.period_end)}
                </span>
              </div>
              <span className="text-faint tnum text-xs">{formatPeriodDate(report.created_at)}</span>
            </Link>
          ))}
        </div>
      )}
    </div>
  )
}
