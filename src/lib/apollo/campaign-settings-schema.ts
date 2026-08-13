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
  // How many verified contacts discovery aims for at each company before
  // opening a new one — see src/lib/pipeline/discover.ts and
  // docs/superpowers/specs/2026-08-10-contacts-per-company-design.md.
  contactsPerCompany: z.number().int().min(1).max(10).default(2),
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
  // Which of the client's mailboxes this campaign sends from. Empty is a
  // valid shape at this shared-schema level — POST /api/campaigns tightens it
  // to at least one via .refine() (a campaign can't be created mailbox-less),
  // while PATCH leaves it as-is so an already-broken campaign can still be
  // opened and saved. Ownership (does each id belong to this campaign's
  // client) is checked by the route, not here — this schema has no DB access.
  mailboxIds: z.array(z.string().uuid()).default([]),
})

export type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>
