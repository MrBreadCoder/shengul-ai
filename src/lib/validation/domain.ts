import { z } from 'zod'

// Bare-hostname shape: labels of letters/digits/hyphens (no leading/trailing
// hyphen), at least one dot. Deliberately simple — this only needs to reject
// obvious garbage before we hand the value to a favicon lookup, not validate
// DNS-perfect hostnames.
const DOMAIN_PATTERN = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$/

// Strips protocol, "www.", any path/query/fragment, and a trailing dot so an
// operator can paste a full URL (https://www.acme.com/pricing) and still get
// a bare, comparable hostname (acme.com).
export function normalizeDomain(input: string): string {
  const withoutProtocol = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  const host = withoutProtocol.split(/[/?#]/)[0] ?? ''
  return host.replace(/^www\./, '').replace(/\.$/, '')
}

// Transforms a raw form value into a normalized domain or `null` (empty
// input clears the field). `.optional()` at the call site distinguishes "field
// not sent" (leave alone) from "field sent empty" (clear it).
export const domainSchema = z
  .string()
  .transform((value) => normalizeDomain(value))
  .refine((value) => value.length === 0 || DOMAIN_PATTERN.test(value), {
    message: 'must be a valid domain, e.g. acme.com',
  })
  .transform((value) => (value.length === 0 ? null : value))
