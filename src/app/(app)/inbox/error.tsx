'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Inbox unavailable"
      description="Your drafts and open questions could not be loaded. Nothing was sent."
      reset={reset}
    />
  )
}
