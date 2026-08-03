'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { getMailboxWarmthStatus, type WarmupProfile } from '@/lib/mailbox/warmup'

const WARMUP_LABEL: Record<WarmupProfile, string> = {
  standard: 'Warm up — raise the cap daily',
  slow: 'Warm up slowly — raise the cap every 2 days',
  none: 'Already warm — no ramp',
}

interface WarmupMailboxRowProps {
  id: string
  emailAddress: string
  profile: WarmupProfile
  warmupStartedAt: string | null
  warmupStartCap: number
  warmupIncrement: number
  warmupTargetCap: number
  dailyCap: number
  sentToday: number
}

interface WarmupPatchBody {
  profile?: WarmupProfile
  warmupStartCap?: number
  warmupIncrement?: number
  warmupTargetCap?: number
  dailyCap?: number
}

export function WarmupMailboxRow(props: WarmupMailboxRowProps): React.ReactElement {
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBusy = isPending || isSubmitting

  const status = getMailboxWarmthStatus({
    profile: props.profile,
    warmupStartedAt: props.warmupStartedAt,
    startCap: props.warmupStartCap,
    increment: props.warmupIncrement,
    targetCap: props.warmupTargetCap,
    dailyCap: props.dailyCap,
    now: new Date(),
  })
  const statusLabel =
    status.kind === 'ramping' ? `Ramping · day ${status.dayNumber} · cap ${status.currentCap}` : 'Already warm'

  async function patch(body: WarmupPatchBody): Promise<void> {
    if (isBusy) return
    setError(null)
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/mailboxes/${props.id}/warmup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
      if (!response.ok) {
        setError('Could not save that change.')
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError('network')
    } finally {
      setIsSubmitting(false)
    }
  }

  function onBlurNumber(current: number, apply: (value: number) => void) {
    return (event: React.FocusEvent<HTMLInputElement>): void => {
      const value = Number(event.target.value)
      if (!Number.isInteger(value) || value < 1 || value === current) return
      apply(value)
    }
  }

  return (
    <div className="border-hairline bg-surface flex flex-wrap items-center gap-x-4 gap-y-3 rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{props.emailAddress}</p>
        <p className="text-faint truncate text-[11px]">
          <span className="tnum">
            {props.sentToday}/{props.dailyCap} today
          </span>{' '}
          · {statusLabel}
        </p>
      </div>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Profile</span>
        <select
          value={props.profile}
          disabled={isBusy}
          onChange={(event) => void patch({ profile: event.target.value as WarmupProfile })}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {(Object.keys(WARMUP_LABEL) as WarmupProfile[]).map((profile) => (
            <option key={profile} value={profile}>
              {WARMUP_LABEL[profile]}
            </option>
          ))}
        </select>
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Start cap</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.warmupStartCap}
          disabled={isBusy}
          onBlur={onBlurNumber(props.warmupStartCap, (value) => void patch({ warmupStartCap: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Increment</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.warmupIncrement}
          disabled={isBusy}
          onBlur={onBlurNumber(props.warmupIncrement, (value) => void patch({ warmupIncrement: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Target cap</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.warmupTargetCap}
          disabled={isBusy}
          onBlur={onBlurNumber(props.warmupTargetCap, (value) => void patch({ warmupTargetCap: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      <label className="flex flex-col gap-1">
        <span className="text-faint text-[10px]">Already-warm cap</span>
        <input
          type="number"
          min={1}
          step={1}
          defaultValue={props.dailyCap}
          disabled={isBusy}
          onBlur={onBlurNumber(props.dailyCap, (value) => void patch({ dailyCap: value }))}
          className="border-hairline bg-surface w-20 rounded-md border px-2 py-1 text-[11px]"
        />
      </label>

      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
