'use client'

import { useTranslations } from 'next-intl'
import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('knowledge')
  return (
    <ErrorPanel
      title={t('sources.errorTitle')}
      description={t('sources.errorDescription')}
      reset={reset}
    />
  )
}
