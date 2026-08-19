'use client'

import { useTranslations } from 'next-intl'
import { ErrorPanel } from '@/components/error-panel'

// The one error boundary above `(app)/layout.tsx`. That layout fetches data
// (draft/knowledge-request counts, client brand) on every render, including
// every `router.refresh()` a save action triggers — but a `page.tsx`-level
// error.tsx (e.g. clients/[id]/error.tsx) never catches a throw from its own
// *layout*, only from the page and its children. Without this file, a
// transient failure in that layout fell through to Next's bare, unstyled,
// English, digest-only default error screen instead of this app's own
// localized panel. See root-cause note in git history for the incident that
// surfaced this gap.
export default function Error({ reset }: { error: Error; reset: () => void }): React.ReactElement {
  const t = useTranslations('common')
  return <ErrorPanel title={t('error')} description={t('appErrorDescription')} reset={reset} />
}
