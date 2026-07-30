'use client'

import { clearStoredConsent } from '@/lib/consent/consent-mode'

interface CookiePreferencesButtonProps {
  className?: string
}

/**
 * Re-opens the consent banner so a decision can be withdrawn as easily as it
 * was given. `clearStoredConsent` fires `CONSENT_CHANGE_EVENT`, which
 * `ConsentBanner`'s `useSyncExternalStore` subscription picks up directly.
 */
export function CookiePreferencesButton({ className }: CookiePreferencesButtonProps): React.ReactElement {
  return (
    <button type="button" onClick={() => clearStoredConsent()} className={className}>
      Cookie preferences
    </button>
  )
}
