import Link from 'next/link'
import { Lightning } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { StatusPill } from '@/components/status-dot'
import { CAMPAIGN_STATUS } from '@/lib/ui/status'
import type { Database } from '@/types/database'

interface CampaignRowProps {
  id: string
  name: string
  status: Database['public']['Enums']['campaign_status']
  dailyTarget: number
}

export async function CampaignRow({
  id,
  name,
  status,
  dailyTarget,
}: CampaignRowProps): Promise<React.ReactElement> {
  const t = await getTranslations('campaigns')
  return (
    <Link
      href={`/analytics?campaign=${id}`}
      className="hover:bg-surface-raised flex items-center gap-3 px-3 py-2.5 transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]"
    >
      {/* Matches CompanyMark/MailRow's size-8 avatar so all three list
          columns share one row grid — the page reads as one system. */}
      <span className="bg-accent text-muted-foreground grid size-8 shrink-0 place-items-center rounded-md">
        <Lightning size={14} weight="light" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{name}</p>
        <p className="text-faint text-[11px]">{t('leadsPerDay', { count: dailyTarget })}</p>
      </div>
      <StatusPill meta={CAMPAIGN_STATUS[status]} className="shrink-0" />
    </Link>
  )
}
