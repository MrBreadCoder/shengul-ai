'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { IdentificationCard } from '@phosphor-icons/react'
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

type EditState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

interface EditSignatureDialogProps {
  clientId: string
  currentSignatureName: string | null
  currentSignatureTitle: string | null
  currentPhone: string | null
  currentAddress: string | null
}

// All four fields are optional and only used to append a deterministic
// signature line to outbound email once a phone number is on file — see
// appendSignatureBlock in src/lib/pipeline/signature.ts. Submitting a field
// empty clears it, same convention as EditDomainDialog.
export function EditSignatureDialog({
  clientId,
  currentSignatureName,
  currentSignatureTitle,
  currentPhone,
  currentAddress,
}: EditSignatureDialogProps): React.ReactElement {
  const t = useTranslations('clients')
  const tCommon = useTranslations('common')
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [signatureName, setSignatureName] = useState(currentSignatureName ?? '')
  const [signatureTitle, setSignatureTitle] = useState(currentSignatureTitle ?? '')
  const [phone, setPhone] = useState(currentPhone ?? '')
  const [address, setAddress] = useState(currentAddress ?? '')
  const [state, setState] = useState<EditState>({ status: 'idle' })

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    setState({ status: 'submitting' })
    try {
      const res = await fetch(`/api/clients/${clientId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ signatureName, signatureTitle, phone, address }),
      })
      if (!res.ok) {
        const json: unknown = await res.json().catch(() => ({}))
        const message =
          typeof json === 'object' && json !== null && 'error' in json
            ? String((json as { error: unknown }).error)
            : t('editSignatureDialog.updateFailed')
        setState({ status: 'error', message })
        toast.error(t('editSignatureDialog.updateFailedToast'), { description: message })
        return
      }
      setState({ status: 'idle' })
      setOpen(false)
      toast.success(t('editSignatureDialog.updatedToast'))
      router.refresh()
    } catch {
      setState({ status: 'error', message: t('editSignatureDialog.networkError') })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (next) {
          setSignatureName(currentSignatureName ?? '')
          setSignatureTitle(currentSignatureTitle ?? '')
          setPhone(currentPhone ?? '')
          setAddress(currentAddress ?? '')
        }
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm" aria-label={t('editSignatureDialog.trigger')}>
          <IdentificationCard size={14} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('editSignatureDialog.title')}</DialogTitle>
        </DialogHeader>
        <form
          onSubmit={onSubmit}
          // Declarative WebMCP: an agent may fill this in, but the operator
          // presses the button. No `toolautosubmit` — see `@/types/webmcp`.
          toolname="setClientSignature"
          tooldescription={t('editSignatureDialog.toolDescription')}
          className="flex flex-col gap-4"
        >
          <div className="flex flex-col gap-2">
            <Label htmlFor="signatureName" className="text-xs">
              {t('editSignatureDialog.nameLabel')}
            </Label>
            <Input
              id="signatureName"
              name="signatureName"
              value={signatureName}
              onChange={(event) => setSignatureName(event.target.value)}
              placeholder="John Smith"
              toolparamdescription={t('editSignatureDialog.nameToolParamDescription')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="signatureTitle" className="text-xs">
              {t('editSignatureDialog.titleLabel')}
            </Label>
            <Input
              id="signatureTitle"
              name="signatureTitle"
              value={signatureTitle}
              onChange={(event) => setSignatureTitle(event.target.value)}
              placeholder="Sales Director"
              toolparamdescription={t('editSignatureDialog.titleToolParamDescription')}
            />
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientPhone" className="text-xs">
              {t('editSignatureDialog.phoneLabel')}
            </Label>
            <Input
              id="clientPhone"
              name="phone"
              value={phone}
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+1 555 123 4567"
              toolparamdescription={t('editSignatureDialog.phoneToolParamDescription')}
            />
            <p className="text-faint text-[11px]">{t('editSignatureDialog.phoneHint')}</p>
          </div>
          <div className="flex flex-col gap-2">
            <Label htmlFor="clientAddress" className="text-xs">
              {t('editSignatureDialog.addressLabel')}
            </Label>
            <Input
              id="clientAddress"
              name="address"
              value={address}
              onChange={(event) => setAddress(event.target.value)}
              placeholder="123 Main St, Istanbul, Turkey"
              toolparamdescription={t('editSignatureDialog.addressToolParamDescription')}
            />
          </div>
          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}
          <DialogFooter>
            <Button type="submit" size="sm" disabled={state.status === 'submitting'}>
              {state.status === 'submitting' ? tCommon('saving') : tCommon('save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
