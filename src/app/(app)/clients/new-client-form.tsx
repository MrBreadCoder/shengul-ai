'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus } from '@phosphor-icons/react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

export function NewClientForm(): React.ReactElement {
  const router = useRouter()
  const [state, setState] = useState<SubmitState>({ status: 'idle' })

  async function onSubmit(formData: FormData): Promise<void> {
    setState({ status: 'submitting' })
    const name = String(formData.get('name') ?? '')
    try {
      const res = await fetch('/api/clients', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'The server rejected the client.'
        setState({ status: 'error', message })
        toast.error('Could not create client', { description: message })
        return
      }
      setState({ status: 'idle' })
      toast.success('Client created')
      router.refresh()
    } catch {
      const message = 'Network request failed. Check your connection and retry.'
      setState({ status: 'error', message })
      toast.error('Could not create client', { description: message })
    }
  }

  const isSubmitting = state.status === 'submitting'

  return (
    <form
      action={onSubmit}
      // Declarative WebMCP: an agent may fill this in, but the operator presses
      // the button. No `toolautosubmit` — see `@/types/webmcp`.
      toolname="createClient"
      tooldescription="Adds a client to the console. Creating one does not start any outreach; a campaign has to be set up for it separately."
      className="border-hairline bg-surface flex flex-col gap-4 rounded-lg border p-5 sm:flex-row sm:items-end"
    >
      <div className="flex flex-1 flex-col gap-2">
        <Label htmlFor="name" className="text-xs">
          Client name
        </Label>
        <Input
          id="name"
          name="name"
          required
          placeholder="Acme Corp"
          toolparamdescription="The client company's name, as it should appear throughout the console."
        />
      </div>
      <div className="flex items-center gap-3">
        <Button type="submit" size="sm" disabled={isSubmitting}>
          <Plus size={14} weight="bold" />
          {isSubmitting ? 'Creating…' : 'Create client'}
        </Button>
        {state.status === 'error' ? (
          <span role="alert" className="text-destructive text-xs">
            {state.message}
          </span>
        ) : null}
      </div>
    </form>
  )
}
