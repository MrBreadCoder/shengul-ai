// `null` means "no denominator, so no rate exists" — distinct from 0%, which
// means "we tried and nothing converted". The UI renders them differently.
export function rate(numerator: number, denominator: number): number | null {
  if (denominator <= 0) return null
  return numerator / denominator
}

const EMPTY_VALUE = '—'

export function formatPercent(value: number | null): string {
  if (value === null) return EMPTY_VALUE
  return `${(value * 100).toFixed(1)}%`
}

export function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

// Server- and client-rendered on the same page, so the timezone must be pinned;
// letting it default would produce a hydration mismatch.
export function formatDateTime(iso: string | null): string {
  if (!iso) return EMPTY_VALUE
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return EMPTY_VALUE
  const pad = (n: number): string => String(n).padStart(2, '0')
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}` +
    ` ${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())} UTC`
  )
}
