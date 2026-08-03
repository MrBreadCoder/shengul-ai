'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel
      title="CRM settings unavailable"
      description="Your CRM connection could not be loaded."
      reset={reset}
    />
  )
}
