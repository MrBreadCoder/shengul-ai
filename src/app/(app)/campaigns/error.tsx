'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Campaigns unavailable"
      description="The campaign list could not be loaded."
      reset={reset}
    />
  )
}
