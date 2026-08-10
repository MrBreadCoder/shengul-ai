import type { z } from 'zod'

// The bare literal 'validation_error' code told a caller nothing about which
// field was wrong or why — every Route Handler that parsed a request body
// with Zod surfaced that same opaque string to the client, turning every
// validation failure into an unhelpful "Could not save changes" toast. This
// renders the first few issues as "path: message" pairs instead, which the
// client already displays verbatim (no client-side change needed) and is
// still just field paths and Zod's own messages — no stack traces, no
// internal service names.
const MAX_ISSUES_IN_MESSAGE = 3

export function formatZodMessage(error: z.ZodError): string {
  const parts = error.issues.slice(0, MAX_ISSUES_IN_MESSAGE).map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join('.') : '(root)'
    return `${path}: ${issue.message}`
  })
  const remaining = error.issues.length - parts.length
  if (remaining > 0) parts.push(`and ${remaining} more`)
  return parts.join('; ')
}
