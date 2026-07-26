'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, EnvelopeSimple, LinkSimple } from '@phosphor-icons/react'
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
import { formatInviteTtl, INVITE_TTL_MINUTES } from '@/lib/auth/invite-ttl'

type InviteState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'success'; link: string; expiresInMinutes: number }

export function InviteUserDialog({ clientId }: { clientId: string }): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [email, setEmail] = useState('')
  const [state, setState] = useState<InviteState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}/invite`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      })
      const json: unknown = await res.json().catch(() => ({}))
      if (!res.ok) {
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : 'Could not create the invite.'
        setState({ status: 'error', message })
        return
      }
      const link =
        typeof json === 'object' && json !== null && 'link' in json ? String((json as { link: unknown }).link) : ''
      // Falls back to the compiled-in window rather than showing nothing: the
      // server is the authority on the expiry it actually stored, but a
      // missing field must not leave the operator without a deadline to quote.
      const expiresInMinutes =
        typeof json === 'object' && json !== null && typeof (json as { expiresInMinutes?: unknown }).expiresInMinutes === 'number'
          ? (json as { expiresInMinutes: number }).expiresInMinutes
          : INVITE_TTL_MINUTES
      setState({ status: 'success', link, expiresInMinutes })
    } catch {
      setState({ status: 'error', message: 'Network request failed. Check your connection and retry.' })
    }
  }

  async function copyLink(link: string): Promise<void> {
    await navigator.clipboard.writeText(link)
    toast.success('Link copied')
  }

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setEmail('')
      setState({ status: 'idle' })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <Button type="button" variant="outline" size="sm">
          <EnvelopeSimple size={13} weight="light" />
          Invite user
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Create an account-creation link</DialogTitle>
        </DialogHeader>

        {state.status === 'success' ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              Send this link to the client. It lets them set their own password and sign in, and works for the
              next {formatInviteTtl(state.expiresInMinutes)} — they can open it more than once in that time. After
              that it stops working and you issue a new one.
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={state.link} className="text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={() => copyLink(state.link)}>
                <Copy size={13} weight="light" />
                Copy
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            // Declarative WebMCP: an agent may fill this in, but the operator
            // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
            toolname="createClientInviteLink"
            tooldescription="Generates a link that lets this client set their own password and sign in. It stays usable for a couple of hours and can be opened more than once in that time, then expires. The link is shown on screen to copy; nothing is emailed."
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={`invite-email-${clientId}`} className="text-xs">
                Client&apos;s email
              </Label>
              <Input
                id={`invite-email-${clientId}`}
                name="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@client.com"
                toolparamdescription="The email address that will own the login. It becomes the account's identity, so it has to be one the client controls."
              />
            </div>
            {state.status === 'error' ? (
              <p role="alert" className="text-destructive text-xs">
                {state.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="submit" size="sm" disabled={state.status === 'submitting'}>
                <LinkSimple size={13} weight="light" />
                {state.status === 'submitting' ? 'Generating…' : 'Generate link'}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
