'use client'

import { useTranslations } from 'next-intl'
import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('knowledge')
  return (
    <ErrorPanel
      title={t('resources.errorTitle')}
      description={t('resources.errorDescription')}
      reset={reset}
    />
  )
}
