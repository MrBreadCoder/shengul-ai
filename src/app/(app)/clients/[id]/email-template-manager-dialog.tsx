'use client'

import { useState } from 'react'
import { toast } from 'sonner'
import { PencilSimple, Plus, Star, Trash } from '@phosphor-icons/react'
import type { EmailTemplateRow } from '@/lib/db/email-templates'
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

interface EmailTemplateManagerDialogProps {
  clientId: string
  templates: EmailTemplateRow[]
  selectedTemplateId: string
  /** Called after any mutation that should refresh the parent page's data. */
  onChanged: () => void
}

type FormState =
  | { mode: 'closed' }
  | { mode: 'create'; name: string; templateText: string }
  | { mode: 'edit'; templateId: string; name: string; templateText: string }

type SubmitState = { status: 'idle' } | { status: 'submitting' } | { status: 'error'; message: string }

// Operator-only, plain English — same rule as email-template-select.tsx.
// Every template here is a GLOBAL row: editing or deleting one from this
// client's page changes it for every client/campaign currently on it, which
// is why the dialog says so explicitly rather than reading as a per-client
// copy edit.
export function EmailTemplateManagerDialog({
  clientId,
  templates,
  selectedTemplateId,
  onChanged,
}: EmailTemplateManagerDialogProps): React.ReactElement {
  const [open, setOpen] = useState(false)
  const [form, setForm] = useState<FormState>({ mode: 'closed' })
  const [submit, setSubmit] = useState<SubmitState>({ status: 'idle' })

  function startEdit(template: EmailTemplateRow): void {
    setForm({ mode: 'edit', templateId: template.id, name: template.name, templateText: template.template_text })
    setSubmit({ status: 'idle' })
  }

  function startCreate(): void {
    setForm({ mode: 'create', name: '', templateText: '' })
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
    const url = isCreate ? '/api/email-templates' : `/api/email-templates/${form.templateId}`
    try {
      const response = await fetch(url, {
        method: isCreate ? 'POST' : 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: form.name, templateText: form.templateText }),
      })
      if (!response.ok) {
        const json: unknown = await response.json().catch(() => ({}))
        const errorCode =
          typeof json === 'object' && json !== null && 'error' in json ? String((json as { error: unknown }).error) : 'unknown'
        const message = errorCode === 'name_taken' ? 'A template with that name already exists.' : 'Failed to save the template.'
        setSubmit({ status: 'error', message })
        toast.error(message)
        return
      }
      if (isCreate) {
        const json = (await response.json()) as { template: EmailTemplateRow }
        // A new template is immediately selected for this client — otherwise
        // it would exist but no client would be using it yet.
        await fetch(`/api/clients/${clientId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ emailTemplateId: json.template.id }),
        })
      }
      setForm({ mode: 'closed' })
      setSubmit({ status: 'idle' })
      toast.success(isCreate ? 'Template created.' : 'Template updated.')
      onChanged()
    } catch {
      setSubmit({ status: 'error', message: 'Network error — please try again.' })
    }
  }

  async function setDefault(template: EmailTemplateRow): Promise<void> {
    setSubmit({ status: 'submitting' })
    try {
      const response = await fetch(`/api/email-templates/${template.id}`, {
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
      toast.success(`"${template.name}" is now the default template.`)
      onChanged()
    } catch {
      toast.error('Network error — please try again.')
      setSubmit({ status: 'idle' })
    }
  }

  async function deleteTemplate(template: EmailTemplateRow): Promise<void> {
    if (template.is_default) return
    if (!window.confirm(`Delete "${template.name}"? Clients and campaigns on this template fall back to the default template.`)) return
    setSubmit({ status: 'submitting' })
    try {
      const response = await fetch(`/api/email-templates/${template.id}`, { method: 'DELETE' })
      if (!response.ok) {
        toast.error('Failed to delete the template.')
        setSubmit({ status: 'idle' })
        return
      }
      setSubmit({ status: 'idle' })
      toast.success(`"${template.name}" deleted.`)
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
        <Button type="button" variant="ghost" size="icon-xs" aria-label="Manage email templates">
          <PencilSimple size={12} weight="light" />
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Manage email templates</DialogTitle>
        </DialogHeader>

        {form.mode === 'closed' ? (
          <div className="flex flex-col gap-3">
            <p className="text-faint text-[11px]">
              Editing or deleting a template below changes it for every client or campaign currently using it, not just this one.
            </p>
            <ul className="flex flex-col gap-2">
              {templates.map((template) => (
                <li key={template.id} className="border-hairline flex items-center justify-between gap-2 rounded-md border p-2">
                  <div className="flex items-center gap-1.5">
                    <span className="text-sm">{template.name}</span>
                    {template.is_default ? <span className="text-faint text-[10px]">(default)</span> : null}
                    {template.id === selectedTemplateId ? <span className="text-faint text-[10px]">— in use here</span> : null}
                  </div>
                  <div className="flex items-center gap-1">
                    {!template.is_default ? (
                      <Button
                        type="button"
                        variant="ghost"
                        size="icon-xs"
                        aria-label={`Set "${template.name}" as default`}
                        disabled={submit.status === 'submitting'}
                        onClick={() => void setDefault(template)}
                      >
                        <Star size={12} weight="light" />
                      </Button>
                    ) : null}
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Edit "${template.name}"`}
                      onClick={() => startEdit(template)}
                    >
                      <PencilSimple size={12} weight="light" />
                    </Button>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      aria-label={`Delete "${template.name}"`}
                      disabled={template.is_default || submit.status === 'submitting'}
                      title={template.is_default ? "Can't delete the default template" : undefined}
                      onClick={() => void deleteTemplate(template)}
                    >
                      <Trash size={12} weight="light" />
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
            <Button type="button" variant="outline" size="sm" onClick={startCreate}>
              <Plus size={14} weight="light" />
              New template
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {form.mode === 'edit' ? (
              <p className="text-faint text-[11px]">This updates the template for every client or campaign currently using it.</p>
            ) : null}
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-template-name" className="text-xs">
                Name
              </Label>
              <Input
                id="email-template-name"
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                placeholder="e.g. Hospitality & Travel"
                maxLength={80}
              />
            </div>
            <div className="flex flex-col gap-2">
              <Label htmlFor="email-template-text" className="text-xs">
                Template
              </Label>
              <Textarea
                id="email-template-text"
                value={form.templateText}
                onChange={(event) => setForm({ ...form, templateText: event.target.value })}
                placeholder={'Dear [Name],\n\nWe design and manufacture...\n\nKind regards,\n...'}
                maxLength={4000}
                rows={8}
              />
              <p className="text-faint text-[11px]">
                Paste a reference email — the client&apos;s own wording is best. The AI personalizes a new email per lead in this
                voice and fills in any [bracketed] placeholders using that lead&apos;s real details; it never sends this text
                verbatim. Subject-line formatting, English-only output, and the human-voice/no-spam rules always apply on top.
                The sign-off is never included — a signature block is appended separately.
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
                disabled={submit.status === 'submitting' || form.name.trim().length === 0 || form.templateText.trim().length === 0}
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
