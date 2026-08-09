'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { PencilSimple, Plus, Star, Trash } from '@phosphor-icons/react'
import type { EmailStyleRow } from '@/lib/db/email-styles'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'

interface EmailStyleManagerDialogProps {
  clientId: string
  styles: EmailStyleRow[]
  selectedStyleId: string
  /** Called after any mutation that should refresh the parent page's data. */
  onChanged: () => void
}

type FormState =
  | { mode: 'closed' }
  | { mode: 'create'; name: string; voiceInstructions: string }
  | { mode: 'edit'; styleId: string; name: string; voiceInstructions: string }

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

// Operator-only, plain English — same rule as email-style-select.tsx. Every
// style here is a GLOBAL row: editing or deleting one from this client's
// page changes it for every client currently on it, which is why the dialog
// says so explicitly rather than reading as a per-client copy edit.
export function EmailStyleManagerDialog({
  clientId,
  styles,
  selectedStyleId,
  onChanged,
}: EmailStyleManagerDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>({ mode: 'closed' })
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' })

  function startEdit(style: EmailStyleRow): void {
    setForm({ mode: 'edit', styleId: style.id, name: style.name, voiceInstructions: style.voice_instructions })
    setSubmit({ status: 'idle' })
  }

  function startCreate(): void {
    setForm({ mode: 'create', name: '', voiceInstructions: '' })
    setSubmit({ status: 'idle' })
  }

  function cancelForm(): void {
    setForm({ mode: 'closed' })
    setSubmit({ status: 'idle' })
  }

  async function submitForm(): Promise<void> {
    if (form.mode === 'closed') return
    setSubmit({ status: 'submitting' })
    const isCreate = form.mode === 'create'
    const url = isCreate ? '/api/email-styles' : `/api/email-styles/${form.styleId}`
    try {
      const response = await fetch(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, voiceInstructions: form.voiceInstructions }),
      })
      if (!response.ok) {
        const json: unknown = await response.json().catch(() => ({}))
        const errorCode =
          typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'unknown'
        const message = errorCode === 'name_taken' ? 'A style with that name already exists.' : 'Failed to save the style.'
        setSubmit({ status: 'error', message })
        toast.error(message)
        return
      }
      if (isCreate) {
        const json = (await response.json()) as { style: EmailStyleRow }
        // A new style is immediately selected for this client — otherwise
        // it would exist but no client would be using it yet.
        await fetch(`/api/clients/${clientId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailStyleId: json.style.id }),
        })
      }
      setForm({ mode: 'closed' })
      setSubmit({ status: 'idle' })
      toast.success(isCreate ? 'Style created.' : 'Style updated.')
      onChanged()
    } catch {
      setSubmit({ status: 'error', message: 'Network error — please try again.' })
    }
  }

  async function setDefault(style: EmailStyleRow): Promise<void> {
    setSubmit({ status: 'submitting' })
    try {
      const response = await fetch(`/api/email-styles/${style.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isDefault: true }),
      })
      if (!response.ok) {
        toast.error('Failed to set as default.')
        setSubmit({ status: 'idle' })
        return
      }
      setSubmit({ status: 'idle' })
      toast.success(`"${style.name}" is now the default style.`)
      onChanged()
    } catch {
      toast.error('Network error — please try again.')
      setSubmit({ status: 'idle' })
    }
  }

  async function deleteStyle(style: EmailStyleRow): Promise<void> {
    if (style.is_default) return
    if (!window.confirm(`Delete "${style.name}"? Clients on this style fall back to the default style.`)) return
    setSubmit({ status: 'submitting' })
    try {
      const response = await fetch(`/api/email-styles/${style.id}`, { method: 'DELETE' })
      if (!response.ok) {
        toast.error('Failed to delete the style.')
        setSubmit({ status: 'idle' })
        return
      }
      setSubmit({ status: 'idle' })
      toast.success(`"${style.name}" deleted.`)
      onChanged()
    } catch {
      toast.error('Network error — please try again.')
      setSubmit({ status: 'idle' })
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) cancelForm()
      }}
    >
      <DialogTrigger asChild>
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Manage email styles">
          <PencilSimple size={12} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage email styles</DialogTitle>
        </DialogHeader>

        {form.mode === 'closed' ? (
          <div className="flex flex-col gap-3">
            <p className="text-faint text-[11px]">
              Editing or deleting a style below changes it for every client currently using it, not just this one.
            </p>
            <ul className="flex flex-col gap-2">
              {styles.map((style) => (
                <li key={style.id} className="border-hairline flex items-center justify-between gap-2 rounded-md border p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{style.name}</span>
                    {style.is_default ? <span className="text-faint text-[10px]">(default)</span> : null}
                    {style.id === selectedStyleId ? <span className="text-faint text-[10px]">— in use here</span> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {!style.is_default ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Set "${style.name}" as default`}
                        disabled={submit.status === 'submitting'}
                        onClick={() => void setDefault(style)}
                      >
                        <Star size={12} weight="light" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit "${style.name}"`}
                      onClick={() => startEdit(style)}
                    >
                      <PencilSimple size={12} weight="light" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete "${style.name}"`}
                      disabled={style.is_default || submit.status === 'submitting'}
                      title={style.is_default ? "Can't delete the default style" : undefined}
                      onClick={() => void deleteStyle(style)}
                    >
                      <Trash size={12} weight="light" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" size="sm" onClick={startCreate}>
              <Plus size={14} weight="light" />
              New style
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {form.mode === 'edit' ? (
              <p className="text-faint text-[11px]">This updates the style for every client currently using it.</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-style-name" className="text-xs">
                Name
              </Label>
              <Input
                id="email-style-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="e.g. Casual referral intro"
                maxLength={80}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-style-voice" className="text-xs">
                Voice instructions
              </Label>
              <Textarea
                id="email-style-voice"
                value={form.voiceInstructions}
                onChange={(event) => setForm({ ...form, voiceInstructions: event.target.value })}
                placeholder="e.g. Open with the recipient's first name. Keep it under 80 words. End with a direct question."
                maxLength={4000}
                rows={8}
              />
              <p className="text-faint text-[11px]">
                Subject-line formatting, English-only output, and the human-voice/no-spam rules always apply on top of this —
                you&apos;re only writing the voice, structure, and word-count guidance.
              </p>
            </div>
            {submit.status === 'error' ? (
              <p role="alert" className="text-destructive text-xs">
                {submit.message}
              </p>
            ) : null}
            <DialogFooter>
              <Button type="button" variant="ghost" size="sm" onClick={cancelForm}>
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                disabled={submit.status === 'submitting' || form.name.trim().length === 0 || form.voiceInstructions.trim().length === 0}
                onClick={() => void submitForm()}
              >
                {submit.status === 'submitting' ? 'Saving…' : 'Save'}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
}
