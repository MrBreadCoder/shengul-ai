import { z } from 'zod'
import { apolloPersonSeniorities, apolloContactEmailStatuses, APOLLO_MAX_EMPLOYEE_COUNT } from './types'
import { timeOfDaySchema, timezoneSchema } from '@/lib/validation/schedule'

// Shared between POST /api/campaigns (create) and PATCH /api/campaigns/[campaignId]
// (edit) — every field a campaign's settings form submits, except clientId
// (set once at creation, immutable afterward).
export const campaignSettingsSchema = z.object({
  name: z.string().min(1),
  valueProp: z.string().min(1),
  bookingLink: z.string().url().nullable().default(null),
  dailyTarget: z.number().int().min(1).max(100).default(50),
  personTitles: z.array(z.string()).default([]),
  organizationLocations: z.array(z.string()).default([]),
  employeeRangeMin: z.number().int().nonnegative().max(APOLLO_MAX_EMPLOYEE_COUNT).nullable().default(null),
  employeeRangeMax: z.number().int().nonnegative().max(APOLLO_MAX_EMPLOYEE_COUNT).nullable().default(null),
  keywords: z.array(z.string()).default([]),
  excludeOrganizationLocations: z.array(z.string()).default([]),
  excludeKeywords: z.array(z.string()).default([]),
  personSeniorities: z.array(z.enum(apolloPersonSeniorities)).default([]),
  contactEmailStatuses: z.array(z.enum(apolloContactEmailStatuses)).default([]),
  // null = inherit the owning client's timezone/default_discover_time.
  discoverTime: timeOfDaySchema.nullable().default(null),
  discoverTimezone: timezoneSchema.nullable().default(null),
})

export type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>
