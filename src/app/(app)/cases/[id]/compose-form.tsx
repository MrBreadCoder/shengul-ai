'use client'

import { useState, useTransition } from 'react'
import { PaperPlaneTilt } from '@phosphor-icons/react'
import { useTranslations } from 'next-intl'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select'
import { ResourcePicker } from '@/components/resource-picker'
import type { ResourceSummary } from '@/components/resource-list'
import { MAX_SUBJECT_CHARS, MAX_BODY_CHARS } from '@/lib/validation/email-limits'
import type { ComposeContact } from '@/types/mail'
import { sendManualEmail, type SendManualEmailResult } from './send-actions'

interface ComposeFormProps {
  caseId: string
  /** Active leads on this case that have an address. */
  contacts: readonly ComposeContact[]
  resources: readonly ResourceSummary[]
  /** `Re: <last outbound subject>` when a thread exists, else ''. */
  defaultSubject: string
}

// Maps the codes sendManualEmail's result can report onto something a client
// can act on. Anything else is a bug, not a state they can fix.
function messageForCode(t: ReturnType<typeof useTranslations<'cases'>>, code: string): string {
  if (code === 'FORBIDDEN') return t('composeForm.errorForbidden')
  if (code === 'RATE_LIMITED') return t('composeForm.errorRateLimited')
  if (code === 'VALIDATION_ERROR') return t('composeForm.errorValidation')
  return t('composeForm.errorGeneric')
}

export function ComposeForm({
  caseId,
  contacts,
  resources,
  defaultSubject,
}: ComposeFormProps): React.ReactElement {
  const t = useTranslations('cases')
  const [leadId, setLeadId] = useState<string>(contacts[0]?.id ?? '')
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (contacts.length === 0) {
    return (
      <p className="border-hairline text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-sm">
        {t('composeForm.noVerifiedContact')}
      </p>
    )
  }

  function submit(formData: FormData): void {
    setError(null)
    setSentTo(null)
    formData.set('caseId', caseId)
    formData.set('leadId', leadId)
    startTransition(async () => {
      const result: SendManualEmailResult = await sendManualEmail(formData)
      if (!result.ok) {
        setError(messageForCode(t, result.code))
        return
      }
      const recipient = contacts.find((contact) => contact.id === leadId)
      setSentTo(recipient?.email ?? t('composeForm.theContact'))
      setBody('')
    })
  }

  return (
    <form action={submit} className="border-hairline bg-surface flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-col gap-1.5">
          <Label htmlFor={contacts.length > 1 ? 'compose-recipient' : undefined}>{t('composeForm.toLabel')}</Label>
          {contacts.length === 1 ? (
            // length check above guarantees index 0 exists
            <p className="text-sm font-medium">
              {contacts[0]!.fullName} — {contacts[0]!.email}
            </p>
          ) : (
            <Select value={leadId} onValueChange={setLeadId}>
              <SelectTrigger id="compose-recipient">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {contacts.map((contact) => (
                  <SelectItem key={contact.id} value={contact.id}>
                    {contact.fullName} — {contact.email}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <Label htmlFor="compose-subject">{t('composeForm.subjectLabel')}</Label>
          <Input
            id="compose-subject"
            name="subject"
            value={subject}
            onChange={(event) => setSubject(event.target.value)}
            maxLength={MAX_SUBJECT_CHARS}
            required
          />
        </div>
      </div>

      <Textarea
        name="body"
        value={body}
        onChange={(event) => setBody(event.target.value)}
        placeholder={t('composeForm.bodyPlaceholder')}
        rows={8}
        maxLength={MAX_BODY_CHARS}
        required
        aria-label={t('composeForm.bodyLabel')}
      />

      <ResourcePicker resources={resources} name="resourceIds" />

      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
      {sentTo ? (
        <p role="status" className="text-[12px] text-[var(--status-won)]">
          {t('composeForm.sentTo', { recipient: sentTo })}
        </p>
      ) : null}

      <Button
        type="submit"
        size="sm"
        className="w-fit"
        disabled={isPending || subject.trim().length === 0 || body.trim().length === 0}
      >
        <PaperPlaneTilt size={13} weight="light" />
        {isPending ? t('composeForm.sending') : t('composeForm.sendButton')}
      </Button>
    </form>
  )
}
