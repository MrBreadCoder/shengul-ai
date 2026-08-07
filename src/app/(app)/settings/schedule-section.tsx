'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { updateSchedule } from './schedule-actions'

const TIMEZONE_OPTIONS: readonly string[] = Intl.supportedValuesOf('timeZone')

interface ScheduleSectionProps {
  initialTimezone: string
  initialDefaultDiscoverTime: string
}

export function ScheduleSection({
  initialTimezone,
  initialDefaultDiscoverTime,
}: ScheduleSectionProps): React.ReactElement {
  const t = useTranslations('settings')
  const [timezone, setTimezone] = useState(initialTimezone)
  const [defaultDiscoverTime, setDefaultDiscoverTime] = useState(initialDefaultDiscoverTime)
  const [savedTimezone, setSavedTimezone] = useState(initialTimezone)
  const [savedTime, setSavedTime] = useState(initialDefaultDiscoverTime)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const isDirty = timezone !== savedTimezone || defaultDiscoverTime !== savedTime

  function onSave(): void {
    setError(null)
    setShowSaved(false)
    const formData = new FormData()
    formData.set('timezone', timezone)
    formData.set('defaultDiscoverTime', defaultDiscoverTime)
    startTransition(async () => {
      try {
        await updateSchedule(formData)
        setSavedTimezone(timezone)
        setSavedTime(defaultDiscoverTime)
        setShowSaved(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : t('scheduleSaveFailed'))
      }
    })
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-[12px]">{t('scheduleHint')}</p>
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1.5">
          <span className="text-xs">{t('scheduleTimezoneLabel')}</span>
          <select
            value={timezone}
            disabled={isPending}
            onChange={(event) => setTimezone(event.target.value)}
            className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
          >
            {TIMEZONE_OPTIONS.map((tz) => (
              <option key={tz} value={tz}>
                {tz}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5">
          <span className="text-xs">{t('scheduleTimeLabel')}</span>
          <input
            type="time"
            value={defaultDiscoverTime}
            disabled={isPending}
            onChange={(event) => setDefaultDiscoverTime(event.target.value)}
            className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
          />
        </label>
        <Button type="button" size="sm" disabled={isPending || !isDirty} onClick={onSave}>
          {isPending ? t('scheduleSaving') : t('scheduleSaveChanges')}
        </Button>
        {showSaved && !isDirty ? <span className="text-faint text-[11px]">{t('scheduleSaved')}</span> : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
