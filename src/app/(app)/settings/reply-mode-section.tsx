'use client'

import { useState, useTransition } from 'react'
import { useTranslations } from 'next-intl'
import type { Database } from '@/types/database'
import { updateReplyMode } from './reply-mode-actions'

type ReplyMode = Database['public']['Enums']['reply_mode']

const REPLY_MODES: readonly ReplyMode[] = ['auto_send', 'human_approve', 'hybrid']

// Keys, not literal English — REPLY_MODE_LABEL/HELP become functions of `t`.
function replyModeLabel(t: ReturnType<typeof useTranslations<'settings'>>, mode: ReplyMode): string {
  return t(`replyMode.${mode}.label` as 'replyMode.auto_send.label')
}
function replyModeHelp(t: ReturnType<typeof useTranslations<'settings'>>, mode: ReplyMode): string {
  return t(`replyMode.${mode}.help` as 'replyMode.auto_send.help')
}

interface ReplyModeSectionProps {
  currentMode: ReplyMode
}

export function ReplyModeSection({ currentMode }: ReplyModeSectionProps): React.ReactElement {
  const t = useTranslations('settings')
  const [mode, setMode] = useState<ReplyMode>(currentMode)
  const [isPending, startTransition] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function onChange(next: ReplyMode): void {
    const previous = mode
    setError(null)
    setMode(next)
    const formData = new FormData()
    formData.set('replyMode', next)
    startTransition(async () => {
      try {
        await updateReplyMode(formData)
      } catch {
        setError(t('replyModeSaveFailed'))
        setMode(previous)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">{t('replyModeSrOnly')}</span>
        <select
          value={mode}
          disabled={isPending}
          onChange={(event) => onChange(event.target.value as ReplyMode)}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {REPLY_MODES.map((value) => (
            <option key={value} value={value}>
              {replyModeLabel(t, value)}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground text-[12px]">{replyModeHelp(t, mode)}</p>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
