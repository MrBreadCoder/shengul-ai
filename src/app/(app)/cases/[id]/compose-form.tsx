'use client'

import { useState, useTransition } from 'react'
import { PaperPlaneTilt } from '@phosphor-icons/react'
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
import { sendManualEmail, type SendManualEmailResult } from './send-actions'

export interface ComposeContact {
  id: string
  fullName: string
  email: string
}

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
function messageForCode(code: string): string {
  if (code === 'FORBIDDEN') return 'That address is on your suppression list, so nothing was sent.'
  if (code === 'RATE_LIMITED') return 'No healthy mailbox is available right now. Check Settings.'
  if (code === 'VALIDATION_ERROR') return 'Check the recipient, the subject and the attachments, then try again.'
  return 'Could not send that email. Try again.'
}

export function ComposeForm({
  caseId,
  contacts,
  resources,
  defaultSubject,
}: ComposeFormProps): React.ReactElement {
  const [leadId, setLeadId] = useState<string>(contacts[0]?.id ?? '')
  const [subject, setSubject] = useState(defaultSubject)
  const [body, setBody] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [sentTo, setSentTo] = useState<string | null>(null)
  const [isPending, startTransition] = useTransition()

  if (contacts.length === 0) {
    return (
      <p className="border-hairline text-muted-foreground rounded-lg border border-dashed px-4 py-5 text-center text-sm">
        No contact on this case has a verified address yet, so there is nobody to write to.
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
        setError(messageForCode(result.code))
        return
      }
      const recipient = contacts.find((contact) => contact.id === leadId)
      setSentTo(recipient?.email ?? 'the contact')
      setBody('')
    })
  }

  return (
    <form action={submit} className="border-hairline bg-surface flex flex-col gap-3 rounded-lg border p-4">
      <div className="flex flex-wrap items-end gap-3">
        <div className="flex min-w-56 flex-col gap-1.5">
          <Label htmlFor="compose-recipient">To</Label>
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
        </div>
        <div className="flex min-w-64 flex-1 flex-col gap-1.5">
          <Label htmlFor="compose-subject">Subject</Label>
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
        placeholder="Write your message. It goes out from your own mailbox, in your own words."
        rows={8}
        maxLength={MAX_BODY_CHARS}
        required
        aria-label="Message body"
      />

      <ResourcePicker resources={resources} name="resourceIds" />

      {error ? (
        <p role="alert" className="text-destructive text-[12px]">
          {error}
        </p>
      ) : null}
      {sentTo ? (
        <p role="status" className="text-[12px] text-[var(--status-won)]">
          Sent to {sentTo}. Follow-ups for this contact will adjust automatically.
        </p>
      ) : null}

      <Button
        type="submit"
        size="sm"
        className="w-fit"
        disabled={isPending || subject.trim().length === 0 || body.trim().length === 0}
      >
        <PaperPlaneTilt size={13} weight="light" />
        {isPending ? 'Sending…' : 'Send'}
      </Button>
    </form>
  )
}
