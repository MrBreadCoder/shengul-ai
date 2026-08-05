'use client'

import { useRouter } from 'next/navigation'
import { useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { RANGE_OPTIONS, type RangeDays } from '@/lib/analytics/range'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'

export interface CampaignOption {
  id: string
  name: string
  clientId: string
}

export interface ClientOption {
  id: string
  name: string
}

interface AnalyticsFiltersProps {
  days: RangeDays
  campaignId: string | null
  clientId: string | null
  campaigns: CampaignOption[]
  clients: ClientOption[]
  /** Where filter changes navigate to. Defaults to /analytics. */
  basePath?: string
  /** Extra query params always re-appended (e.g. `{ tab: 'analytics' }` from the client detail page). */
  fixedParams?: Record<string, string>
}

/** Sentinel for "no filter" — Radix Select forbids an empty item value. */
const ALL_CAMPAIGNS = '__all'
const ALL_CLIENTS = '__all'

export function AnalyticsFilters({
  days,
  campaignId,
  clientId,
  campaigns,
  clients,
  basePath = '/analytics',
  fixedParams = {},
}: AnalyticsFiltersProps): React.ReactElement {
  const t = useTranslations('analytics')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()

  // The current filter state arrives as props from the server, so this
  // component never reads useSearchParams — it just rebuilds the URL from
  // what it was given, scoped to this render's basePath/fixedParams.
  const buildHref = (nextDays: RangeDays, nextCampaignId: string | null, nextClientId: string | null): string => {
    const params = new URLSearchParams(fixedParams)
    params.set('days', String(nextDays))
    if (nextCampaignId) params.set('campaign', nextCampaignId)
    if (nextClientId) params.set('client', nextClientId)
    return `${basePath}?${params.toString()}`
  }

  const visibleCampaigns = clientId ? campaigns.filter((campaign) => campaign.clientId === clientId) : campaigns

  const onRangeClick = (nextDays: RangeDays): void => {
    startTransition(() => {
      router.push(buildHref(nextDays, campaignId, clientId))
    })
  }

  const onCampaignChange = (value: string): void => {
    const nextCampaign = value === ALL_CAMPAIGNS ? null : value
    startTransition(() => {
      router.push(buildHref(days, nextCampaign, clientId))
    })
  }

  const onClientChange = (value: string): void => {
    const nextClient = value === ALL_CLIENTS ? null : value
    // Switching clients drops the campaign filter — a campaign from a
    // different client would otherwise combine into an always-empty result.
    startTransition(() => {
      router.push(buildHref(days, null, nextClient))
    })
  }

  return (
    <div className="border-hairline flex flex-wrap items-center gap-x-5 gap-y-3 rounded-lg border p-3">
      <div role="group" aria-label={t('filters.rangeAriaLabel')} className="flex items-center gap-1.5">
        <span className="text-faint mr-0.5 text-[11px]">{t('filters.rangeLabel')}</span>
        {RANGE_OPTIONS.map((option) => (
          <button
            key={option}
            type="button"
            onClick={() => onRangeClick(option)}
            disabled={isPending}
            aria-pressed={option === days}
            className={cn(
              'tnum rounded-full px-2.5 py-1 text-[11px] font-medium',
              'transition-colors duration-200 ease-[cubic-bezier(0.22,1,0.36,1)]',
              'disabled:cursor-wait',
              option === days
                ? 'bg-primary/15 text-primary'
                : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            )}
          >
            {t('filters.rangeDays', { count: option })}
          </button>
        ))}
      </div>

      {clients.length > 0 ? (
        <div className="flex items-center gap-2">
          <span className="text-faint text-[11px]">{t('filters.clientLabel')}</span>
          <Select value={clientId ?? ALL_CLIENTS} onValueChange={onClientChange} disabled={isPending}>
            <SelectTrigger size="sm" className="w-[200px]" aria-label={t('filters.clientLabel')}>
              <SelectValue placeholder={t('filters.allClients')} />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={ALL_CLIENTS}>{t('filters.allClients')}</SelectItem>
              {clients.map((client) => (
                <SelectItem key={client.id} value={client.id}>
                  {client.name}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      ) : null}

      <div className="flex items-center gap-2">
        <span className="text-faint text-[11px]">{t('filters.campaignLabel')}</span>
        <Select
          value={campaignId ?? ALL_CAMPAIGNS}
          onValueChange={onCampaignChange}
          disabled={isPending || visibleCampaigns.length === 0}
        >
          <SelectTrigger size="sm" className="w-[200px]" aria-label={t('filters.campaignLabel')}>
            <SelectValue placeholder={t('filters.allCampaigns')} />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value={ALL_CAMPAIGNS}>{t('filters.allCampaigns')}</SelectItem>
            {visibleCampaigns.map((campaign) => (
              <SelectItem key={campaign.id} value={campaign.id}>
                {campaign.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {isPending ? (
        <span role="status" className="text-faint text-[11px]">
          {t('filters.updating')}
        </span>
      ) : null}
    </div>
  )
}
