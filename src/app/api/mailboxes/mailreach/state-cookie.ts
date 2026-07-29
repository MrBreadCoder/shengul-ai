// Shared between /[id]/mailreach/connect (sets it) and /mailreach/callback
// (validates it) — the OAuth2 CSRF state nonce for the Mailreach connect flow.
// Path is the common /api/mailboxes prefix so both routes' cookie jars overlap.
export const MAILREACH_OAUTH_STATE_COOKIE = 'mailreach_oauth_state'
export const MAILREACH_OAUTH_STATE_COOKIE_PATH = '/api/mailboxes'
export const MAILREACH_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600
