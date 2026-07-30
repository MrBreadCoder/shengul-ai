/**
 * Client-side half of Google Consent Mode v2.
 *
 * The root layout's inline head script sets the default state (`denied`) via
 * the same `gtag`/`dataLayer` stub before GTM's container script loads, so no
 * tag can fire un-gated on first paint. This module is what the consent banner
 * calls afterward to record and replay the visitor's actual choice. Ads
 * consent is intentionally never exposed here — this product runs no
 * advertising, so only `analytics_storage` reflects a real decision.
 */

export const CONSENT_STORAGE_KEY = 'ai-b2b-consent'

/**
 * Dispatched on `window` any time the stored decision changes, from whichever
 * component made the change. `ConsentBanner` subscribes to this via
 * `useSyncExternalStore` rather than reading storage in an effect and calling
 * `setState`, so a decision made anywhere (accept/reject in the banner, or the
 * footer's "Cookie preferences" reset) is reflected without a page reload.
 */
export const CONSENT_CHANGE_EVENT = 'ai-b2b-consent:change'

export type ConsentDecision = 'granted' | 'denied'

interface ConsentWindow {
  dataLayer?: unknown[]
  gtag?: (...args: unknown[]) => void
  dispatchEvent?: (event: Event) => boolean
}

function getConsentWindow(): ConsentWindow {
  return window as unknown as ConsentWindow
}

/**
 * Mirrors the inline `gtag` stub defined in the layout's head script. Kept as
 * a second definition rather than shared code because the head copy has to be
 * a plain JS string executed before any bundle loads — see NO_FLASH_THEME's
 * neighbor, `CONSENT_DEFAULT_SCRIPT`, in `src/app/layout.tsx`.
 */
function ensureGtagStub(consentWindow: ConsentWindow): (...args: unknown[]) => void {
  consentWindow.dataLayer = consentWindow.dataLayer ?? []
  if (consentWindow.gtag === undefined) {
    consentWindow.gtag = (...args: unknown[]): void => {
      consentWindow.dataLayer?.push(args)
    }
  }
  return consentWindow.gtag
}

function notifyConsentChanged(): void {
  window.dispatchEvent(new Event(CONSENT_CHANGE_EVENT))
}

export function applyConsentDecision(decision: ConsentDecision): void {
  const consentWindow = getConsentWindow()
  const gtag = ensureGtagStub(consentWindow)
  gtag('consent', 'update', { analytics_storage: decision })
}

export function readStoredConsent(): ConsentDecision | null {
  try {
    const value = window.localStorage.getItem(CONSENT_STORAGE_KEY)
    return value === 'granted' || value === 'denied' ? value : null
  } catch {
    // Storage disabled (private mode, hardened browser settings) — treat as
    // no decision yet, so the banner is offered again this session.
    return null
  }
}

export function storeConsentDecision(decision: ConsentDecision): void {
  try {
    window.localStorage.setItem(CONSENT_STORAGE_KEY, decision)
  } catch {
    // Decision still applies to this page load via dataLayer; it just will
    // not persist to the next one. Nothing to recover from here.
  }
  notifyConsentChanged()
}

/**
 * Reverts to the pre-decision state: analytics_storage back to denied, and
 * the stored choice removed so `readStoredConsent` reports null again.
 */
export function clearStoredConsent(): void {
  applyConsentDecision('denied')
  try {
    window.localStorage.removeItem(CONSENT_STORAGE_KEY)
  } catch {
    // Nothing to recover from — see storeConsentDecision.
  }
  notifyConsentChanged()
}
