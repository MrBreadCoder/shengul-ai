import { z } from 'zod'
import { apolloPersonSeniorities, apolloContactEmailStatuses, APOLLO_MAX_EMPLOYEE_COUNT } from './types'
import { timeOfDaySchema, timezoneSchema } from '@/lib/validation/schedule'
import { nullablePhoneSchema } from '@/lib/validation/phone'

// Trimmed, length-capped, nullable. Every field on this schema submits an
// explicit `null` to mean "not set" (same convention as bookingLink/
// discoverTime below), so — unlike the client PATCH route's equivalent
// helper — this doesn't need an empty-string-to-null transform.
function nullableTextSchema(maxLength: number) {
  return z
    .string()
    .trim()
    .refine((value) => value.length > 0, { message: 'must not be empty' })
    .refine((value) => value.length <= maxLength, { message: `must be ${maxLength} characters or fewer` })
    .nullable()
}

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
  // Per-campaign override of the owning client's signature fields — null
  // means inherit the client's value, independently per field. See
  // resolveSignatureContext in src/lib/pipeline/signature.ts.
  signatureName: nullableTextSchema(120).default(null),
  signatureTitle: nullableTextSchema(120).default(null),
  phone: nullablePhoneSchema.default(null),
  address: nullableTextSchema(200).default(null),
})

export type CampaignSettingsInput = z.infer<typeof campaignSettingsSchema>
