'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Pause, Play } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import type { WarmupProfile } from '@/lib/mailbox/warmup'

const WARMUP_LABEL: Record<WarmupProfile, string> = {
  standard: 'Ramp daily',
  slow: 'Ramp every 2 days',
  none: 'Already warm',
}

interface MailboxControlsProps {
  id: string
  isBlocked: boolean
  warmupProfile: WarmupProfile
}

export function MailboxControls({ id, isBlocked, warmupProfile }: MailboxControlsProps): React.ReactElement {
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
        setError('Could not apply that change.')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('network')
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2.5">
      <label className="sr-only" htmlFor={`warmup-${id}`}>
        Warmup profile
      </label>
      <select
        id={`warmup-${id}`}
        value={warmupProfile}
        disabled={isBusy}
        onChange={(event) => void post('warmup', { profile: event.target.value })}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
      >
        {(Object.keys(WARMUP_LABEL) as WarmupProfile[]).map((profile) => (
          <option key={profile} value={profile}>
            {WARMUP_LABEL[profile]}
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
        {isBlocked ? 'Resume' : 'Pause'}
      </Button>

      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
