'use client'

import { useState, useTransition } from 'react'
import type { Database } from '@/types/database'
import { updateReplyMode } from './reply-mode-actions'

type ReplyMode = Database['public']['Enums']['reply_mode']

const REPLY_MODE_LABEL: Record<ReplyMode, string> = {
  auto_send: 'Automatic',
  human_approve: 'Manual',
  hybrid: 'Hybrid',
}

const REPLY_MODE_HELP: Record<ReplyMode, string> = {
  auto_send: 'The AI sends replies to leads immediately, with no review.',
  human_approve: 'Every reply is drafted for your team to review and send from the Inbox.',
  hybrid: 'The AI sends high-confidence replies automatically and drafts the rest for review.',
}

const REPLY_MODES = Object.keys(REPLY_MODE_LABEL) as ReplyMode[]

interface ReplyModeSectionProps {
  currentMode: ReplyMode
}

export function ReplyModeSection({ currentMode }: ReplyModeSectionProps): React.ReactElement {
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
        setError('Could not save that change. Please try again.')
        setMode(previous)
      }
    })
  }

  return (
    <div className="flex flex-col gap-2">
      <label className="flex flex-col gap-1.5">
        <span className="sr-only">Reply mode</span>
        <select
          value={mode}
          disabled={isPending}
          onChange={(event) => onChange(event.target.value as ReplyMode)}
          className="border-hairline bg-surface rounded-md border px-2 py-1 text-[11px]"
        >
          {REPLY_MODES.map((value) => (
            <option key={value} value={value}>
              {REPLY_MODE_LABEL[value]}
            </option>
          ))}
        </select>
      </label>
      <p className="text-muted-foreground text-[12px]">{REPLY_MODE_HELP[mode]}</p>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
