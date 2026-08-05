'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import { setClientMailreachEnabled } from './mailreach-actions'

interface MailreachToggleProps {
  clientId: string
  enabled: boolean
}

// Client-level kill switch. Turning it off bulk-disconnects every currently
// connected mailbox under this client (best-effort); turning it back on
// silently reconnects the SMTP ones and leaves gmail/outlook ones showing
// "needs reconnect" on /settings, since OAuth needs interactive consent.
export function MailreachToggle({ clientId, enabled }: MailreachToggleProps): React.ReactElement {
  const t = useTranslations('clients')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function toggle(next: boolean): void {
    if (isPending) return
    setError(null)
    startTransition(async () => {
      const result = await setClientMailreachEnabled(clientId, next)
      if (!result.ok) {
        setError(t('mailreachToggle.saveFailed'))
        return
      }
      router.refresh()
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-[11px]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isPending}
          onChange={(event) => toggle(event.target.checked)}
        />
        {t('mailreachToggle.label')}
      </label>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
