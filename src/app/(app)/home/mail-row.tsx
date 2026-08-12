import Link from 'next/link'
import { ArrowBendUpLeft, PaperPlaneTilt } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { StatusPill } from '@/components/status-dot'
import { EMAIL_STATUS } from '@/lib/ui/status'
import { formatAbsolute, formatRelative } from '@/lib/format'
import type { Database } from '@/types/database'
import { cn } from '@/lib/utils'

interface MailRowProps {
  direction: Database['public']['Enums']['email_direction']
  status: Database['public']['Enums']['email_status']
  subject: string | null
  companyName: string | null
  caseId: string | null
  timestamp: string
  now: Date
}

/**
 * A one-line summary of an outbound/inbound message for the home dashboard's
 * "at a glance" mail column — deliberately not EmailMessage (full body,
 * expandable), which is built for reading mail, not scanning it. Mirrors
 * LeadRow's exact row shape (avatar, title+subtitle, status pill, time) so
 * all three list columns on /home share one grid.
 */
export async function MailRow({
  direction,
  status,
  subject,
  companyName,
  caseId,
  timestamp,
  now,
}: MailRowProps): Promise<React.ReactElement> {
  const t = await getTranslations('home')
  const isInbound = direction === 'inbound'
  const Icon = isInbound ? ArrowBendUpLeft : PaperPlaneTilt

  const content = (
    <>
      <span
        className={cn(
          'grid size-8 shrink-0 place-items-center rounded-md',
          isInbound ? 'bg-primary/15 text-primary' : 'bg-accent text-muted-foreground',
        )}
      >
        <Icon size={14} weight="bold" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{subject ?? t('noSubject')}</p>
        <p className="text-faint truncate text-[11px]">{companyName ?? t('noCase')}</p>
      </div>
      <StatusPill meta={EMAIL_STATUS[status]} className="shrink-0" />
      <time
        dateTime={timestamp}
        title={formatAbsolute(timestamp)}
        className="text-faint w-10 shrink-0 text-right text-[11px]"
      >
        {formatRelative(timestamp, now)}
      </time>
    </>
  )

  if (!caseId) {
    return (
      <div className="flex items-center gap-3 px-3 py-2.5" title={t('noCase')}>
        {content}
      </div>
    )
  }

  return (
    <Link
      href={`/cases/${caseId}`}
      className="hover:bg-surface-raised flex items-center gap-3 px-3 py-2.5 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      {content}
    </Link>
  )
}
