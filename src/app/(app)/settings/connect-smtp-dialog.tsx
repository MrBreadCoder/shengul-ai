'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { EnvelopeSimple, Plus } from '@phosphor-icons/react'
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

type ConnectState =
  | { status: 'idle' }
  | { status: 'submitting' }
  | { status: 'error'; message: string }

interface FormValues {
  emailAddress: string
  displayName: string
  firstName: string
  lastName: string
  username: string
  password: string
  smtpHost: string
  smtpPort: string
  smtpSecure: string
  imapHost: string
  imapPort: string
  imapSecure: string
}

// Ports and TLS modes almost every provider uses. 587 is STARTTLS, 993 is
// implicit TLS — a user who knows neither term gets a working default.
const INITIAL_VALUES: FormValues = {
  emailAddress: '',
  displayName: '',
  firstName: '',
  lastName: '',
  username: '',
  password: '',
  smtpHost: '',
  smtpPort: '587',
  smtpSecure: 'false',
  imapHost: '',
  imapPort: '993',
  imapSecure: 'true',
}

type SmtpStage = 'smtp' | 'imap'

function isSmtpStage(value: unknown): value is SmtpStage {
  return value === 'smtp' || value === 'imap'
}

function errorMessage(t: ReturnType<typeof useTranslations<'settings'>>, code: unknown, stage: unknown): string {
  const leg = isSmtpStage(stage)
    ? t('smtpDialog.errorLegSuffix', { stage: t(stage === 'smtp' ? 'smtpDialog.stageSmtp' : 'smtpDialog.stageImap') })
    : ''
  if (code === 'auth_failed') return t('smtpDialog.errorAuthFailed', { leg })
  if (code === 'timeout') return t('smtpDialog.errorTimeout', { leg })
  if (code === 'connection_failed') return t('smtpDialog.errorConnectionFailed', { leg })
  if (code === 'validation_error') return t('smtpDialog.errorValidation')
  return t('smtpDialog.errorGeneric')
}

