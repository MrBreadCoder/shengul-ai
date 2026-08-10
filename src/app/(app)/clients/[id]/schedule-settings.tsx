'use client'

import { useState, useTransition } from 'react'
import { TimeOfDayInput } from '@/components/ui/time-of-day-input'
import { updateClientSchedule } from './schedule-actions'

const TIMEZONE_OPTIONS: readonly string[] = Intl.supportedValuesOf('timeZone')
const SELECT_CLASSNAME = 'border-hairline bg-surface rounded-md border px-2 py-1 text-[12px]'

interface ScheduleSettingsProps {
  clientId: string
  timezone: string
  defaultDiscoverTime: string
}

// Operator-only, so no i18n here (per project convention: translate
// client-facing surfaces only). What time and timezone this client's
// campaigns run their default discovery search at — see schedule-actions.ts.
// A campaign with its own schedule override is unaffected by this.
export function ScheduleSettings({ clientId, timezone, defaultDiscoverTime }: ScheduleSettingsProps): React.ReactElement {
  const [savedTimezone, setSavedTimezone] = useState(timezone)
  const [savedTime, setSavedTime] = useState(defaultDiscoverTime)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function save(nextTimezone: string, nextTime: string): void {
    // An empty time means the operator cleared a select mid-edit — not a
    // value to persist, so wait for both segments to be picked again.
    if (!nextTime) return
    setError(null)
    startTransition(async () => {
      const result = await updateClientSchedule(clientId, nextTimezone, nextTime)
      if (!result.ok) {
        setError(result.message)
        return
      }
      setSavedTimezone(nextTimezone)
      setSavedTime(nextTime)
    })
  }

  return (
    <div className="flex flex-col gap-1">
      <span className="text-faint text-[11px]">Discovery schedule</span>
      <div className="flex items-center gap-2">
        <select
          aria-label="Discovery timezone"
          value={savedTimezone}
          disabled={isPending}
          onChange={(event) => save(event.target.value, savedTime)}
          className={SELECT_CLASSNAME}
        >
          {TIMEZONE_OPTIONS.map((tz) => (
            <option key={tz} value={tz}>
              {tz}
            </option>
          ))}
        </select>
        <TimeOfDayInput
          value={savedTime}
          onChange={(next) => save(savedTimezone, next)}
          disabled={isPending}
          hourAriaLabel="Default discovery hour"
          minuteAriaLabel="Default discovery minute"
          className={SELECT_CLASSNAME}
        />
      </div>
      {error ? (
        <span role="alert" className="text-destructive text-[11px]">
          {error}
        </span>
      ) : null}
    </div>
  )
}
