import Link from 'next/link'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default function ClientNotFound(): React.ReactElement {
  return (
    <EmptyState
      icon={MagnifyingGlass}
      title="Client not found"
      description="This client does not exist, or you do not have access to it."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/clients">Back to clients</Link>
        </Button>
      }
    />
  )
}
