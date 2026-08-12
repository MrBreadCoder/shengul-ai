export interface ReportPeriod {
  periodStart: string
  periodEnd: string
  periodLabel: 'this week' | 'this month'
}

const MS_PER_DAY = 86_400_000
const DAYS_PER_WEEK = 7

// Half-open UTC window [periodStart, periodEnd) — periodEnd is the start of
// today, so a 7-day report covers the 7 full UTC days before today, giving
// a clean "Aug 4 – Aug 11" label with no fractional-day edges.
export function getWeeklyPeriod(now: Date): ReportPeriod {
  const startOfToday = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())
  return {
    periodStart: new Date(startOfToday - DAYS_PER_WEEK * MS_PER_DAY).toISOString(),
    periodEnd: new Date(startOfToday).toISOString(),
    periodLabel: 'this week',
  }
}

// The just-completed calendar month in full, independent of the weekly
// cadence. `Date.UTC` rolls a negative month index back a year on its own
// (month -1 in January means December of the previous year), so December's
// wraparound needs no special-casing here.
export function getMonthlyPeriod(now: Date): ReportPeriod {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)
  const end = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  return {
    periodStart: new Date(start).toISOString(),
    periodEnd: new Date(end).toISOString(),
    periodLabel: 'this month',
  }
}
