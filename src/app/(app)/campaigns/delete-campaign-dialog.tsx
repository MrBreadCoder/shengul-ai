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

type StatsState =
  | { status: 'loading' }
  | { status: 'loaded'; caseCount: number; leadCount: number }
  | { status: 'error' }

type DeleteState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface DeleteCampaignDialogProps {
  campaignId: string
  campaignName: string
}

// Three-step by design, same as DeleteClientDialog: (1) open the dialog,
// which fetches and states the blast radius, (2) type the exact campaign
// name to arm the button, (3) click the armed button.
export function DeleteCampaignDialog({ campaignId, campaignName }: DeleteCampaignDialogProps): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [confirmName, setConfirmName] = useState('')
  const [stats, setStats] = useState<StatsState>({ status: 'loading' })
  const [state, setState] = useState<DeleteState>({ status: 'idle' })

  const isArmed = confirmName === campaignName && stats.status === 'loaded'

  async function loadStats(): Promise<void> {
    setStats({ status: 'loading' })
    try {
      const res = await fetch(`/api/campaigns/${campaignId}/stats`)
      if (!res.ok) {
        setStats({ status: 'error' })
        return
      }
      const json = (await res.json()) as { caseCount: number; leadCount: number }
      setStats({ status: 'loaded', caseCount: json.caseCount, leadCount: json.leadCount })
    } catch {
      setStats({ status: 'error' })
    }
  }

  async function onConfirm(): Promise<void> {
    if (!isArmed) return
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/campaigns/${campaignId}`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirmName }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not delete the campaign.'
        setState({ status: 'error', message })
        toast.error('Delete failed', { description: message })
        return
      }
      toast.success(`${campaignName} deleted`)
      setOpen(false)
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
        if (next) {
          void loadStats()
        } else {
          setConfirmName('')
          setState({ status: 'idle' })
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="destructive" size="sm">
          <Trash size={13} weight="light" />
          Delete
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Delete {campaignName} permanently</DialogTitle>
        </DialogHeader>

        <div className="flex flex-col gap-4">
          {stats.status === 'loading' ? (
            <p className="text-muted-foreground text-sm">Checking what this deletes…</p>
          ) : stats.status === 'error' ? (
            <p role="alert" className="text-destructive text-sm">
              Could not load the case and lead counts for this campaign. Close and reopen this dialog to retry.
            </p>
          ) : (
            <p className="text-muted-foreground text-sm">
              This deletes {stats.caseCount} case{stats.caseCount === 1 ? '' : 's'} and {stats.leadCount} lead
              {stats.leadCount === 1 ? '' : 's'} under this campaign, plus every email and sequence tied to them.
              There is no undo.
            </p>
          )}

          <div className="flex flex-col gap-2">
            <Label htmlFor={`confirmName-${campaignId}`} className="text-xs">
              Type <span className="font-mono">{campaignName}</span> to confirm
            </Label>
            <Input
              id={`confirmName-${campaignId}`}
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
          <Button
            type="button"
            variant="destructive"
            size="sm"
            disabled={!isArmed || state.status === 'submitting'}
            onClick={onConfirm}
          >
            {state.status === 'submitting' ? 'Deleting…' : 'Delete forever'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
