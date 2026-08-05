import { z } from 'zod'

// Shared between the client-default Settings form and the per-lead override
// form on a case page, so the two never validate against different bounds.
export const MIN_FOLLOWUP_STEPS = 1
export const MAX_FOLLOWUP_STEPS = 10
export const MIN_FOLLOWUP_DELAY_DAYS = 1
export const MAX_FOLLOWUP_DELAY_DAYS = 90

// Today's hardcoded cadence, preserved as the default for both clients.followup_delays_days
// (column default) and any caller needing a fallback (see scheduleFirstFollowup).
export const DEFAULT_FOLLOWUP_DELAYS_DAYS: number[] = [3, 7, 14]

// z.coerce because every write path is a Server Action reading FormData —
// formData.getAll('delaysDays') always yields strings.
export const followupDelaysSchema = z
  .array(z.coerce.number().int().min(MIN_FOLLOWUP_DELAY_DAYS).max(MAX_FOLLOWUP_DELAY_DAYS))
  .min(MIN_FOLLOWUP_STEPS)
  .max(MAX_FOLLOWUP_STEPS)
