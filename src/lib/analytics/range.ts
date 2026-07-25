import { z } from 'zod'

const MS_PER_DAY = 86_400_000

// The ranges the dashboard offers. Anything else in the URL is rejected — the
// value reaches SQL, so it is never taken on trust.
export const RANGE_OPTIONS = [7, 30, 90] as const
export type RangeDays = (typeof RANGE_OPTIONS)[number]
export const DEFAULT_RANGE_DAYS: RangeDays = 30

export function parseRangeDays(raw: number | undefined): RangeDays {
  return RANGE_OPTIONS.find((option) => option === raw) ?? DEFAULT_RANGE_DAYS
}

export const analyticsSearchParamsSchema = z.object({
  days: z.coerce.number().int().optional(),
  campaign: z.string().uuid().optional(),
  client: z.string().uuid().optional(),
})

export interface DateRange {
  from: string
  to: string
}

// Half-open UTC window [from, to). `to` is the start of tomorrow so today's rows
// count; a 7-day range therefore covers today plus the previous six days, which
// is what `analytics_daily`'s generate_series expands into exactly 7 buckets.
export function rangeFromDays(days: RangeDays, now: Date): DateRange {
  const startOfTomorrow = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1)
  return {
    from: new Date(startOfTomorrow - days * MS_PER_DAY).toISOString(),
    to: new Date(startOfTomorrow).toISOString(),
  }
}
