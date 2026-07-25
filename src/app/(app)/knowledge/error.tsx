'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Knowledge unavailable"
      description="The knowledge library could not be loaded."
      reset={reset}
    />
  )
}
