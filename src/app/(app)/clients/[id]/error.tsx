'use client'

import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  return <ErrorPanel title="Client unavailable" description="This client's page could not be loaded." reset={reset} />
}
