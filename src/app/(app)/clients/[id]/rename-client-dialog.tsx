'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PencilSimple } from '@phosphor-icons/react'
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

type RenameState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

export function RenameClientDialog({ clientId, currentName }: { clientId: string; currentName: string }): React.ReactElement {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
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
            : t('renameDialog.genericError')
        setState({ status: 'error', message })
        toast.error(t('renameDialog.renameFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success(t('renameDialog.renamedToast'))
      router.refresh()
    } catch {
      setState({ status: 'error', message: t('renameDialog.networkError') })
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
        <Button type="button" variant="ghost" size="sm" aria-label={t('renameDialog.trigger')}>
          <PencilSimple size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('renameDialog.title')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          // Declarative WebMCP: an agent may fill this in, but the operator
          // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
          toolname="renameClient"
          tooldescription={t('renameDialog.toolDescription')}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientName" className="text-xs">
              {t('renameDialog.nameLabel')}
            </Label>
            <Input
              id="clientName"
              name="name"
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              toolparamdescription={t('renameDialog.nameToolParamDescription')}
            />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting' || name.trim().length === 0}>
              {state.status === 'submitting' ? tCommon('saving') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
