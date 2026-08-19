'use client'

import { useTranslations } from 'next-intl'
import { ArrowClockwise, WarningOctagon } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'

interface ErrorPanelProps {
  title: string
  /** What the operator should understand, not the raw exception. */
  description: string
  reset: () => void
}

export function ErrorPanel({ title, description, reset }: ErrorPanelProps): React.ReactElement {
  // Every caller already translates title/description for its own route —
  // the retry label is the one piece of copy ErrorPanel owns itself, so it
  // needs its own translation rather than a hardcoded English string.
  const tCommon = useTranslations('common')
  return (
    <div
      role="alert"
      className="border-hairline bg-surface-sunken flex flex-col items-center rounded-lg border border-dashed px-6 py-14 text-center"
    >
      <WarningOctagon size={22} weight="light" className="text-destructive" />
      <p className="mt-3 text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 max-w-[52ch] text-sm">{description}</p>
      <Button type="button" variant="outline" size="sm" onClick={reset} className="mt-5">
        <ArrowClockwise size={14} weight="light" />
        {tCommon('retry')}
      </Button>
    </div>
  )
}
