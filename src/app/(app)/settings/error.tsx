'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Settings unavailable"
      description="Your mailbox settings could not be loaded."
      reset={reset}
    />
  )
}
