import Link from 'next/link'
import { MagnifyingGlass } from '@phosphor-icons/react/dist/ssr'
import { getTranslations } from 'next-intl/server'
import { EmptyState } from '@/components/empty-state'
import { Button } from '@/components/ui/button'

export default async function ClientNotFound(): Promise<React.ReactElement> {
  const t = await getTranslations('clients')
  return (
    <EmptyState
      icon={MagnifyingGlass}
      title={t('notFoundTitle')}
      description={t('notFoundDescription')}
      action={
        <Button asChild size="sm" variant="outline">
          <Link href="/clients">{t('backToClients')}</Link>
        </Button>
      }
    />
  )
}
