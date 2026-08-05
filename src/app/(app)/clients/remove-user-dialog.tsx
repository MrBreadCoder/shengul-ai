'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

type RemoveState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

type RemoveErrorCode = 'email_mismatch' | 'not_found' | 'forbidden'

function isRemoveErrorCode(value: string): value is RemoveErrorCode {
  return value === 'email_mismatch' || value === 'not_found' || value === 'forbidden'
}

interface RemoveUserDialogProps {
  clientId: string
  userId: string
  email: string
}

export function RemoveUserDialog({ clientId, userId, email }: RemoveUserDialogProps): React.ReactElement {
  const t = useTranslations('clients')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmEmail, setConfirmEmail] = useState('')
  const [state, setState] = useState<RemoveState>({ status: 'idle' })

  const isArmed = confirmEmail === email

  async function onConfirm(): Promise<void> {
    if (!isArmed) return
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/users/${userId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmEmail }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const code =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : ''
        const message = isRemoveErrorCode(code)
          ? t(`removeUserDialog.error.${code}` as 'removeUserDialog.error.email_mismatch')
          : t('removeUserDialog.error.generic')
        setState({ status: 'error', message })
        toast.error(t('removeUserDialog.removeFailedToast'), { description: message })
        return
      }
      toast.success(t('removeUserDialog.removedToast', { email }))
      setOpen(false)
      setConfirmEmail('')
      setState({ status: 'idle' })
      router.refresh()
    } catch {
      setState({ status: 'error', message: t('removeUserDialog.networkError') })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setConfirmEmail('')
          setState({ status: 'idle' })
        }
      }}
    >
      <DialogTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="text-muted-foreground hover:text-destructive shrink-0"
          aria-label={t('removeUserDialog.trigger', { email })}
        >
          <Trash size={13} weight="light" />
          {t('removeUserDialog.remove')}
        </Button>
      </DialogTrigger>
      {/* Deliberately unannotated for WebMCP, like the sign-in and set-password
          forms: permanently deleting a client's login is not an action to hand
          to a browsing agent. Lighthouse listing it under
          `webmcp-form-coverage` is the intended state. */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('removeUserDialog.title', { email })}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">{t('removeUserDialog.warning')}</p>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`confirm-email-${userId}`} className="text-xs">
              {t.rich('removeUserDialog.confirmLabel', {
                email,
                bold: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </Label>
            <Input
              id={`confirm-email-${userId}`}
              value={confirmEmail}
              onChange={(event) => setConfirmEmail(event.target.value)}
              autoComplete="off"
            />
          </div>

          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!isArmed || state.status === 'submitting'}
            onClick={onConfirm}
          >
            {state.status === 'submitting' ? t('removeUserDialog.removing') : t('removeUserDialog.removeLogin')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
