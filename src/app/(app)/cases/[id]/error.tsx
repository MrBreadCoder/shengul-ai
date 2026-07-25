'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="Case unavailable"
      description="This case could not be loaded. It may have been reassigned, or the database is briefly unreachable."
      reset={reset}
    />
  )
}
