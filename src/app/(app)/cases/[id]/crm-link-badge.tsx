import { ArrowSquareOut, WarningCircle } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'

interface CrmLinkBadgeProps {
  provider: string
  dealUrl: string | null
  syncError: string | null
}

function formatProvider(provider: string): string {
  return provider === 'hubspot' ? 'HubSpot' : 'Pipedrive'
}

export async function CrmLinkBadge({ provider, dealUrl, syncError }: CrmLinkBadgeProps): Promise<React.ReactElement | null> {
  const t = await getTranslations('cases')

  if (syncError) {
    return (
      <span className="text-faint inline-flex items-center gap-1.5 text-[12px]">
        <WarningCircle size={13} weight="light" />
        {t('crmLinkBadge.syncFailed', { provider: formatProvider(provider), error: syncError })}
      </span>
    )
  }
  // A deal exists but the provider gave us no portal id to link to. Say so
  // rather than rendering a dead anchor.
  if (!dealUrl) return null

  return (
    <a
      href={dealUrl}
      target="_blank"
      rel="noreferrer"
      className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-[12px] transition-colors"
    >
      {t('crmLinkBadge.synced', { provider: formatProvider(provider) })}
      <ArrowSquareOut size={13} weight="light" />
    </a>
  )
}
