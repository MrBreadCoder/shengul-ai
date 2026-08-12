'use client'

import { useTranslations } from 'next-intl'
import { ErrorPanel } from '@/components/error-panel'

export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('home')
  return <ErrorPanel title={t('errorTitle')} description={t('errorDescription')} reset={reset} />
}
