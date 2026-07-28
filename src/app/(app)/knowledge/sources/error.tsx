'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Knowledge sources unavailable"
      description="The list of pages and files the agent reads could not be loaded."
      reset={reset}
    />
  )
}