export function ConnectSmtpDialog(): React.ReactElement {
  const t = useTranslations('settings')
  const router = useRouter()
  const [isPending, startTransition] = useTransition()
  const [open, setOpen] = useState(false)
  const [values, setValues] = useState<FormValues>(INITIAL_VALUES)
  const [state, setState] = useState<ConnectState>({ status: 'idle' })
  const isBusy = state.status === 'submitting' || isPending

  function setField(field: keyof FormValues, value: string): void {
    setValues((current) => ({ ...current, [field]: value }))
  }

  function onOpenChange(next: boolean): void {
    setOpen(next)
    if (!next) {
      setValues(INITIAL_VALUES)
      setState({ status: 'idle' })
    }
  }

  async function onSubmit(event: React.FormEvent): Promise<void> {
    event.preventDefault()
    if (isBusy) return
    setState({ status: 'submitting' })
    try {
      const response = await fetch('/api/mailboxes/smtp/connect', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          emailAddress: values.emailAddress,
          displayName: values.displayName.trim() === '' ? null : values.displayName.trim(),
          firstName: values.firstName.trim(),
          lastName: values.lastName.trim(),
          username: values.username,
          password: values.password,
          smtpHost: values.smtpHost,
          smtpPort: Number(values.smtpPort),
          smtpSecure: values.smtpSecure === 'true',
          imapHost: values.imapHost,
          imapPort: Number(values.imapPort),
          imapSecure: values.imapSecure === 'true',
        }),
      })
      const json: unknown = await response.json().catch(() => ({}))
      if (!response.ok) {
        const body = typeof json === 'object' && json !== null ? (json as Record<string, unknown>) : {}
        setState({ status: 'error', message: errorMessage(t, body.error, body.stage) })
        return
      }
      onOpenChange(false)
      startTransition(() => router.refresh())
    } catch {
      setState({ status: 'error', message: t('smtpDialog.errorNetwork') })
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogTrigger asChild>
        <button
          type="button"
          className="border-hairline bg-surface hover:border-hairline-strong group flex items-center gap-3 rounded-lg border p-4 text-left transition-[border-color,transform] duration-200 ease-[cubic-bezier(0.22,1,0.36,1)] active:scale-[0.99]"
        >
          <span className="bg-accent text-muted-foreground grid size-9 shrink-0 place-items-center rounded-md">
            <EnvelopeSimple size={18} weight="light" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[13px] font-medium">{t('smtpDialog.triggerTitle')}</span>
            <span className="text-faint block text-[11px]">{t('smtpDialog.triggerHint')}</span>
          </span>
          <Plus
            size={15}
            weight="light"
            className="text-faint group-hover:text-foreground shrink-0 transition-colors duration-200"
          />
        </button>
      </DialogTrigger>

      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('smtpDialog.title')}</DialogTitle>
        </DialogHeader>

        {/*
          Deliberately unannotated for WebMCP. This form takes a mailbox password
          — the credential the whole pipeline sends with — so it is not something
          an agent should be filling in, even with a human on the submit button.
          Lighthouse listing it under `webmcp-form-coverage` is intended.
        */}
        <form onSubmit={onSubmit} className="flex flex-col gap-4">
          <p className="text-muted-foreground text-xs">{t('smtpDialog.intro')}</p>

          <div className="flex flex-col gap-2">
            <Label htmlFor="smtp-email" className="text-xs">
              {t('smtpDialog.emailLabel')}
            </Label>
            <Input
              id="smtp-email"
              type="email"
              required
              autoComplete="off"
              value={values.emailAddress}
              onChange={(event) => setField('emailAddress', event.target.value)}
              placeholder="ops@yourdomain.com"
            />
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="smtp-display-name" className="text-xs">
              {t('smtpDialog.displayNameLabel')}
            </Label>
            <Input
              id="smtp-display-name"
              type="text"
              autoComplete="off"
              value={values.displayName}
              onChange={(event) => setField('displayName', event.target.value)}
              placeholder="Client Ops"
            />
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-first-name" className="text-xs">
                {t('smtpDialog.firstNameLabel')}
              </Label>
              <Input
                id="smtp-first-name"
                type="text"
                required
                autoComplete="off"
                value={values.firstName}
                onChange={(event) => setField('firstName', event.target.value)}
                placeholder="Jordan"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-last-name" className="text-xs">
                {t('smtpDialog.lastNameLabel')}
              </Label>
              <Input
                id="smtp-last-name"
                type="text"
                required
                autoComplete="off"
                value={values.lastName}
                onChange={(event) => setField('lastName', event.target.value)}
                placeholder="Lee"
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-username" className="text-xs">
                {t('smtpDialog.usernameLabel')}
              </Label>
              <Input
                id="smtp-username"
                type="text"
                required
                autoComplete="off"
                value={values.username}
                onChange={(event) => setField('username', event.target.value)}
                placeholder="ops@yourdomain.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-password" className="text-xs">
                {t('smtpDialog.passwordLabel')}
              </Label>
              <Input
                id="smtp-password"
                type="password"
                required
                autoComplete="new-password"
                value={values.password}
                onChange={(event) => setField('password', event.target.value)}
              />
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="smtp-host" className="text-xs">
                {t('smtpDialog.smtpHostLabel')}
              </Label>
              <Input
                id="smtp-host"
                type="text"
                required
                value={values.smtpHost}
                onChange={(event) => setField('smtpHost', event.target.value)}
                placeholder="smtp.yourdomain.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="smtp-port" className="text-xs">
                {t('smtpDialog.smtpPortLabel')}
              </Label>
              <Input
                id="smtp-port"
                type="number"
                required
                min={1}
                max={65535}
                value={values.smtpPort}
                onChange={(event) => setField('smtpPort', event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="smtp-secure" className="text-xs">
              {t('smtpDialog.smtpSecureLabel')}
            </Label>
            <select
              id="smtp-secure"
              value={values.smtpSecure}
              onChange={(event) => setField('smtpSecure', event.target.value)}
              className="border-hairline bg-surface rounded-md border px-2 py-2 text-[13px]"
            >
              <option value="false">{t('smtpDialog.smtpSecureStarttls')}</option>
              <option value="true">{t('smtpDialog.smtpSecureSsl')}</option>
            </select>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            <div className="flex flex-col gap-2 sm:col-span-2">
              <Label htmlFor="imap-host" className="text-xs">
                {t('smtpDialog.imapHostLabel')}
              </Label>
              <Input
                id="imap-host"
                type="text"
                required
                value={values.imapHost}
                onChange={(event) => setField('imapHost', event.target.value)}
                placeholder="imap.yourdomain.com"
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="imap-port" className="text-xs">
                {t('smtpDialog.imapPortLabel')}
              </Label>
              <Input
                id="imap-port"
                type="number"
                required
                min={1}
                max={65535}
                value={values.imapPort}
                onChange={(event) => setField('imapPort', event.target.value)}
              />
            </div>
          </div>

          <div className="flex flex-col gap-2">
            <Label htmlFor="imap-secure" className="text-xs">
              {t('smtpDialog.imapSecureLabel')}
            </Label>
            <select
              id="imap-secure"
              value={values.imapSecure}
              onChange={(event) => setField('imapSecure', event.target.value)}
              className="border-hairline bg-surface rounded-md border px-2 py-2 text-[13px]"
            >
              <option value="true">{t('smtpDialog.imapSecureSsl')}</option>
              <option value="false">{t('smtpDialog.imapSecureStarttls')}</option>
            </select>
          </div>

          {state.status === 'error' ? (
            <p role="alert" className="text-destructive text-xs">
              {state.message}
            </p>
          ) : null}

          <DialogFooter>
            <Button type="submit" size="sm" disabled={isBusy}>
              <EnvelopeSimple size={13} weight="light" />
              {isBusy ? t('smtpDialog.checking') : t('smtpDialog.connectButton')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
