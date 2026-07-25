'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Lock, Pause, Play } from '@phosphor-icons/react'
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

async function postAction(clientId: string, action: 'pause' | 'resume' | 'archive'): Promise<{ ok: boolean; message?: string }> {
  const res = await fetch(`/api/clients/${clientId}/${action}`, { method: 'POST' })
  if (res.ok) return { ok: true }
  const json: unknown = await res.json().catch(() => ({}))
  const message =
    typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'Request failed.'
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
  const [open, setOpen] = useState(false)
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onConfirm(): Promise<void> {
    setState({ status: 'submitting' })
    const result = await postAction(clientId, action)
    if (!result.ok) {
      const message = result.message ?? 'Request failed.'
      setState({ status: 'error', message })
      toast.error('Action failed', { description: message })
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
  const router = useRouter()
  const [resumeState, setResumeState] = useState<SubmitState>({ status: 'idle' })

  async function runResume(successMessage: string): Promise<void> {
    setResumeState({ status: 'submitting' })
    const result = await postAction(clientId, 'resume')
    if (!result.ok) {
      toast.error('Action failed', { description: result.message })
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
          triggerLabel="Pause operations"
          confirmLabel="Yes, pause operations"
          pendingLabel="Pausing…"
          title="Pause operations?"
          description="Discovery stops immediately and every active campaign for this client is paused. Logins are unaffected. You can resume at any time."
          successMessage="Operations paused"
          onDone={() => router.refresh()}
        />
      ) : null}

      {status === 'paused' ? (
        <Button type="button" variant="outline" size="sm" disabled={isResuming} onClick={() => runResume('Operations resumed')}>
          <Play size={13} weight="light" />
          {isResuming ? 'Resuming…' : 'Resume operations'}
        </Button>
      ) : null}

      {status !== 'archived' ? (
        <ConfirmLifecycleDialog
          clientId={clientId}
          action="archive"
          icon={<Lock size={13} weight="light" />}
          triggerLabel="Stop + block login"
          confirmLabel="Yes, stop and block login"
          pendingLabel="Archiving…"
          title="Stop operations and block login?"
          description="Every active campaign for this client is paused and every client-role login is banned immediately. No data is deleted — you can reactivate at any time."
          successMessage="Client archived — login blocked"
          onDone={() => router.refresh()}
        />
      ) : (
        <Button type="button" variant="outline" size="sm" disabled={isResuming} onClick={() => runResume('Client reactivated')}>
          <Play size={13} weight="light" />
          {isResuming ? 'Reactivating…' : 'Reactivate'}
        </Button>
      )}
    </div>
  )
}
