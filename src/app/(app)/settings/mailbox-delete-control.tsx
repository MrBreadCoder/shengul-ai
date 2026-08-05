'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { Trash } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'

interface MailboxDeleteControlProps {
  id: string
  emailAddress: string
}

export function MailboxDeleteControl({ id, emailAddress }: MailboxDeleteControlProps): React.ReactElement {
  const t = useTranslations('settings')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [isConfirming, setIsConfirming] = useState(false)
  const [isPending, startTransition] = useTransition()
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const isBusy = isPending || isSubmitting

  async function remove(): Promise<void> {
    if (isBusy) return
    setError(null)
    setIsSubmitting(true)
    try {
      const response = await fetch(`/api/mailboxes/${id}`, { method: 'DELETE' })
      if (!response.ok) {
        setError(t('mailboxDelete.removeFailed'))
        return
      }
      startTransition(() => router.refresh())
    } catch {
      setError(t('mailboxDelete.networkError'))
    } finally {
      setIsSubmitting(false)
    }
  }

  if (isConfirming) {
    return (
      <div className="flex flex-col gap-1.5">
        <p className="text-muted-foreground max-w-64 text-[11px]">
          {t('mailboxDelete.warning', { emailAddress })}
        </p>
        <div className="flex gap-2">
          <Button type="button" variant="destructive" size="sm" disabled={isBusy} onClick={() => void remove()}>
            {isBusy ? t('mailboxDelete.removing') : t('mailboxDelete.confirmRemove')}
          </Button>
          <Button type="button" variant="outline" size="sm" disabled={isBusy} onClick={() => setIsConfirming(false)}>
            {tCommon('cancel')}
          </Button>
        </div>
        {error ? (
          <span role="alert" className="text-destructive text-[11px] font-medium">
            {error}
          </span>
        ) : null}
      </div>
    )
  }

  return (
    <Button type="button" variant="outline" size="sm" onClick={() => setIsConfirming(true)}>
      <Trash size={13} weight="light" />
      {t('mailboxDelete.remove')}
    </Button>
  )
}
