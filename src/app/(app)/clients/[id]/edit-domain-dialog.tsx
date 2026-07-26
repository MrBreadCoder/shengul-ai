'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Globe } from '@phosphor-icons/react'
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

type EditState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface EditDomainDialogProps {
  clientId: string
  currentDomain: string | null
}

// Website is optional and only used for the auto-fetched favicon fallback in
// CompanyMark, so an empty submission is valid — it clears the field rather
// than failing validation.
export function EditDomainDialog({ clientId, currentDomain }: EditDomainDialogProps): React.ReactElement {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [domain, setDomain] = useState(currentDomain ?? '')
  const [state, setState] = useState<EditState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ domain }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not update the website.'
        setState({ status: 'error', message })
        toast.error('Update failed', { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success('Website updated')
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
        if (next) setDomain(currentDomain ?? '')
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label="Edit website">
          <Globe size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Website</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          // Declarative WebMCP: an agent may fill this in, but the operator
          // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
          toolname="setClientWebsite"
          tooldescription="Records the client's own website, used to auto-fetch its logo from the site favicon. Submitting it empty clears the field."
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientDomain" className="text-xs">
              Domain
            </Label>
            <Input
              id="clientDomain"
              name="domain"
              value={domain}
              onChange={(event) => setDomain(event.target.value)}
              placeholder="acme.com"
              toolparamdescription="The client's bare domain, without a scheme or path — for example acme.com. Optional; leave blank to clear it."
            />
            <p className="text-faint text-[11px]">
              Used to auto-fetch a logo from the site&apos;s favicon when no logo is uploaded. Leave blank to clear it.
            </p>
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting'}>
              {state.status === 'submitting' ? 'Saving…' : 'Save'}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
