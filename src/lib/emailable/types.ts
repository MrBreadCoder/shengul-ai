import { z } from 'zod'

// Emailable's documented /v1/verify response. Only `state` and `email` are
// required: `state` is the sole field the send policy branches on, and every
// other field exists purely for the audit record on leads.email_verification.
//
// Everything else is optional on purpose. A schema failure here would be
// indistinguishable from a vendor outage and would fall into the fail-open
// branch, activating a lead we had a real verdict for. Being permissive about
// fields we do not read is strictly safer than being strict about them.
//
// `state` is typed as a plain string rather than an enum for the same reason:
// an unrecognized state is mapped to a parked lead by map-verification.ts,
// which is a better outcome than a parse error that fails open.
export const emailableResultSchema = z.object({
  state: z.string(),
  email: z.string(),
  reason: z.string().optional(),
  score: z.number().optional(),
  domain: z.string().optional(),
  user: z.string().optional(),
  accept_all: z.boolean().nullable().optional(),
  did_you_mean: z.string().nullable().optional(),
  disposable: z.boolean().optional(),
  free: z.boolean().optional(),
  role: z.boolean().optional(),
  no_reply: z.boolean().optional(),
  mailbox_full: z.boolean().optional(),
  mx_record: z.string().nullable().optional(),
  smtp_provider: z.string().nullable().optional(),
  tag: z.string().nullable().optional(),
  duration: z.number().optional(),
}).passthrough()

export type EmailableResult = z.infer<typeof emailableResultSchema>

/**
 * One lead's verification attempt. `ok: false` means we got no verdict at all
 * (network, timeout, 4xx, 5xx) — distinct from a verdict we understood and
 * rejected. Only this case triggers the fail-open branch.
 */
export type VerificationOutcome =
  | { ok: true; result: EmailableResult }
  | { ok: false; error: string }
