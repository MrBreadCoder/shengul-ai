'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { disconnectCrm } from './crm-actions'

interface ConnectionCardProps {
  provider: string
  accountLabel: string | null
  pipelineLabel: string | null
  lastSyncedAt: string | null
  canManage: boolean
}

function formatProvider(provider: string): string {
  return provider === 'hubspot' ? 'HubSpot' : 'Pipedrive'
}

export function ConnectionCard({
  provider, accountLabel, pipelineLabel, lastSyncedAt, canManage,
}: ConnectionCardProps): React.ReactElement {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const [isConfirming, setIsConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()

  return (
    <div className="border-hairline bg-surface flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-col gap-1">
        <span className="text-[13px] font-medium">{formatProvider(provider)}</span>
        <span className="text-faint text-[11px]">{accountLabel ?? t('connectionCard.connectedAccount')}</span>
      </div>
      <dl className="grid grid-cols-2 gap-2 text-[12px]">
        <div>
          <dt className="text-faint">{t('connectionCard.pipeline')}</dt>
          <dd>{pipelineLabel ?? t('connectionCard.notSelected')}</dd>
        </div>
        <div>
          <dt className="text-faint">{t('connectionCard.lastSync')}</dt>
          <dd>{lastSyncedAt ? new Date(lastSyncedAt).toLocaleString('en-US') : t('connectionCard.notYet')}</dd>
        </div>
      </dl>

      {canManage ? (
        isConfirming ? (
          <div className="flex flex-col gap-2">
            <p className="text-muted-foreground text-[12px]">
              {t('connectionCard.disconnectWarning', { provider: formatProvider(provider) })}
            </p>
            <div className="flex gap-2">
              <button
                type="button"
                disabled={isPending}
                onClick={() => startTransition(async () => { await disconnectCrm() })}
                className="rounded-md border border-red-600/40 px-3 py-1.5 text-[12px] font-medium text-red-600 disabled:opacity-50"
              >
                {isPending ? t('connectionCard.disconnecting') : t('connectionCard.confirmDisconnect')}
              </button>
              <button
                type="button"
                onClick={() => setIsConfirming(false)}
                className="border-hairline rounded-md border px-3 py-1.5 text-[12px]"
              >
                {tCommon('cancel')}
              </button>
            </div>
          </div>
        ) : (
          <button
            type="button"
            onClick={() => setIsConfirming(true)}
            className="border-hairline hover:border-hairline-strong self-start rounded-md border px-3 py-1.5 text-[12px]"
          >
            {t('connectionCard.disconnect')}
          </button>
        )
      ) : null}
    </div>
  )
}
