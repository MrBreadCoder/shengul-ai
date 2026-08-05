'use client'

import { useState, useTransition } from 'react'
import { FollowupDelaysEditor } from '@/components/followup-delays-editor'
import { Button } from '@/components/ui/button'
import { updateFollowupCadence } from './followup-cadence-actions'

interface FollowupCadenceSectionProps {
  initialDelaysDays: readonly number[]
}

function arraysEqual(a: readonly number[], b: readonly number[]): boolean {
  return a.length === b.length && a.every((value, index) => value === b[index])
}

export function FollowupCadenceSection({ initialDelaysDays }: FollowupCadenceSectionProps): React.ReactElement {
  const [delaysDays, setDelaysDays] = useState<number[]>([...initialDelaysDays])
  const [savedDelaysDays, setSavedDelaysDays] = useState<number[]>([...initialDelaysDays])
  // Bumped on Reset to force FollowupDelaysEditor to remount — its internal
  // row keys must reseed when the array is replaced wholesale from outside.
  const [resetVersion, setResetVersion] = useState(0)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)
  const [showSaved, setShowSaved] = useState(false)
  const isDirty = !arraysEqual(delaysDays, savedDelaysDays)

  function onSave(): void {
    setError(null)
    setShowSaved(false)
    const formData = new FormData()
    for (const day of delaysDays) formData.append('delaysDays', String(day))
    startTransition(async () => {
      try {
        await updateFollowupCadence(formData)
        setSavedDelaysDays([...delaysDays])
        setShowSaved(true)
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Could not save that change. Please try again.')
      }
    })
  }

  function onReset(): void {
    setDelaysDays([...savedDelaysDays])
    setResetVersion((v) => v + 1)
    setError(null)
  }

  return (
    <div className="flex flex-col gap-3">
      <p className="text-muted-foreground text-[12px]">
        Applies to new contacts going forward — an already-running follow-up sequence for a contact keeps its
        cadence unless you edit that contact directly, from its case page.
      </p>
      <FollowupDelaysEditor
        key={resetVersion}
        idPrefix="client-default"
        delaysDays={delaysDays}
        onChange={setDelaysDays}
        disabled={isPending}
      />
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" disabled={isPending || !isDirty} onClick={onSave}>
          {isPending ? 'Saving…' : 'Save changes'}
        </Button>
        {isDirty ? (
          <Button type="button" variant="ghost" size="sm" disabled={isPending} onClick={onReset}>
            Reset
          </Button>
        ) : null}
        {showSaved && !isDirty ? <span className="text-faint text-[11px]">Saved</span> : null}
      </div>
      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
    </div>
  )
}
