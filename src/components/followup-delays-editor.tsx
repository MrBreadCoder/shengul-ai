'use client'

import { useState } from 'react'
import {
  MIN_FOLLOWUP_STEPS,
  MAX_FOLLOWUP_STEPS,
  MIN_FOLLOWUP_DELAY_DAYS,
  MAX_FOLLOWUP_DELAY_DAYS,
} from '@/lib/validation/followup-limits'

interface FollowupDelaysEditorProps {
  /** Namespaces this instance's <label>/<input> ids — two editors can be on the page at once. */
  idPrefix: string
  delaysDays: readonly number[]
  onChange: (next: number[]) => void
  disabled?: boolean
}

const DEFAULT_NEW_STEP_DAYS = 7

// Monotonic, not reset between renders/instances: uniqueness is all that
// matters, and sharing the counter across every editor on the page is
// harmless.
let keySeed = 0
function nextRowKey(): string {
  keySeed += 1
  return `step-${keySeed}`
}

/**
 * Controlled array-of-days editor: add/remove/edit follow-up steps. Owns no
 * save logic — the parent holds `delaysDays` state and decides when/how to
 * persist it. Rows use a stable generated key (not array index), since this
 * list is mutable: removing a middle row must not cause React to reuse a
 * later row's <input> for an earlier value. If the parent ever replaces the
 * whole `delaysDays` array from outside (e.g. a "Reset to last saved"
 * control), it should remount this component via a `key` prop so the row
 * keys reseed correctly — see followup-cadence-section.tsx.
 */
export function FollowupDelaysEditor({
  idPrefix,
  delaysDays,
  onChange,
  disabled = false,
}: FollowupDelaysEditorProps): React.ReactElement {
  const [rowKeys, setRowKeys] = useState<string[]>(() => delaysDays.map(() => nextRowKey()))

  function setDay(index: number, value: number): void {
    const next = [...delaysDays]
    next[index] = value
    onChange(next)
  }

  function addStep(): void {
    setRowKeys([...rowKeys, nextRowKey()])
    onChange([...delaysDays, DEFAULT_NEW_STEP_DAYS])
  }

  function removeStep(index: number): void {
    setRowKeys(rowKeys.filter((_, i) => i !== index))
    onChange(delaysDays.filter((_, i) => i !== index))
  }

  return (
    <div className="flex flex-col gap-2">
      {delaysDays.map((days, index) => {
        const rowKey = rowKeys[index] ?? `fallback-${index}`
        const inputId = `${idPrefix}-${rowKey}`
        return (
          <div key={rowKey} className="flex items-center gap-2">
            <label htmlFor={inputId} className="text-muted-foreground w-20 shrink-0 text-[12px]">
              Follow-up {index + 1}
            </label>
            <input
              id={inputId}
              type="number"
              min={MIN_FOLLOWUP_DELAY_DAYS}
              max={MAX_FOLLOWUP_DELAY_DAYS}
              step={1}
              value={days}
              disabled={disabled}
              onChange={(event) => {
                const value = Number(event.target.value)
                if (Number.isInteger(value)) setDay(index, value)
              }}
              className="border-hairline bg-surface w-16 rounded-md border px-2 py-1 text-[11px]"
            />
            <span className="text-faint text-[11px]">days later</span>
            <button
              type="button"
              disabled={disabled || delaysDays.length <= MIN_FOLLOWUP_STEPS}
              onClick={() => removeStep(index)}
              className="text-faint hover:text-destructive text-[11px] underline underline-offset-2 disabled:no-underline disabled:opacity-40"
            >
              Remove
            </button>
          </div>
        )
      })}
      <button
        type="button"
        disabled={disabled || delaysDays.length >= MAX_FOLLOWUP_STEPS}
        onClick={addStep}
        className="text-faint hover:text-foreground self-start text-[11px] underline underline-offset-2 disabled:no-underline disabled:opacity-40"
      >
        + Add follow-up
      </button>
    </div>
  )
}
