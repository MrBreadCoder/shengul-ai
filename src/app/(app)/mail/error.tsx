'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Mail unavailable"
      description="The message history could not be loaded."
      reset={reset}
    />
  )
}
