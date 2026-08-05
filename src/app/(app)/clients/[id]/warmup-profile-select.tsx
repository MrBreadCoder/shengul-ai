'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { WarmupProfile } from '@/lib/mailbox/warmup'

const PROFILES: readonly WarmupProfile[] = ['standard', 'slow', 'none']

interface WarmupProfileSelectProps {
  clientId: string
  value: WarmupProfile
}

// Applies to mailboxes connected *after* this change. Existing mailboxes keep
// the profile they were connected with — change those on /settings.
export function WarmupProfileSelect({ clientId, value }: WarmupProfileSelectProps): React.ReactElement {
  const t = useTranslations('clients')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  async function change(profile: string): Promise<void> {
    setError(null)
    const response = await fetch(`/api/clients/${clientId}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ warmupProfile: profile }),
    })
    if (!response.ok) {
      setError(t('warmupProfileSelect.saveFailed'))
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`warmup-${clientId}`} className="text-faint text-[11px]">
        {t('warmupProfileSelect.label')}
      </label>
      <select
        id={`warmup-${clientId}`}
        value={value}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {PROFILES.map((profile) => (
          <option key={profile} value={profile}>
            {t(`warmupMailboxRow.warmupOption.${profile}` as 'warmupMailboxRow.warmupOption.standard')}
          </option>
        ))}
      </select>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
