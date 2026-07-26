'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash } from '@phosphor-icons/react'
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

// The server re-checks the typed address against the real one, so this is a
// deliberate-action gate rather than the security boundary.
const ERROR_MESSAGES: Record<string, string> = {
  email_mismatch: 'That address does not match this login.',
  not_found: 'This login no longer exists. Refresh the page.',
  forbidden: 'Only operators can remove a login.',
}

interface RemoveUserDialogProps {
  clientId: string
  userId: string
  email: string
}

export function RemoveUserDialog({ clientId, userId, email }: RemoveUserDialogProps): React.ReactElement {
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
        const message = ERROR_MESSAGES[code] ?? 'Could not remove this login.'
        setState({ status: 'error', message })
        toast.error('Remove failed', { description: message })
        return
      }
      toast.success(`${email} removed`)
      setOpen(false)
      setConfirmEmail('')
      setState({ status: 'idle' })
      router.refresh()
    } catch {
      setState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
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
          aria-label={`Remove ${email}`}
        >
          <Trash size={13} weight="light" />
          Remove
        </Button>
      </DialogTrigger>
      {/* Deliberately unannotated for WebMCP, like the sign-in and set-password
          forms: permanently deleting a client's login is not an action to hand
          to a browsing agent. Lighthouse listing it under
          `webmcp-form-coverage` is the intended state. */}
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Remove {email}</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          <p className="text-muted-foreground text-sm">
            This deletes the login permanently. They lose access immediately, and the address becomes free to
            invite again. There is no undo.
          </p>

          <div className="flex flex-col gap-2">
            <Label htmlFor={`confirm-email-${userId}`} className="text-xs">
              Type <span className="font-mono">{email}</span> to confirm
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
            {state.status === 'submitting' ? 'Removing…' : 'Remove login'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
