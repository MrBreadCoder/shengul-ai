'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import type { WarmupProfile } from '@/lib/mailbox/warmup'

const OPTIONS: { value: WarmupProfile; label: string }[] = [
  { value: 'standard', label: 'Warm up — raise the cap daily' },
  { value: 'slow', label: 'Warm up slowly — raise the cap every 2 days' },
  { value: 'none', label: 'Already warm — no ramp' },
]

interface WarmupProfileSelectProps {
  clientId: string
  value: WarmupProfile
}

// Applies to mailboxes connected *after* this change. Existing mailboxes keep
// the profile they were connected with — change those on /settings.
export function WarmupProfileSelect({ clientId, value }: WarmupProfileSelectProps): React.ReactElement {
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
      setError('Could not save that.')
      return
    }
    startTransition(() => router.refresh())
  }

  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={`warmup-${clientId}`} className="text-faint text-[11px]">
        New mailbox warmup
      </label>
      <select
        id={`warmup-${clientId}`}
        value={value}
        disabled={isPending}
        onChange={(event) => void change(event.target.value)}
        className="border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]"
      >
        {OPTIONS.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
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
