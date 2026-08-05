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

// Three-step by design: (1) open this dialog, which states the blast radius,
// (2) type the exact client name to arm the button, (3) click the armed
// button. There is no fourth "are you sure" — the typed name IS the
// confirmation, and the button stays disabled until it matches exactly.
type DeleteState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface DeleteClientDialogProps {
  clientId: string
  clientName: string
  campaignCount: number
  userCount: number
}

export function DeleteClientDialog({
  clientId,
  clientName,
  campaignCount,
  userCount,
}: DeleteClientDialogProps): React.ReactElement {
  const t = useTranslations('clients')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [state, setState] = useState<DeleteState>({ status: 'idle' })

  const isArmed = confirmName === clientName

  async function onConfirm(): Promise<void> {
    if (!isArmed) return
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('deleteDialog.deleteFailed')
        setState({ status: 'error', message })
        toast.error(t('deleteDialog.deleteFailedToast'), { description: message })
        return
      }
      toast.success(t('deleteDialog.deletedToast', { clientName }))
      router.push('/clients')
      router.refresh()
    } catch {
      setState({ status: 'error', message: t('deleteDialog.networkError') })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) {
          setConfirmName('')
          setState({ status: 'idle' })
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          <Trash size={13} weight="light" />
          {t('deleteDialog.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('deleteDialog.title', { clientName })}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            {t('deleteDialog.warning', { campaignCount, userCount })}
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="confirmName" className="text-xs">
              {t.rich('deleteDialog.confirmLabel', {
                name: clientName,
                bold: (chunks) => <span className="font-mono">{chunks}</span>,
              })}
            </Label>
            <Input
              id="confirmName"
              value={confirmName}
              onChange={(event) => setConfirmName(event.target.value)}
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
          <Button type="button" variant="destructive" size="sm" disabled={!isArmed || state.status === 'submitting'} onClick={onConfirm}>
            {state.status === 'submitting' ? t('deleteDialog.deleting') : t('deleteDialog.deleteForever')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
