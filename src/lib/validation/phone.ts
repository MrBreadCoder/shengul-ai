import { z } from 'zod'

// Lenient international format: digits, spaces, parens, hyphens, dots, and an
// optional leading +. Not a strict E.164 validator — this only needs to catch
// obvious garbage before a value goes into a signature line, not validate a
// dialable number.
const PHONE_PATTERN = /^\+?[0-9()\-.\s]{7,25}$/

function digitCount(value: string): number {
  return (value.match(/\d/g) ?? []).length
}

function isValidPhone(value: string): boolean {
  return PHONE_PATTERN.test(value) && digitCount(value) >= 7
}

// Transforms a raw form value into a trimmed phone string or `null` (empty
// input clears the field). `.optional()` at the call site distinguishes
// "field not sent" (leave alone) from "field sent empty" (clear it) — same
// convention as domainSchema.
export const phoneSchema = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length === 0 || isValidPhone(value), {
    message: 'must be a valid phone number, e.g. +1 555 123 4567',
  })
  .transform((value) => (value.length === 0 ? null : value))

// Same format check as phoneSchema, but for schemas that submit an explicit
// `null` to mean "no value" rather than an empty string to be cleared
// server-side — the convention campaignSettingsSchema uses for every
// optional field (see bookingLink/discoverTime there).
export const nullablePhoneSchema = z
  .string()
  .trim()
  .refine(isValidPhone, { message: 'must be a valid phone number, e.g. +1 555 123 4567' })
  .nullable()
