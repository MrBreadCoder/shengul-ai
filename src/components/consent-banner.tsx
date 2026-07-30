'use client'

import Link from 'next/link'
import { useEffect, useSyncExternalStore } from 'react'
import { Button } from '@/components/ui/button'
import {
  applyConsentDecision,
  CONSENT_CHANGE_EVENT,
  readStoredConsent,
  storeConsentDecision,
  type ConsentDecision,
} from '@/lib/consent/consent-mode'
import { legalDocumentPath } from '@/lib/legal/registry'

type BannerVisibility = 'visible' | 'hidden'

function subscribeToConsentChanges(callback: () => void): () => void {
  window.addEventListener(CONSENT_CHANGE_EVENT, callback)
  return () => window.removeEventListener(CONSENT_CHANGE_EVENT, callback)
}

function getVisibilitySnapshot(): BannerVisibility {
  return readStoredConsent() === null ? 'visible' : 'hidden'
}

/** No decision exists yet on the server, so the pre-hydration markup never claims one. */
function getServerVisibilitySnapshot(): BannerVisibility {
  return 'hidden'
}

/** Only rendered by the root layout when NEXT_PUBLIC_GTM_ID is configured — with no GTM there is nothing for analytics_storage to gate. */
export function ConsentBanner(): React.ReactElement | null {
  const visibility = useSyncExternalStore(
    subscribeToConsentChanges,
    getVisibilitySnapshot,
    getServerVisibilitySnapshot,
  )

  useEffect(() => {
    // Every load starts from the head script's 'denied' default — replay a
    // prior choice so returning visitors don't have to grant it again.
    const stored = readStoredConsent()
    if (stored !== null) applyConsentDecision(stored)
  }, [])

  function choose(decision: ConsentDecision): void {
    applyConsentDecision(decision)
    storeConsentDecision(decision)
  }

  if (visibility === 'hidden') return null

  return (
    <div
      role="region"
      aria-label="Cookie consent"
      className="fixed inset-x-0 bottom-0 z-50 border-t bg-background/95 p-4 backdrop-blur supports-backdrop-filter:bg-background/80 sm:p-6"
    >
      <div className="mx-auto flex max-w-[1180px] flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
        <p className="text-sm text-muted-foreground">
          We&apos;d like to use analytics cookies to understand how the site is used. Nothing
          loads until you say yes, and we never use them for advertising. See the{' '}
          <Link
            href={legalDocumentPath('cookie-policy')}
            className="underline underline-offset-2 hover:text-foreground"
          >
            cookie notice
          </Link>{' '}
          for details.
        </p>
        <div className="flex shrink-0 gap-2">
          <Button variant="outline" size="sm" onClick={() => choose('denied')}>
            Reject
          </Button>
          <Button size="sm" onClick={() => choose('granted')}>
            Accept analytics
          </Button>
        </div>
      </div>
    </div>
  )
}
