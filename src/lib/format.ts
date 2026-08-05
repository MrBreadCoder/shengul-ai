const EMPTY = '—'

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS
const DAY_MS = 24 * HOUR_MS
const WEEK_MS = 7 * DAY_MS

/**
 * Relative age of a timestamp. `now` is an explicit parameter so callers stay
 * pure and testable, and so Server Components can compute the string once and
 * pass it down as a prop — computing it inside a Client Component would
 * produce a server/client hydration mismatch.
 */
export function formatRelative(iso: string | null, now: Date): string {
  if (!iso) return EMPTY
  const then = new Date(iso)
  const elapsed = now.getTime() - then.getTime()
  if (Number.isNaN(elapsed)) return EMPTY
  if (elapsed < 0) return 'just now'
  if (elapsed < MINUTE_MS) return 'just now'
  if (elapsed < HOUR_MS) return `${Math.floor(elapsed / MINUTE_MS)}m ago`
  if (elapsed < DAY_MS) return `${Math.floor(elapsed / HOUR_MS)}h ago`
  if (elapsed < WEEK_MS) return `${Math.floor(elapsed / DAY_MS)}d ago`
  return `${Math.floor(elapsed / WEEK_MS)}w ago`
}

/** Pinned to UTC: the same string must render on the server and the client. */
export function formatAbsolute(iso: string | null): string {
  if (!iso) return EMPTY
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  )
}

/** Two-letter monogram for a company mark. Falls back to a single glyph. */
export function initialsFor(name: string): string {
  const words = name
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter(Boolean)
  const first = words[0]
  if (!first) return '?'
  const second = words[1]
  if (!second) return first.slice(0, 2).toUpperCase()
  return (first[0]! + second[0]!).toUpperCase()
}

/** Deterministic hue per company so a mark keeps its colour across renders. */
export function hueFor(seed: string): number {
  let hash = 0
  for (let i = 0; i < seed.length; i += 1) {
    hash = (hash << 5) - hash + seed.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash) % 360
}

/** snake_case enum value to a human label: `hot_handoff` to `Hot handoff`. */
export function humanizeEnum(value: string): string {
  const spaced = value.replace(/_/g, ' ')
  return spaced.charAt(0).toUpperCase() + spaced.slice(1)
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

/**
 * "3d" / "today" for a future timestamp; null when nothing is scheduled
 * (sequence paused, exhausted, or no next follow-up yet). `now` is explicit
 * for the same server/client hydration reason as formatRelative.
 */
export function formatFollowupCountdown(nextActionAtIso: string | null, now: Date): string | null {
  if (!nextActionAtIso) return null
  const next = new Date(nextActionAtIso)
  const remainingMs = next.getTime() - now.getTime()
  if (Number.isNaN(remainingMs)) return null
  if (remainingMs <= 0) return 'today'
  return `${Math.ceil(remainingMs / DAY_MS)}d`
}

/** e.g. "1/3 follow-ups sent · next in 3d" — the countdown clause is omitted
 *  when nothing is currently scheduled. */
export function formatFollowupStatus(currentStep: number, totalSteps: number, countdown: string | null): string {
  const sent = `${currentStep}/${totalSteps} follow-up${totalSteps === 1 ? '' : 's'} sent`
  return countdown ? `${sent} · next in ${countdown}` : sent
}
