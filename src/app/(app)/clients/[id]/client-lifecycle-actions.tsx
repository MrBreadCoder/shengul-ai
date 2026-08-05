'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Lock, Pause, Play } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import type { Database } from '@/types/database'

type ClientStatus = Database['public']['Enums']['client_status']

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

async function postAction(
  clientId: string,
  action: 'pause' | 'resume' | 'archive',
  t: ReturnType<typeof useTranslations<'clients'>>,
): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/clients/${clientId}/${action}`, { method: 'POST' })
  if (res.ok) return { ok: true }
  const json: unknown = await res.json().catch(() => ({}))
  const message =
    typeof json === 'object' && json !== null && 'error' in json
      ? String((json as { error: unknown }).error)
      : t('lifecycle.requestFailed')
  return { ok: false, message }
}

// Two-step by design: (1) open the dialog, which states exactly what pausing
// or archiving does to live campaigns/logins, (2) click the confirm button.
// Unlike Resume/Reactivate below (which only ever restore a safer prior
// state), Pause and Archive change externally-visible behaviour immediately,
// so neither fires on a single click.
interface ConfirmLifecycleDialogProps {
  clientId: string
  action: 'pause' | 'archive'
  triggerLabel: string
  confirmLabel: string
  pendingLabel: string
  icon: React.ReactNode
  title: string
  description: string
  successMessage: string
  onDone: () => void
}

function ConfirmLifecycleDialog({
  clientId,
  action,
  triggerLabel,
  confirmLabel,
  pendingLabel,
  icon,
  title,
  description,
  successMessage,
  onDone,
}: ConfirmLifecycleDialogProps): React.ReactElement {
  const t = useTranslations('clients')
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onConfirm(): Promise<void> {
    setState({ status: 'submitting' })
    const result = await postAction(clientId, action, t)
    if (!result.ok) {
      const message = result.message ?? t('lifecycle.requestFailed')
      setState({ status: 'error', message })
      toast.error(t('lifecycle.actionFailedToast'), { description: message })
      return
    }
    setState({ status: 'idle' })
    setOpen(false)
    toast.success(successMessage)
    onDone()
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setState({ status: 'idle' })
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          {icon}
          {triggerLabel}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
        </DialogHeader>
        <p className="text-muted-foreground text-sm">{description}</p>
        {state.status === 'error' ? (
          <p role="alert" className="text-destructive text-xs">
            {state.message}
          </p>
        ) : null}
        <DialogFooter>
          <Button type="button" size="sm" disabled={state.status === 'submitting'} onClick={onConfirm}>
            {state.status === 'submitting' ? pendingLabel : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export function ClientLifecycleActions({ clientId, status }: { clientId: string; status: ClientStatus }): React.ReactElement {
  const t = useTranslations('clients')
  const router = useRouter()
  const [resumeState, setResumeState] = useState<SubmitState>({ status: 'idle' })

  async function runResume(successMessage: string): Promise<void> {
    setResumeState({ status: 'submitting' })
    const result = await postAction(clientId, 'resume', t)
    if (!result.ok) {
      toast.error(t('lifecycle.actionFailedToast'), { description: result.message })
      setResumeState({ status: 'idle' })
      return
    }
    toast.success(successMessage)
    setResumeState({ status: 'idle' })
    router.refresh()
  }

  const isResuming = resumeState.status === 'submitting'

  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === 'active' ? (
        <ConfirmLifecycleDialog
          clientId={clientId}
          action="pause"
          icon={<Pause size={13} weight="light" />}
          triggerLabel={t('lifecycle.pauseTrigger')}
          confirmLabel={t('lifecycle.pauseConfirm')}
          pendingLabel={t('lifecycle.pausing')}
          title={t('lifecycle.pauseTitle')}
          description={t('lifecycle.pauseDescription')}
          successMessage={t('lifecycle.pausedToast')}
          onDone={() => router.refresh()}
        />
      ) : null}

      {status === 'paused' ? (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isResuming}
          onClick={() => runResume(t('lifecycle.resumedToast'))}
        >
          <Play size={13} weight="light" />
          {isResuming ? t('lifecycle.resuming') : t('lifecycle.resumeTrigger')}
        </Button>
      ) : null}

      {status !== 'archived' ? (
        <ConfirmLifecycleDialog
          clientId={clientId}
          action="archive"
          icon={<Lock size={13} weight="light" />}
          triggerLabel={t('lifecycle.archiveTrigger')}
          confirmLabel={t('lifecycle.archiveConfirm')}
          pendingLabel={t('lifecycle.archiving')}
          title={t('lifecycle.archiveTitle')}
          description={t('lifecycle.archiveDescription')}
          successMessage={t('lifecycle.archivedToast')}
          onDone={() => router.refresh()}
        />
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={isResuming}
          onClick={() => runResume(t('lifecycle.reactivatedToast'))}
        >
          <Play size={13} weight="light" />
          {isResuming ? t('lifecycle.reactivating') : t('lifecycle.reactivateTrigger')}
        </Button>
      )}
    </div>
  )
}
