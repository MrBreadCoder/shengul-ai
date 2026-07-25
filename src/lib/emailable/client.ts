import { env } from '@/lib/env'
import { fetchJson } from '@/lib/http/fetch-json'
import { emailableResultSchema, type EmailableResult } from './types'

const BASE_URL = 'https://api.emailable.com/v1'

// Vendor-side ceiling for the SMTP probe; their docs allow 2-10s and default to 5.
const VERIFY_TIMEOUT_SECONDS = 5

// Sits above VERIFY_TIMEOUT_SECONDS so their own deadline always wins the race —
// aborting first would turn a real verdict into a fail-open activation.
const TRANSPORT_TIMEOUT_MS = 10_000

const REDACTED_KEY = 'REDACTED'

function buildVerifyUrl(email: string, apiKey: string): string {
  const params = new URLSearchParams({
    email,
    api_key: apiKey,
    timeout: String(VERIFY_TIMEOUT_SECONDS),
  })
  return `${BASE_URL}/verify?${params.toString()}`
}

/**
 * Verifies one address against Emailable. Throws `AppError` on any failure —
 * the caller decides what a missing verdict means, this module does not.
 *
 * The key travels in the query string because that is the only auth mechanism
 * the documented endpoint accepts, so a redacted copy of the URL is handed to
 * fetchJson for error context: that context reaches the events table.
 */
export async function verifyEmail(email: string): Promise<EmailableResult> {
  return fetchJson(
    buildVerifyUrl(email, env.EMAILABLE_API_KEY),
    { method: 'GET', headers: { Accept: 'application/json' } },
    emailableResultSchema,
    TRANSPORT_TIMEOUT_MS,
    buildVerifyUrl(email, REDACTED_KEY),
  )
}
