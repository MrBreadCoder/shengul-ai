// Shared between /connect (sets it) and /callback (validates it) — the OAuth2
// CSRF state nonce for the Outlook connect flow. httpOnly, short-lived, scoped
// to this provider's routes only.
export const OUTLOOK_OAUTH_STATE_COOKIE = 'outlook_oauth_state'
export const OUTLOOK_OAUTH_STATE_COOKIE_PATH = '/api/mailboxes/outlook'
export const OUTLOOK_OAUTH_STATE_COOKIE_MAX_AGE_SECONDS = 600
