import Link from 'next/link'
import { getTranslations } from 'next-intl/server'
import { CompanyMark } from '@/components/company-mark'
import { StatusPill } from '@/components/status-dot'
import { leadEmailStatusMetaFor } from '@/lib/ui/status'
import { formatAbsolute, formatRelative } from '@/lib/format'
import type { Database } from '@/types/database'

interface LeadRowProps {
  fullName: string
  title: string | null
  companyName: string | null
  companyDomain: string | null
  emailStatus: Database['public']['Enums']['lead_email_status']
  caseId: string | null
  createdAt: string
  now: Date
}

export async function LeadRow({
  fullName,
  title,
  companyName,
  companyDomain,
  emailStatus,
  caseId,
  createdAt,
  now,
}: LeadRowProps): Promise<React.ReactElement> {
  const t = await getTranslations('home')
  const subtitle = title && companyName ? `${title} · ${companyName}` : (title ?? companyName ?? '')

  const content = (
    <>
      <CompanyMark name={companyName ?? fullName} domain={companyDomain} />
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{fullName}</p>
        {subtitle ? <p className="text-faint truncate text-[11px]">{subtitle}</p> : null}
      </div>
      {/* Client-facing view: 'risky' collapses into 'verified' (leadEmailStatusMetaFor), matching cases/[id]/page.tsx. */}
      <StatusPill meta={leadEmailStatusMetaFor(emailStatus, 'client')} className="shrink-0" />
      <time
        dateTime={createdAt}
        title={formatAbsolute(createdAt)}
        className="text-faint w-10 shrink-0 text-right text-[11px]"
      >
        {formatRelative(createdAt, now)}
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
