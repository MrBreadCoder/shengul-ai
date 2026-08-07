import { z } from 'zod'

// HH:mm, 24-hour, zero-padded — matches the wire format of an
// <input type="time"> element, used by both the client settings form and
// the per-campaign override fields.
export const timeOfDaySchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Expected HH:mm, 24-hour, zero-padded')

// Intl.DateTimeFormat throws RangeError for any string it doesn't recognize
// as a valid IANA timezone name — this is the standard runtime way to
// validate one without a database of zone names to maintain ourselves.
export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: timezone })
    return true
  } catch {
    return false
  }
}

export const timezoneSchema = z.string().refine(isValidTimezone, { message: 'Invalid IANA timezone' })
