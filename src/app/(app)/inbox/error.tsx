'use client'

import { useTranslations } from 'next-intl'
import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('inbox')
  return (
    <ErrorPanel
      title={t('errorTitle')}
      description={t('errorDescription')}
      reset={reset}
    />
  )
}
