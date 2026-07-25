'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Analytics unavailable"
      description="Your metrics could not be computed. The pipeline itself is unaffected."
      reset={reset}
    />
  )
}
