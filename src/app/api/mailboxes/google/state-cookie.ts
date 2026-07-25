// Shared between /connect (sets it) and /callback (validates it) — the OAuth2
// CSRF state nonce for the Gmail connect flow. httpOnly, short-lived, scoped
// to this provider's routes only.
export const GMAIL_OAUTH_STATE_COOKIE = 'gmail_oauth_state'
export const GMAIL_OAUTH_STATE_COOKIE_PATH = '/api/mailboxes/google'
export const GMAIL_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600
