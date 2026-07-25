import Link from 'next/link'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default function CaseNotFound(): React.ReactElement {
  return (
    <EmptyState
      icon={MagnifyingGlass}
      title="Case not found"
      description="This case does not exist, or it belongs to a client you do not have access to."
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/crm">Back to pipeline</Link>
        </Button>
      }
    />
  )
}
