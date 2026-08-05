'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { useTranslations } from 'next-intl'
import type { Database } from '@/types/database'

type MailboxProvider = Database['public']['Enums']['mailbox_provider']

interface MailreachControlsProps {
  id: string
  provider: MailboxProvider
  enabled: boolean
}

// SMTP mailboxes toggle synchronously (we hold real IMAP/SMTP credentials).
// Gmail/Outlook mailboxes need Mailreach's own OAuth consent — checking the
// box for those navigates the browser instead of firing an async POST.
export function MailreachControls({ id, provider, enabled }: MailreachControlsProps): React.ReactElement {
  const t = useTranslations('settings')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBusy = isPending || isSubmitting

  async function toggle(next: boolean): Promise<void> {
    if (isBusy) return
    setError(null)

    if (next && provider !== 'smtp') {
      setIsSubmitting(true)
      try {
        const response = await fetch(`/api/mailboxes/${id}/mailreach/connect`, { method: 'POST' })
        const json: unknown = await response.json()
        if (
          response.ok &&
          typeof json === 'object' &&
          json !== null &&
          'authorizeUrl' in json &&
          typeof (json as { authorizeUrl: unknown }).authorizeUrl === 'string'
        ) {
          window.location.href = (json as { authorizeUrl: string }).authorizeUrl
          return
        }
        setError(t('mailreachControls.startFailed'))
      } catch {
        setError(t('mailreachControls.startFailed'))
      } finally {
        setIsSubmitting(false)
      }
      return
    }

    setIsSubmitting(true)
    try {
      const path = next ? 'connect' : 'disconnect'
      const response = await fetch(`/api/mailboxes/${id}/mailreach/${path}`, { method: 'POST' })
      if (!response.ok) {
        setError(t('mailreachControls.applyFailed'))
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError(t('mailreachControls.applyFailed'))
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <label className="flex items-center gap-1.5 text-[11px]">
        <input
          type="checkbox"
          checked={enabled}
          disabled={isBusy}
          onChange={(event) => void toggle(event.target.checked)}
        />
        {t('mailreachControls.label')}
      </label>
      {error ? (
        <span role="alert" className="text-destructive text-[11px] font-medium">
          {error}
        </span>
      ) : null}
    </div>
  )
}
