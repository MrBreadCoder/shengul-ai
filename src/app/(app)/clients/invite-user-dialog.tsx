'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { Copy, EnvelopeSimple, LinkSimple } from '@phosphor-icons/react'
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
import { formatInviteTtl, INVITE_TTL_MINUTES } from '@/lib/auth/invite-ttl'

type InviteState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }
  | { status: 'success'; link: string; expiresInMinutes: number; emailSent: boolean }

export function InviteUserDialog({ clientId }: { clientId: string }): React.ReactElement {
  const t = useTranslations('clients')
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
            : t('inviteDialog.createFailed')
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
      const emailSent =
        typeof json === 'object' && json !== null && typeof (json as { emailSent?: unknown }).emailSent === 'boolean'
          ? (json as { emailSent: boolean }).emailSent
          : false
      setState({ status: 'success', link, expiresInMinutes, emailSent })
    } catch {
      setState({ status: 'error', message: t('inviteDialog.networkError') })
    }
  }

  async function copyLink(link: string): Promise<void> {
    await navigator.clipboard.writeText(link)
    toast.success(t('inviteDialog.copiedToast'))
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
          {t('inviteDialog.trigger')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('inviteDialog.title')}</DialogTitle>
        </DialogHeader>

        {state.status === 'success' ? (
          <div className="flex flex-col gap-3">
            <p className="text-muted-foreground text-sm">
              {state.emailSent
                ? t('inviteDialog.successHintEmailed', { ttl: formatInviteTtl(state.expiresInMinutes) })
                : t('inviteDialog.successHintEmailFailed', { ttl: formatInviteTtl(state.expiresInMinutes) })}
            </p>
            <div className="flex items-center gap-2">
              <Input readOnly value={state.link} className="text-xs" />
              <Button type="button" variant="outline" size="sm" onClick={() => copyLink(state.link)}>
                <Copy size={13} weight="light" />
                {t('inviteDialog.copy')}
              </Button>
            </div>
          </div>
        ) : (
          <form
            onSubmit={onSubmit}
            // Declarative WebMCP: an agent may fill this in, but the operator
            // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
            toolname="createClientInviteLink"
            tooldescription={t('inviteDialog.toolDescription')}
            className="flex flex-col gap-4"
          >
            <div className="flex flex-col gap-2">
              <Label htmlFor={`invite-email-${clientId}`} className="text-xs">
                {t('inviteDialog.emailLabel')}
              </Label>
              <Input
                id={`invite-email-${clientId}`}
                name="email"
                type="email"
                required
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="person@client.com"
                toolparamdescription={t('inviteDialog.emailToolParamDescription')}
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
                {state.status === 'submitting' ? t('inviteDialog.generating') : t('inviteDialog.generateButton')}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  )
}
