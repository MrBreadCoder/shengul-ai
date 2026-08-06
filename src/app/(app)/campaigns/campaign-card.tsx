import { StatusPill } from '@/components/status-dot'
import { CAMPAIGN_STATUS } from '@/lib/ui/status'
import type { CampaignRow } from '@/lib/db/campaigns'

interface CampaignCardProps {
  campaign: CampaignRow
  leadsPerDayLabel: string
  mailboxCountLabel: string
  createdRelativeLabel: string
  animationDelayMs: number
  /** Row actions (Edit/Stop/Resume/Delete). Omitted entirely for the
   *  client-facing read-only view — no `actions` means no bordered action
   *  strip renders at all, not an empty one. */
  actions?: React.ReactNode
}

export function CampaignCard({
  campaign,
  leadsPerDayLabel,
  mailboxCountLabel,
  createdRelativeLabel,
  animationDelayMs,
  actions,
}: CampaignCardProps): React.ReactElement {
  return (
    <li
      className="border-hairline bg-surface card-interactive animate-rise rounded-lg border p-4"
      style={{ animationDelay: `${animationDelayMs}ms` }}
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 truncate text-[13px] font-medium">{campaign.name}</p>
        <StatusPill meta={CAMPAIGN_STATUS[campaign.status]} />
      </div>

      <p className="text-muted-foreground mt-2.5 max-w-[70ch] text-sm leading-relaxed">
        {campaign.value_prop}
      </p>

      <div className="text-faint mt-3 flex flex-wrap items-center gap-x-4 gap-y-1 text-[11px]">
        <span className="tnum">{leadsPerDayLabel}</span>
        <span className="tnum">{mailboxCountLabel}</span>
        <span className="ml-auto">{createdRelativeLabel}</span>
      </div>

      {actions ? (
        <div className="border-hairline mt-3 flex items-center gap-2 border-t pt-3">{actions}</div>
      ) : null}
    </li>
  )
}
