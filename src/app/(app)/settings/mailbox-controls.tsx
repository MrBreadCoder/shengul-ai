'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import type { WarmupProfile } from '@/lib/mailbox/warmup'

const WARMUP_PROFILES: readonly WarmupProfile[] = ['standard', 'slow', 'none']

interface MailboxControlsProps {
  id: string
  isBlocked: boolean
  warmupProfile: WarmupProfile
}

export function MailboxControls({ id, isBlocked, warmupProfile }: MailboxControlsProps): React.ReactElement {
  const t = useTranslations('settings')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBusy = isPending || isSubmitting

  async function post(path: string, body?: unknown): Promise<void> {
    if (isBusy) return
    setError(null)
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/mailboxes/${id}/${path}`, {
        method: 'POST',
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      })
      if (!response.ok) {
        setError(t('mailboxControls.applyFailed'))
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError(t('mailboxControls.networkError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <label className="sr-only" htmlFor={`warmup-${id}`}>
        {t('mailboxControls.warmupProfileSrOnly')}
      </label>
      <select
        id={`warmup-${id}`}
        value={warmupProfile}
        disabled={isBusy}
        onChange={(event) => void post('warmup', { profile: event.target.value })}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
      >
        {WARMUP_PROFILES.map((profile) => (
          <option key={profile} value={profile}>
            {t(`mailboxControls.warmupLabel.${profile}` as 'mailboxControls.warmupLabel.standard')}
          </option>
        ))}
      </select>

      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={isBusy}
        onClick={() => void post(isBlocked ? 'resume' : 'pause')}
      >
        {isBlocked ? <Play size={13} weight="light" /> : <Pause size={13} weight="light" />}
        {isBlocked ? t('mailboxControls.resume') : t('mailboxControls.pause')}
      </Button>

      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
