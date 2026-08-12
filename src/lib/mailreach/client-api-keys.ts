import { env } from '@/lib/env'

// Uniforms Fashion asked to warm up mail through their own Mailreach account
// rather than the shared platform-level one. This is intentionally a single
// hardcoded if/else, not a generic per-client key system — if a second client
// ever needs their own key, replace this with a real per-client column
// (encrypted at rest, like crm_connections.oauth / mailboxes.oauth) instead of
// stacking more env vars and branches here.
const UNIFORMS_FASHION_CLIENT_ID = 'd99edf8f-b185-47b2-9615-1f6e43853001'

/**
 * Resolves which Mailreach API key to use for a given client's vendor calls.
 * Falls back to the global MAILREACH_API_KEY for every client other than
 * Uniforms Fashion, and for Uniforms Fashion itself until the override env
 * var is actually configured.
 */
export function resolveMailreachApiKey(clientId: string): string {
  if (clientId === UNIFORMS_FASHION_CLIENT_ID && env.MAILREACH_API_KEY_UNIFORMS_FASHION) {
    return env.MAILREACH_API_KEY_UNIFORMS_FASHION
  }
  return env.MAILREACH_API_KEY
}
