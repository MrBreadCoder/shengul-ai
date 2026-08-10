'use client'

import { useState } from 'react'

const HOURS: readonly string[] = Array.from({ length: 24 }, (_, hour) => hour.toString().padStart(2, '0'))
const MINUTES: readonly string[] = Array.from({ length: 60 }, (_, minute) => minute.toString().padStart(2, '0'))
const TIME_OF_DAY_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/

function splitTime(value: string): { hour: string; minute: string } {
  const match = TIME_OF_DAY_PATTERN.exec(value)
  // match[1] and match[2] are non-null whenever match itself is non-null —
  // the pattern has exactly two capturing groups and both are required.
  return match ? { hour: match[1]!, minute: match[2]! } : { hour: '', minute: '' }
}

interface TimeOfDayInputProps {
  /** '' (unset) or a 24-hour zero-padded "HH:mm" string — see timeOfDaySchema. */
  value: string
  onChange: (value: string) => void
  disabled?: boolean
  hourAriaLabel: string
  minuteAriaLabel: string
  className?: string
}

// A native <input type="time"> renders as a segmented picker whose browser-
// native constraint validation can report "bad input" (the "Invalid value"
// bubble) even when every segment looks filled — a long-standing, hard-to-
// reproduce cross-browser quirk, worst on macOS Chrome/Safari where the
// picker displays 12-hour AM/PM while the wire value stays 24-hour "HH:mm".
// Two plain <select> elements can only ever hold one of their own listed
// options, so there is no "invalid" state to land in — this replaces the
// native widget everywhere a time-of-day is collected.
export function TimeOfDayInput({
  value,
  onChange,
  disabled,
  hourAriaLabel,
  minuteAriaLabel,
  className,
}: TimeOfDayInputProps): React.ReactElement {
  // Deliberately seeded from `value` only once, not re-derived on every
  // render: picking just the hour leaves the combined string incomplete, so
  // commit() below reports '' upward. If hour/minute were derived straight
  // from `value` (the incomplete '' echoing back down as this component's
  // prop), that '' would re-split to { hour: '', minute: '' } and wipe out
  // the hour the user just picked before they got to the minute — exactly
  // the "selecting a number doesn't get inserted" bug. Holding the pair as
  // local state makes each select's own selection stick regardless of what
  // the combined value looks like.
  const [hour, setHour] = useState(() => splitTime(value).hour)
  const [minute, setMinute] = useState(() => splitTime(value).minute)

  function commit(nextHour: string, nextMinute: string): void {
    setHour(nextHour)
    setMinute(nextMinute)
    onChange(nextHour && nextMinute ? `${nextHour}:${nextMinute}` : '')
  }

  return (
    <div className="flex items-center gap-1">
      <select
        aria-label={hourAriaLabel}
        value={hour}
        disabled={disabled}
        onChange={(event) => commit(event.target.value, minute)}
        className={className}
      >
        <option value="">--</option>
        {HOURS.map((h) => (
          <option key={h} value={h}>
            {h}
          </option>
        ))}
      </select>
      <span aria-hidden className="text-faint text-xs">
        :
      </span>
      <select
        aria-label={minuteAriaLabel}
        value={minute}
        disabled={disabled}
        onChange={(event) => commit(hour, event.target.value)}
        className={className}
      >
        <option value="">--</option>
        {MINUTES.map((m) => (
          <option key={m} value={m}>
            {m}
          </option>
        ))}
      </select>
    </div>
  )
}
