import type { Database } from '@/types/database'

type LeadEmailStatus = Database['public']['Enums']['lead_email_status']

const STATUS_MAP: Record<string, LeadEmailStatus> = {
  verified: 'verified',
  unverified: 'unverified',
  update_required: 'unverified',
  catch_all: 'risky',
  unavailable: 'not_found',
}

function normalize(status: string): string {
  return status.toLowerCase().trim().replace(/[^a-z]+/g, '_').replace(/^_+|_+$/g, '')
}

// Apollo's email_status vocabulary (Verified / Unverified / Update required /
// Unavailable / Catch-all) mapped onto our own lead_email_status enum.
// Anything Apollo returns that we don't recognize defaults to 'unverified',
// never 'verified' — per .claude/architecture.md's "no guessing" principle, only a
// status we can positively identify as Apollo's own "Verified" activates a lead.
export function mapApolloEmailStatus(status: string | null | undefined): LeadEmailStatus {
  if (!status) return 'not_found'
  const key = normalize(status)
  return STATUS_MAP[key] ?? 'unverified'
}
