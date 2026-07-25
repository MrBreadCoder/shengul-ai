'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return (
    <ErrorPanel title="Clients unavailable" description="The client list could not be loaded." reset={reset} />
  )
}
