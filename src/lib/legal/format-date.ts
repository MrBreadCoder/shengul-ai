const MONTHS: readonly string[] = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
]

/**
 * Renders a `YYYY-MM-DD` document date as long-form prose.
 *
 * Built from the parts rather than through `Intl` or a local `Date`: a legal
 * document's effective date must read identically on the server and in every
 * reader's browser, and `new Date('2026-07-25')` is UTC midnight, which prints
 * as the day before anywhere west of Greenwich.
 */
export function formatLegalDate(isoDate: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(isoDate)
  if (!match) return isoDate

  const [, year, month, day] = match
  const monthName = MONTHS[Number(month) - 1]
  if (!monthName) return isoDate

  return `${Number(day)} ${monthName} ${year}`
}
