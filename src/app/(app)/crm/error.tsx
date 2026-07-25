'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Pipeline unavailable"
      description="The case board could not be loaded. This is usually a transient database issue."
      reset={reset}
    />
  )
}
