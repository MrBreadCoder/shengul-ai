'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Resources unavailable"
      description="The files the agent can send could not be loaded."
      reset={reset}
    />
  )
}
