'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilSimple } from '@phosphor-icons/react'
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

type RenameState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

export function RenameClientDialog({ clientId, currentName }: { clientId: string; currentName: string }): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(currentName)
  const [state, setState] = useState<RenameState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not rename the client.'
        setState({ status: 'error', message })
        toast.error('Rename failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success('Client renamed')
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
        if (next) setName(currentName)
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Rename client">
          <PencilSimple size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename client</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          // Declarative WebMCP: an agent may fill this in, but the operator
          // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
          toolname="renameClient"
          tooldescription="Changes a client's display name across the console. Cosmetic only — campaigns, cases and mail are unaffected."
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientName" className="text-xs">
              Name
            </Label>
            <Input
              id="clientName"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              toolparamdescription="The client's new name. Cannot be blank."
            />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting' || name.trim().length === 0}>
              {state.status === 'submitting' ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
